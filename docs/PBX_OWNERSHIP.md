# POC ownership and directory reconciliation

Decision: 2026-09-08. This supersedes the original cross-repository merge order
and proposed PBX ownership in [identity #16](https://github.com/localsplash/identity/issues/16).
The implemented directory contract remains [PLATFORM_CONTRACT.md](PLATFORM_CONTRACT.md).

## Authority and application responsibilities

| Data or operation | Authority and access |
| --- | --- |
| Users, tenants, roles, memberships, application sessions | Identity; AidaAdmin uses the actor-authorized directory API |
| Business ownership and access to shared voice/messaging numbers | Identity phone-number registry; AidaAdmin administers it |
| Extensions, queues and queue members, trunks, applied DID routing | OfficePulse/Asterisk PBX; OfficePulseAidaIntegration exposes a read-only POC API |
| Registration, queue activity and active calls | Asterisk runtime; use supported runtime interfaces, not an inference from configuration rows |
| Tenant call history and recordings | AidaAdmin presents authorized runtime records/API results; it does not become a PBX configuration store |
| PBX health, carrier troubleshooting and restricted maintenance | OfficePulseAidaIntegration API and operations UI |

AidaAdmin may associate business metadata with an existing PBX object, using a
PBX installation identifier plus the object's native identifier. A tenant ID or
extension number alone is not a globally unique PBX identity. Such associations
do not copy extension credentials, queue membership or provisioning state.
Server-side tenant authorization and an operator-reviewed PBX ownership mapping
must precede inventory access; an arbitrary browser-supplied tenant/context is
not authority.

The POC permits SELECT access to the installed PBX's MySQL configuration through
the OfficePulse web API. Browsers and AidaAdmin do not receive MySQL credentials.
The API must return only the authorized tenant's supported inventory fields,
exclude SIP secrets, and distinguish unavailable/unsupported sources from empty
inventory. The actual installed schema and Asterisk configuration mechanism must
be verified before enabling this path. Asterisk can use files, realtime storage,
or generated configuration; a database row alone does not prove it is active.
See Asterisk's [PJSIP realtime configuration](https://docs.asterisk.org/Configuration/Channel-Drivers/SIP/Configuring-res_pjsip/Setting-up-PJSIP-Realtime/)
and [AMI QueueStatus](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/AMI_Actions/QueueStatus/)
for the distinction between configured objects and runtime queue state.

Queues are the selected call-distribution mechanism. A simultaneous `Dial()` to
several endpoints is a ring group and must not be relabeled as a queue. Existing
ring-group configuration needs an explicit, PBX-operated transition. No queue
tables or vendor schema migrations belong in Identity or EchoDatabase.

There is no AidaAdmin-to-Asterisk desired-state synchronization workflow in this
decision: no copied extension master, reconciliation jobs, retry dashboard, or
"extension created here, pending there" status. The POC reads existing PBX
configuration. Future PBX changes belong to the OfficePulse integration boundary
and must use the installed PBX's supported apply mechanism and read-back result.
That future write API is separate work from read-only inventory.

Adding/disabling a shared number changes business access in Identity, not the
carrier or PBX DID route. Disable an applied route through PBX operations when
required. The two actions have distinct meanings and must not be represented as
a synchronization backlog.

## What issue #16 already delivered

Evidence: [directory/session PR #18](https://github.com/localsplash/identity/pull/18),
[shared-number PR #19](https://github.com/localsplash/identity/pull/19), and the
current `src/migrations.ts`, `src/platform.ts`, `src/platformRoutes.ts`,
`src/memberManagement.ts`, `src/phoneNumbers.ts` and `docs/openapi.json`.

| Original proposal | Implemented contract / disposition |
| --- | --- |
| Tenant table and TenantUser table | `identity_tbl_Tenant` and composite-key `identity_tbl_Membership`; do not add a duplicate TenantUser authority |
| Nullable-tenant SUPER_ADMIN membership | Global privilege is session provenance plus `bSuperAdminOverride`; tenant membership roles remain TENANT_ADMIN/USER |
| CIDR-only directory except grantSuperAdmin | Every directory call needs server admission and a central actor bearer; role changes recheck current authority |
| Tenant ensure by slug/idempotency key | Create by unique slug, with 409 on duplicate; user ensure has idempotency keys |
| PUT tenant and `/users` membership paths | PATCH tenant and `/memberships` paths are the published contract; `/users` supports adding by email |
| Renamed session columns and migration ledger | Existing `sSessionId`, `sProvider`, `sSubject`, and `identity_tbl_Migration` are retained; these naming changes are not completed and are not needed for consolidation |
| Automatic settings/base rename and dual reader | Canonical PlatformConfig reader plus explicit protected export/convert/import; preserve legacy source during cutover |
| Shared business numbers | `identity_tbl_PhoneNumber`, actor-authorized management, audited import and session number grants |

Consolidation implementation does not prove that a particular deployed database
was moved or that legacy mappings/numbers were imported. Preserve reviewed
manifests, backups and validation evidence for each deployment.

## Remaining issue #16 work

- Tenant merge is not implemented. Specify conflicting memberships, immutable
  phone-number ownership, legacy maps, audit records and downstream business
  references before adding a merge API or UI. Never silently reassign PBX objects.
- `tenant.disabled` and `tenant.merged` are not published events. Current
  authorization checks Identity online; do not build consumers around nonexistent
  events. If required later, deliver event catalogue, durable delivery, OpenAPI,
  fixtures, client and consumer handling together with replay/idempotency tests.
- Keep [#17](https://github.com/localsplash/identity/issues/17) as the focused
  privilege review, reconciled with the implemented membership/override API,
  rather than assuming the originally proposed standalone endpoint exists.
- Session/ledger cosmetic renames are deferred. Any later migration must preserve
  deployed readers, session tokens and migration history; never edit released
  migrations to fit the original issue text.
- Verify each environment's PlatformConfig scopes, protected legacy conversion,
  database cutover and consumer adoption separately from code completion.

The active repositories are Identity, AidaAdmin, OfficePulseAidaIntegration,
EchoOrchestrator, EchoDatabase, EchoWeb, EchoService and EchoMedia. AidaHandset and
AidaAgent are deferred. `delme_AidaControl` and AidaOfficePbxAdmin (being retired as
`delme_AidaOfficePbxAdmin`) are excluded. AidaOfficePbxAdmin is not a separate new
application. AidaInfrastructureSetupInstructions is historical documentation,
not a source-code dependency or a required first merge.
