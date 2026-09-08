# Platform Identity contract v2

Identity owns `platform_db`: users, provider identities, tenants (businesses), memberships, SSO sessions and application browser sessions. Echo and Aida retain domain records and canonical ID mappings. Applications must not create an independent user, membership, or browser-session authority.

PBX configuration is owned by the OfficePulse/Asterisk installation. Extensions,
queues, queue membership, trunks and applied DID routes are read through the
OfficePulse integration API. Identity's shared phone-number registry grants
business access; it does not provision or mirror PBX configuration. See
[PBX ownership and issue reconciliation](PBX_OWNERSHIP.md) for the POC boundary
and the remaining requirements from issue #16.

## Session protocol

`POST /api/token {code,redirect_uri}` preserves all existing fields and adds `appSession: {token}`. The new opaque 64-hex token belongs in an HttpOnly, Secure, host-only application cookie, with SameSite=Lax. Consumers validate browser CSRF/origin on mutations and never forward browser-controlled server credentials. Application tokens are SHA-256 hashed inside the same `identity_tbl_Session` table as SSO sessions, with `sAppOrigin` distinguishing token types. SSO cookies cannot be redeemed as application tokens and application credentials cannot sign into Identity's account/admin UI.

All following APIs require trusted server admission, using the existing `IDENTITY_APP_AUTH_MODE` policy: `cidr` (default, `trustedCIDR`), `secret` (`X-Id-Client-Secret`), or `dual` (either). Trust authenticates a controlled first-party service; it is not per-application isolation. `sAppOrigin` records issuance provenance and does not restrict the holder from calling another first-party platform service. Bearer credentials must never be logged.

| Endpoint | Body / result |
| --- | --- |
| `POST /api/sessions/introspect` | `{token}` → `{active:false}` or the active shape below |
| `POST /api/sessions/revoke` | `{token}` → `{revoked:true}`; idempotent |
| `POST /api/sessions/select-tenant` | `{token,iTenantId:number|null}` → `{selectedTenantId:number|null}` |
| `GET /api/runtime/tenants/:id` | `{iTenantId,bEnabled}` only; 404 for unknown tenant; no actor needed |

```json
{
  "active": true,
  "user": {"iUserId": 7, "email": "person@X.TLD", "displayName": "Person", "superAdmin": false},
  "tenants": [{"iTenantId": 12, "name": "Office", "slug": "office", "role": "TENANT_ADMIN", "bEnabled": true}],
  "numbers": [{"iPhoneNumberId":1,"iTenantId":12,"phoneNumber":"+17145550100","label":"Reception","bVoice":true,"bMessaging":true,"bEnabled":true,"accessPolicy":"TENANT_MEMBERS","iVersion":1}],
  "selectedTenantId": 12
}
```

Membership roles are `TENANT_ADMIN` and `USER`, with a non-null tenant and unique `(iTenantId,iUserId)`. `SUPER_ADMIN` is a synthetic response role across all tenants, including disabled tenants in administrative listings. It is never stored as a membership row. Migration `0004_user_role_override` adds nullable `identity_tbl_User.bSuperAdminOverride`: NULL preserves provider-proven SSO authority, 1 explicitly grants global access, and 0 explicitly removes it. Only a current Super Admin can change this override. SSO, application introspection and code redemption read it live; directory email never grants global access. A SUPER_ADMIN may inspect disabled tenants but cannot select one for active work.

Ordinary sessions enumerate only enabled tenant memberships in enabled tenants. Introspection reads current membership on each call, so role changes/disablement take effect without local authorization caches. Selection returns null if access is later removed. Consumers must fail closed on Identity unavailability; session revocation/authorization is online for this POC. Sessions preserve the existing policy of remaining valid until revoked; account/admin revoke-all covers SSO and app sessions together. No tenant/membership event feed is added in this PR because consumers check online.

## Directory APIs

Every directory read/write requires server admission **and** `Authorization: Bearer <appSession.token>`. A claimed browser role, tenant ID or header is not authority.

| Endpoint | Authorization and shape |
| --- | --- |
| `GET /api/directory/tenants` | Current actor → `{tenants:[...]}` |
| `POST /api/directory/tenants` | SUPER_ADMIN, `{name,slug}` → 201 tenant; duplicate slug → 409 |
| `PATCH /api/directory/tenants/:id` | Own TENANT_ADMIN or SUPER_ADMIN, `{name?,slug?,bEnabled?}`; enable/disable requires SUPER_ADMIN |
| `GET /api/directory/tenants/:id/memberships` | Own TENANT_ADMIN or SUPER_ADMIN → `{memberships:[{iUserId,email,displayName,role,bEnabled}]}` |
| `PUT /api/directory/tenants/:id/memberships/:userId` | Own TENANT_ADMIN or SUPER_ADMIN, `{role,bEnabled,displayName?,email?}` → membership; Super Admin may also assign `SUPER_ADMIN` |
| `GET /api/directory/users?query=&limit=&cursor=` | SUPER_ADMIN, existing `{items,nextCursor}` shape |
| `GET /api/directory/users/:id` | SUPER_ADMIN, existing minimal directory user |
| `POST /api/directory/users` | SUPER_ADMIN, existing `{email,displayName?,idempotencyKey?}` → existing minimal directory user |
| `PATCH /api/directory/users/:id` | SUPER_ADMIN, `{displayName:string|null}` → directory user |

Tenant admins can add a user by email with `POST /api/directory/tenants/:id/users` (`{email,displayName,role,bEnabled}`), without browsing the global directory. Existing imported Google email bindings are recognized when the primary user email is missing, preventing duplicate pending accounts. Ambiguous email matches return 409 for explicit reconciliation.

