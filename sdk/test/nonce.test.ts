// Finding a session's next sponsored nonce: how many reads it takes, that it never hands out a
// used nonce, and that it never reports a session used up while a nonce is free. And renewing a
// session with the key it already has.
import { describe, expect, test } from 'bun:test';
import type { ProviderInterface } from 'starknet';
import {
  beginConnect,
  beginExtend,
  finishConnect,
  loadConnection,
  nextSessionNonce,
  parseConnectRequest,
  resultUrl,
  sessionCall,
  type ConnectOptions,
  type Connection,
  type KeyValueStore,
} from '../src';

const APP = 'https://game.example';
const KEYCHAIN = 'https://keychain.example';
const ACCOUNT = '0x3ec3b3ead6762ecf0172e0d5e3f9df472e66608e3f483f300a784dc9652d193';
const GAME = '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc';
const KEY = '0x5f513650a95ebc650404cfb1da39de4eba808aab4273f0c9a0d6d3bb09d3966';
const BASE = 0x1000n;
const SEPOLIA = '0x534e5f5345504f4c4941';

/** An account's view of one session: which offsets are used, and how often it was asked. */
function fakeAccount(used: Iterable<number> = [], base = BASE) {
  const account = {
    base,
    used: new Set(used),
    baseReads: 0,
    nonceReads: 0,
    /** Largest number of nonce reads in flight at once. */
    peak: 0,
    inFlight: 0,
    sessionNonceBase: async (_key: string) => {
      account.baseReads++;
      return `0x${account.base.toString(16)}`;
    },
    isOutsideNonceAvailable: async (nonce: string | bigint | number) => {
      account.nonceReads++;
      account.peak = Math.max(account.peak, ++account.inFlight);
      await Promise.resolve();
      account.inFlight--;
      return !account.used.has(Number(BigInt(nonce) - account.base));
    },
  };
  return account;
}

const range = (n: number, from = 0) => Array.from({ length: n }, (_, i) => from + i);

describe('the next session nonce', () => {
  test('an unused session: the first nonce, in one read', async () => {
    const account = fakeAccount();
    expect(await nextSessionNonce(account, KEY, 1000)).toEqual({ nonce: '0x1000', offset: 0 });
    expect(account.nonceReads).toBe(1);
    expect(account.baseReads).toBe(1);
  });

  test('nonces used in order: the first free one, for every count and size', async () => {
    for (const maxCalls of [1, 2, 3, 7, 8, 9, 33]) {
      for (let usedCount = 0; usedCount <= maxCalls; usedCount++) {
        const account = fakeAccount(range(usedCount));
        const next = await nextSessionNonce(account, KEY, maxCalls);
        if (usedCount === maxCalls) expect(next).toBeNull();
        else expect(next).toEqual({ nonce: `0x${(BASE + BigInt(usedCount)).toString(16)}`, offset: usedCount });
      }
    }
  });

  test('a long session costs a logarithm of reads, not one per used nonce', async () => {
    for (const [maxCalls, usedCount] of [[1000, 500], [10_000, 9_999], [100_000, 54_321], [1_000_000, 999_999]] as const) {
      const account = fakeAccount(range(usedCount));
      expect((await nextSessionNonce(account, KEY, maxCalls))!.offset).toBe(usedCount);
      expect(account.nonceReads).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(usedCount + 1)) + 1);
    }
    // 500 used of 1000: the scan this replaces read 501 nonces.
    const account = fakeAccount(range(500));
    await nextSessionNonce(account, KEY, 1000);
    expect(account.nonceReads).toBe(18);
  });

  test('a good hint is one read; a stale one still finds a free nonce', async () => {
    const account = fakeAccount(range(500));
    expect((await nextSessionNonce(account, KEY, 1000, 0, { hint: 500 }))!.offset).toBe(500);
    expect(account.nonceReads).toBe(1);
    // A hint that is behind: a few reads to catch up.
    account.nonceReads = 0;
    expect((await nextSessionNonce(account, KEY, 1000, 0, { hint: 490 }))!.offset).toBe(500);
    expect(account.nonceReads).toBeLessThanOrEqual(10);
    // A hint that is ahead is free, so it is used; nothing below it is handed out twice.
    expect((await nextSessionNonce(account, KEY, 1000, 0, { hint: 700 }))!.offset).toBe(700);
  });

  test('the last nonce of the range is found, and the one after it is not', async () => {
    const account = fakeAccount(range(99));
    expect((await nextSessionNonce(account, KEY, 100))!.offset).toBe(99);
    expect(await nextSessionNonce(fakeAccount(), KEY, 1)).toEqual({ nonce: '0x1000', offset: 0 });
    expect(await nextSessionNonce(fakeAccount([0]), KEY, 1)).toBeNull();
    expect(await nextSessionNonce(fakeAccount(), KEY, 0)).toBeNull();
  });

  test('a used-up session reads every nonce once, in batches, before saying so', async () => {
    const account = fakeAccount(range(100));
    expect(await nextSessionNonce(account, KEY, 100)).toBeNull();
    expect(account.nonceReads).toBe(100);
    expect(account.peak).toBe(8);

    const quick = fakeAccount(range(100));
    expect(await nextSessionNonce(quick, KEY, 100, 0, { scanGaps: false })).toBeNull();
    expect(quick.nonceReads).toBe(8); // 0, 1, 3, 7, 15, 31, 63, 99
  });

  test('nonces used out of order: a free one behind used ones is still found', async () => {
    // Everything used except offset 40: the search runs off the end, the gap scan finds it.
    const holed = fakeAccount(range(100).filter((offset) => offset !== 40));
    expect((await nextSessionNonce(holed, KEY, 100))!.offset).toBe(40);
    // With the gap scan off, the same session looks used up.
    expect(await nextSessionNonce(holed, KEY, 100, 0, { scanGaps: false })).toBeNull();
    // Below `fromOffset` nothing is handed out, free or not.
    expect(await nextSessionNonce(holed, KEY, 100, 41)).toBeNull();
    expect((await nextSessionNonce(holed, KEY, 100, 40))!.offset).toBe(40);
    // The lowest of several gaps.
    const two = fakeAccount(range(100).filter((offset) => offset !== 90 && offset !== 22));
    expect((await nextSessionNonce(two, KEY, 100))!.offset).toBe(22);
  });

  test('whatever was used, the answer is a free nonce in range, and null only when none is', async () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let round = 0; round < 400; round++) {
      const maxCalls = 1 + Math.floor(random() * 60);
      const density = random();
      const used = range(maxCalls).filter(() => random() < density);
      const fromOffset = random() < 0.3 ? Math.floor(random() * (maxCalls + 2)) : 0;
      const hint = random() < 0.5 ? Math.floor(random() * (maxCalls + 2)) : undefined;
      const account = fakeAccount(used);
      const next = await nextSessionNonce(account, KEY, maxCalls, fromOffset, { hint });
      const free = range(maxCalls).filter((offset) => offset >= fromOffset && !account.used.has(offset));
      if (free.length === 0) expect(next).toBeNull();
      else {
        expect(free).toContain(next!.offset);
        expect(BigInt(next!.nonce)).toBe(BASE + BigInt(next!.offset));
      }
      // No offset is read twice.
      expect(account.nonceReads).toBeLessThanOrEqual(maxCalls);
    }
  });
});

