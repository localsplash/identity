import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LocalConfigError,
  applyLocalConfig,
  localConfigWritable,
  readLocalConfig,
  writeLocalConfig,
} from './localConfig';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-config-'));
  file = path.join(dir, 'config.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('readLocalConfig', () => {
  it('reads a missing file as the first-run state, not an error', () => {
    expect(readLocalConfig(file)).toEqual({});
  });

  it('round-trips the two keys it is allowed to carry', () => {
    writeLocalConfig({ NOCODB_BASE_URL: 'https://nocodb.test', NOCODB_API_TOKEN: 'tok' }, file);
    expect(readLocalConfig(file)).toEqual({
      NOCODB_BASE_URL: 'https://nocodb.test',
      NOCODB_API_TOKEN: 'tok',
    });
  });

  it('ignores blank values and anything that is not one of its keys', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        NOCODB_BASE_URL: '  https://nocodb.test  ',
        NOCODB_API_TOKEN: '   ',
        trustedCIDR: '0.0.0.0/0',
        DB_PASSWORD: 'nope',
      })
    );
    // trustedCIDR is a platform-wide settings row; a local copy would be a
    // second answer that silently outranked it, so it is not accepted here.
    expect(readLocalConfig(file)).toEqual({ NOCODB_BASE_URL: 'https://nocodb.test' });
  });

  it('refuses to guess past a corrupt file', () => {
    fs.writeFileSync(file, '{ not json');
    expect(() => readLocalConfig(file)).toThrow(LocalConfigError);
    fs.writeFileSync(file, '["an", "array"]');
    expect(() => readLocalConfig(file)).toThrow(/not a JSON object/);
  });
});

describe('writeLocalConfig', () => {
  it('creates the directory and keeps the token off other users', () => {
    const nested = path.join(dir, 'deep', 'config.json');
    writeLocalConfig({ NOCODB_API_TOKEN: 'tok' }, nested);
    expect(readLocalConfig(nested)).toEqual({ NOCODB_API_TOKEN: 'tok' });
    expect(fs.statSync(nested).mode & 0o077).toBe(0);
  });

  it('leaves no temporary files behind', () => {
    writeLocalConfig({ NOCODB_API_TOKEN: 'tok' }, file);
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });

  it('replaces rather than merges, so a rewrite cannot leave a stale half', () => {
    writeLocalConfig({ NOCODB_BASE_URL: 'https://old.test', NOCODB_API_TOKEN: 'a' }, file);
    writeLocalConfig({ NOCODB_BASE_URL: 'https://new.test' }, file);
    expect(readLocalConfig(file)).toEqual({ NOCODB_BASE_URL: 'https://new.test' });
  });
});

describe('applyLocalConfig', () => {
  it('fills gaps in the environment', () => {
    writeLocalConfig({ NOCODB_BASE_URL: 'https://nocodb.test', NOCODB_API_TOKEN: 'tok' }, file);
    const env: NodeJS.ProcessEnv = {};
    applyLocalConfig(env, file);
    expect(env.NOCODB_BASE_URL).toBe('https://nocodb.test');
    expect(env.NOCODB_API_TOKEN).toBe('tok');
  });

  it('never overrides what the deployment already stated', () => {
    writeLocalConfig({ NOCODB_BASE_URL: 'https://file.test', NOCODB_API_TOKEN: 'file' }, file);
    const env: NodeJS.ProcessEnv = { NOCODB_BASE_URL: 'https://env.test', NOCODB_API_TOKEN: '  ' };
    applyLocalConfig(env, file);
    expect(env.NOCODB_BASE_URL).toBe('https://env.test');
    // Blank counts as unset, the same rule the settings overrides use.
    expect(env.NOCODB_API_TOKEN).toBe('file');
  });
});

describe('localConfigWritable', () => {
  it('reports on the directory as it stands, and never creates one', () => {
    expect(localConfigWritable(dir)).toBe(true);

    const absent = path.join(dir, 'not-there');
    expect(localConfigWritable(absent)).toBe(false);
    expect(fs.existsSync(absent)).toBe(false);
  });

  it('is false for a directory this process cannot write', () => {
    const readonly = path.join(dir, 'readonly');
    fs.mkdirSync(readonly);
    fs.chmodSync(readonly, 0o500);
    // Root ignores the mode bits, so only assert where that is meaningful.
    if (process.getuid?.() !== 0) expect(localConfigWritable(readonly)).toBe(false);
    fs.chmodSync(readonly, 0o700);
  });
});