Tenant Admins may assign `TENANT_ADMIN` or `USER`, and cannot modify Super Admins. Super Admins may assign any of the three roles. Profile and role edits commit together with an audit entry; linked sign-in emails cannot be changed through membership editing. Last enabled tenant administrator and last global administrator removal return 409. New tenants may initially have zero members. User merges move non-conflicting memberships and legacy mappings; conflicting roles/enablement must be reconciled before merging. No tenant deletion or tenant merge API is exposed.

IDs are positive safe JSON integers (maximum 9007199254740991). Unknown/unsafe identifiers and invalid payloads are rejected. Mutations record their actor and target in `identity_tbl_Audit` in the same transaction. Directory-user idempotency keys preserve existing global key semantics; reuse for a different email returns conflict. Tenant creation is create-by-unique-slug, not an ensure operation: repeat submissions return 409 so clients must use the listed tenant explicitly.

## Settings and cutover

NocoDB base `PlatformConfig`, table `cfg_tbl_Setting`, fields `app`, `settingKey`, `settingValue`, `description`, `bSecret`, `dtCreated`, `dtUpdated` plus the NocoDB `Id`. Resolution is nonblank environment override, exact `identity` scope, then global `*`; Identity has no parent scope. Other apps' scope parents are fixed in the platform plan. Duplicate bases/tables/scoped keys are errors; blank seed rows are unset. Writes target the `identity` scope and do not overwrite global rows. Runtime reads do not bootstrap missing objects. Bootstrap explicitly creates the canonical table and seeds identity-scoped empty fields. Use `*` for intentionally shared `PARENT_DOMAIN`/`trustedCIDR`; provider/database secrets stay in `identity`.

This branch requires canonical settings. Before switching a deployed Identity image, export existing `IdentityBase/auth_tbl_Settings` records to a protected file and transform with `scripts/convert-legacy-settings.mjs`; import the result into `PlatformConfig/cfg_tbl_Setting`. This maps legacy `Key/Value/Description` explicitly and does not print secret values into normal logs. The converter's stdout contains secrets, so use a file under `umask 077`. Preserve source data until cutover validation passes. There is no automatic base rename or legacy fallback writer.

Creating a new `platform_db` does not move users. Rehearse a consistent dump/restore of the existing Identity database into `platform_db`, preserving all table IDs and session/handoff rows, then apply the additive migrations. Freeze Identity writes for the final copy; compare users/provider identities/session counts and IDs and validate login/revocation before changing `DB_NAME`. Retain the original database and snapshot for recovery. Existing named migrations and `id_tbl_*` adoption remain in place; no vendor/Asterisk schemas are touched.

For legacy Echo/Aida IDs, create reviewed records such as `{ "source":"echo", "entity":"TENANT", "legacyId":"legacy-org-id", "targetId":12 }`. `identity_tbl_LegacyMap` stores immutable source/entity/ID → canonical IDs with FKs. `PLATFORM_DB_URL=... node scripts/import-legacy-map.mjs manifest.json` validates in a rolled-back transaction by default; `--apply` commits. Never equate unrelated numeric IDs or automatically merge by a claimed email. Preserve source tables and backfill consumer references from the verified manifest. Legacy app cookies require consumer adoption or a fresh SSO handoff; this PR does not silently reinterpret old cookie formats.

## Validation

The server admission requirement on global directory routes is intentionally tightened in contract v2; existing CIDR-only consumers must add the central actor bearer. The existing OpenAPI breaking-change CI gate will report this intentional API change for coordinated rollout review.

`docker build --target test -t identity-platform:test .` uses Node 22 and executes the unit/contract suite. Real MySQL tests require `TEST_DB_URL` pointed at a disposable MySQL container: the migration suite recreates the database in that URL and the platform suite recreates `identity_platform_test`. They exercise migration idempotency, preserved users, multi-tenant isolation, credential hashing/type separation, central selection, enablement, revoke-all, membership concurrency and audit writes. Never use a live database URL.

## Shared tenant numbers

Migration `0005_shared_phone_numbers` adds `identity_tbl_PhoneNumber` in `platform_db`. Every number supports voice and messaging, belongs to one immutable tenant, and explicitly grants `TENANT_MEMBERS` access. Active introspection includes enabled numbers for enabled tenant memberships; Super Admins see all enabled tenants’ numbers. No Echo-local user or organization row is needed to grant access.

AidaAdmin manages the registry through actor-authorized `GET/POST /api/directory/tenants/:id/numbers` and `PUT /api/directory/tenants/:id/numbers/:numberId`. GET returns `{numbers:[...]}`; writes return the number record. POST takes `phoneNumber,label,bEnabled,accessPolicy` (both capability flags default true). PUT additionally requires `expectedVersion`. Phone number and tenant cannot be changed; duplicate ownership or stale edits return 409. Only Super Admins or that tenant’s enabled Tenant Admins can write. Ordinary members only consume numbers through introspection. Echo currently requires +1 ten-digit numbers.

Deploy Identity before consumers that require the `numbers` session field. Backfill only reviewed E.164/tenant assignments using `IMPORT_ACTOR_USER_ID=... PLATFORM_DB_URL=... node scripts/import-phone-numbers.mjs manifest.json` (dry run); append `--apply` to commit. Entries contain `iTenantId`, `phoneNumber`, and `label`. Conflicting ownership aborts the transaction; existing assignments are never overwritten or re-enabled. Preserve legacy Echo rows as history/provenance. Adding a number does not provision a carrier or DID route. Disabling access revokes Echo access on the next request; existing PBX routes must be disabled separately in DID routes.