/** A provider that answers the two reads `sessionCall` makes, from a fake account. */
function providerFor(account: ReturnType<typeof fakeAccount>): ProviderInterface {
  return {
    callContract: async ({ entrypoint, calldata }: { entrypoint: string; calldata: string[] }) => {
      if (entrypoint === 'get_session_nonce_base') return [await account.sessionNonceBase(calldata[0]!)];
      if (entrypoint === 'is_valid_outside_execution_nonce') return [(await account.isOutsideNonceAvailable(calldata[0]!)) ? '0x1' : '0x0'];
      throw new Error(`unexpected read ${entrypoint}`);
    },
  } as unknown as ProviderInterface;
}

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const options = (over: Partial<ConnectOptions> = {}): ConnectOptions => ({
  keychainUrl: KEYCHAIN,
  redirectUri: `${APP}/play`,
  validUntil: FUTURE,
  maxCalls: 50,
  calls: [{ to: GAME, entrypoint: 'move' }],
  ...over,
});

/** A connection as an approved connect request leaves it in the store. */
function connect(store: KeyValueStore, over: Partial<ConnectOptions> = {}): Connection {
  const request = parseConnectRequest(new URL(beginConnect(options(over), store)).hash, `${APP}/`)!;
  const back = resultUrl(request, { v: 1, id: request.id, ok: true, account: ACCOUNT, chainId: SEPOLIA, classHash: '0x1' });
  return finishConnect(new URL(back).hash, store)!;
}

const calls = [{ contractAddress: GAME, entrypoint: 'move', calldata: ['0x1'] }];
/** The nonce of an `execute_from_outside_v2` call: its second calldata felt. */
const nonceOf = (call: { calldata?: unknown }) => BigInt((call.calldata as string[])[1]!);

