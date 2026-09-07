#!/usr/bin/env node
// Offline transform only. Input/output contain secrets: redirect into a protected file.
import fs from "node:fs";
const filename = process.argv[2];
if (!filename)
  throw new Error(
    "Usage: node scripts/convert-legacy-settings.mjs /protected/legacy-settings.json",
  );
const input = JSON.parse(fs.readFileSync(filename, "utf8"));
const rows = Array.isArray(input) ? input : input.list;
if (!Array.isArray(rows))
  throw new Error("Expected a NocoDB records export array or {list:[]}");
const seen = new Set();
const converted = rows.map((row) => {
  if (typeof row.Key !== "string" || !row.Key)
    throw new Error("Missing legacy Key");
  if (seen.has(row.Key)) throw new Error(`Duplicate legacy key: ${row.Key}`);
  seen.add(row.Key);
  const global = ["PARENT_DOMAIN", "trustedCIDR"].includes(row.Key);
  return {
    app: global ? "*" : "identity",
    settingKey: row.Key,
    settingValue: row.Value ?? "",
    description: row.Description ?? "",
    bSecret: /SECRET|PASSWORD|TOKEN|APP_KEY/.test(row.Key),
  };
});
process.stdout.write(JSON.stringify(converted, null, 2) + "\n");
