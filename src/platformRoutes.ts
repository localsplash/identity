import express from "express";
import mysql from "mysql2/promise";
import { z } from "zod";
import * as platform from "./platform";
import * as store from "./store";
import { manageMember } from "./memberManagement";

type Trust = (req: express.Request, res: express.Response) => Promise<unknown>;
const tenantInput = z
  .object({
    name: z.string().trim().min(1).max(255),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(100),
  })
  .strict();
const tokenInput = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/) });
export function installPlatformRoutes(
  app: express.Express,
  db: mysql.Pool,
  trust: Trust,
) {
  const router = express.Router();
  router.use(
    ["/sessions", "/runtime", "/directory"],
    async (req, res, next) => {
      try {
        if (await trust(req, res)) {
          res.set("Cache-Control", "no-store");
          next();
        }
      } catch (e) {
        next(e);
      }
    },
  );
  const route =
    (
      fn: (req: express.Request, res: express.Response) => Promise<unknown>,
    ): express.RequestHandler =>
    async (req, res, next) => {
      try {
        await fn(req, res);
      } catch (e) {
        if (e instanceof platform.PlatformError)
          res.status(e.status).json({ error: e.message });
        else if (e instanceof store.DirectoryConflictError)
          res.status(409).json({ error: e.message });
        else if (e instanceof z.ZodError)
          res.status(400).json({ error: "Invalid request", details: e.issues });
        else if ((e as { code?: string }).code === "ER_DUP_ENTRY")
          res.status(409).json({ error: "Record already exists" });
        else if ((e as { code?: string }).code === "ER_NO_REFERENCED_ROW_2")
          res
            .status(404)
            .json({ error: "Referenced user or tenant not found" });
        else next(e);
      }
    };
  async function tokenSession(token: string) {
    const actor = await platform.getAppSession(db, token);
    if (!actor)
      throw new platform.PlatformError(
        401,
        "Invalid or revoked application session",
      );
    return actor;
  }
  async function actor(req: express.Request) {
    const token = /^Bearer ([0-9a-f]{64})$/.exec(
      req.get("Authorization") ?? "",
    )?.[1];
    if (!token)
      throw new platform.PlatformError(
        401,
        "Application session bearer token required",
      );
    return tokenSession(token);
  }
  function superAdmin(session: platform.AppSession) {
    if (!session.bSuperAdmin)
      throw new platform.PlatformError(403, "Super administrator required");
  }
  router.post(
    "/sessions/introspect",
    route(async (req, res) => {
      const { token } = tokenInput.parse(req.body);
      const session = await platform.getAppSession(db, token);
      if (!session) return res.json({ active: false });
      const user = await store.getUser(db, session.iUserId);
      if (!user) return res.json({ active: false });
      const tenants = await platform.listTenants(db, session);
      const selectedTenantId =
        tenants.find(
          (t) => t.bEnabled && t.iTenantId === session.iSelectedTenantId,
        )?.iTenantId ?? null;
      res.json({
        active: true,
        user: {
          iUserId: platform.safeId(user.iUserId),
          email: user.email,
          displayName: user.displayName,
          superAdmin: session.bSuperAdmin,
        },
        tenants,
        selectedTenantId,
      });
    }),
  );
  router.post(
    "/sessions/revoke",
    route(async (req, res) => {
      const { token } = tokenInput.parse(req.body);
      await platform.revokeAppSession(db, token);
      res.json({ revoked: true });
    }),
  );
  router.post(
    "/sessions/select-tenant",
    route(async (req, res) => {
      const body = tokenInput
        .extend({
          iTenantId: z
            .number()
            .int()
            .positive()
            .max(Number.MAX_SAFE_INTEGER)
            .nullable(),
        })
        .parse(req.body);
      const session = await tokenSession(body.token);
      if (
        body.iTenantId !== null &&
        !(await platform.listTenants(db, session)).some(
          (t) => t.bEnabled && t.iTenantId === body.iTenantId,
        )
      ) {
        throw new platform.PlatformError(
          403,
          "Tenant is not available to this session",
        );
      }
      await db.query(
        `UPDATE identity_tbl_Session SET iSelectedTenantId = ? WHERE sSessionId = ? AND dtRevoked IS NULL`,
        [body.iTenantId, session.sSessionId],
      );
      res.json({ selectedTenantId: body.iTenantId });
    }),
  );
  router.get(
    "/runtime/tenants/:id",
    route(async (req, res) => {
      const id = platform.safeId(req.params.id);
      const [rows] = await db.query<mysql.RowDataPacket[]>(
        `SELECT iTenantId,bEnabled FROM identity_tbl_Tenant WHERE iTenantId = ?`,
        [id],
      );
      if (!rows.length)
        throw new platform.PlatformError(404, "Tenant not found");
      res.json({
        iTenantId: platform.safeId(rows[0].iTenantId),
        bEnabled: Boolean(rows[0].bEnabled),
      });
    }),
  );
  router.get(
    "/directory/tenants",
    route(async (req, res) => {
      res.json({ tenants: await platform.listTenants(db, await actor(req)) });
    }),
  );
  router.post(
    "/directory/tenants",
    route(async (req, res) => {
      const session = await actor(req);
      superAdmin(session);
      const body = tenantInput.parse(req.body);
      const id = await platform.createTenant(db, session, body.name, body.slug);
      res
        .status(201)
        .json({ iTenantId: id, ...body, bEnabled: true, role: "SUPER_ADMIN" });
    }),
  );
  router.patch(
    "/directory/tenants/:id",
    route(async (req, res) => {
      const session = await actor(req),
        id = platform.safeId(req.params.id);
      await platform.requireTenantAdmin(db, session, id);
      const body = tenantInput
        .partial()
        .extend({ bEnabled: z.boolean().optional() })
        .strict()
        .parse(req.body);
      if (!Object.keys(body).length)
        throw new platform.PlatformError(400, "No changes supplied");
      if (body.bEnabled !== undefined && body.bEnabled !== true)
        superAdmin(session);
      // Ordinary administrators only reach enabled tenants; true is a permitted no-op.
      await platform.updateTenant(db, session, id, body);
      res.json(
        (await platform.listTenants(db, session)).find(
          (t) => t.iTenantId === id,
        ),
      );
    }),
  );
  router.get(
    "/directory/tenants/:id/memberships",
    route(async (req, res) => {
      const session = await actor(req),
        id = platform.safeId(req.params.id);
      await platform.requireTenantAdmin(db, session, id);
      res.json({ memberships: await platform.listMemberships(db, id) });
    }),
  );
  router.put(
    "/directory/tenants/:id/memberships/:userId",
    route(async (req, res) => {
      const session = await actor(req),
        id = platform.safeId(req.params.id),
        userId = platform.safeId(req.params.userId);
      const body = z
        .object({
          role: z.enum(["SUPER_ADMIN", "TENANT_ADMIN", "USER"]),
          bEnabled: z.boolean(),
          displayName: z.string().trim().max(255).nullable().optional(),
          email: z.email().max(255).optional(),
        })
        .strict()
        .parse(req.body);
      await manageMember(db, session, id, userId, body);
      res.json(
        (await platform.listMemberships(db, id)).find(
          (m) => m.iUserId === userId,
        ),
      );
    }),
  );
  router.post(
    "/directory/tenants/:id/users",
    route(async (req, res) => {
      const session = await actor(req),
        id = platform.safeId(req.params.id);
      await platform.requireTenantAdmin(db, session, id);
      const body = z
        .object({
          email: z.email().max(255),
          displayName: z.string().trim().max(255).nullable(),
          role: z.enum(["SUPER_ADMIN", "TENANT_ADMIN", "USER"]),
          bEnabled: z.boolean(),
        })
        .strict()
        .parse(req.body);
      if (body.role === "SUPER_ADMIN") superAdmin(session);
      const user = await store.ensureDirectoryUser(db, {
        email: body.email,
        displayName: body.displayName,
        idempotencyKey: null,
        actorUserId: session.iUserId,
      });
      await manageMember(db, session, id, user.iUserId, {
        role: body.role,
        bEnabled: body.bEnabled,
      });
      res
        .status(201)
        .json(
          (await platform.listMemberships(db, id)).find(
            (m) => m.iUserId === user.iUserId,
          ),
        );
    }),
  );
  router.patch(
    "/directory/users/:id",
    route(async (req, res) => {
      const session = await actor(req);
      superAdmin(session);
      const id = platform.safeId(req.params.id);
      const body = z
        .object({ displayName: z.string().trim().max(255).nullable() })
        .strict()
        .parse(req.body);
      if (!(await store.getDirectoryUser(db, id)))
        throw new platform.PlatformError(404, "User not found");
      await platform.transaction(db, async (conn) => {
        await conn.query(
          `UPDATE identity_tbl_User SET displayName = ? WHERE iUserId = ?`,
          [body.displayName, id],
        );
        await platform.audit(conn, session, null, "user.updated", {
          iUserId: id,
          ...body,
        });
      });
      res.json(await store.getDirectoryUser(db, id));
    }),
  );
  // Existing global directory handlers follow this router, with the same actor rule.
  router.use("/directory/users", async (req, res, next) => {
    try {
      const session = await actor(req);
      superAdmin(session);
      res.locals.platformActor = session;
      next();
    } catch (e) {
      if (e instanceof platform.PlatformError)
        res.status(e.status).json({ error: e.message });
      else next(e);
    }
  });
  app.use("/api", router);
}
