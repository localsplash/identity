import { AppConfig } from './config';

/** PlatformConfig is discovered by unique name; runtime reads never bootstrap.
 * Resolution: nonblank environment override > identity > global '*'. Identity
 * has no shared parent scope. Blank seed rows are unset, duplicate scoped keys
 * are configuration errors, and secrets are never promoted to global scope. */
export const SETTINGS_BASE_NAME = 'PlatformConfig';
export const SETTINGS_TABLE_NAME = 'cfg_tbl_Setting';
export const SETTINGS_SCOPE = 'identity';

/**
 * Scopes this console may list and write.
 *
 * PlatformConfig is shared: EchoService reads `service`, EchoWeb reads
 * `echo-web` under `echo`, and `*` is read by everything. Managing only
 * `identity` meant a write for another app's key silently created an
 * identity-scoped row nobody reads, while the console displayed it as set.
 */
export const MANAGED_SCOPES = ['*', 'identity', 'echo', 'echo-web', 'service'] as const;
export type ManagedScope = (typeof MANAGED_SCOPES)[number];

export function isManagedScope(app: string): app is ManagedScope {
  return (MANAGED_SCOPES as readonly string[]).includes(app);
}

/**
 * Keys this console deliberately does not manage.
 *
 * Bandwidth credentials belong to a carrier application, which binds per-DID
 * through `sms_tbl_BusinessPhone.iCarrierApplicationId`. The PlatformConfig
 * `BANDWIDTH_*` rows are only the fallback for a phone that has no such row,
 * and the per-carrier credentials win whenever one exists. Offering them here
 * would steer an operator into the deprecated path instead of the carrier
 * application that actually routes their number.
 *
 * `BANDWIDTH_MESSAGING_API_BASE_URL` is NOT in this list: `bandwidthBase()`
 * reads it from PlatformConfig alone and never consults carrier settings, so
 * it is a genuine deployment-wide endpoint, not a per-carrier credential.
 */
export const UNMANAGED_KEYS = [
  'BANDWIDTH_ACCOUNT_ID',
  'BANDWIDTH_API_TOKEN',
  'BANDWIDTH_API_SECRET',
  'BANDWIDTH_APPLICATION_ID',
] as const;

export function isConsoleManaged(key: string): boolean {
  return !(UNMANAGED_KEYS as readonly string[]).includes(key);
}

/**
 * Keys whose value must never be returned to a browser, and which may not be
 * written to the global `*` scope.
 *
 * WEBHOOK_BASIC_PASS is why this is not the narrower word list it looks like
 * it should be: it carries PASS, not PASSWORD, so the earlier pattern did not
 * match and the credential gating EchoService's webhooks would have been
 * stored unflagged.
 */
export function isSecretKey(key: string): boolean {
  return /SECRET|PASSWORD|PASS|TOKEN|APP_KEY|CREDENTIAL/i.test(key);
}

export interface SettingDef {
  key: string;
  description: string;
}

