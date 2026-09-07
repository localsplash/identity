import mysql from "mysql2/promise";
import { z } from "zod";
import {
  audit,
  getAppSession,
  listTenants,
  PlatformError,
  safeId,
  type AppSession,
} from "./platform";

export const phoneNumberInput = z
  .object({
    phoneNumber: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{7,14}$/, "Use an E.164 number, such as +17145550100"),
    label: z.string().trim().max(100).default(""),
    bVoice: z.literal(true).default(true),
    bMessaging: z.literal(true).default(true),
    bEnabled: z.boolean(),
    accessPolicy: z.literal("TENANT_MEMBERS"),
  })
  .strict()
  .refine((v) => !v.bMessaging || /^\+1[2-9]\d{9}$/.test(v.phoneNumber), {
    message: "Echo currently supports +1 ten-digit messaging numbers",
    path: ["phoneNumber"],
  });
export type PhoneNumberInput = z.infer<typeof phoneNumberInput>;
export interface PhoneNumber extends PhoneNumberInput {
  iPhoneNumberId: number;
  iTenantId: number;
  iVersion: number;
}
const rowView = (r: mysql.RowDataPacket): PhoneNumber => ({
  iPhoneNumberId: safeId(r.iPhoneNumberId),
  iTenantId: safeId(r.iTenantId),
  phoneNumber: r.phoneNumber,
  label: r.label,
  bVoice: true,
  bMessaging: true,
  bEnabled: Boolean(r.bEnabled),
  accessPolicy: r.accessPolicy,
  iVersion: Number(r.iVersion),
});

/** One shared tenant-to-number mapping. All enabled tenant members inherit access explicitly. */
export async function listPhoneNumbers(
  pool: mysql.Pool,
  actor: AppSession,
  tenantId?: number,
): Promise<PhoneNumber[]> {
  const tenants = await listTenants(pool, actor);
  const allowed = tenants.filter(
    (t) => t.bEnabled && (tenantId === undefined || t.iTenantId === tenantId),
  );
  if (tenantId !== undefined && !tenants.some((t) => t.iTenantId === tenantId))
    throw new PlatformError(403, "Tenant is not available to this session");
  if (!allowed.length) return [];
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM identity_tbl_PhoneNumber WHERE iTenantId IN (?) ORDER BY iTenantId,phoneNumber",
    [allowed.map((t) => t.iTenantId)],
  );
  return rows.map(rowView);
}

export async function savePhoneNumber(
  pool: mysql.Pool,
  token: string,
  tenantId: number,
  numberId: number | null,
  input: PhoneNumberInput,
  expectedVersion?: number,
): Promise<PhoneNumber> {
  const conn = await pool.getConnection();
  let locked = false;
  try {
    // Serialize writes with live actor revalidation; never authorize from client role fields.
    const [locks] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT GET_LOCK('identity_phone_number_write',10) AS acquired",
    );
    if (Number(locks[0]?.acquired) !== 1)
      throw new PlatformError(503, "Number management is busy; retry");
    locked = true;
    const actor = await getAppSession(pool, token);
    if (!actor) throw new PlatformError(401, "Session is no longer active");
    await conn.beginTransaction();
    // Lock the membership and tenant rows used for authorization until commit.
    const [tenants] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT bEnabled FROM identity_tbl_Tenant WHERE iTenantId=? FOR UPDATE",
      [tenantId],
    );
    const [members] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT role,bEnabled FROM identity_tbl_Membership WHERE iTenantId=? AND iUserId=? FOR UPDATE",
      [tenantId, actor.iUserId],
    );
    const [actors] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT COALESCE(u.bSuperAdminOverride,s.bSuperAdmin) AS superAdmin FROM identity_tbl_Session s JOIN identity_tbl_User u ON u.iUserId=s.iUserId WHERE s.sSessionId=? AND s.dtRevoked IS NULL FOR UPDATE",
      [actor.sSessionId],
    );
    if (!actors.length)
      throw new PlatformError(401, "Session is no longer active");
    if (
      !tenants[0]?.bEnabled ||
      (!actors[0].superAdmin &&
        !(members[0]?.bEnabled && members[0]?.role === "TENANT_ADMIN"))
    )
      throw new PlatformError(403, "Tenant administrator required");
    let id = numberId;
    if (id === null) {
      const [created] = await conn.query<mysql.ResultSetHeader>(
        "INSERT INTO identity_tbl_PhoneNumber (iTenantId,phoneNumber,label,bVoice,bMessaging,bEnabled,accessPolicy) VALUES (?,?,?,?,?,?,?)",
        [
          tenantId,
          input.phoneNumber,
          input.label,
          input.bVoice,
          input.bMessaging,
          input.bEnabled,
          input.accessPolicy,
        ],
      );
      id = safeId(created.insertId);
    } else {
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        "SELECT * FROM identity_tbl_PhoneNumber WHERE iPhoneNumberId=? AND iTenantId=? FOR UPDATE",
        [id, tenantId],
      );
      if (!rows.length) throw new PlatformError(404, "Phone number not found");
      if (rows[0].phoneNumber !== input.phoneNumber)
        throw new PlatformError(
          409,
          "Phone numbers cannot be reassigned; add a new number instead",
        );
      if (Number(rows[0].iVersion) !== expectedVersion)
        throw new PlatformError(
          409,
          "Phone number changed; reload before saving",
        );
      await conn.query(
        "UPDATE identity_tbl_PhoneNumber SET label=?,bVoice=?,bMessaging=?,bEnabled=?,accessPolicy=?,iVersion=iVersion+1 WHERE iPhoneNumberId=?",
        [
          input.label,
          input.bVoice,
          input.bMessaging,
          input.bEnabled,
          input.accessPolicy,
          id,
        ],
      );
    }
    await audit(
      conn,
      actor,
      tenantId,
      numberId === null ? "phone_number.created" : "phone_number.updated",
      { iPhoneNumberId: id, ...input },
    );
    const [result] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT * FROM identity_tbl_PhoneNumber WHERE iPhoneNumberId=?",
      [id],
    );
    await conn.commit();
    return rowView(result[0]);
  } catch (e) {
    await conn.rollback();
    if ((e as { code?: string }).code === "ER_DUP_ENTRY")
      throw new PlatformError(
        409,
        "Phone number is already assigned to a tenant",
      );
    throw e;
  } finally {
    if (locked)
      await conn.query("SELECT RELEASE_LOCK('identity_phone_number_write')");
    conn.release();
  }
}
