import { buildApp } from './app';
import { loadConfig } from './config';
import { LOCAL_CONFIG_PATH, applyLocalConfig } from './localConfig';
import { runMigrations } from './migrations';
import { parseCidrList } from './net';
import { isUnclaimed } from './providers';
import { SETTINGS_BASE_NAME, SETTINGS_TABLE_NAME, SettingsUnavailableError } from './settings';
import { drainDeliveries } from './webhooks';

const RETRY_DELAY_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // The bootstrap file first: it may be where NOCODB_BASE_URL and
  // NOCODB_API_TOKEN come from, and everything below reads them from the
  // environment. Stated variables still win; this only fills the gaps.
  const local = applyLocalConfig();
  if (Object.keys(local).length) {
    console.log(`[settings] store address read from ${LOCAL_CONFIG_PATH}`);
  }

  const config = loadConfig();
  const { app, db, settingsStore } = buildApp();

/**
   * The settings store is not optional and there is no fallback once its
   * address is known: this app cannot learn its own database, its trusted
   * network, or its OAuth credentials without it. So a store that is named
   * but unusable is find-or-die — one retry for the ordinary case of NocoDB
   * still coming up beside us, then exit with the reason rather than serving
   * an instance that would answer every request with a fault it cannot
   * explain.
   *
   * A store that has not been named at all is a different thing entirely.
   * That is a fresh install, and the only way to name it — short of an
   * operator hand-writing a file into a volume — is the wizard this process
   * serves. Exiting would make that wizard unreachable and the install
   * impossible to finish from a browser, so we listen instead and let
   * /setup collect the address.
   */
  let storeReady = false;
  for (let attempt = 1; ; attempt++) {
    try {
      await settingsStore.bootstrap();
      storeReady = true;
      console.log(`[settings] ${SETTINGS_BASE_NAME}.${SETTINGS_TABLE_NAME} ready`);
      // Seeded rows are empty on purpose: a table being created for the
      // first time is not where a public URL or a domain gets invented. The
      // setup wizard fills those in from the URL the first admin arrives on.
      const pinned = settingsStore.overriddenKeys();
      if (pinned.length) {
        console.log(`[settings] overridden by the environment: ${pinned.join(', ')}`);
      }
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof SettingsUnavailableError && err.reason === 'unconfigured') {
        console.warn(`[settings] ${message}`);
        console.warn(
          '[settings] First run: nothing has told this app where its settings ' +
            'live yet. Open it in a browser — /setup asks for the NocoDB address, ' +
            `the API token and the trusted network, and writes them to ${LOCAL_CONFIG_PATH}.`
        );
        break;
      }
      if (attempt === 1) {
        console.warn(`[settings] ${message} — retrying once in ${RETRY_DELAY_MS / 1000}s`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      console.error(`[settings] ${message}`);
      console.error(
        `[settings] Cannot start without the ${SETTINGS_BASE_NAME} base at ` +
          `${config.NOCODB_BASE_URL}. Fix NOCODB_BASE_URL / NOCODB_API_TOKEN, or create ` +
          `the base (its name must be unique), then start again.`
      );
      process.exit(1);
    }
  }

  const settings = storeReady ? await settingsStore.getAll() : {};

  // Network trust is security configuration: a malformed CIDR entry, or an
  // empty trustedCIDR in a production deployment that admits callers by
  // network, must stop the process at startup rather than fail requests
  // ambiguously at runtime.
  //
  // The one exception is an instance nobody has claimed yet. On a brand-new
  // install every setting is empty by design — including this one — and the
  // only way to fill any of them in is the wizard this process serves. Dying
  // here would make that wizard permanently unreachable (the image sets
  // NODE_ENV=production), so a fresh install could never reach the state the
  // check is defending. While unclaimed the process starts and says what is
  // missing; the endpoints the network policy guards stay shut regardless,
  // because peerIsTrusted() denies on an empty list. Claiming the instance
  // makes the check binding again, so a running deployment cannot drift into
  // serving those endpoints without a trusted network named.
  const trusted = parseCidrList(settings.trustedCIDR ?? '');
  if (
    storeReady &&
    config.NODE_ENV === 'production' &&
    config.IDENTITY_APP_AUTH_MODE !== 'secret' &&
    trusted.length === 0
  ) {
    const detail =
      `IDENTITY_APP_AUTH_MODE=${config.IDENTITY_APP_AUTH_MODE} requires trustedCIDR in ` +
      `${SETTINGS_BASE_NAME}.${SETTINGS_TABLE_NAME} to name the trusted network in production`;
    if (!isUnclaimed(settings)) throw new Error(detail);
    console.warn(
      `[trust] ${detail} — starting anyway because this instance is unclaimed. ` +
        'The server-only endpoints (/api/token, /api/apps/register, /api/events, ' +
        '/api/directory/*) reject every caller until it is set.'
    );
  }

  // The identity schema — this repo is the sole owner; versioned, additive,
  // recorded migrations (a second run is a no-op).
  //
  // The database coordinates are settings, so on a brand-new install they
  // may not exist yet. That is a first-run state, not a crash: the app still
  // listens, /setup collects the coordinates, and the schema is applied by
  // the ticker below (or by the wizard itself) as soon as they work.
  let schemaReady = false;
  let lastSchemaError = '';
  const ensureSchema = async (): Promise<void> => {
    if (schemaReady) return;
    try {
      const applied = await runMigrations(db);
      schemaReady = true;
      console.log(
        applied.length
          ? `[db] applied migrations: ${applied.join(', ')}`
          : '[db] schema up to date'
      );
    } catch (err) {
      // One line per distinct problem — this retries every tick.
      const message = String(err);
      if (message !== lastSchemaError) {
        lastSchemaError = message;
        console.warn(`[db] schema not applied yet: ${message}`);
      }
    }
  };
  await ensureSchema();

  // Webhook delivery ticker. Deliveries are durable rows, so this is a
  // drain loop rather than a scheduler: a restart mid-retry resumes here,
  // and a due row is picked up within one tick.
  //
  // A pass is serial and each delivery may sit on a 10s timeout, so it can
  // easily outlast the 5s interval. Without this guard the next tick would
  // pick up rows the running pass has not marked yet and send them twice.
  let draining = false;
  const tick = async () => {
    if (draining) return;
    draining = true;
    try {
      await ensureSchema();
      if (!schemaReady) return;
      await drainDeliveries(db);
    } catch (err) {
      console.error(`[webhooks] delivery pass failed: ${String(err)}`);
    } finally {
      draining = false;
    }
  };
  const ticker = setInterval(() => void tick(), 5_000);
  ticker.unref();
  void tick();

  app.listen(config.PORT, () => {
    console.log(`identity listening on :${config.PORT}`);
  });
}

main().catch((err) => {
  if (err instanceof SettingsUnavailableError) console.error(`[settings] ${err.message}`);
  else console.error(err);
  process.exit(1);
});
