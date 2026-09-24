import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  KNOWN_SETTINGS,
  SettingsStore,
  SettingsUnavailableError,
  SETTINGS_BASE_NAME,
  SETTINGS_TABLE_NAME,
} from './settings';
import type { AppConfig } from './config';
import { dbCoordinates } from './db';

/**
 * The settings rule: the store holds what the wizard and /admin write, and
 * nothing is invented for a key it has not answered.
 */

const config = {
  NOCODB_BASE_URL: 'http://nocodb.test',
  NOCODB_API_TOKEN: 'token',
} as AppConfig;

type Row = { Id: number; Key: string; Value: string | null };

/**
 * A NocoDB stub. `bases` is what /meta/bases answers with, so a test can
 * present a missing base, two bases of the same name, or a rename between
 * calls — the cases the unique-name convention exists to catch.
 */
function stubNocoDb(
  rows: Row[],
  opts: { bases?: () => Array<{ id: string; title: string }>; tableTitle?: string } = {}
) {
  const calls: string[] = [];
  const bases = opts.bases ?? (() => [{ id: 'b1', title: SETTINGS_BASE_NAME }]);
  const tableTitle = opts.tableTitle ?? SETTINGS_TABLE_NAME;
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const json = (value: unknown) => ({ ok: true, json: async () => value }) as unknown as Response;

    if (url.endsWith('/api/v2/meta/bases')) return json({ list: bases() });
    if (/\/api\/v2\/meta\/bases\/[^/]+\/tables$/.test(url)) {
      return json({ list: [{ id: 't1', title: tableTitle }] });
    }
    if (url.includes('/api/v2/tables/t1/records')) {
      if (method === 'POST' || method === 'PATCH') return json({});
      return json({
        list: rows.map((r) => ({ Id:r.Id, app:'identity', settingKey:r.Key, settingValue:r.Value, description:'' })),
        pageInfo: { isLastPage: true },
      });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SettingsStore', () => {
  it('reads the store', async () => {
    stubNocoDb([{ Id: 1, Key: 'APP_BASE_URL', Value: 'https://identity.wisp.net' }]);
    const store = new SettingsStore(config);
    expect((await store.getAll()).APP_BASE_URL).toBe('https://identity.wisp.net');
  });

  it('leaves an unanswered key unset — no value is invented', async () => {
    stubNocoDb([{ Id: 1, Key: 'APP_BASE_URL', Value: '' }]);
    const store = new SettingsStore(config);
    expect((await store.getAll()).APP_BASE_URL).toBeUndefined();
  });

  it('fails loudly when the store cannot answer — there is no fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    const store = new SettingsStore(config);
    await expect(store.getAll()).rejects.toBeInstanceOf(SettingsUnavailableError);
  });

  it('shows the admin every row and the keys still to fill in', async () => {
    stubNocoDb([
      { Id: 1, Key: 'APP_BASE_URL', Value: 'https://identity.wisp.net' },
      { Id: 2, Key: 'PARENT_DOMAIN', Value: 'wisp.net' },
    ]);
    const store = new SettingsStore(config);
    const items = await store.listForAdmin();
    const byKey = Object.fromEntries(
      items.filter((i) => i.app === 'identity').map((i) => [i.key, i])
    );

    expect(byKey.APP_BASE_URL).toMatchObject({ value: 'https://identity.wisp.net', hasValue: true });
    expect(byKey.PARENT_DOMAIN).toMatchObject({ value: 'wisp.net', hasValue: true });
    // Known but unanswered — offered as an empty field rather than hidden.
    expect(byKey.GOOGLE_CLIENT_ID).toMatchObject({ value: '', hasValue: false });
  });
});

describe('database coordinates as settings', () => {
  it('reads the pool coordinates out of the settings', () => {
    expect(
      dbCoordinates({
        DB_HOST: 'mysql.internal',
        DB_PORT: '13306',
        DB_USER: 'id_app',
        DB_PASSWORD: 'pw',
        DB_NAME: 'id_db',
      })
    ).toEqual({
      host: 'mysql.internal',
      port: 13306,
      user: 'id_app',
      password: 'pw',
      database: 'id_db',
    });
  });

  it("falls back to MySQL's own port, and to no password", () => {
    expect(dbCoordinates({ DB_HOST: 'mysql.internal', DB_USER: 'id_app', DB_NAME: 'id_db' })).toEqual({
      host: 'mysql.internal',
      port: 3306,
      user: 'id_app',
      password: '',
      database: 'id_db',
    });
  });

  it('invents nothing when the deployment has not said where the database is', () => {
    expect(dbCoordinates({})).toBeNull();
    expect(dbCoordinates({ DB_HOST: 'mysql.internal' })).toBeNull();
    expect(dbCoordinates({ DB_HOST: 'mysql.internal', DB_USER: 'id_app' })).toBeNull();
  });
});

