import { describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { randomUUID } from 'node:crypto';
import { PostgresRegistryStore, REGISTRY_SCHEMA_SQL } from './postgres-store';
import type { StoredSession } from './store';
import { listSessions, putSession, removeSession, type RegistryContext } from './registry';
import { shortString } from 'starknet';

// Opt in only to an explicitly supplied disposable database. No developer .env is read.
const url = process.env.KAMUI_TEST_POSTGRES_URL;
const now = 1_800_000_000;
const session = (key: string, until = now + 3600): StoredSession => ({
  publicKey: key, origin: 'https://app.example', validUntil: until, maxCalls: 10,
  maxFeePerTx: '0x0', calls: [{ to: '0x1', entrypoint: 'ping' }], limits: [],
});

async function withDatabase(work: (first: SQL, second: SQL) => Promise<void>) {
  const schema = 'kamui_registry_' + randomUUID().replaceAll('-', '');
  const admin = new SQL(url!, { max: 1 });
  let first: SQL | undefined;
  let second: SQL | undefined;
  try {
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    first = new SQL(url!, { max: 4, connection: { search_path: schema } });
    second = new SQL(url!, { max: 4, connection: { search_path: schema } });
    await first.unsafe(REGISTRY_SCHEMA_SQL);
    await work(first, second);
  } finally {
    await first?.close();
    await second?.close();
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.close();
  }
}

describe.skipIf(!url)('PostgreSQL registry (explicit disposable database)', () => {
  test('concurrent replay admission is once-only and expiry boundary stays inclusive', async () => {
    await withDatabase(async (first, second) => {
      const a = new PostgresRegistryStore(first);
      const b = new PostgresRegistryStore(second);
      const admitted = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).useOnce('0x123', now + 300, now)));
      expect(admitted.filter(Boolean)).toHaveLength(1);
      expect(await b.useOnce('0x123', now + 300, now + 300)).toBe(false);
      expect(await b.useOnce('0x123', now + 301, now + 301)).toBe(true);
    });
  });

  test('concurrent inserts cannot exceed the per-account limit, even with no initial rows', async () => {
    await withDatabase(async (first, second) => {
      const a = new PostgresRegistryStore(first, 3);
      const b = new PostgresRegistryStore(second, 3);
      const admitted = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).put('0x1', session('0x' + (i + 1).toString(16)), now)));
      expect(admitted.filter(Boolean)).toHaveLength(3);
      const listed = await a.list('0x1', now);
      expect(listed).toHaveLength(3);
      const replacement = { ...listed[0]!, origin: 'https://other.example' };
      expect(await b.put('0x1', replacement, now + 1)).toBe(true);
      expect(await a.list('0x1', now)).toHaveLength(3);
      expect((await a.list('0x1', now))[0]!.origin).toBe('https://other.example');
      expect(await a.put('0x2', session('0xabc'), now)).toBe(true);
      expect(await b.list('0x2', now)).toHaveLength(1);
    });
  });

  test('equal-time ordering, expiry, removal and state survive another connection', async () => {
    await withDatabase(async (first, second) => {
      const a = new PostgresRegistryStore(first, 2);
      expect(await a.put('0x1', session('0x1', now + 1), now)).toBe(true);
      expect(await a.put('0x1', session('0x2'), now)).toBe(true);
      const b = new PostgresRegistryStore(second, 2);
      expect((await b.list('0x1', now)).map(s => s.publicKey)).toEqual(['0x2', '0x1']);
      expect(await b.put('0x1', session('0x3'), now + 1)).toBe(true);
      expect((await b.list('0x1', now + 1)).map(s => s.publicKey)).toEqual(['0x3', '0x2']);
      expect((await b.list('0x1', now + 1))[0]!.createdAt).toBe(now + 1);
      expect(await b.remove('0x1', '0x2')).toBe(true);
      expect(await b.remove('0x1', '0x2')).toBe(false);
      expect(await a.list('0x2', now)).toEqual([]);
      expect(await a.dropExpired(now + 3600)).toBe(1);
      expect(await b.list('0x1', now + 3600)).toEqual([]);
    });
  });

  test('registry routes await asynchronous replay and persistence decisions', async () => {
    await withDatabase(async first => {
      const ctx: RegistryContext = {
        chainId: '0x534e5f5345504f4c4941', classHash: '0x1',
        store: new PostgresRegistryStore(first, 1), now: () => now,
        provider: {
          getClassHashAt: async () => '0x1',
          callContract: async () => [shortString.encodeShortString('VALID')],
        } as any,
      };
      const body = { account: '0x1', timestamp: now, nonce: '0x1', signature: ['0x1', '0x2'], session: session('0x2') };
      await expect(putSession(body, ctx)).resolves.toEqual({ ok: true });
      await expect(putSession(body, ctx)).rejects.toMatchObject({ status: 401, message: 'REPLAYED' });
      await expect(putSession({ ...body, nonce: '0x2', session: session('0x3') }, ctx)).rejects.toMatchObject({ status: 409, message: 'REGISTRY_FULL' });
      const read = await listSessions({ ...body, nonce: '0x3' }, ctx);
      expect(read.sessions.map(s => s.publicKey)).toEqual(['0x2']);
      await expect(removeSession({ ...body, nonce: '0x4', publicKey: '0x2' }, ctx)).resolves.toEqual({ ok: true });
      expect((await listSessions({ ...body, nonce: '0x5' }, ctx)).sessions).toEqual([]);
    });
  });

  test('SQL parameters keep hostile text inert', async () => {
    await withDatabase(async first => {
      const a = new PostgresRegistryStore(first);
      const value = "0x1'; DROP TABLE registry_sessions; --";
      expect(await a.put(value, session(value), now)).toBe(true);
      expect(await a.useOnce(value, now + 300, now)).toBe(true);
      expect((await a.list(value, now))[0]!.publicKey).toBe(value);
      expect(await a.remove(value, value)).toBe(true);
      expect(await a.list(value, now)).toEqual([]);
    });
  });
});
