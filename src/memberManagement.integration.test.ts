import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import mysql from "mysql2/promise";
import { runMigrations } from "./migrations";
import * as store from "./store";
import * as platform from "./platform";
import { manageMember, removeMember } from "./memberManagement";

const url = process.env.TEST_DB_URL;
describe.skipIf(!url)("central role hierarchy on MySQL", () => {
  let admin: mysql.Connection, pool: mysql.Pool;
  let root: number,
    tenantAdmin: number,
    user: number,
    other: number,
    a: number,
    b: number;
  let rootActor: platform.AppSession,
    adminActor: platform.AppSession,
    userActor: platform.AppSession;
  let userToken: string;
  const db = "identity_member_management_test";
  async function session(id: number, superAdmin = false) {
    const token = await platform.createAppSession(
      pool,
      {
        iUserId: id,
        bSuperAdmin: superAdmin,
        sProvider: "google",
        sSubject: String(id),
      },
      "https://aida-admin.test",
    );
    return { token, actor: (await platform.getAppSession(pool, token))! };
  }
  beforeAll(async () => {
    const u = new URL(url!);
    u.pathname = "/";
    admin = await mysql.createConnection(u.toString());
  });
  beforeEach(async () => {
    if (pool) await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${db}`);
    await admin.query(`CREATE DATABASE ${db}`);
    const u = new URL(url!);
    u.pathname = "/" + db;
    pool = mysql.createPool(u.toString());
    await runMigrations(pool);
    root = await store.createUser(pool, "root@example.test", "Root");
    tenantAdmin = await store.createUser(pool, "admin@example.test", "Admin");
    user = await store.createUser(pool, "user@example.test", "User");
    other = await store.createUser(pool, "other@example.test", "Other");
    rootActor = (await session(root, true)).actor;
    adminActor = (await session(tenantAdmin)).actor;
    const uSession = await session(user);
    userActor = uSession.actor;
    userToken = uSession.token;
    a = await platform.createTenant(pool, rootActor, "A", "a");
    b = await platform.createTenant(pool, rootActor, "B", "b");
    await platform.setMembership(
      pool,
      rootActor,
      a,
      tenantAdmin,
      "TENANT_ADMIN",
      true,
    );
    await platform.setMembership(pool, rootActor, a, user, "USER", true);
    await platform.setMembership(
      pool,
      rootActor,
      b,
      other,
      "TENANT_ADMIN",
      true,
    );
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${db}`);
    await admin?.end();
  });
  it("Super Admin can grant and remove global access; existing sessions reflect both changes", async () => {
    await manageMember(pool, rootActor, a, user, {
      role: "SUPER_ADMIN",
      bEnabled: true,
    });
    expect((await platform.getAppSession(pool, userToken))!.bSuperAdmin).toBe(
      true,
    );
    expect(
      (await platform.listMemberships(pool, a)).find((m) => m.iUserId === user)!
        .role,
    ).toBe("SUPER_ADMIN");
    await expect(
      manageMember(pool, adminActor, a, user, { role: "USER", bEnabled: true }),
    ).rejects.toMatchObject({ status: 403 });
    await manageMember(pool, rootActor, a, user, {
      role: "USER",
      bEnabled: true,
    });
    expect((await platform.getAppSession(pool, userToken))!.bSuperAdmin).toBe(
      false,
    );
  });
  it("Tenant Admin assigns both tenant roles, but cannot grant global access or change another tenant", async () => {
    await manageMember(pool, adminActor, a, user, {
      role: "TENANT_ADMIN",
      bEnabled: true,
    });
    await manageMember(pool, adminActor, a, user, {
      role: "USER",
      bEnabled: true,
    });
    await expect(
      manageMember(pool, adminActor, a, user, {
        role: "SUPER_ADMIN",
        bEnabled: true,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      manageMember(pool, adminActor, b, other, {
        role: "USER",
        bEnabled: true,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      manageMember(pool, userActor, a, user, {
        role: "TENANT_ADMIN",
        bEnabled: true,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("preserves the last global administrator and last tenant administrator", async () => {
    await expect(
      manageMember(pool, rootActor, a, root, { role: "USER", bEnabled: true }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      manageMember(pool, adminActor, a, tenantAdmin, {
        role: "USER",
        bEnabled: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("edits an unclaimed member profile and rejects claimed email changes atomically", async () => {
    await manageMember(pool, adminActor, a, user, {
      role: "USER",
      bEnabled: true,
      email: "new@example.test",
      displayName: "New Name",
    });
    expect(await store.getUser(pool, user)).toMatchObject({
      email: "new@example.test",
      displayName: "New Name",
    });
    await store.ensureIdentity(
      pool,
      user,
      "google",
      "verified-user",
      "new@example.test",
    );
    await expect(
      manageMember(pool, rootActor, a, user, {
        role: "SUPER_ADMIN",
        bEnabled: true,
        email: "changed@example.test",
        displayName: "Wrong",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await platform.getAppSession(pool, userToken))!.bSuperAdmin).toBe(
      false,
    );
    expect((await store.getUser(pool, user))!.displayName).toBe("New Name");
  });
  it("rechecks a revoked actor inside the mutation and rejects guessed-user profile edits", async () => {
    await pool.query(
      "UPDATE identity_tbl_Session SET dtRevoked=NOW() WHERE sSessionId=?",
      [rootActor.sSessionId],
    );
    await expect(
      manageMember(pool, rootActor, a, user, {
        role: "SUPER_ADMIN",
        bEnabled: true,
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      manageMember(pool, adminActor, a, other, {
        role: "USER",
        bEnabled: true,
        displayName: "Attacker edit",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("keeps one user per email and lets a proven sign-in claim an invitation", async () => {
    await expect(
      store.createUser(pool, "user@example.test", "Second"),
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    // Signed in first with an unproven address: no email on the user.
    const signedIn = await store.createUser(pool, null, "Signed In");
    await store.ensureIdentity(
      pool,
      signedIn,
      "microsoft",
      "work",
      "late@example.test",
    );
    const invite = await store.ensureDirectoryUser(pool, {
      email: "late@example.test",
      displayName: null,
      idempotencyKey: null,
    });
    expect(invite.iUserId).not.toBe(signedIn);
    await platform.setMembership(
      pool,
      rootActor,
      a,
      invite.iUserId,
      "USER",
      true,
    );
    // Later proves the address (e.g. links Google): the invitation folds in.
    expect(await store.claimEmail(pool, signedIn, "late@example.test")).toBe(
      invite.iUserId,
    );
    expect(await store.getUser(pool, invite.iUserId)).toBeNull();
    expect((await store.getUser(pool, signedIn))!.email).toBe(
      "late@example.test",
    );
    expect(
      (await platform.listMemberships(pool, a)).some(
        (m) => m.iUserId === signedIn,
      ),
    ).toBe(true);
  });
  it("refuses to add someone already in the tenant, with a message that says so", async () => {
    await expect(
      manageMember(
        pool,
        adminActor,
        a,
        user,
        { role: "USER", bEnabled: true },
        { newMember: true },
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(
        "user@example.test is already in this tenant as User",
      ),
    });
    // The last-admin rule is about removing an admin, never about adding.
    await expect(
      manageMember(
        pool,
        adminActor,
        a,
        tenantAdmin,
        { role: "USER", bEnabled: true },
        { newMember: true },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("already in this tenant"),
    });
  });
  it("Super Admins may leave a tenant without a Tenant Admin; Tenant Admins may not", async () => {
    await expect(
      removeMember(pool, adminActor, a, tenantAdmin),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("only Tenant Admin"),
    });
    await manageMember(pool, rootActor, a, tenantAdmin, {
      role: "USER",
      bEnabled: true,
    });
  });
  it("removes members, deleting users who were only an invitation", async () => {
    const invite = await store.ensureDirectoryUser(pool, {
      email: "invite@example.test",
      displayName: null,
      idempotencyKey: null,
    });
    await manageMember(
      pool,
      adminActor,
      a,
      invite.iUserId,
      { role: "USER", bEnabled: true },
      { newMember: true },
    );
    expect(await removeMember(pool, adminActor, a, invite.iUserId)).toEqual({
      userDeleted: true,
    });
    expect(await store.getUser(pool, invite.iUserId)).toBeNull();
    await store.ensureIdentity(
      pool,
      user,
      "google",
      "user-google",
      "user@example.test",
    );
    expect(await removeMember(pool, adminActor, a, user)).toEqual({
      userDeleted: false,
    });
    expect(await store.getUser(pool, user)).not.toBeNull();
    await expect(removeMember(pool, adminActor, a, user)).rejects.toMatchObject(
      {
        status: 404,
      },
    );
  });
  it("editing an invitation's email to someone else's address hands the access to them", async () => {
    const person = await store.createUser(
      pool,
      "person@example.test",
      "Person",
    );
    await store.ensureIdentity(
      pool,
      person,
      "google",
      "person",
      "person@example.test",
    );
    const result = await manageMember(pool, adminActor, a, user, {
      role: "TENANT_ADMIN",
      bEnabled: true,
      email: "person@example.test",
    });
    expect(result).toEqual({ iUserId: person, mergedFromUserId: user });
    expect(await store.getUser(pool, user)).toBeNull();
    expect(
      (await platform.listMemberships(pool, a)).find(
        (m) => m.iUserId === person,
      )!.membershipRole,
    ).toBe("TENANT_ADMIN");
    await expect(
      manageMember(pool, adminActor, a, person, {
        role: "USER",
        bEnabled: true,
        email: "admin@example.test",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("repairs an unclaimed duplicate while preserving the Google login and tenant role", async () => {
    const imported = await store.createUser(pool, null, "Imported");
    await store.ensureIdentity(
      pool,
      imported,
      "google",
      "imported-login",
      "duplicate@example.test",
    );
    const existing = await session(imported);
    const pending = await store.createUser(
      pool,
      "duplicate@example.test",
      "Pending",
    );
    await platform.setMembership(
      pool,
      rootActor,
      a,
      pending,
      "TENANT_ADMIN",
      true,
    );
    await store.mergeUsers(pool, pending, imported);
    expect(await store.getUser(pool, pending)).toBeNull();
    expect((await store.getUser(pool, imported))!.email).toBe(
      "duplicate@example.test",
    );
    expect((await platform.getAppSession(pool, existing.token))!.iUserId).toBe(
      imported,
    );
    expect(
      (await platform.listMemberships(pool, a)).find(
        (m) => m.iUserId === imported,
      )!.role,
    ).toBe("TENANT_ADMIN");
  });
});
