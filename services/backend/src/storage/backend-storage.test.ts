import { describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { randomUUID } from 'node:crypto';
import { openBackendStorage } from './backend-storage';

const url = process.env.KAMUI_TEST_POSTGRES_URL;
const binding = '0x534e5f5345504f4c4941:0x123';

test('PostgreSQL factory refuses ambiguous SQLite paths before opening any store', async () => {
  await expect(openBackendStorage({ STORAGE_BACKEND: 'postgres', DATABASE_URL: 'postgres://localhost/unused', REGISTRY_DB: '/unused/registry.sqlite' }, binding, () => {})).rejects.toThrow('SQLITE_PATHS_WITH_POSTGRES');
  await expect(openBackendStorage({ STORAGE_BACKEND: 'postgres' }, binding, () => {})).rejects.toThrow('DATABASE_URL_REQUIRED');
});

describe.skipIf(!url)('PostgreSQL backend storage factory (explicit disposable database)', () => {
  test('initializes shared stores, rejects a concurrent writer and preserves data on reopen', async () => {
    const database = 'kamui_factory_' + randomUUID().replaceAll('-', '');
    const admin = new SQL(url!);
    let inspector: SQL | undefined;
    let first: Awaited<ReturnType<typeof openBackendStorage>> | undefined;
    let reopened: Awaited<ReturnType<typeof openBackendStorage>> | undefined;
    let leaseLost = 0;
    try {
      await admin.unsafe(`CREATE DATABASE "${database}"`);
      const target = new URL(url!);
      target.pathname = '/' + database;
      const env = { STORAGE_BACKEND: 'postgres', DATABASE_URL: target.toString() };
      first = await openBackendStorage(env, binding, () => { leaseLost++; });
      expect(first.backend).toBe('postgres');
      expect(first.recoveryJobs.durable).toBe(true);
      expect(first.store.journalMode).toBe('postgresql');
      inspector = new SQL(target.toString());
      expect((await inspector`SELECT value FROM kamui_storage_meta WHERE key = 'schema_version'`)[0].value).toBe('2');
      expect((await inspector`SELECT value FROM recovery_meta WHERE key = 'binding'`)[0].value).toBe(binding);
      const now = 1_800_000_000;
      const session = { publicKey: '0x2', origin: 'https://app.example', validUntil: now + 3600, maxCalls: 2, maxFeePerTx: '0x0', calls: [], limits: [] };
      expect(await first.store.put('0x1', session, now)).toBe(true);
      expect(await first.store.useOnce('0xabc', now + 300, now)).toBe(true);
      await expect(openBackendStorage(env, binding, () => {})).rejects.toThrow('POSTGRES_WRITER_ALREADY_RUNNING');
      await first.close();
      first = undefined;
      // A wrong network/class cannot silently adopt this persisted database.
      await expect(openBackendStorage(env, 'different-binding', () => {})).rejects.toThrow('RECOVERY_DB_NETWORK_MISMATCH');
      reopened = await openBackendStorage(env, binding, () => { leaseLost++; });
      expect(await reopened.store.list('0x1', now)).toEqual([{ ...session, createdAt: now }]);
      expect(await reopened.store.useOnce('0xabc', now + 300, now)).toBe(false);
      expect(leaseLost).toBe(0);
    } finally {
      await first?.close();
      await reopened?.close();
      await inspector?.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.close();
    }
  });
});