export const KNOWN_SETTINGS: SettingDef[] = [
  {
    key: 'PARENT_DOMAIN',
    description:
      'Apex domain (X.TLD) that all participating apps live under, e.g. X.TLD. ' +
      'Drives the SSO cookie scope and the redirect_uri allowlist (any https host ' +
      'under this domain). This is where the applications live; where the ' +
      'identities come from is SUPERADMIN_DOMAIN, which defaults to this but is ' +
      'not always the same domain.',
  },
  {
    key: 'APP_BASE_URL',
    description:
      'Public base URL of this identity app, e.g. https://identity.X.TLD. Used to ' +
      'build the OAuth callback URIs registered with each provider. Leave it empty ' +
      'and the URL the browser reached this service on is used instead — the setup ' +
      'wizard writes exactly that, so it normally never has to be typed.',
  },
  {
    key: 'DB_HOST',
    description:
      'Hostname of the MySQL server holding platform_db, the shared platform identity ' +
      'database this app owns and migrates itself. Required — the app has no ' +
      'sessions, users or identities until it is set. A change takes a restart.',
  },
  {
    key: 'DB_PORT',
    description: "MySQL port. Empty means MySQL's own default, 3306.",
  },
  { key: 'DB_USER', description: 'MySQL user for platform_db. Required.' },
  { key: 'DB_PASSWORD', description: 'Password for DB_USER.' },
  {
    key: 'DB_NAME',
    description: 'Database name, conventionally platform_db. Required.',
  },
  {
    key: 'trustedCIDR',
    description:
      'The network the platform\'s servers sit on, as an IPv4 CIDR (/32 allowed, a ' +
      'bare IP treated as /32). ONE value for the whole platform — every application ' +
      'reads this same key rather than spelling the same network under its own name. ' +
      'It admits callers to the server-only endpoints (/api/token, /api/apps/register, ' +
      '/api/events, /api/directory/*); nothing outside it is trusted, and IPv6 never ' +
      'is. A comma-separated list is parsed, for servers that straddle two ranges.',
  },
  {
    key: 'IDENTITY_CLIENT_SECRET',
    description:
      'LEGACY (rollout only). Shared secret applications present at POST /api/token ' +
      'when IDENTITY_APP_AUTH_MODE is secret or dual. The POC default (cidr) trusts ' +
      'the trustedCIDR network instead and ignores this. ' +
      'Generate with: openssl rand -hex 32',
  },
  {
    key: 'SUPERADMIN_DOMAIN',
    description:
      'Domain(s) whose provider-verified users become Super System Admins — a ' +
      'comma-separated list is accepted. Defaults to PARENT_DOMAIN when empty. ' +
      'Set it explicitly whenever the identity provider vouches for a different ' +
      'domain than the apps are served from: with a Google Workspace domain alias ' +
      '(apps at app.example.ai, Workspace primary example.com) every token comes ' +
      'back as user@example.com with hd=example.com — Google never asserts the ' +
      'alias — so this must be example.com.',
  },
  {
    key: 'DEFAULT_REDIRECT_URI',
    description:
      'Where to send a user who signs in without a pending application request ' +
      '(e.g. entering straight from the UISP portal), such as ' +
      'https://echo.X.TLD/auth/callback. Empty = show the account page.',
  },
  { key: 'GOOGLE_CLIENT_ID', description: 'Google OAuth 2.0 client ID.' },
  { key: 'GOOGLE_CLIENT_SECRET', description: 'Google OAuth 2.0 client secret.' },
  { key: 'MICROSOFT_CLIENT_ID', description: 'Microsoft Entra ID application (client) ID.' },
  { key: 'MICROSOFT_CLIENT_SECRET', description: 'Microsoft Entra ID client secret.' },
  {
    key: 'MICROSOFT_TENANT',
    description:
      "Entra authority segment: 'common' accepts any account; a tenant GUID restricts " +
      'sign-in to that tenant. Defaults to common when empty.',
  },
  {
    key: 'UISP_SSO_SECRET',
    description:
      'HMAC-SHA256 hex secret shared with the UISP bridge plugin. Must match the ' +
      "plugin's SSO Shared Secret setting exactly.",
  },
  {
    key: 'UISP_PLUGIN_URL',
    description:
      "The UISP bridge plugin's public URL (UCRM generates it at install time). The " +
      'ISP login button is hidden until this is set.',
  },
  { key: 'UISP_BASE_URL', description: 'UISP instance base URL, e.g. https://my.X.TLD.' },
  {
    key: 'UISP_CRM_APP_KEY_READ',
    description:
      'Read-only UISP CRM App Key. Used by applications to look up ' +
      'subscriber records when provisioning accounts.',
  },
  // ── Read by EchoService, in the 'service' scope ────────────────────────────
  {
    key: 'WEBHOOK_BASIC_USER',
    description:
      'Basic-auth username carriers present on /webhooks/*. Callers inside trustedCIDR ' +
      'are admitted without it. WARNING: leaving BOTH this and WEBHOOK_BASIC_PASS blank ' +
      'disables basic auth entirely, leaving trustedCIDR as the only check on endpoints ' +
      'that write inbound messages.',
  },
  {
    key: 'WEBHOOK_BASIC_PASS',
    description:
      'Basic-auth password for /webhooks/*. Rotating it takes effect within 30 seconds, ' +
      'with no restart. Bandwidth reaches Echo from outside the trusted network, so this ' +
      'is the real control for it.',
  },
  {
    key: 'CORS_ORIGINS',
    description: 'Comma-separated browser origins EchoService accepts. Deployment configuration.',
  },
  {
    key: 'BANDWIDTH_MESSAGING_API_BASE_URL',
    description:
      "Bandwidth's own API base, deployment-wide. Defaults to " +
      'https://messaging.bandwidth.com/api/v2 when blank. Not a credential and not ' +
      'per-carrier: account credentials belong to the carrier application.',
  }
];

