import fs from 'node:fs';
import path from 'node:path';

/**
 * The bootstrap file — the one piece of configuration that cannot live in
 * the configuration store, because it is how the store is found.
 *
 * Everything else about this app is a row in `auth_tbl_Settings`; the
 * address of the NocoDB holding that table obviously cannot be. That is
 * the whole content of this file: where the settings store is, and the
 * token to read it with. The first-run wizard writes it, so a fresh
 * install is a browser session rather than a text editor, and it lives on
 * a named volume so a rebuild, a recreate or a restart keeps it.
 *
 * It is NOT a second place to configure the app. Two keys, no more — the
 * moment the store is reachable, the store is the answer to everything.
 *
 * Precedence is environment first: a deployment that already states these
 * as variables keeps doing so and never grows a file it did not ask for.
 */
export const LOCAL_CONFIG_DIR = process.env.IDENTITY_CONFIG_DIR || '/data';
export const LOCAL_CONFIG_PATH = path.join(LOCAL_CONFIG_DIR, 'config.json');

/** The only keys this file may carry. Anything else is a settings row. */
export const LOCAL_CONFIG_KEYS = ['NOCODB_BASE_URL', 'NOCODB_API_TOKEN'] as const;
export type LocalConfigKey = (typeof LOCAL_CONFIG_KEYS)[number];
export type LocalConfig = Partial<Record<LocalConfigKey, string>>;

/** Raised when the bootstrap file exists but cannot be believed. */
export class LocalConfigError extends Error {
  constructor(file: string, detail: string) {
    super(
      `${file} could not be read (${detail}). It holds the address of the ` +
        'settings store, so this app will not guess past it: repair the file, ' +
        'delete it to start the first-run wizard again, or state ' +
        'NOCODB_BASE_URL and NOCODB_API_TOKEN in the environment instead.'
    );
    this.name = 'LocalConfigError';
  }
}

/**
 * Read the bootstrap file. A missing file is the ordinary first-run state
 * and reads as "nothing set yet"; a corrupt one is an operator's problem
 * and is raised rather than silently treated as empty, which would look
 * to them exactly like a wizard that forgot what they typed.
 */
export function readLocalConfig(file: string = LOCAL_CONFIG_PATH): LocalConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new LocalConfigError(file, String((err as Error).message));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LocalConfigError(file, 'not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LocalConfigError(file, 'not a JSON object');
  }
  const out: LocalConfig = {};
  for (const key of LOCAL_CONFIG_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    // Blank counts as unset, matching how the environment is read.
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim();
  }
  return out;
}

/**
 * Write the bootstrap file, replacing it whole. Written to a temporary
 * name in the same directory and renamed over the target, so a crash
 * mid-write leaves the previous file intact rather than a half one — this
 * is the file the app needs in order to start at all.
 *
 * Mode 0600: it carries an API token.
 */
export function writeLocalConfig(values: LocalConfig, file: string = LOCAL_CONFIG_PATH): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(values, null, 2) + '\n';
  const tmp = path.join(dir, `.config.json.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the temp file may not exist; the original error is the one to raise */
    }
    throw err;
  }
}

/**
 * Exit so the supervisor starts us again on the file we just wrote.
 *
 * The process reads its configuration once, at boot, and hands pieces of it
 * to things that hold it for their lifetime — the settings store, the
 * database pool. Rebuilding all of that in place would be a second, less
 * travelled way to be configured; coming back up is the same path every
 * other start takes. Deliberately a named function so tests can stub it,
 * and delayed so the response reaches the browser first.
 */
export function restartToApplyConfig(delayMs = 250): void {
  setTimeout(() => process.exit(0), delayMs).unref();
}

/**
 * Can the wizard persist what it collects? Checked before it offers to.
 *
 * A test of the directory as it stands, never an attempt to create it: this
 * runs on every /api/setup/status call, and a creating variant would put a
 * blocking mkdir of an operator-supplied path in a request handler. The
 * directory is made by the image and mounted by compose; writeLocalConfig
 * still creates it if something exotic has not.
 */
export function localConfigWritable(dir: string = LOCAL_CONFIG_DIR): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fold the bootstrap file into an environment, without overriding anything
 * already stated there. Applied once at startup so that every later reader
 * — loadConfig, the settings overrides — sees one merged picture and none
 * of them has to know this file exists.
 */
export function applyLocalConfig(
  env: NodeJS.ProcessEnv = process.env,
  file: string = LOCAL_CONFIG_PATH
): LocalConfig {
  const local = readLocalConfig(file);
  for (const [key, value] of Object.entries(local)) {
    const stated = env[key];
    if (typeof stated !== 'string' || stated.trim() === '') env[key] = value;
  }
  return local;
}
