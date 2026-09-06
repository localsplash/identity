#!/usr/bin/env node
import fs from "node:fs";
import mysql from "mysql2/promise";
const filename = process.argv[2],
  apply = process.argv.includes("--apply");
if (!filename || !process.env.PLATFORM_DB_URL)
  throw new Error(
    "Set PLATFORM_DB_URL and pass a reviewed mapping JSON file; --apply commits, otherwise rollback validates only",
  );
const records = JSON.parse(fs.readFileSync(filename, "utf8"));
if (!Array.isArray(records))
  throw new Error("Mapping manifest must be an array");
const conn = await mysql.createConnection(process.env.PLATFORM_DB_URL);
try {
  await conn.beginTransaction();
  for (const row of records) {
    if (
      !/^[a-z0-9-]{1,64}$/.test(row.source) ||
      !["USER", "TENANT"].includes(row.entity) ||
      typeof row.legacyId !== "string" ||
      !row.legacyId ||
      row.legacyId.length > 128 ||
      !Number.isSafeInteger(row.targetId) ||
      row.targetId < 1
    )
      throw new Error("Invalid mapping row");
    const [existing] = await conn.query(
      `SELECT iUserId,iTenantId FROM identity_tbl_LegacyMap WHERE sSource=? AND sEntity=? AND sLegacyId=? FOR UPDATE`,
      [row.source, row.entity, row.legacyId],
    );
    if (existing.length) {
      if (
        Number(
          row.entity === "USER" ? existing[0].iUserId : existing[0].iTenantId,
        ) !== row.targetId
      )
        throw new Error(
          "Mapping conflicts with existing provenance; refusing overwrite",
        );
      continue;
    }
    await conn.query(
      `INSERT INTO identity_tbl_LegacyMap (sSource,sEntity,sLegacyId,iUserId,iTenantId) VALUES (?,?,?,?,?)`,
      [
        row.source,
        row.entity,
        row.legacyId,
        row.entity === "USER" ? row.targetId : null,
        row.entity === "TENANT" ? row.targetId : null,
      ],
    );
  }
  if (apply) await conn.commit();
  else await conn.rollback();
  console.log(
    `${records.length} mappings validated; ${apply ? "committed" : "rolled back (dry run)"}`,
  );
} catch (e) {
  await conn.rollback();
  throw e;
} finally {
  await conn.end();
}
