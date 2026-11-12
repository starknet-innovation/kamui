// Offline cutover only. The operator must stop SQLite writers first; PostgreSQL fencing
// cannot stop a process that is still writing the source files.
import { Database } from 'bun:sqlite';
import { realpathSync, statSync } from 'node:fs';
import { acquirePostgresWriterLock, initializePostgres, postgresUrl } from './postgres';

type Row = Record<string, string | bigint | null>;
export type SqliteMigrationOptions = {
  registryPath: string;
  recoveryPath: string;
  binding: string;
  apiStopped: true;
};
export type SqliteMigrationCounts = { sessions: number; usedMessages: number; recoveryJobs: number; recoveryMetadata: number };
const HEX = /^0x[0-9a-fA-F]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;
const canonical = (row: Row) => JSON.stringify(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])));
const invalid = (): never => { throw new Error('SQLITE_MIGRATION_INVALID_SOURCE'); };
const integer = (v: unknown, minimum = 0n): v is bigint => typeof v === 'bigint' && v >= minimum && v <= BigInt(Number.MAX_SAFE_INTEGER);
const text = (v: unknown): v is string => typeof v === 'string';
const object = (value: unknown): Record<string, any> => {
  if (!text(value)) return invalid();
  let parsed: any;
  try { parsed = JSON.parse(value); } catch { return invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid();
  return parsed;
};
function noSecrets(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (['jwt', 'pepper', 'blinding', 'signature', 'keyProof', 'proof', 'jobId'].includes(key)) invalid();
    noSecrets(entry);
  }
}
function snapshot(db: Database, table: string, columns: readonly string[], order: string): Row[] {
  const actual = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (actual.length !== columns.length || actual.some(({ name }) => !columns.includes(name))) invalid();
  return db.query(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${order}`).all() as Row[];
}
function openSource(path: string): Database {
  if (path === ':memory:' || !statSync(path).isFile()) throw new Error('SQLITE_MIGRATION_SOURCE_REQUIRED');
  const db = new Database(path, { readonly: true, strict: true, safeIntegers: true });
  try {
    db.exec('PRAGMA query_only=ON');
    db.exec('BEGIN');
    const checked = db.query('PRAGMA quick_check').all() as { quick_check: string }[];
    if (checked.length !== 1 || checked[0]!.quick_check !== 'ok') invalid();
    return db;
  } catch (e) { db.close(); throw e; }
}

/** Imports exact rows atomically; never prunes expired/terminal rows during cutover. */
export async function migrateSqliteToPostgres(url: string, options: SqliteMigrationOptions): Promise<SqliteMigrationCounts> {
  if (options.apiStopped !== true) throw new Error('SQLITE_MIGRATION_STOP_API_REQUIRED');
  if (!options.binding || realpathSync(options.registryPath) === realpathSync(options.recoveryPath)) throw new Error('SQLITE_MIGRATION_INVALID_SOURCE');
  postgresUrl(url);
  let registry: Database | undefined;
  let recovery: Database | undefined;
  let lockLost = false;
  const assertLock = () => { if (lockLost) throw new Error('POSTGRES_WRITER_LOCK_LOST'); };
  const lock = await acquirePostgresWriterLock(url, () => { lockLost = true; });
  const sql = lock.sql;
  try {
    registry = openSource(options.registryPath);
    recovery = openSource(options.recoveryPath);
    const sessions = snapshot(registry, 'sessions', ['id', 'account', 'public_key', 'valid_until', 'created_at', 'session'], 'id');
    const messages = snapshot(registry, 'used_messages', ['message', 'expires'], 'message');
    const jobs = snapshot(recovery, 'recovery_jobs', ['id', 'fingerprint', 'account', 'state', 'finished_at', 'intent'], 'id');
    const metadata = snapshot(recovery, 'recovery_meta', ['key', 'value'], 'key');
    if (metadata.some((r) => r.key !== 'binding')) invalid();
    const binding = metadata.find((r) => r.key === 'binding');
    // Missing binding on a populated historical journal is not safe to guess.
    if (binding?.value !== options.binding) throw new Error('RECOVERY_DB_NETWORK_MISMATCH');
    for (const r of sessions) {
      const value = object(r.session);
      if (!integer(r.id, 1n) || !text(r.account) || !HEX.test(r.account) || !text(r.public_key) || !HEX.test(r.public_key) || !integer(r.valid_until, 1n) || !integer(r.created_at) || value.publicKey !== r.public_key || value.validUntil !== Number(r.valid_until)) invalid();
      noSecrets(value);
    }
    for (const r of messages) if (!text(r.message) || !HEX.test(r.message) || !integer(r.expires)) invalid();
    for (const r of jobs) {
      const state = object(r.state);
      if (!text(r.id) || !HASH.test(r.id) || !text(r.fingerprint) || !HASH.test(r.fingerprint) || !text(r.account) || !/^(0|[1-9a-f][0-9a-f]*)$/.test(r.account) || (r.finished_at !== null && !integer(r.finished_at))) invalid();
      if (r.finished_at === null ? state.status !== 'running' : !['failed', 'succeeded'].includes(state.status)) invalid();
      if (r.finished_at !== null && r.intent !== null) invalid();
      noSecrets(state);
      if (r.intent !== null) {
        const intent = object(r.intent);
        if (!['recover', 'deploy', 'prepare'].includes(intent.kind) || !HEX.test(intent.transaction_hash) || !HEX.test(intent.address) || !HEX.test(intent.identity)) invalid();
        noSecrets(intent);
      }
    }
    for (const r of metadata) if (!text(r.key) || !text(r.value)) invalid();
    const sequenceRow = registry.query("SELECT seq FROM sqlite_sequence WHERE name = 'sessions'").get() as { seq: bigint } | null;
    const highestId = sessions.length ? sessions[sessions.length - 1]!.id as bigint : 0n;
    const sequence = sequenceRow?.seq ?? highestId;
    if (!integer(sequence) || sequence < highestId || sequence === BigInt(Number.MAX_SAFE_INTEGER)) invalid();
    assertLock();
    await initializePostgres(sql, options.binding);
    assertLock();
    const counts = await sql.begin(async (tx) => {
      await tx.unsafe('CREATE TABLE IF NOT EXISTS sqlite_migration (id INTEGER PRIMARY KEY CHECK (id = 1))');
      // Excludes accidental target writes even by callers that did not use Kamui's writer lock.
      await tx.unsafe('LOCK TABLE registry_sessions, registry_used_messages, recovery_jobs, recovery_meta, sqlite_migration IN ACCESS EXCLUSIVE MODE');
      const [{ occupied }] = await tx`SELECT EXISTS(SELECT 1 FROM registry_sessions) OR EXISTS(SELECT 1 FROM registry_used_messages) OR EXISTS(SELECT 1 FROM recovery_jobs) OR EXISTS(SELECT 1 FROM sqlite_migration) OR EXISTS(SELECT 1 FROM recovery_meta) AS occupied`;
      if (occupied) throw new Error('SQLITE_MIGRATION_TARGET_NOT_EMPTY');
      assertLock();
      for (const r of sessions) await tx`INSERT INTO registry_sessions (id, account, public_key, valid_until, created_at, session) VALUES (${r.id}, ${r.account}, ${r.public_key}, ${r.valid_until}, ${r.created_at}, ${r.session})`;
      for (const r of messages) await tx`INSERT INTO registry_used_messages (message, expires) VALUES (${r.message}, ${r.expires})`;
      for (const r of jobs) await tx`INSERT INTO recovery_jobs (id, fingerprint, account, state, finished_at, intent) VALUES (${r.id}, ${r.fingerprint}, ${r.account}, ${r.state}, ${r.finished_at}, ${r.intent})`;
      for (const r of metadata) await tx`INSERT INTO recovery_meta (key, value) VALUES (${r.key}, ${r.value}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      const compare = (source: Row[], target: Row[]) => {
        if (source.length !== target.length || source.some((r, i) => canonical(r) !== canonical(target[i]!))) throw new Error('SQLITE_MIGRATION_VERIFICATION_FAILED');
      };
      compare(sessions, await tx`SELECT id::text AS id, account, public_key, valid_until::text AS valid_until, created_at::text AS created_at, session FROM registry_sessions ORDER BY id`);
      compare(messages, await tx`SELECT message, expires::text AS expires FROM registry_used_messages ORDER BY message COLLATE "C"`);
      compare(jobs, await tx`SELECT id, fingerprint, account, state, finished_at::text AS finished_at, intent FROM recovery_jobs ORDER BY id COLLATE "C"`);
      compare(metadata, await tx`SELECT key, value FROM recovery_meta ORDER BY key COLLATE "C"`);
      // Identity restart is transactional (unlike setval), including when verification fails.
      await tx.unsafe(`ALTER TABLE registry_sessions ALTER COLUMN id RESTART WITH ${sequence + 1n}`);
      await tx`INSERT INTO sqlite_migration (id) VALUES (1)`;
      assertLock();
      return { sessions: sessions.length, usedMessages: messages.length, recoveryJobs: jobs.length, recoveryMetadata: metadata.length };
    });
    return counts;
  } finally {
    registry?.close();
    recovery?.close();
    await lock.close();
  }
}