export type Settings = Record<string, string>;

// ─── Environment overrides ────────────────────────────────────────────────────

/**
 * Any known setting may be pinned in the environment, where it wins over the
 * store. This is the escape hatch for deployments that manage configuration
 * as environment (a Helm chart, a CI secret) and for bringing an instance up
 * before NocoDB exists at all; the zero-config path leaves all of it unset.
 *
 * Blank and whitespace-only values are ignored rather than treated as an
 * override of "" — an empty variable in a compose file means "not set here".
 */
export function settingOverridesFromEnv(env: NodeJS.ProcessEnv = process.env): Settings {
  const overrides: Settings = {};
  const take = (key: string, from: string): void => {
    if (key in overrides) return;
    const raw = env[from];
    if (typeof raw === 'string' && raw.trim() !== '') overrides[key] = raw.trim();
  };
  for (const { key } of KNOWN_SETTINGS) take(key, key);
  // Environment-shaped spellings for keys whose canonical name is not, and
  // the pre-rollout names kept working for one release.
  for (const [key, names] of Object.entries(ENV_ALIASES)) {
    for (const name of names) take(key, name);
  }
  return overrides;
}

/**
 * Environment names that pin a setting whose canonical key reads oddly as a
 * variable (`trustedCIDR`), plus the names this app used before `id` became
 * `identity`. First one set wins, canonical spelling first.
 */
export const ENV_ALIASES: Record<string, string[]> = {
  trustedCIDR: ['IDENTITY_TRUSTED_NETWORK', 'ID_TRUSTED_NETWORK', 'ID_TRUSTED_APP_CIDRS'],
  IDENTITY_CLIENT_SECRET: ['ID_CLIENT_SECRET'],
};

/** Raised when a write targets a key the environment has pinned. */
export class SettingOverriddenError extends Error {
  constructor(public key: string) {
    super(
      `${key} is set in this app's environment, which overrides the settings ` +
        'store. Change it there (and restart) or unset it to manage it here.'
    );
    this.name = 'SettingOverriddenError';
  }
}

/** Raised when a write targets a key this console deliberately does not manage. */
export class SettingUnmanagedError extends Error {
  constructor(public key: string) {
    super(
      `${key} is a carrier-application credential and is not managed here. It binds to a ` +
        'carrier application, which binds per-DID through sms_tbl_BusinessPhone. Set it on ' +
        'the carrier application instead; the PlatformConfig row is only a fallback for a ' +
        'business phone that has none.'
    );
    this.name = 'SettingUnmanagedError';
  }
}

/** Raised when a write targets a scope this console may not manage. */
export class SettingScopeError extends Error {
  constructor(
    public app: string,
    public key?: string
  ) {
    super(
      key
        ? `${key} looks like a secret, so it cannot be written to the global '*' scope ` +
          'where every application can read it. Write it to the scope of the app that ' +
          'needs it.'
        : `'${app}' is not a scope this console manages. Managed scopes are ` +
          `${MANAGED_SCOPES.map((m) => `'${m}'`).join(', ')}.`
    );
    this.name = 'SettingScopeError';
  }
}