/**
 * The base is found by name, and the name is unique because we say it is.
 * Everything here is about not carrying a base ID around: a stored ID
 * survives a rename, outlives a restore, and cannot be checked by eye.
 */
describe('base-ID detection', () => {
  it('resolves the base by name and the table inside it', async () => {
    const { calls } = stubNocoDb([{ Id: 1, Key: 'PARENT_DOMAIN', Value: 'wisp.net' }]);
    const store = new SettingsStore(config);
    await store.getAll();
    expect(calls[0]).toBe('GET http://nocodb.test/api/v2/meta/bases');
    expect(calls[1]).toBe('GET http://nocodb.test/api/v2/meta/bases/b1/tables');
  });

  it('says so when no base carries the name', async () => {
    stubNocoDb([], { bases: () => [{ id: 'b9', title: 'SomethingElse' }] });
    const store = new SettingsStore(config);
    await expect(store.getAll()).rejects.toMatchObject({
      name: 'SettingsUnavailableError',
      reason: 'base_missing',
    });
  });

  it('refuses to guess when two bases carry the name', async () => {
    stubNocoDb([], {
      bases: () => [
        { id: 'b1', title: SETTINGS_BASE_NAME },
        { id: 'b2', title: SETTINGS_BASE_NAME },
      ],
    });
    const store = new SettingsStore(config);
    await expect(store.getAll()).rejects.toMatchObject({ reason: 'base_ambiguous' });
  });

  it('says so when the base has no settings table', async () => {
    stubNocoDb([], { tableTitle: 'some_other_table' });
    const store = new SettingsStore(config);
    await expect(store.getAll()).rejects.toMatchObject({ reason: 'table_missing' });
  });

  it('never remembers an ID it could not confirm', async () => {
    let title = 'RenamedByMistake';
    stubNocoDb([{ Id: 1, Key: 'PARENT_DOMAIN', Value: 'wisp.net' }], {
      bases: () => [{ id: 'b1', title }],
    });
    const store = new SettingsStore(config);
    await expect(store.getAll()).rejects.toMatchObject({ reason: 'base_missing' });

    // Renamed back in NocoDB: the next read re-detects, no restart.
    title = SETTINGS_BASE_NAME;
    expect((await store.getAll()).PARENT_DOMAIN).toBe('wisp.net');
  });

  it('re-detects the base after a rename once the cache turns over', async () => {
    let baseId = 'b1';
    const { calls } = stubNocoDb([{ Id: 1, Key: 'PARENT_DOMAIN', Value: 'wisp.net' }], {
      bases: () => [{ id: baseId, title: SETTINGS_BASE_NAME }],
    });
    const store = new SettingsStore(config);
    await store.getAll();

    // Inside the 30s window the cached IDs are reused — no extra lookups.
    const before = calls.length;
    await store.getAll();
    expect(calls.length).toBe(before);

    // invalidate() is what the operator-facing retry does; it drops the IDs
    // as well as the values, so a base restored under a new ID is found.
    baseId = 'b2';
    store.invalidate();
    await store.getAll();
    expect(calls).toContain('GET http://nocodb.test/api/v2/meta/bases/b2/tables');
  });
});

