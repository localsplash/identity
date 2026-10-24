import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mysql from 'mysql2/promise';
import { runMigrations, MIGRATIONS } from './migrations';

/**
 * Real-MySQL migration tests: clean install, upgrade of a pre-ownership
 * database, and second-run no-op. Skipped unless TEST_DB_URL points at a
 * disposable MySQL (CI provides one; locally e.g.
 * TEST_DB_URL=mysql://root:devpass@127.0.0.1:13306/id_db_migration_test).
 * The named database is DROPPED and recreated — never point this at real data.
 */

const url = process.env.TEST_DB_URL;
const suite = describe.skipIf(!url);

suite('id_db migrations (real MySQL)', () => {
  let pool: mysql.Pool;
  let dbName: string;

  beforeAll(async () => {
    const parsed = new URL(url!);
    dbName = parsed.pathname.replace(/^\//, '') || 'id_db_migration_test';
    const admin = await mysql.createConnection({
      host: parsed.hostname,
      port: Number(parsed.port || 3306),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    });
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.query(`CREATE DATABASE \`${dbName}\``);
    await admin.end();
    pool = mysql.createPool({ uri: url!, connectionLimit: 3, timezone: 'Z' });
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function tableNames(): Promise<string[]> {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT TABLE_NAME name FROM information_schema.tables WHERE table_schema = ?`,
      [dbName]
    );
    return rows.map((r) => String(r.name)).sort();
  }

  it('clean install applies every migration and creates the full schema', async () => {
    const applied = await runMigrations(pool);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.name));
    const tables = await tableNames();
    for (const t of [
      'identity_tbl_User',
      'identity_tbl_SignIn',
      'identity_tbl_Session',
      'identity_tbl_AuthCode',
      'identity_tbl_App',
      'identity_tbl_Event',
      'identity_tbl_Delivery',
      'identity_tbl_SsoNonce',
      'identity_tbl_DirectoryKey',
      'identity_tbl_Migration',
    ]) {
      expect(tables).toContain(t);
    }
  });

  it('a second run is a no-op', async () => {
    expect(await runMigrations(pool)).toEqual([]);
    expect(await runMigrations(pool)).toEqual([]);
  });

  it('upgrades a pre-ownership database without data loss', async () => {
    // Simulate a database created by an earlier deployment: the current
    // tables and data exist, but no migration history was ever recorded.
    await pool.query(`INSERT INTO identity_tbl_User (email, displayName) VALUES (?, ?)`, [
      'ada@x.tld',
      'Ada',
    ]);
    const [before] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT iUserId FROM identity_tbl_User WHERE email = 'ada@x.tld'`
    );
    const iUserId = before[0].iUserId as number;

    await pool.query(`DROP TABLE identity_tbl_DirectoryKey`);
    await pool.query(`DROP TABLE identity_tbl_Migration`);

    const applied = await runMigrations(pool);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.name));

    // Existing users retain their iUserId (and can therefore authenticate).
    const [after] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT iUserId, email, displayName FROM identity_tbl_User WHERE email = 'ada@x.tld'`
    );
    expect(after).toHaveLength(1);
    expect(after[0].iUserId).toBe(iUserId);
    expect(after[0].displayName).toBe('Ada');

    expect(await runMigrations(pool)).toEqual([]);
  });

  it('0007 merges users sharing an address and renames the sign-in table', async () => {
    await pool.query(`DROP DATABASE \`${dbName}\``);
    await pool.query(`CREATE DATABASE \`${dbName}\``);
    await pool.query(`USE \`${dbName}\``);
    const conn = await pool.getConnection();
    try {
      await conn.query(`USE \`${dbName}\``);
      await conn.query(
        `CREATE TABLE identity_tbl_Migration (sName VARCHAR(128) PRIMARY KEY,
          dtApplied DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`
      );
      for (const m of MIGRATIONS.slice(0, 6)) {
        await m.run(conn);
        await conn.query(`INSERT INTO identity_tbl_Migration (sName) VALUES (?)`, [m.name]);
      }
      // An invitation with tenant access, and the same person signed in
      // separately (unproven Microsoft address) with none.
      const [t] = await conn.query<mysql.ResultSetHeader>(
        `INSERT INTO identity_tbl_Tenant (name, slug) VALUES ('A', 'a')`
      );
      const [invite] = await conn.query<mysql.ResultSetHeader>(
        `INSERT INTO identity_tbl_User (email) VALUES ('Bo@Example.test ')`
      );
      const [signedIn] = await conn.query<mysql.ResultSetHeader>(
        `INSERT INTO identity_tbl_User (email, displayName) VALUES ('bo@example.test', 'Bo')`
      );
      await conn.query(
        `INSERT INTO identity_tbl_Identity (iUserId, provider, subject) VALUES (?, 'microsoft', 'bo')`,
        [signedIn.insertId]
      );
      await conn.query(
        `INSERT INTO identity_tbl_Membership (iTenantId, iUserId, role) VALUES (?, ?, 'TENANT_ADMIN')`,
        [t.insertId, invite.insertId]
      );
    } finally {
      conn.release();
    }
    expect(await runMigrations(pool)).toEqual(['0007_one_user_per_email']);
    const tables = await tableNames();
    expect(tables).toContain('identity_tbl_SignIn');
    expect(tables).not.toContain('identity_tbl_Identity');
    const [users] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT u.iUserId, u.email, m.role FROM identity_tbl_User u
        LEFT JOIN identity_tbl_Membership m ON m.iUserId = u.iUserId`
    );
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: 'bo@example.test', role: 'TENANT_ADMIN' });
    await expect(
      pool.query(`INSERT INTO identity_tbl_User (email) VALUES ('bo@example.test')`)
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    expect(await runMigrations(pool)).toEqual([]);
  });
});