/**
 * The settings store could not answer. There is no fallback: an application
 * that cannot read its configuration says so, loudly, rather than carrying
 * on as though nothing were configured — which reads to an operator as an
 * application fault instead of the configuration fault it is.
 */
export class SettingsUnavailableError extends Error {
  constructor(
    public reason: 'unconfigured' | 'unreachable' | 'base_missing' | 'base_ambiguous' | 'table_missing' | 'duplicate',
    message: string
  ) {
    super(message);
    this.name = 'SettingsUnavailableError';
  }
}

/** Where an effective value came from — surfaced to /admin and the wizard. */
export type SettingSource = 'environment' | 'store';

export interface AdminSetting {
  key: string;
  /** Which app reads this row. */
  app: string;
  /** Empty for secrets — see `hasValue`. */
  value: string;
  /** Whether a secret is set, since its value is never sent to the browser. */
  hasValue: boolean;
  secret: boolean;
  description: string;
  source: SettingSource;
}

// ─── NocoDB v2 API client ─────────────────────────────────────────────────────

interface NocoTableRow {
  Id: number;
  app: string;
  settingKey: string;
  settingValue: string | null;
  description: string | null;
  bSecret?: boolean;
}

/**
 * How long a value — and the resolved base/table ID with it — is trusted
 * without asking NocoDB again. A change made in NocoDB reaches every running
 * application within this window, with no restart; that includes renaming or
 * restoring the base, because the IDs live on the same clock as the values
 * rather than being resolved once per process.
 */
export const CACHE_TTL_MS = 30_000;

interface ResolvedIds {
  baseId: string;
  tableId: string;
}

export class SettingsStore {
  private ids: { at: number; ids: ResolvedIds } | null = null;
  private cache: { at: number; settings: Settings } | null = null;

  constructor(
    private config: AppConfig,
    private overrides: Settings = settingOverridesFromEnv()
  ) {}

  /** True when the environment pins this key, so the store cannot decide it. */
  isOverridden(key: string): boolean {
    return key in this.overrides;
  }

  /** The keys the environment is pinning, for logging and the admin UI. */
  overriddenKeys(): string[] {
    return Object.keys(this.overrides);
  }

