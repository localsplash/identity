import mysql from "mysql2/promise";
import {
  audit,
  PlatformError,
  type AppSession,
  type MembershipRole,
} from "./platform";
import { deleteUserIfUnused, foldUser, normalizeEmail } from "./store";

export interface MemberInput {
  role: MembershipRole | "SUPER_ADMIN";
  bEnabled: boolean;
  displayName?: string | null;
  email?: string;
}

export interface MemberResult {
  /** The member's user — a different one when an email edit folded the user into the address's owner. */
  iUserId: number;
  /** Set when the edited user was merged into the user who already owned the new email. */
  mergedFromUserId?: number;
}

interface Context {
  conn: mysql.PoolConnection;
  isSuper: boolean;
  members: mysql.RowDataPacket[];
  users: mysql.RowDataPacket[];
}

const LABEL: Record<string, string> = {
  TENANT_ADMIN: "Tenant Admin",
  USER: "User",
};

function nameOf(user: mysql.RowDataPacket | undefined): string {
  return String(user?.email || user?.displayName || `User ${user?.iUserId}`);
}

/**
 * Every membership change runs here: one lock, one transaction, and the
 * actor's rights rechecked after the lock so a revoked or demoted actor
 * cannot finish a change it started.
 */
async function withMemberLock<T>(
  pool: mysql.Pool,
  actor: AppSession,
  tenantId: number,
  fn: (ctx: Context) => Promise<T>,
): Promise<T> {
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
    >(`SELECT u.iUserId,u.email,u.displayName,u.bSuperAdminOverride,
      COALESCE(u.bSuperAdminOverride,EXISTS(SELECT 1 FROM identity_tbl_Session s WHERE s.iUserId=u.iUserId AND s.bSuperAdmin=1 AND s.dtRevoked IS NULL)) AS superAdmin,
      EXISTS(SELECT 1 FROM identity_tbl_SignIn i WHERE i.iUserId=u.iUserId) AS claimed
      FROM identity_tbl_User u FOR UPDATE`);
    const result = await fn({ conn, isSuper, members, users });
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    if (locked)
      await conn.query("SELECT RELEASE_LOCK('identity_member_management')");
    conn.release();
  }
}

/**
 * A Tenant Admin may not leave their tenant without an enabled Tenant Admin.
 * Super Admins manage every tenant, so the rule does not bind them.
 */
function guardLastAdmin(
  ctx: Context,
  userId: number,
  user: mysql.RowDataPacket | undefined,
) {
  if (ctx.isSuper) return;
  const admins = ctx.members.filter(
    (m) => m.role === "TENANT_ADMIN" && m.bEnabled,
  );
  if (admins.length === 1 && Number(admins[0].iUserId) === userId)
    throw new PlatformError(
      409,
      `${nameOf(user)} is this tenant's only Tenant Admin. Make someone else a Tenant Admin first.`,
    );
}

