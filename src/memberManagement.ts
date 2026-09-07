import mysql from "mysql2/promise";
import {
  audit,
  PlatformError,
  type AppSession,
  type MembershipRole,
} from "./platform";

export interface MemberInput {
  role: MembershipRole | "SUPER_ADMIN";
  bEnabled: boolean;
  displayName?: string | null;
  email?: string;
}

/** Role/profile changes share a transaction and recheck the actor after acquiring the lock. */
export async function manageMember(
  pool: mysql.Pool,
  actor: AppSession,
  tenantId: number,
  userId: number,
  input: MemberInput,
) {
  const conn = await pool.getConnection();
  let locked = false;
  try {
    const [lock] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT GET_LOCK('identity_member_management',10) AS acquired",
    );
    if (Number(lock[0]?.acquired) !== 1)
      throw new PlatformError(503, "Role management is busy; retry");
    locked = true;
    await conn.beginTransaction();
    const [actors] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT COALESCE(u.bSuperAdminOverride,s.bSuperAdmin) AS superAdmin
      FROM identity_tbl_Session s JOIN identity_tbl_User u ON u.iUserId=s.iUserId
      WHERE s.sSessionId=? AND s.dtRevoked IS NULL AND s.iUserId=?`,
      [actor.sSessionId, actor.iUserId],
    );
    if (!actors.length)
      throw new PlatformError(401, "Session is no longer active");
    const isSuper = Boolean(actors[0].superAdmin);
    const [tenants] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT bEnabled FROM identity_tbl_Tenant WHERE iTenantId=? FOR UPDATE",
      [tenantId],
    );
    const [members] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT iUserId,role,bEnabled FROM identity_tbl_Membership WHERE iTenantId=? FOR UPDATE",
      [tenantId],
    );
    if (
      !isSuper &&
      (!tenants[0]?.bEnabled ||
        !members.some(
          (m) =>
            Number(m.iUserId) === actor.iUserId &&
            m.role === "TENANT_ADMIN" &&
            m.bEnabled,
        ))
    ) {
      throw new PlatformError(403, "Tenant administrator required");
    }
    if (!tenants.length) throw new PlatformError(404, "Tenant not found");
    const [users] = await conn.query<
      mysql.RowDataPacket[]
    >(`SELECT u.iUserId,u.email,u.bSuperAdminOverride,
      COALESCE(u.bSuperAdminOverride,EXISTS(SELECT 1 FROM identity_tbl_Session s WHERE s.iUserId=u.iUserId AND s.bSuperAdmin=1 AND s.dtRevoked IS NULL)) AS superAdmin,
      EXISTS(SELECT 1 FROM identity_tbl_Identity i WHERE i.iUserId=u.iUserId) AS claimed
      FROM identity_tbl_User u FOR UPDATE`);
    const target = users.find((u) => Number(u.iUserId) === userId);
    if (!target) throw new PlatformError(404, "User not found");
    if (!isSuper && (input.role === "SUPER_ADMIN" || target.superAdmin))
      throw new PlatformError(
        403,
        "Only a Super Admin can change Super Admin access",
      );
    if (input.role === "SUPER_ADMIN" && !input.bEnabled)
      throw new PlatformError(
        400,
        "Choose a tenant role before disabling tenant membership",
      );
    if (
      isSuper &&
      target.superAdmin &&
      input.role !== "SUPER_ADMIN" &&
      users.filter((u) => u.superAdmin).length === 1
    ) {
      throw new PlatformError(
        409,
        "Assign another Super Admin before removing the last Super Admin",
      );
    }
    const memberRole =
      input.role === "SUPER_ADMIN" ? "TENANT_ADMIN" : input.role;
    const admins = members.filter(
      (m) => m.role === "TENANT_ADMIN" && m.bEnabled,
    );
    if (
      admins.length === 1 &&
      Number(admins[0].iUserId) === userId &&
      (memberRole !== "TENANT_ADMIN" || !input.bEnabled)
    ) {
      throw new PlatformError(
        409,
        "Assign another Tenant Admin before removing the last Tenant Admin",
      );
    }
    // Tenant admins can edit current members, not mutate a stranger's global profile by guessed ID.
    if (
      !isSuper &&
      !members.some((m) => Number(m.iUserId) === userId) &&
      (input.displayName !== undefined || input.email !== undefined)
    ) {
      throw new PlatformError(
        403,
        "Add this user to the tenant before editing their profile",
      );
    }
    if (input.email !== undefined) {
      const email = input.email.trim().toLowerCase();
      if (email !== String(target.email ?? "").toLowerCase()) {
        if (target.claimed)
          throw new PlatformError(
            409,
            "A linked sign-in email cannot be changed here",
          );
        const [duplicates] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT u.iUserId FROM identity_tbl_User u WHERE u.iUserId<>? AND
          (u.email=? OR EXISTS(SELECT 1 FROM identity_tbl_Identity i WHERE i.iUserId=u.iUserId AND i.provider='google' AND i.email=?)) LIMIT 1`,
          [userId, email, email],
        );
        if (duplicates.length)
          throw new PlatformError(
            409,
            "Another account already uses this email",
          );
        await conn.query(
          "UPDATE identity_tbl_User SET email=? WHERE iUserId=?",
          [email, userId],
        );
      }
    }
    if (input.displayName !== undefined)
      await conn.query(
        "UPDATE identity_tbl_User SET displayName=? WHERE iUserId=?",
        [input.displayName, userId],
      );
    if (isSuper && (input.role === "SUPER_ADMIN" || target.superAdmin)) {
      await conn.query(
        "UPDATE identity_tbl_User SET bSuperAdminOverride=? WHERE iUserId=?",
        [input.role === "SUPER_ADMIN" ? 1 : 0, userId],
      );
    }
    await conn.query(
      `INSERT INTO identity_tbl_Membership (iTenantId,iUserId,role,bEnabled) VALUES (?,?,?,?)
      ON DUPLICATE KEY UPDATE role=VALUES(role),bEnabled=VALUES(bEnabled)`,
      [tenantId, userId, memberRole, input.bEnabled ? 1 : 0],
    );
    await audit(conn, actor, tenantId, "member.updated", {
      iUserId: userId,
      ...input,
    });
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    if (locked)
      await conn.query("SELECT RELEASE_LOCK('identity_member_management')");
    conn.release();
  }
}