  private headers(): Record<string, string> {
    return {
      'xc-token': this.config.NOCODB_API_TOKEN,
      'Content-Type': 'application/json',
    };
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const resp = await fetch(`${this.config.NOCODB_BASE_URL}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`NocoDB ${method} ${path} failed: ${resp.status} ${text.slice(0, 200)}`);
    }
    return resp.json() as Promise<T>;
  }

  /** True when this app has both halves of the store's address. */
  isConfigured(): boolean {
    return Boolean(this.config.NOCODB_BASE_URL && this.config.NOCODB_API_TOKEN);
  }

  /**
   * Prove the store is usable right now: reachable, token accepted, exactly
   * one base by our name, and the settings table inside it. Throws a
   * SettingsUnavailableError naming which of those failed.
   */
  async ping(): Promise<void> {
    await this.resolveIds();
  }

  /**
   * The base and table IDs, found by name.
   *
   * The base name is unique by our convention, so exactly one match is the
   * only acceptable answer: none means the base has not been created (or has
   * been renamed), and more than one is a configuration error we refuse to
   * guess our way past. Cached for CACHE_TTL_MS and dropped on any failure,
   * so a rename in NocoDB is picked up on the next refresh rather than at
   * the next restart.
   */
  private async resolveIds(): Promise<ResolvedIds> {
    if (this.ids && Date.now() - this.ids.at < CACHE_TTL_MS) return this.ids.ids;
    if (!this.isConfigured()) {
      throw new SettingsUnavailableError(
        'unconfigured',
        'NOCODB_BASE_URL and NOCODB_API_TOKEN must both be set — they are the ' +
          'only two things this app reads from its environment.'
      );
    }
    try {
      const bases = await this.api<{ list: Array<{ id: string; title: string }> }>(
        'GET',
        '/api/v2/meta/bases'
      );
      const matches = bases.list.filter((b) => b.title === SETTINGS_BASE_NAME);
      if (matches.length === 0) {
        throw new SettingsUnavailableError(
          'base_missing',
          `No NocoDB base named ${SETTINGS_BASE_NAME} at ${this.config.NOCODB_BASE_URL}. ` +
            'Create it (or check the token can see it) — the base is found by name, ' +
            'so a renamed base looks like a missing one.'
        );
      }
      if (matches.length > 1) {
        throw new SettingsUnavailableError(
          'base_ambiguous',
          `${matches.length} NocoDB bases are named ${SETTINGS_BASE_NAME} at ` +
            `${this.config.NOCODB_BASE_URL}. The name must be unique — this app will ` +
            'not guess which one holds its settings. Rename or delete the duplicates.'
        );
      }
      const baseId = matches[0].id;

      const tables = await this.api<{ list: Array<{ id: string; title: string }> }>(
        'GET',
        `/api/v2/meta/bases/${baseId}/tables`
      );
      const matchingTables = tables.list.filter((t) => t.title === SETTINGS_TABLE_NAME);
      if (matchingTables.length > 1) throw new SettingsUnavailableError('duplicate', 'Duplicate settings tables');
      const table = matchingTables[0];
      if (!table) {
        throw new SettingsUnavailableError(
          'table_missing',
          `The base ${SETTINGS_BASE_NAME} has no table named ${SETTINGS_TABLE_NAME}.`
        );
      }

      const ids = { baseId, tableId: table.id };
      this.ids = { at: Date.now(), ids };
      return ids;
    } catch (err) {
      this.ids = null; // never reuse an ID we could not confirm
      throw this.asUnavailable(err);
    }
  }

  /** Everything that is not already a SettingsUnavailableError is a reach failure. */
  private asUnavailable(err: unknown): SettingsUnavailableError {
    if (err instanceof SettingsUnavailableError) return err;
    return new SettingsUnavailableError(
      'unreachable',
      `NocoDB at ${this.config.NOCODB_BASE_URL} did not answer or rejected the ` +
        `token: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`
    );
  }

  /**
   * Create the base and table if they are missing, and seed every known key
   * so the admin never has to guess what goes in the table.
   *
   * This is the one path allowed to create the base — everywhere else a
   * missing base is an error, because a second base appearing by accident is
   * exactly what the unique-name convention exists to prevent.
   */
  async bootstrap(): Promise<void> {
    if (!this.isConfigured()) {
      throw new SettingsUnavailableError(
        'unconfigured',
        'NOCODB_BASE_URL and NOCODB_API_TOKEN must both be set before this app ' +
          'can read or create its settings.'
      );
    }
    try {
      const bases = await this.api<{ list: Array<{ id: string; title: string }> }>(
        'GET',
        '/api/v2/meta/bases'
      );
      const matches = bases.list.filter((b) => b.title === SETTINGS_BASE_NAME);
      if (matches.length > 1) {
        throw new SettingsUnavailableError(
          'base_ambiguous',
          `${matches.length} NocoDB bases are named ${SETTINGS_BASE_NAME}. The name ` +
            'must be unique; rename or delete the duplicates.'
        );
      }
      const base =
        matches[0] ??
        (await this.api<{ id: string; title: string }>('POST', '/api/v2/meta/bases', {
          title: SETTINGS_BASE_NAME,
        }));

      const tables = await this.api<{ list: Array<{ id: string; title: string }> }>(
        'GET',
        `/api/v2/meta/bases/${base.id}/tables`
      );
      if (tables.list.filter(t => t.title === SETTINGS_TABLE_NAME).length > 1) throw new SettingsUnavailableError('duplicate', 'Duplicate settings tables');
      const table =
        tables.list.find((t) => t.title === SETTINGS_TABLE_NAME) ??
        (await this.api<{ id: string; title: string }>(
          'POST',
          `/api/v2/meta/bases/${base.id}/tables`,
          {
            table_name: SETTINGS_TABLE_NAME,
            title: SETTINGS_TABLE_NAME,
            columns: [
              { column_name: 'id', title: 'Id', uidt: 'ID', pk: true },
              { column_name: 'app', title: 'app', uidt: 'SingleLineText' },
              { column_name: 'settingKey', title: 'settingKey', uidt: 'SingleLineText' },
              { column_name: 'settingValue', title: 'settingValue', uidt: 'LongText' },
              { column_name: 'description', title: 'description', uidt: 'LongText' },
              { column_name: 'bSecret', title: 'bSecret', uidt: 'Checkbox' },
              { column_name: 'dtCreated', title: 'dtCreated', uidt: 'CreatedTime' },
              { column_name: 'dtUpdated', title: 'dtUpdated', uidt: 'LastModifiedTime' },
            ],
          }
        ));
      this.ids = { at: Date.now(), ids: { baseId: base.id, tableId: table.id } };

      // Seed missing keys so the full settings menu is visible. Values are
      // left EMPTY — a table being created for the first time is not the
      // place to invent a public URL or a domain, and an environment
      // override is not copied in either: it would be a snapshot that goes
      // stale the moment the environment changed. The setup wizard fills
      // these in from the URL the first admin actually reached this app on.
      const rows = await this.listRows();
      const present = new Set(rows.filter(r => r.app === SETTINGS_SCOPE).map((r) => r.settingKey));
      const missing = KNOWN_SETTINGS.filter((s) => !present.has(s.key));
      if (missing.length) {
        // v2 records POST accepts an array for bulk insert.
        await this.api(
          'POST',
          `/api/v2/tables/${table.id}/records`,
          missing.map((s) => ({ app: SETTINGS_SCOPE, settingKey: s.key, settingValue: '', description: s.description, bSecret: /SECRET|PASSWORD|TOKEN|APP_KEY/.test(s.key) }))
        );
      }
    } catch (err) {
      this.ids = null;
      throw this.asUnavailable(err);
    }
  }

  private async listRows(): Promise<NocoTableRow[]> {
    const { tableId } = await this.resolveIds();
    try {
      const out: NocoTableRow[] = [];
      let offset = 0;
      for (;;) {
        const page = await this.api<{ list: NocoTableRow[]; pageInfo?: { isLastPage?: boolean } }>(
          'GET',
          `/api/v2/tables/${tableId}/records?limit=200&offset=${offset}`
        );
        out.push(...page.list);
        if (page.list.length < 200 || page.pageInfo?.isLastPage === true) break;
        offset += 200;
      }
      const seen = new Set<string>();
      for (const row of out) {
        const key = JSON.stringify([row.app, row.settingKey]);
        if (seen.has(key)) throw new SettingsUnavailableError('duplicate', `Duplicate setting for scope ${row.app} and key ${row.settingKey}`);
        seen.add(key);
      }
      return out;
    } catch (err) {
      // The table ID may have gone stale (base restored, table recreated);
      // drop it so the next call re-detects rather than retrying a dead ID.
      this.ids = null;
      throw this.asUnavailable(err);
    }
  }

  /**
   * All settings as a map, with the environment overriding the store. Cached
   * briefly; empty values are omitted, so a blank row reads as "not set"
   * rather than as an empty string that would shadow the override.
   */
  async getAll(): Promise<Settings> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.settings;
    const rows = await this.listRows();
    const settings: Settings = {};
    for (const r of [...rows.filter(r => r.app === '*'), ...rows.filter(r => r.app === SETTINGS_SCOPE)]) {
      if (r.settingKey && r.settingValue != null && String(r.settingValue).trim() !== '') {
        settings[r.settingKey] = String(r.settingValue).trim();
      }
    }
    Object.assign(settings, this.overrides);
    this.cache = { at: Date.now(), settings };
    return settings;
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.getAll())[key];
  }

  /**
   * Rows including empty values and descriptions — for the admin UI. The
   * effective value is reported, so a key the environment pins shows what is
   * actually in force (tagged 'environment', and not editable) rather than
   * the store row it is shadowing.
   */
  async listForAdmin(): Promise<AdminSetting[]> {
    const rows = await this.listRows();
    const described = new Map(KNOWN_SETTINGS.map((s) => [s.key, s.description]));

    // One entry per (scope, key). Rows are NOT collapsed to an effective
    // value any more: a `service` row and an `identity` row of the same name
    // are different settings read by different applications, and showing only
    // the winner would hide the one the operator came to edit.
    const items: AdminSetting[] = rows
      .filter((r) => r.settingKey && isManagedScope(r.app) && isConsoleManaged(r.settingKey))
      .map((r) => {
        const secret = isSecretKey(r.settingKey);
        // Only this app's own environment can override a row, and only for
        // its own scope. Another app's overrides are invisible from here.
        const overridden = r.app === SETTINGS_SCOPE && this.isOverridden(r.settingKey);
        const value = overridden ? this.overrides[r.settingKey] : String(r.settingValue ?? '');
        return {
          key: r.settingKey,
          app: r.app,
          value: secret ? '' : value,
          hasValue: value.trim() !== '',
          secret,
          description: r.description == null ? '' : String(r.description),
          source: overridden ? ('environment' as const) : ('store' as const),
        };
      });

    // An override for a key the store has no row for yet (NocoDB seeded
    // before the key existed, or bootstrap has not run) is still in force —
    // show it rather than letting it act invisibly.
    const present = new Set(items.filter((i) => i.app === SETTINGS_SCOPE).map((i) => i.key));
    for (const [key, value] of Object.entries(this.overrides)) {
      if (present.has(key)) continue;
      const secret = isSecretKey(key);
      items.push({
        key,
        app: SETTINGS_SCOPE,
        value: secret ? '' : value,
        hasValue: String(value).trim() !== '',
        secret,
        description: described.get(key) ?? '',
        source: 'environment',
      });
    }
    return items.sort((a, b) => a.app.localeCompare(b.app) || a.key.localeCompare(b.key));
  }

  /** Write a key to the store. Refused when the environment pins it. */
  async set(key: string, value: string, app: string = SETTINGS_SCOPE): Promise<void> {
    if (!isManagedScope(app)) throw new SettingScopeError(app);
    if (!isConsoleManaged(key)) throw new SettingUnmanagedError(key);
    // The store's own rule, enforced rather than just documented: a secret in
    // '*' is readable by every application that can reach PlatformConfig.
    if (app === '*' && isSecretKey(key)) throw new SettingScopeError('*', key);
    // Only this app's environment can shadow a row, and only in its own scope.
    if (app === SETTINGS_SCOPE && this.isOverridden(key)) throw new SettingOverriddenError(key);
    const { tableId } = await this.resolveIds();
    const rows = await this.listRows();
    const existing = rows.find((r) => r.app === app && r.settingKey === key);
    if (existing) {
      await this.api('PATCH', `/api/v2/tables/${tableId}/records`, [
        { Id: existing.Id, settingValue: value },
      ]);
    } else {
      const known = KNOWN_SETTINGS.find((s) => s.key === key);
      await this.api('POST', `/api/v2/tables/${tableId}/records`, {
        app,
        settingKey: key,
        settingValue: value,
        description: known?.description ?? '',
        bSecret: isSecretKey(key),
      });
    }
    this.cache = null; // read-your-writes
  }

  /**
   * Force the next read to hit NocoDB, IDs included — this is what the
   * operator-facing retry does, so a base that was missing a moment ago is
   * re-detected rather than remembered as missing.
   */
  invalidate(): void {
    this.cache = null;
    this.ids = null;
  }
}
