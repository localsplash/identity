import { beforeAll, afterAll, describe, it, expect } from "vitest";
import mysql from "mysql2/promise";
import express from "express";
import request from "supertest";
import { runMigrations } from "./migrations";
import { installPlatformRoutes } from "./platformRoutes";
import * as p from "./platform";
import * as store from "./store";

const url = process.env.TEST_DB_URL;
describe.skipIf(!url)("platform authority (isolated MySQL)", () => {
  let pool: mysql.Pool, app: express.Express;
  let rootToken: string, aliceToken: string, bobToken: string;
  let rootId: number,
    aliceId: number,
    bobId: number,
    tenantA: number,
    tenantB: number;
  const auth = (token: string) => ({
    Authorization: `Bearer ${token}`,
    "X-Test-Server": "trusted",
  });
  beforeAll(async () => {
    const parsed = new URL(url!);
    const database = "identity_platform_test";
    const admin = await mysql.createConnection({
      host: parsed.hostname,
      port: Number(parsed.port || 3306),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    });
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    parsed.pathname = `/${database}`;
    pool = mysql.createPool({
      uri: parsed.toString(),
      connectionLimit: 8,
      timezone: "Z",
    });
    await runMigrations(pool);
    app = express();
    app.use(express.json());
    installPlatformRoutes(app, pool, async (req, res) => {
      if (req.get("X-Test-Server") === "trusted") return true;
      res.status(403).json({ error: "Forbidden" });
      return false;
    });
    rootId = await store.createUser(pool, "root@x.tld", "Root");
    aliceId = await store.createUser(pool, "alice@x.tld", "Alice");
    bobId = await store.createUser(pool, "bob@x.tld", "Bob");
    async function token(iUserId: number, bSuperAdmin: boolean) {
      return p.createAppSession(
        pool,
        {
          iUserId,
          bSuperAdmin,
          sProvider: "google",
          sSubject: String(iUserId),
        },
        "https://aida.X.TLD",
      );
    }
    rootToken = await token(rootId, true);
    aliceToken = await token(aliceId, false);
    bobToken = await token(bobId, false);
    const actor = (await p.getAppSession(pool, rootToken))!;
    tenantA = await p.createTenant(pool, actor, "Office A", "office-a");
    tenantB = await p.createTenant(pool, actor, "Office B", "office-b");
    await p.setMembership(pool, actor, tenantA, aliceId, "TENANT_ADMIN", true);
    await p.setMembership(pool, actor, tenantB, bobId, "TENANT_ADMIN", true);
  });
  afterAll(async () => {
    await pool?.end();
  });
  const introspect = (token: string) =>
    request(app)
      .post("/api/sessions/introspect")
      .set("X-Test-Server", "trusted")
      .send({ token });
  it("requires server admission plus actor authority for directory requests", async () => {
    expect(
      (
        await request(app)
          .get("/api/directory/tenants")
          .set("Authorization", `Bearer ${rootToken}`)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get("/api/directory/tenants")
          .set("X-Test-Server", "trusted")
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post("/api/directory/tenants")
          .set(auth(aliceToken))
          .send({ name: "Office C", slug: "office-c" })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get(`/api/directory/tenants/${tenantB}/memberships`)
          .set(auth(aliceToken))
      ).status,
    ).toBe(403);
  });
  it("returns all tenants to SUPER_ADMIN and only current enabled memberships to ordinary users", async () => {
    const root = await introspect(rootToken),
      alice = await introspect(aliceToken);
    expect(root.body.user.superAdmin).toBe(true);
    expect(root.body.tenants.map((t: p.Tenant) => t.role)).toEqual([
      "SUPER_ADMIN",
      "SUPER_ADMIN",
    ]);
    expect(alice.body.user.superAdmin).toBe(false);
    expect(alice.body.tenants.map((t: p.Tenant) => t.iTenantId)).toEqual([
      tenantA,
    ]);
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT * FROM identity_tbl_Membership WHERE iUserId = ?`,
      [rootId],
    );
    expect(rows).toHaveLength(0);
  });
  it("hashes app credentials and prevents confusing app tokens with SSO cookies", async () => {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT sSessionId FROM identity_tbl_Session WHERE iUserId = ?`,
      [rootId],
    );
    expect(rows[0].sSessionId).not.toBe(rootToken);
    expect(await store.getSession(pool, rootToken)).toBeNull();
    expect(await store.getSession(pool, rows[0].sSessionId)).toBeNull();
    const sso = await store.createSession(pool, rootId, true, "google", "root");
    expect(await p.getAppSession(pool, sso)).toBeNull();
    expect(await store.getSession(pool, sso)).not.toBeNull();
  });
  it("persists selection centrally and refuses cross-tenant selections", async () => {
    expect(
      (
        await request(app)
          .post("/api/sessions/select-tenant")
          .set("X-Test-Server", "trusted")
          .send({ token: aliceToken, iTenantId: tenantB })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/sessions/select-tenant")
          .set("X-Test-Server", "trusted")
          .send({ token: aliceToken, iTenantId: tenantA })
      ).body.selectedTenantId,
    ).toBe(tenantA);
    expect((await introspect(aliceToken)).body.selectedTenantId).toBe(tenantA);
  });
  it("rejects cross-tenant writes and serializes competing last-admin removals", async () => {
    const write = () =>
      request(app)
        .put(`/api/directory/tenants/${tenantA}/memberships/${aliceId}`)
        .set(auth(aliceToken))
        .send({ role: "USER", bEnabled: true });
    const results = await Promise.all([write(), write()]);
    expect(results.map((r) => r.status)).toEqual([409, 409]);
    expect(
      (
        await request(app)
          .put(`/api/directory/tenants/${tenantB}/memberships/${aliceId}`)
          .set(auth(aliceToken))
          .send({ role: "TENANT_ADMIN", bEnabled: true })
      ).status,
    ).toBe(403);
  });
  it("observes disablement immediately and exposes only runtime enablement to services", async () => {
    expect(
      (
        await request(app)
          .patch(`/api/directory/tenants/${tenantA}`)
          .set(auth(aliceToken))
          .send({ bEnabled: false })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch(`/api/directory/tenants/${tenantA}`)
          .set(auth(rootToken))
          .send({ bEnabled: false })
      ).status,
    ).toBe(200);
    const res = await introspect(aliceToken);
    expect(res.body.tenants).toEqual([]);
    expect(res.body.selectedTenantId).toBeNull();
    const runtime = await request(app)
      .get(`/api/runtime/tenants/${tenantA}`)
      .set("X-Test-Server", "trusted");
    expect(runtime.body).toEqual({ iTenantId: tenantA, bEnabled: false });
  });
  it("revokes centrally, including revoke-all, without consumer session state", async () => {
    expect(
      (
        await request(app)
          .post("/api/sessions/revoke")
          .set("X-Test-Server", "trusted")
          .send({ token: aliceToken })
      ).body,
    ).toEqual({ revoked: true });
    expect((await introspect(aliceToken)).body).toEqual({ active: false });
    await store.revokeAllSessions(pool, bobId);
    expect((await introspect(bobToken)).body).toEqual({ active: false });
  });
  it("rejects unsafe IDs and invalid membership roles", async () => {
    expect(
      (
        await request(app)
          .get("/api/runtime/tenants/9007199254740993")
          .set("X-Test-Server", "trusted")
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .put(`/api/directory/tenants/${tenantA}/memberships/${aliceId}`)
          .set(auth(rootToken))
          .send({ role: "INVALID_ROLE", bEnabled: true })
      ).status,
    ).toBe(400);
  });
  it("records directory changes with actor and tenant in the same database", async () => {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT iActorUserId,iTenantId,action FROM identity_tbl_Audit ORDER BY iAuditId`,
    );
    expect(
      rows.some(
        (r) =>
          r.iActorUserId === rootId &&
          r.iTenantId === tenantA &&
          r.action === "tenant.updated",
      ),
    ).toBe(true);
    expect(await runMigrations(pool)).toEqual([]);
  });
  it("rejects conflicting directory idempotency keys without creating extra users", async () => {
    const ensured = await store.ensureDirectoryUser(pool, {
      email: "new@x.tld",
      displayName: "New",
      idempotencyKey: "integration",
      actorUserId: rootId,
    });
    const calls = await Promise.allSettled([
      store.ensureDirectoryUser(pool, {
        email: "new@x.tld",
        displayName: "New",
        idempotencyKey: "integration",
      }),
      store.ensureDirectoryUser(pool, {
        email: "other@x.tld",
        displayName: "Other",
        idempotencyKey: "integration",
      }),
    ]);
    expect(calls[0].status).toBe("fulfilled");
    expect(calls[1].status).toBe("rejected");
    expect(
      (calls[0] as PromiseFulfilledResult<store.DirectoryUser>).value.iUserId,
    ).toBe(ensured.iUserId);
    expect(await store.findUserByEmail(pool, "other@x.tld")).toBeNull();
  });
});
