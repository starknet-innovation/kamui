import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { acquirePostgresWriterLock, initializePostgres, postgresUrl, storageBackend } from './postgres';
import { randomUUID } from 'node:crypto';

test('storage configuration cannot silently fall back after PostgreSQL selection', () => {
  expect(storageBackend({})).toBe('sqlite');
  expect(storageBackend({ DATABASE_URL: 'postgres://localhost/kamui' })).toBe('postgres');
  expect(() => storageBackend({ STORAGE_BACKEND: 'postgres' })).toThrow('DATABASE_URL_REQUIRED');
  expect(() => storageBackend({ STORAGE_BACKEND: 'other' })).toThrow('STORAGE_BACKEND_INVALID');
  expect(() => storageBackend({ STORAGE_BACKEND: 'sqlite', DATABASE_URL: 'postgres://localhost/kamui' })).toThrow('DATABASE_URL_WITH_SQLITE');
  expect(() => storageBackend({ DATABASE_URL: 'postgres://localhost/kamui', RECOVERY_DB: 'old.sqlite' })).toThrow('SQLITE_PATHS_WITH_POSTGRES');
  expect(() => postgresUrl('https://secret.invalid')).toThrow('DATABASE_URL_INVALID');
});

const integration = process.env.KAMUI_TEST_POSTGRES_URL ? test : test.skip;
let admin: SQL;
let sql: SQL;
let url: string;
const db = `kamui_storage_${randomUUID().replaceAll('-', '')}`;
beforeAll(async () => {
  if (!process.env.KAMUI_TEST_POSTGRES_URL) return;
  admin = new SQL(process.env.KAMUI_TEST_POSTGRES_URL);
  await admin.unsafe(`CREATE DATABASE ${db}`);
  const target = new URL(process.env.KAMUI_TEST_POSTGRES_URL); target.pathname = `/${db}`; url = target.toString();
  sql = new SQL(url);
});
afterAll(async () => {
  if (!admin) return;
  await sql.close();
  await admin.unsafe(`DROP DATABASE ${db} WITH (FORCE)`);
  await admin.close();
});

integration('exclusive lease blocks another API/operator and releases on close', async () => {
  const first = await acquirePostgresWriterLock(url);
  try { await expect(acquirePostgresWriterLock(url)).rejects.toThrow('POSTGRES_WRITER_ALREADY_RUNNING'); }
  finally { await first.close(); }
  const next = await acquirePostgresWriterLock(url);
  await next.close();
});

integration('losing the writer session closes its data pool and forbids reconnection', async () => {
  let lost = 0;
  const lease = await acquirePostgresWriterLock(url, () => { lost++; });
  try {
    await lease.sql`CREATE TABLE lease_probe (id INTEGER PRIMARY KEY)`;
    await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${db} AND application_name = 'kamui-writer-lease'`;
    const deadline = Date.now() + 8000;
    while (!lost && Date.now() < deadline) await Bun.sleep(10);
    expect(lost).toBe(1);
    const writes = await Promise.allSettled(Array.from({ length: 8 }, (_, id) => lease.sql`INSERT INTO lease_probe (id) VALUES (${id})`));
    expect(writes.every(result => result.status === 'rejected')).toBe(true);
    await expect(lease.sql.begin(tx => tx`INSERT INTO lease_probe (id) VALUES (${99})`)).rejects.toThrow();
    const [{ n }] = await sql`SELECT COUNT(*)::INTEGER AS n FROM lease_probe`;
    expect(n).toBe(0);
    // Another writer can acquire after loss, but the old pool stays permanently closed.
    const replacement = await acquirePostgresWriterLock(url);
    try {
      await replacement.sql`INSERT INTO lease_probe (id) VALUES (${1})`;
      await expect(lease.sql`INSERT INTO lease_probe (id) VALUES (${2})`).rejects.toThrow();
      const [{ n }] = await replacement.sql`SELECT COUNT(*)::INTEGER AS n FROM lease_probe`;
      expect(n).toBe(1);
      expect(lost).toBe(1);
    } finally { await replacement.close(); }
  } finally { await lease.close(); }
});

integration('transactions use the locked session and queue outside queries until commit', async () => {
  const lease = await acquirePostgresWriterLock(url);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const [{ pid }] = await lease.sql`SELECT pg_backend_pid() AS pid`;
    const transaction = lease.sql.begin(async tx => {
      const [{ pid: txPid }] = await tx`SELECT pg_backend_pid() AS pid`;
      expect(txPid).toBe(pid);
      entered();
      await gate;
      await tx`SELECT 1`;
    });
    await started;
    let completed = false;
    const outside = Promise.resolve(lease.sql`SELECT pg_backend_pid() AS pid`).then(rows => {
      completed = true;
      expect(rows[0].pid).toBe(pid);
    });
    await Bun.sleep(25);
    expect(completed).toBe(false);
    release();
    await Promise.all([transaction, outside]);
    expect(completed).toBe(true);
    await expect(acquirePostgresWriterLock(url)).rejects.toThrow('POSTGRES_WRITER_ALREADY_RUNNING');
  } finally { release(); await lease.close(); }
});

integration('schema initialization is repeatable and refuses unknown versions', async () => {
  await initializePostgres(sql);
  await initializePostgres(sql);
  await sql`UPDATE kamui_storage_meta SET value = '999' WHERE key = 'schema_version'`;
  await expect(initializePostgres(sql)).rejects.toThrow('POSTGRES_SCHEMA_VERSION_UNSUPPORTED');
});
