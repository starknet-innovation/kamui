import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { PostgresRegistryStore } from '../services/registry/postgres-store';
import { PostgresRecoveryJobs } from '../services/recovery/postgres-store';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateSqliteToPostgres } from './migrate-sqlite';
import { acquirePostgresWriterLock, initializePostgres } from './postgres';

const configured = process.env.KAMUI_TEST_POSTGRES_URL;
const pgTest = configured ? test : test.skip;
let admin: SQL;
let sql: SQL;
let url: string;
const dbName = `kamui_migration_${process.pid}_${Math.random().toString(16).slice(2, 10)}`;
const binding = '0x534e5f5345504f4c4941:0x123';
const jobId = '0x' + '1'.repeat(62);
const jobHash = createHash('sha256').update(jobId).digest('hex');
const temporary: string[] = [];

beforeAll(async () => {
  if (!configured) return;
  admin = new SQL(configured);
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  const parsed = new URL(configured); parsed.pathname = `/${dbName}`; url = parsed.toString();
  sql = new SQL(url);
});
afterEach(async () => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  if (!configured) return;
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
});
afterAll(async () => {
  if (!configured) return;
  await sql.close();
  await admin.unsafe(`DROP DATABASE "${dbName}"`);
  await admin.close();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kamui-pg-migrate-')); temporary.push(dir);
  const registryPath = join(dir, 'registry.sqlite');
  const recoveryPath = join(dir, 'recovery.sqlite');
  const registry = new Database(registryPath);
  registry.exec('CREATE TABLE sessions(id INTEGER PRIMARY KEY AUTOINCREMENT,account TEXT NOT NULL,public_key TEXT NOT NULL,valid_until INTEGER NOT NULL,created_at INTEGER NOT NULL,session TEXT NOT NULL,UNIQUE(account,public_key)); CREATE TABLE used_messages(message TEXT PRIMARY KEY,expires INTEGER NOT NULL) WITHOUT ROWID');
  for (const [id, key, expires] of [[1, '0x2', 9], [9, '0x3', 9999999999]] as const) {
    const value = { publicKey: key, origin: 'https://example.test', validUntil: expires, maxCalls: 1, maxFeePerTx: '0x1', calls: [], limits: [] };
    registry.query('INSERT INTO sessions(id,account,public_key,valid_until,created_at,session) VALUES(?,?,?,?,?,?)').run(id, '0x1', key, expires, 3, JSON.stringify(value));
  }
  registry.query("UPDATE sqlite_sequence SET seq=17 WHERE name='sessions'").run();
  registry.query('INSERT INTO used_messages VALUES(?,?)').run('0x123', 1);
  registry.query('INSERT INTO used_messages VALUES(?,?)').run('0x124', 9999999999);
  registry.close();
  const recovery = new Database(recoveryPath);
  recovery.exec('CREATE TABLE recovery_jobs(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,account TEXT NOT NULL,state TEXT NOT NULL,finished_at INTEGER,intent TEXT); CREATE TABLE recovery_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  recovery.query('INSERT INTO recovery_meta VALUES(?,?)').run('binding', binding);
  const intent = JSON.stringify({ kind: 'recover', address: '0x1', identity: '0x2', transaction_hash: '0x3', sender_address: '0x4', nonce: '0x5' });
  recovery.query('INSERT INTO recovery_jobs VALUES(?,?,?,?,?,?)').run(jobHash, 'b'.repeat(64), '1', '{"status":"running"}', null, intent);
  recovery.query('INSERT INTO recovery_jobs VALUES(?,?,?,?,?,?)').run('c'.repeat(64), 'd'.repeat(64), '2', '{"status":"failed","error":"TEST","httpStatus":409}', 1, null);
  recovery.close();
  return { registryPath, recoveryPath, binding, apiStopped: true as const, intent };
}

pgTest('imports exact rows, expired replay history, active intent and original identity sequence without changing SQLite', async () => {
  const source = fixture();
  const registryBefore = readFileSync(source.registryPath), recoveryBefore = readFileSync(source.recoveryPath);
  const counts = await migrateSqliteToPostgres(url, source);
  expect(counts).toEqual({ sessions: 2, usedMessages: 2, recoveryJobs: 2, recoveryMetadata: 1 });
  expect(readFileSync(source.registryPath)).toEqual(registryBefore);
  expect(readFileSync(source.recoveryPath)).toEqual(recoveryBefore);
  const [row] = await sql`SELECT id,fingerprint,account,state,finished_at,intent FROM recovery_jobs WHERE account='1'`;
  expect(row).toEqual({ id:jobHash, fingerprint:'b'.repeat(64), account:'1', state:'{"status":"running"}', finished_at:null, intent:source.intent });
  const messages: {message:string}[] = await sql`SELECT message FROM registry_used_messages ORDER BY message`;
  expect(messages).toEqual([{message:'0x123'},{message:'0x124'}]);
  const [next] = await sql`INSERT INTO registry_sessions(account,public_key,valid_until,created_at,session) VALUES('0x1','0x4',9,3,'{}') RETURNING id::text AS id`;
  expect(next.id).toBe('18');
});

pgTest('refuses to merge into a nonempty target and leaves it unchanged', async () => {
  const source = fixture();
  await initializePostgres(sql);
  await sql`INSERT INTO registry_used_messages(message,expires) VALUES('0x456',123)`;
  await expect(migrateSqliteToPostgres(url, source)).rejects.toThrow('SQLITE_MIGRATION_TARGET_NOT_EMPTY');
  const messages: {message:string}[] = await sql`SELECT message FROM registry_used_messages`;
  expect(messages).toEqual([{message:'0x456'}]);
  expect((await sql`SELECT count(*)::int AS n FROM recovery_jobs`)[0].n).toBe(0);
});

pgTest('refuses a repeated import even after all migrated data is removed', async () => {
  const source = fixture();
  await migrateSqliteToPostgres(url, source);
  await sql.unsafe('TRUNCATE registry_sessions,registry_used_messages,recovery_jobs,recovery_meta');
  await expect(migrateSqliteToPostgres(url, source)).rejects.toThrow('SQLITE_MIGRATION_TARGET_NOT_EMPTY');
});

pgTest('wrong chain/class binding and malformed JSON never import data', async () => {
  const source = fixture();
  await expect(migrateSqliteToPostgres(url, { ...source, binding:'other-network' })).rejects.toThrow('RECOVERY_DB_NETWORK_MISMATCH');
  const recovery = new Database(source.recoveryPath);
  recovery.query('UPDATE recovery_jobs SET state=? WHERE account=?').run('not-json', '1'); recovery.close();
  await expect(migrateSqliteToPostgres(url, source)).rejects.toThrow('SQLITE_MIGRATION_INVALID_SOURCE');
});

pgTest('verification mismatch rolls all target rows back', async () => {
  const source = fixture();
  await initializePostgres(sql);
  await sql.unsafe(`CREATE FUNCTION corrupt_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.session := NEW.session || ' '; RETURN NEW; END $$; CREATE TRIGGER corrupt_import BEFORE INSERT ON registry_sessions FOR EACH ROW EXECUTE FUNCTION corrupt_import()`);
  await expect(migrateSqliteToPostgres(url, source)).rejects.toThrow('SQLITE_MIGRATION_VERIFICATION_FAILED');
  expect((await sql`SELECT count(*)::int AS n FROM registry_sessions`)[0].n).toBe(0);
  expect((await sql`SELECT count(*)::int AS n FROM registry_used_messages`)[0].n).toBe(0);
  expect((await sql`SELECT count(*)::int AS n FROM recovery_jobs`)[0].n).toBe(0);
  expect((await sql`SELECT count(*)::int AS n FROM recovery_meta`)[0].n).toBe(0);
});

pgTest('migration refuses a running PostgreSQL API writer and requires explicit SQLite shutdown acknowledgement', async () => {
  const source = fixture();
  const lease = await acquirePostgresWriterLock(url);
  try { await expect(migrateSqliteToPostgres(url, source)).rejects.toThrow('POSTGRES_WRITER_ALREADY_RUNNING'); }
  finally { await lease.close(); }
  await expect(migrateSqliteToPostgres(url, { ...source, apiStopped:false } as any)).rejects.toThrow('SQLITE_MIGRATION_STOP_API_REQUIRED');
});

pgTest('CLI errors redact driver URLs and source paths', async () => {
  const missing = '/MIGRATION_PRIVATE_PATH_DO_NOT_LOG';
  const child = Bun.spawn([process.execPath, join(import.meta.dir,'../scripts/migrate-postgres.ts'), '--api-stopped', missing, missing], {
    env: { ...process.env, DATABASE_URL:url, CHAIN_ID:'SN_SEPOLIA', KAMUI_ACCOUNT_CLASS_HASH:'0x123' }, stdout:'pipe', stderr:'pipe',
  });
  const output = await new Response(child.stderr).text();
  expect(await child.exited).toBe(1);
  expect(output).not.toContain(missing); expect(output).not.toContain(url);
  expect(JSON.parse(output)).toEqual({status:'refused',error:'SQLITE_MIGRATION_FAILED'});
});

pgTest('imported replay protection and uncertain intent retain live store semantics', async () => {
  const source = fixture();
  await migrateSqliteToPostgres(url, source);
  const lease = await acquirePostgresWriterLock(url);
  try {
    const registry = new PostgresRegistryStore(lease.sql);
    expect(await registry.useOnce('0x124', 9999999999, 10)).toBe(false);
    const jobs = await PostgresRecoveryJobs.create(lease.sql, { binding, now: () => 100 });
    expect(await jobs.status(jobId)).toEqual({ status:'running' });
    await jobs.reconcile({ getTransactionReceipt:async () => { throw new Error('not yet accepted'); } } as any, jobId);
    expect(await jobs.status(jobId)).toEqual({ status:'running', phase:'reconciling', transaction_hash:'0x3' });
    await expect(jobs.assertAccountAvailable('0x1')).rejects.toThrow('IN_PROGRESS');
    await jobs.reconcile({ getTransactionReceipt:async () => ({ finality_status:'ACCEPTED_ON_L2', execution_status:'SUCCEEDED' }) } as any, jobId);
    expect(await jobs.status(jobId)).toEqual({ status:'succeeded', result:{ address:'0x1', identity:'0x2', transaction_hash:'0x3' } });
    await jobs.assertAccountAvailable('0x1');
  } finally { await lease.close(); }
});

pgTest('unknown recovery metadata is refused rather than copying unsupported or secret fields', async () => {
  const source = fixture();
  const recovery = new Database(source.recoveryPath);
  recovery.query('INSERT INTO recovery_meta(key,value) VALUES(?,?)').run('unexpected', 'PRIVATE_SENTINEL');
  recovery.close();
  await expect(migrateSqliteToPostgres(url, source)).rejects.toThrow('SQLITE_MIGRATION_INVALID_SOURCE');
});