describe('PlatformConfig scope contract',()=>{
  function scoped(rows:unknown[]) {
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>
      url.endsWith('/api/v2/meta/bases') ? {list:[{id:'b',title:SETTINGS_BASE_NAME}]} :
      url.endsWith('/tables') ? {list:[{id:'t',title:SETTINGS_TABLE_NAME}]} :
      {list:rows,pageInfo:{isLastPage:true}}
    })));
  }
  it('uses exact scope then global, skips blanks and excludes other applications',async()=>{
    scoped([
      {Id:1,app:'*',settingKey:'PARENT_DOMAIN',settingValue:'x.tld'},
      {Id:2,app:'identity',settingKey:'PARENT_DOMAIN',settingValue:''},
      {Id:3,app:'echo',settingKey:'DB_PASSWORD',settingValue:'echo-only'},
      {Id:4,app:'*',settingKey:'APP_BASE_URL',settingValue:'https://global.x.tld'},
      {Id:5,app:'identity',settingKey:'APP_BASE_URL',settingValue:'https://identity.x.tld'},
    ]);
    expect(await new SettingsStore(config).getAll()).toEqual({PARENT_DOMAIN:'x.tld',APP_BASE_URL:'https://identity.x.tld'});
  });
  it('rejects duplicates even when values match instead of choosing the last row',async()=>{
    scoped([{Id:1,app:'identity',settingKey:'DB_NAME',settingValue:'platform_db'},{Id:2,app:'identity',settingKey:'DB_NAME',settingValue:'platform_db'}]);
    await expect(new SettingsStore(config).getAll()).rejects.toMatchObject({reason:'duplicate'});
  });
  it('lists another app\'s rows instead of hiding them behind its own',async()=>{
    // The same key in two scopes is two settings read by two applications.
    // Collapsing to the winner hid the one the operator came to edit.
    scoped([
      {Id:1,app:'identity',settingKey:'PARENT_DOMAIN',settingValue:'x.tld'},
      {Id:2,app:'echo-service',settingKey:'CORS_ORIGINS',settingValue:'https://echo.x.tld'},
      {Id:3,app:'echo-service',settingKey:'TYCHRON_WEBHOOK_BASIC_PASS',settingValue:'hunter2'},
    ]);
    const items=await new SettingsStore(config).listForAdmin();
    const service=items.filter(i=>i.app==='echo-service');
    expect(service.filter(i=>i.hasValue).map(i=>i.key).sort()).toEqual(['CORS_ORIGINS','TYCHRON_WEBHOOK_BASIC_PASS']);
    // TYCHRON_WEBHOOK_BASIC_PASS carries PASS, not PASSWORD — the earlier pattern
    // missed it, so the webhook credential was not treated as a secret.
    const pass=service.find(i=>i.key==='TYCHRON_WEBHOOK_BASIC_PASS');
    expect(pass).toMatchObject({secret:true,value:'',hasValue:true});
    for (const carrier of ['BANDWIDTH', 'TYCHRON']) {
      expect(service.find(i=>i.key===`${carrier}_WEBHOOK_BASIC_USER`)).toMatchObject({app:'echo-service',secret:false});
      expect(service.find(i=>i.key===`${carrier}_WEBHOOK_BASIC_PASS`)).toMatchObject({app:'echo-service',secret:true,value:''});
    }
    expect(service.some(i=>['WEBHOOK_BASIC_USER','WEBHOOK_BASIC_PASS'].includes(i.key))).toBe(false);
  });
  it('hides carrier-application credentials even when rows exist for them',async()=>{
    // Dropping them from KNOWN_SETTINGS alone would only remove the help text:
    // listForAdmin reads rows from the store, so an existing row would still
    // have been offered for editing, just undescribed.
    scoped([
      {Id:1,app:'echo-service',settingKey:'BANDWIDTH_API_TOKEN',settingValue:'legacy'},
      {Id:2,app:'echo-service',settingKey:'BANDWIDTH_MESSAGING_API_BASE_URL',settingValue:'https://sandbox'},
      {Id:3,app:'echo-service',settingKey:'TYCHRON_WEBHOOK_BASIC_USER',settingValue:'carrier'},
    ]);
    const keys=(await new SettingsStore(config).listForAdmin()).map(i=>i.key);
    expect(keys).not.toContain('BANDWIDTH_API_TOKEN');
    // The API base is deployment-wide, not per-carrier, so it stays.
    expect(keys).toContain('BANDWIDTH_MESSAGING_API_BASE_URL');
    expect(keys).toContain('TYCHRON_WEBHOOK_BASIC_USER');
  });
  it('refuses to write a carrier-application credential',async()=>{
    scoped([]);
    await expect(new SettingsStore(config).set('BANDWIDTH_API_SECRET','x','echo-service'))
      .rejects.toMatchObject({name:'SettingUnmanagedError'});
    expect(vi.mocked(fetch).mock.calls.find(([,init])=>init?.method==='POST')).toBeUndefined();
  });
  it('writes to the scope it was given, not always its own',async()=>{
    scoped([]);
    await new SettingsStore(config).set('TYCHRON_WEBHOOK_BASIC_USER','carrier','echo-service');
    const write=vi.mocked(fetch).mock.calls.find(([,init])=>init?.method==='POST');
    expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({
      app:'echo-service',settingKey:'TYCHRON_WEBHOOK_BASIC_USER',settingValue:'carrier',
    });
  });
  it('refuses a secret in global scope, where every app can read it',async()=>{
    scoped([]);
    await expect(new SettingsStore(config).set('TYCHRON_WEBHOOK_BASIC_PASS','hunter2','*'))
      .rejects.toMatchObject({name:'SettingScopeError'});
    expect(vi.mocked(fetch).mock.calls.find(([,init])=>init?.method==='POST')).toBeUndefined();
  });
  it('never updates a global row when writing an identity-scoped row',async()=>{
    scoped([{Id:1,app:'*',settingKey:'PARENT_DOMAIN',settingValue:'x.tld'}]);
    await new SettingsStore(config).set('PARENT_DOMAIN','new.tld');
    const calls=vi.mocked(fetch).mock.calls;
    const write=calls.find(([,init])=>init?.method==='POST');
    expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({app:'identity',settingKey:'PARENT_DOMAIN',settingValue:'new.tld'});
  });
});

