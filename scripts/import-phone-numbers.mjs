/** Reviewed legacy number assignments only. Dry run unless --apply is supplied. */
import fs from "node:fs";
import mysql from "mysql2/promise";
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!Array.isArray(manifest) || !manifest.length)
  throw new Error("Expected a nonempty assignment array");
for (const n of manifest) {
  if (
    !Number.isSafeInteger(n.iTenantId) ||
    n.iTenantId < 1 ||
    !/^\+1[2-9]\d{9}$/.test(n.phoneNumber) ||
    typeof n.label !== "string" ||
    n.label.length > 100
  )
    throw new Error("Invalid number assignment");
}
const actor = Number(process.env.IMPORT_ACTOR_USER_ID);
if (!Number.isSafeInteger(actor) || actor < 1)
  throw new Error("IMPORT_ACTOR_USER_ID is required for the audit trail");
if (!process.env.PLATFORM_DB_URL)
  throw new Error("PLATFORM_DB_URL is required");
const db = await mysql.createConnection(process.env.PLATFORM_DB_URL);
let locked = false;
try {
  const [lock] = await db.query(
    "SELECT GET_LOCK('identity_phone_number_write',10) AS acquired",
  );
  if (Number(lock[0].acquired) !== 1)
    throw new Error("Number management is busy");
  locked = true;
  await db.beginTransaction();
  const [users] = await db.query(
    "SELECT iUserId FROM identity_tbl_User WHERE iUserId=?",
    [actor],
  );
  if (!users.length) throw new Error("Unknown audit actor");
  for (const n of manifest) {
    const [tenant] = await db.query(
      "SELECT iTenantId FROM identity_tbl_Tenant WHERE iTenantId=? FOR UPDATE",
      [n.iTenantId],
    );
    if (!tenant.length) throw new Error("Unknown tenant in manifest");
    const [existing] = await db.query(
      "SELECT iTenantId FROM identity_tbl_PhoneNumber WHERE phoneNumber=? FOR UPDATE",
      [n.phoneNumber],
    );
    if (existing.length) {
      if (Number(existing[0].iTenantId) !== n.iTenantId)
        throw new Error(
          "Conflicting number ownership; manual reconciliation required",
        );
      continue;
    }
    await db.query(
      "INSERT INTO identity_tbl_PhoneNumber(iTenantId,phoneNumber,label,bVoice,bMessaging,bEnabled,accessPolicy) VALUES (?,?,?,1,1,1,'TENANT_MEMBERS')",
      [n.iTenantId, n.phoneNumber, n.label],
    );
    await db.query(
      "INSERT INTO identity_tbl_Audit(iActorUserId,iTenantId,action,jDetail) VALUES (?,?,'phone_number.imported',?)",
      [actor, n.iTenantId, JSON.stringify(n)],
    );
  }
  const apply = process.argv.includes("--apply");
  await (apply ? db.commit() : db.rollback());
  console.log(
    `${apply ? "Imported" : "Validated (rolled back)"} ${manifest.length} assignments; existing records preserved.`,
  );
} catch (e) {
  await db.rollback();
  throw e;
} finally {
  if (locked)
    await db.query("SELECT RELEASE_LOCK('identity_phone_number_write')");
  await db.end();
}
