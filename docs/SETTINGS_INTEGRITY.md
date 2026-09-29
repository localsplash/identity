# Settings integrity

Admin writes serialize create/update operations within the Identity process and
update the existing scoped row. A blank save deletes a row; bootstrap no longer
creates blank seeds. The console supplies empty known fields from its catalog,
using `echo-service` for carrier webhook and endpoint settings. Duplicate reads
fail closed with every colliding row ID, without logging setting values.

Run `npm run build` then `npm run audit:settings` with this service's NocoDB
bootstrap credentials exported. The read-only audit lists all duplicate
`{app, settingKey}` groups (including trimmed/case-folded collisions) and blank
row IDs, never values. It exits nonzero on duplicates or unavailable storage and
works separately from web sign-in, so it can diagnose a failed runtime reader.

The v2 table metadata/schema used here exposes no composite unique-index
declaration; per-column uniqueness would incorrectly forbid legitimate scoped
overrides. The audit is the fallback guard for direct NocoDB edits and multiple
Identity processes. It does not claim database-enforced uniqueness. Run it after
external edits and before deployment; resolve duplicate IDs in NocoDB before
restarting consumers. The in-process writer cannot lock out external writers.