describe('PlatformConfig write integrity', () => {
  function mutable(rows: Array<Record<string, unknown>>) {
    const writes: Array<{ method: string; body: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method || 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      let value: unknown;
      if (url.endsWith('/meta/bases')) value = { list: [{ id: 'b', title: SETTINGS_BASE_NAME }] };
      else if (url.endsWith('/tables')) value = { list: [{ id: 't', title: SETTINGS_TABLE_NAME }] };
      else if (method === 'GET') value = { list: rows.map((row) => ({ ...row })), pageInfo: { isLastPage: true } };
      else {
        writes.push({ method, body });
        if (method === 'POST') rows.push({ Id: rows.length + 1, ...body });
        if (method === 'PATCH') Object.assign(rows.find((row) => row.Id === body[0].Id)!, body[0]);
        if (method === 'DELETE') rows.splice(rows.findIndex((row) => row.Id === body[0].Id), 1);
        value = {};
      }
      return { ok: true, json: async () => value } as Response;
    }));
    return writes;
  }

  it('serializes concurrent creates into one insert and one update, even across stores', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const writes = mutable(rows);
    await Promise.all([
      new SettingsStore(config).set('TYCHRON_WEBHOOK_BASIC_USER', 'first', 'echo-service'),
      new SettingsStore(config).set('TYCHRON_WEBHOOK_BASIC_USER', 'second', 'echo-service'),
    ]);
    expect(writes.map((write) => write.method)).toEqual(['POST', 'PATCH']);
    expect(rows).toHaveLength(1);
    expect(rows[0].settingValue).toBe('second');
  });

  it('deletes blanked rows and never inserts missing blank rows or bootstrap seeds', async () => {
    const rows = [{ Id: 82, app: 'identity', settingKey: 'TYCHRON_WEBHOOK_BASIC_USER', settingValue: '' }];
    const writes = mutable(rows);
    const store = new SettingsStore(config);
    await store.set('TYCHRON_WEBHOOK_BASIC_USER', '   ');
    await store.set('TYCHRON_WEBHOOK_BASIC_PASS', '');
    await store.bootstrap();
    expect(writes).toEqual([{ method: 'DELETE', body: [{ Id: 82 }] }]);
    expect(rows).toEqual([]);
    const catalog = await store.listForAdmin();
    expect(catalog.find((item) => item.key === 'TYCHRON_WEBHOOK_BASIC_PASS')).toMatchObject({ app: 'echo-service', hasValue: false, secret: true });
  });

  it('reports every colliding row without values and refuses writes into duplicates', async () => {
    const writes = mutable([
      { Id: 1, app: 'identity', settingKey: 'DB_PASSWORD', settingValue: 'secret-one' },
      { Id: 7, app: 'identity', settingKey: 'DB_PASSWORD', settingValue: 'secret-two' },
      { Id: 83, app: 'identity', settingKey: 'TYCHRON_WEBHOOK_BASIC_PASS', settingValue: '' },
    ]);
    const store = new SettingsStore(config);
    await expect(store.getAll()).rejects.toThrow('identity/DB_PASSWORD (rows 1, 7)');
    await expect(store.set('DB_PASSWORD', 'replacement')).rejects.toMatchObject({ reason: 'duplicate' });
    const report = await store.audit();
    expect(report.duplicates).toEqual([{ app: 'identity', key: 'DB_PASSWORD', rowIds: [1, 7] }]);
    expect(report.blankRows).toEqual([{ app: 'identity', key: 'TYCHRON_WEBHOOK_BASIC_PASS', rowId: 83 }]);
    expect(JSON.stringify(report)).not.toContain('secret-');
    expect(writes).toEqual([]);
  });
});