describe('session calls remember their place', () => {
  test('after the first call, each call is two reads: the base and the next nonce', async () => {
    const connection = connect(memoryStore(), { maxCalls: 1000 });
    const account = fakeAccount(range(300));
    const provider = providerFor(account);

    const first = (await sessionCall(connection, calls, provider))!;
    expect(first.offset).toBe(300);
    expect(nonceOf(first.call)).toBe(BASE + 300n);
    const searching = account.nonceReads;
    expect(searching).toBeGreaterThan(1);

    for (let offset = 301; offset < 320; offset++) {
      account.used.add(offset - 1); // the previous call was sent
      account.baseReads = account.nonceReads = 0;
      expect((await sessionCall(connection, calls, provider))!.offset).toBe(offset);
      expect(account.baseReads + account.nonceReads).toBe(2);
    }
  });

  test('the place is saved in the store when one is given, and read back from it', async () => {
    const store = memoryStore();
    const connection = connect(store, { maxCalls: 1000 });
    const account = fakeAccount(range(300));
    await sessionCall(connection, calls, providerFor(account), { store });
    expect(loadConnection(store)!.session.nonces).toEqual({ base: '0x1000', next: 301 });

    // A reload: a new object from the store finds its nonce in one read.
    account.used.add(300);
    account.nonceReads = 0;
    const reloaded = loadConnection(store)!;
    expect((await sessionCall(reloaded, calls, providerFor(account), { store }))!.offset).toBe(301);
    expect(account.nonceReads).toBe(1);

    // A store that no longer holds this connection is left alone.
    store.removeItem('kamui.connection');
    await sessionCall(reloaded, calls, providerFor(account), { store });
    expect(loadConnection(store)).toBeNull();
  });

  test('a call that was prepared and never sent does not block the session', async () => {
    const connection = connect(memoryStore(), { maxCalls: 3 });
    const account = fakeAccount();
    const provider = providerFor(account);
    expect((await sessionCall(connection, calls, provider))!.offset).toBe(0); // never sent
    expect((await sessionCall(connection, calls, provider))!.offset).toBe(1);
    account.used.add(1);
    expect((await sessionCall(connection, calls, provider))!.offset).toBe(2);
    account.used.add(2);
    // The range's end is reached; the nonce skipped at the start is found and used.
    expect((await sessionCall(connection, calls, provider))!.offset).toBe(0);
  });

  test('a used-up session answers null, and is not searched again', async () => {
    const connection = connect(memoryStore(), { maxCalls: 40 });
    const account = fakeAccount(range(40));
    const provider = providerFor(account);
    expect(await sessionCall(connection, calls, provider)).toBeNull();
    expect(account.nonceReads).toBe(40);
    account.nonceReads = 0;
    expect(await sessionCall(connection, calls, provider)).toBeNull();
    expect(account.nonceReads).toBe(0);
  });

  test('a number as the fourth argument is still the lowest offset to use', async () => {
    const connection = connect(memoryStore(), { maxCalls: 10 });
    const account = fakeAccount();
    expect((await sessionCall(connection, calls, providerFor(account), 4))!.offset).toBe(4);
    expect((await sessionCall(connection, calls, providerFor(account), { fromOffset: 7 }))!.offset).toBe(7);
  });
});

describe('renewing a session', () => {
  test('the request names the same key, and the answer keeps it', () => {
    const store = memoryStore();
    const connection = connect(store);
    const url = new URL(beginExtend(connection, options({ maxCalls: 500, validUntil: FUTURE + 86_400 }), store));
    expect(url.origin + url.pathname).toBe(`${KEYCHAIN}/connect`);
    const request = parseConnectRequest(url.hash, `${APP}/`)!;
    expect(request.session.publicKey).toBe(connection.session.publicKey);
    expect(request.session.maxCalls).toBe(500);
    expect(decodeURIComponent(url.hash)).not.toContain(connection.session.privateKey.slice(2));
    // Until the answer arrives the old connection is still the stored one.
    expect(loadConnection(store)).toEqual(connection);

    const back = resultUrl(request, { v: 1, id: request.id, ok: true, account: ACCOUNT, chainId: SEPOLIA, classHash: '0x1' });
    const renewed = finishConnect(new URL(back).hash, store)!;
    expect(renewed.session).toEqual({ privateKey: connection.session.privateKey, publicKey: connection.session.publicKey, validUntil: FUTURE + 86_400, maxCalls: 500 });
    expect(loadConnection(store)).toEqual(renewed);
  });

  test('a denied renewal leaves the connection as it was', () => {
    const store = memoryStore();
    const connection = connect(store);
    const request = parseConnectRequest(new URL(beginExtend(connection, options({ maxCalls: 500 }), store)).hash, `${APP}/`)!;
    const back = resultUrl(request, { v: 1, id: request.id, ok: false, error: 'denied by the user' });
    expect(() => finishConnect(new URL(back).hash, store)).toThrow(/denied by the user/);
    expect(loadConnection(store)).toEqual(connection);
  });

  test('a renewed session starts again at its new first nonce', async () => {
    const store = memoryStore();
    const connection = connect(store, { maxCalls: 5 });
    const account = fakeAccount(range(5));
    expect(await sessionCall(connection, calls, providerFor(account), { store })).toBeNull();
    expect(loadConnection(store)!.session.nonces).toMatchObject({ exhausted: true });

    // Approved: the account gives the key a new generation, so a new base and nothing used.
    const request = parseConnectRequest(new URL(beginExtend(connection, options({ maxCalls: 5 }), store)).hash, `${APP}/`)!;
    const renewed = finishConnect(new URL(resultUrl(request, { v: 1, id: request.id, ok: true, account: ACCOUNT, chainId: SEPOLIA, classHash: '0x1' })).hash, store)!;
    account.base = 0x9000n;
    account.used.clear();
    const next = (await sessionCall(renewed, calls, providerFor(account), { store }))!;
    expect(next.offset).toBe(0);
    expect(nonceOf(next.call)).toBe(0x9000n);

    // The same happens to a connection object that still remembers the old range.
    connection.session.nonces = { base: '0x1000', next: 5, exhausted: true };
    expect((await sessionCall(connection, calls, providerFor(account)))!.offset).toBe(0);
  });
});
