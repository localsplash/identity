import crypto from "crypto";
import mysql from "mysql2/promise";
import * as store from "./store";

export type MembershipRole = "TENANT_ADMIN" | "USER";
export interface Tenant {
  iTenantId: number;
  name: string;
  slug: string;
  role: MembershipRole | "SUPER_ADMIN";
  bEnabled: boolean;
}
export interface AppSession extends store.SessionRow {
  sAppOrigin: string;
  iSelectedTenantId: number | null;
}
export class PlatformError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function safeId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1)
    throw new PlatformError(400, "ID must be a positive safe integer");
  return id;
}
const tokenHash = (token: string) =>
  crypto.createHash("sha256").update(token).digest("hex");

/** SSO and application sessions share one authority and revoke-all operation.
 * App credentials are hashed at rest; they cannot be used as an Identity SSO cookie. */
export async function createAppSession(
  pool: mysql.Pool,
  auth: store.ConsumedAuthCode,
  origin: string,
): Promise<string> {
  const token = store.generateId(32);
  await pool.query(
    `INSERT INTO identity_tbl_Session
    (sSessionId, iUserId, bSuperAdmin, sProvider, sSubject, sAppOrigin)
    VALUES (?, ?, ?, ?, ?, ?)`,
    [
      tokenHash(token),
      auth.iUserId,
      auth.bSuperAdmin ? 1 : 0,
      auth.sProvider,
      auth.sSubject,
      origin,
    ],
  );
  return token;
}
export async function getAppSession(
  pool: mysql.Pool,
  token: string,
): Promise<AppSession | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT sSessionId, iUserId, bSuperAdmin,
    sProvider, sSubject, sAppOrigin, iSelectedTenantId, dtCreated FROM identity_tbl_Session
    WHERE sSessionId = ? AND dtRevoked IS NULL AND sAppOrigin IS NOT NULL`,
    [tokenHash(token)],
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    sSessionId: row.sSessionId,
    iUserId: safeId(row.iUserId),
    bSuperAdmin: Boolean(row.bSuperAdmin),
    sProvider: row.sProvider,
    sSubject: row.sSubject,
    sAppOrigin: row.sAppOrigin,
    iSelectedTenantId:
      row.iSelectedTenantId == null ? null : safeId(row.iSelectedTenantId),
    dtCreated: new Date(row.dtCreated),
  };
}
export async function revokeAppSession(
  pool: mysql.Pool,
  token: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(token)) return;
  await pool.query(
    `UPDATE identity_tbl_Session SET dtRevoked = NOW(3)
    WHERE sSessionId = ? AND sAppOrigin IS NOT NULL AND dtRevoked IS NULL`,
    [tokenHash(token)],
  );
}
export async function listTenants(
  pool: mysql.Pool,
  actor: AppSession,
): Promise<Tenant[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    actor.bSuperAdmin
      ? `SELECT iTenantId, name, slug, bEnabled, 'SUPER_ADMIN' AS role FROM identity_tbl_Tenant ORDER BY iTenantId`
      : `SELECT t.iTenantId, t.name, t.slug, t.bEnabled, m.role FROM identity_tbl_Tenant t
       JOIN identity_tbl_Membership m ON m.iTenantId = t.iTenantId
       WHERE m.iUserId = ? AND m.bEnabled = 1 AND t.bEnabled = 1 ORDER BY t.iTenantId`,
    actor.bSuperAdmin ? [] : [actor.iUserId],
  );
  return rows.map((r) => ({
    iTenantId: safeId(r.iTenantId),
    name: r.name,
    slug: r.slug,
    role: r.role,
    bEnabled: Boolean(r.bEnabled),
  }));
}
export async function requireTenantAdmin(
  pool: mysql.Pool,
  actor: AppSession,
  id: number,
): Promise<void> {
  const tenant = (await listTenants(pool, actor)).find(
    (t) => t.iTenantId === id,
  );
  if (!tenant || (!actor.bSuperAdmin && tenant.role !== "TENANT_ADMIN"))
    throw new PlatformError(403, "Tenant administrator required");
}
export async function audit(
  conn: mysql.PoolConnection,
  actor: AppSession,
  tenantId: number | null,
  action: string,
  detail: unknown,
): Promise<void> {
  await conn.query(
    `INSERT INTO identity_tbl_Audit (iActorUserId,iTenantId,action,jDetail) VALUES (?,?,?,?)`,
    [actor.iUserId, tenantId, action, JSON.stringify(detail)],
  );
}
export async function transaction<T>(
  pool: mysql.Pool,
  fn: (conn: mysql.PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}
export async function createTenant(
  pool: mysql.Pool,
  actor: AppSession,
  name: string,
  slug: string,
): Promise<number> {
  return transaction(pool, async (conn) => {
    const [r] = await conn.query<mysql.ResultSetHeader>(
      `INSERT INTO identity_tbl_Tenant (name, slug) VALUES (?, ?)`,
      [name, slug],
    );
    const id = safeId(r.insertId);
    await audit(conn, actor, id, "tenant.created", { name, slug });
    return id;
  });
}
export async function updateTenant(
  pool: mysql.Pool,
  actor: AppSession,
  id: number,
  body: { name?: string; slug?: string; bEnabled?: boolean },
): Promise<void> {
  const pairs = Object.entries(body);
  await transaction(pool, async (conn) => {
    await conn.query(
      `UPDATE identity_tbl_Tenant SET ${pairs.map(([key]) => `\`${key}\` = ?`).join(", ")} WHERE iTenantId = ?`,
      [...pairs.map(([, v]) => v), id],
    );
    await audit(conn, actor, id, "tenant.updated", body);
  });
}
export async function listMemberships(pool: mysql.Pool, id: number) {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT m.iUserId, u.email, u.displayName, m.role, m.bEnabled
    FROM identity_tbl_Membership m JOIN identity_tbl_User u ON u.iUserId = m.iUserId WHERE m.iTenantId = ? ORDER BY m.iUserId`,
    [id],
  );
  return rows.map((r) => ({
    iUserId: safeId(r.iUserId),
    email: r.email,
    displayName: r.displayName,
    role: r.role as MembershipRole,
    bEnabled: Boolean(r.bEnabled),
  }));
}
/** Serialize changes per tenant and preserve its last enabled administrator. */
export async function setMembership(
  pool: mysql.Pool,
  actor: AppSession,
  tenantId: number,
  userId: number,
  role: MembershipRole,
  enabled: boolean,
): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [tenants] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT bEnabled FROM identity_tbl_Tenant WHERE iTenantId = ? FOR UPDATE`,
      [tenantId],
    );
    if (!tenants.length) throw new PlatformError(404, "Tenant not found");
    const [members] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT iUserId, role, bEnabled FROM identity_tbl_Membership WHERE iTenantId = ? FOR UPDATE`,
      [tenantId],
    );
    if (
      !actor.bSuperAdmin &&
      (!tenants[0].bEnabled ||
        !members.some(
          (m) =>
            Number(m.iUserId) === actor.iUserId &&
            m.role === "TENANT_ADMIN" &&
            m.bEnabled,
        ))
    ) {
      throw new PlatformError(403, "Tenant administrator required");
    }
    const admins = members.filter(
      (m) => m.role === "TENANT_ADMIN" && m.bEnabled,
    );
    if (
      admins.length === 1 &&
      Number(admins[0].iUserId) === userId &&
      (role !== "TENANT_ADMIN" || !enabled)
    ) {
      throw new PlatformError(
        409,
        "Assign another administrator before removing the last enabled administrator",
      );
    }
    await conn.query(
      `INSERT INTO identity_tbl_Membership (iTenantId, iUserId, role, bEnabled) VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE role = VALUES(role), bEnabled = VALUES(bEnabled)`,
      [tenantId, userId, role, enabled ? 1 : 0],
    );
    await audit(conn, actor, tenantId, "membership.updated", {
      iUserId: userId,
      role,
      bEnabled: enabled,
    });
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