/** Role/profile changes share a transaction and recheck the actor after acquiring the lock. */
export async function manageMember(
  pool: mysql.Pool,
  actor: AppSession,
  tenantId: number,
  userId: number,
  input: MemberInput,
  options: { newMember?: boolean } = {},
): Promise<MemberResult> {
  return withMemberLock(pool, actor, tenantId, async (ctx) => {
    const { conn, isSuper, members, users } = ctx;
    const target = users.find((u) => Number(u.iUserId) === userId);
    if (!target) throw new PlatformError(404, "User not found");
    const current = members.find((m) => Number(m.iUserId) === userId);
    if (options.newMember && current)
      throw new PlatformError(
        409,
        `${nameOf(target)} is already in this tenant as ${
          target.superAdmin ? "Super Admin" : LABEL[current.role]
        }${current.bEnabled ? "" : " (disabled)"}. Use Edit to change their role or access.`,
      );
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
    if (memberRole !== "TENANT_ADMIN" || !input.bEnabled)
      guardLastAdmin(ctx, userId, target);
    // Tenant admins can edit current members, not mutate a stranger's global profile by guessed ID.
    if (
      !isSuper &&
      !current &&
      (input.displayName !== undefined || input.email !== undefined)
    ) {
      throw new PlatformError(
        403,
        "Add this user to the tenant before editing their profile",
      );
    }
    let memberId = userId;
    let mergedFromUserId: number | undefined;
    if (input.email !== undefined) {
      const email = normalizeEmail(input.email);
      if (email !== String(target.email ?? "").toLowerCase()) {
        if (target.claimed)
          throw new PlatformError(
            409,
            "This person has signed in, so their email comes from their sign-in and cannot be changed here",
          );
        const owner = users.find(
          (u) =>
            Number(u.iUserId) !== userId &&
            String(u.email ?? "").toLowerCase() === email,
        );
        if (owner) {
          // The address already belongs to someone (usually the person,
          // who signed in before being added). This entry was only an
          // invitation, so it becomes theirs instead of a second user.
          if (members.some((m) => Number(m.iUserId) === Number(owner.iUserId)))
            throw new PlatformError(
              409,
              `${email} is already in this tenant. Remove this entry instead.`,
            );
          await foldUser(conn, userId, Number(owner.iUserId), {
            combineMemberships: true,
          });
          memberId = Number(owner.iUserId);
          mergedFromUserId = userId;
        } else {
          await conn.query(
            "UPDATE identity_tbl_User SET email=? WHERE iUserId=?",
            [email, userId],
          );
        }
      }
    }
    if (input.displayName !== undefined)
      await conn.query(
        "UPDATE identity_tbl_User SET displayName=? WHERE iUserId=?",
        [input.displayName, memberId],
      );
    if (isSuper && (input.role === "SUPER_ADMIN" || target.superAdmin)) {
      await conn.query(
        "UPDATE identity_tbl_User SET bSuperAdminOverride=? WHERE iUserId=?",
        [input.role === "SUPER_ADMIN" ? 1 : 0, memberId],
      );
    }
    await conn.query(
      `INSERT INTO identity_tbl_Membership (iTenantId,iUserId,role,bEnabled) VALUES (?,?,?,?)
      ON DUPLICATE KEY UPDATE role=VALUES(role),bEnabled=VALUES(bEnabled)`,
      [tenantId, memberId, memberRole, input.bEnabled ? 1 : 0],
    );
    await audit(
      conn,
      actor,
      tenantId,
      options.newMember ? "member.added" : "member.updated",
      {
        iUserId: memberId,
        ...input,
        ...(mergedFromUserId ? { mergedFromUserId } : {}),
      },
    );
    return {
      iUserId: memberId,
      ...(mergedFromUserId ? { mergedFromUserId } : {}),
    };
  });
}

/**
 * Take a user out of a tenant. A user who has never signed in and is left
 * with no tenant was only an invitation, so they are deleted outright.
 */
export async function removeMember(
  pool: mysql.Pool,
  actor: AppSession,
  tenantId: number,
  userId: number,
): Promise<{ userDeleted: boolean }> {
  return withMemberLock(pool, actor, tenantId, async (ctx) => {
    const { conn, isSuper, members, users } = ctx;
    const target = users.find((u) => Number(u.iUserId) === userId);
    if (!members.some((m) => Number(m.iUserId) === userId))
      throw new PlatformError(404, "This user is not in this tenant");
    if (!isSuper && target?.superAdmin)
      throw new PlatformError(
        403,
        "Only a Super Admin can change Super Admin access",
      );
    guardLastAdmin(ctx, userId, target);
    await conn.query(
      "DELETE FROM identity_tbl_Membership WHERE iTenantId=? AND iUserId=?",
      [tenantId, userId],
    );
    const userDeleted = await deleteUserIfUnused(conn, userId);
    await audit(conn, actor, tenantId, "member.removed", {
      iUserId: userId,
      userDeleted,
    });
    return { userDeleted };
  });
}
