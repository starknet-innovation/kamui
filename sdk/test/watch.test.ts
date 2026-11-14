// Learning that a session ended: the expiry timer, the account's events (polled and pushed),
// the look at the start, and the reading of a failed call.
import { describe, expect, test } from 'bun:test';
import { hash, type ProviderInterface, type WebSocketChannel } from 'starknet';
import {
  SESSION_END_EVENT_KEYS,
  checkSessionEnded,
  isSessionRefusal,
  sessionEventTracker,
  watchSession,
  type Connection,
  type SessionEnd,
  type SessionEvent,
  type SessionEventChannel,
} from '../src';

const ACCOUNT = '0x3ec3b3ead6762ecf0172e0d5e3f9df472e66608e3f483f300a784dc9652d193';
const KEY = '0x5a1';
const OTHER_KEY = '0x5a2';
const NOW = 1_800_000_000;
const VALID_UNTIL = NOW + 3600;

const connection: Connection = {
  account: ACCOUNT,
  chainId: '0x534e5f5345504f4c4941',
  classHash: '0x1',
  session: { privateKey: '0x1', publicKey: KEY, validUntil: VALID_UNTIL, maxCalls: 10 },
};

const sel = (name: string) => hash.getSelectorFromName(name);
const hex = (value: number) => '0x' + value.toString(16);
const revoked = (key = KEY, tx = '0xa1', block = 101): SessionEvent => ({ keys: [sel('SessionKeyRevoked'), key], data: [], transaction_hash: tx, block_number: block });
const allRevoked = (tx = '0xa2', block = 101): SessionEvent => ({ keys: [sel('AllSessionsRevoked')], data: ['0x2'], transaction_hash: tx, block_number: block });
const ownerAdded = (tx = '0xa2', block = 101): SessionEvent => ({ keys: [sel('OwnerAdded'), '0xdead'], data: [], transaction_hash: tx, block_number: block });
const ownerRemoved = (tx = '0xa2', block = 101): SessionEvent => ({ keys: [sel('OwnerRemoved'), '0xdead'], data: [], transaction_hash: tx, block_number: block });
const keySet = (validUntil = VALID_UNTIL, key = KEY, tx = '0xa3', block = 101): SessionEvent => ({
  keys: [sel('SessionKeySet'), key],
  data: [hex(validUntil), '0xa', '0x0', '0x1', '0x1', '0x2'],
  transaction_hash: tx,
  block_number: block,
});

/** Timers that run only when the test says so. */
function fakeTimers() {
  let nextId = 1;
  const pending = new Map<number, { run: () => void; ms: number }>();
  return {
    pending,
    setTimeout(run: () => void, ms: number) {
      pending.set(nextId, { run, ms });
      return nextId++;
    },
    clearTimeout(timer: unknown) {
      pending.delete(timer as number);
    },
    /** Runs the pending timer set for `ms`. */
    fire(ms: number) {
      const found = [...pending].find(([, timer]) => timer.ms === ms);
      if (!found) throw new Error(`no timer of ${ms} ms`);
      pending.delete(found[0]);
      found[1].run();
    },
  };
}

/** A node: a block height, the session as the account reports it, and events by block. */
function fakeNode(init: { block?: number; validUntil?: number } = {}) {
  const node = {
    block: init.block ?? 100,
    /** 0 when the account no longer has the session. */
    validUntil: init.validUntil ?? VALID_UNTIL,
    events: [] as SessionEvent[],
    pageSize: 100,
    filters: [] as any[],
    reads: 0,
    fail: null as Error | null,
    provider: {
      async getBlockNumber() {
        if (node.fail) throw node.fail;
        return node.block;
      },
      async callContract({ entrypoint }: { entrypoint: string }) {
        if (entrypoint !== 'get_session_data') throw new Error(`unexpected ${entrypoint}`);
        node.reads += 1;
        return [hex(node.validUntil), '0xa', '0x0', '0x1'];
      },
      async getEvents(filter: any) {
        node.filters.push(filter);
        const matching = node.events.filter((event) => event.block_number! >= filter.from_block.block_number && event.block_number! <= filter.to_block.block_number);
        const start = filter.continuation_token ? Number(filter.continuation_token) : 0;
        const next = start + node.pageSize;
        return { events: matching.slice(start, next), ...(next < matching.length ? { continuation_token: String(next) } : {}) };
      },
    } as unknown as ProviderInterface,
  };
  return node;
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const POLL = 30_000;

function start(node: ReturnType<typeof fakeNode>, extra: { channel?: SessionEventChannel; now?: () => number } = {}) {
  const timers = fakeTimers();
  const ends: SessionEnd[] = [];
  const errors: unknown[] = [];
  const stop = watchSession(connection, node.provider, (end) => ends.push(end), { timers, now: extra.now ?? (() => NOW), onError: (error) => errors.push(error), channel: extra.channel });
  return { timers, ends, errors, stop };
}

describe('sessionEventTracker', () => {
  const track = (...events: SessionEvent[]) => {
    const tracker = sessionEventTracker(connection.session);
    for (const event of events) tracker.push(event);
    return tracker.ended;
  };

  test('nothing, or events about other sessions, leave the session alive', () => {
    expect(track()).toBeNull();
    expect(track(revoked(OTHER_KEY), keySet(NOW + 5, OTHER_KEY), { keys: [], data: [] })).toBeNull();
  });

  test('a revocation of this session', () => {
    expect(track(revoked())).toEqual({ reason: 'revoked', transactionHash: '0xa1', blockNumber: 101 });
  });

  test('a session key in another formatting is the same key', () => {
    expect(track(revoked('0x00005A1'))?.reason).toBe('revoked');
  });

  test('revoke_all_sessions', () => {
    expect(track(allRevoked())).toEqual({ reason: 'all-revoked', transactionHash: '0xa2', blockNumber: 101 });
  });

  test('a device added or removed in the same transaction', () => {
    expect(track(ownerAdded(), allRevoked())?.reason).toBe('owners-changed');
    expect(track(ownerRemoved(), ownerAdded(), allRevoked())?.reason).toBe('owners-changed');
  });

  test('an owner event of another transaction does not explain the revocation', () => {
    expect(track(ownerAdded('0xb0'), allRevoked('0xb1'))?.reason).toBe('all-revoked');
  });

  test('registered again with another expiry: replaced', () => {
    expect(track(keySet(VALID_UNTIL + 60))?.reason).toBe('replaced');
  });

  test('registered again with the same expiry: alive, whatever came before', () => {
    expect(track(keySet())).toBeNull();
    expect(track(revoked(), keySet())).toBeNull();
    expect(track(ownerAdded(), allRevoked(), keySet())).toBeNull();
  });

  test('the filter names the five events', () => {
    expect(SESSION_END_EVENT_KEYS).toEqual([[sel('SessionKeySet'), sel('SessionKeyRevoked'), sel('AllSessionsRevoked'), sel('OwnerAdded'), sel('OwnerRemoved')]]);
  });
});

describe('checkSessionEnded', () => {
  test('alive', async () => {
    expect(await checkSessionEnded(connection, fakeNode().provider, NOW)).toBeNull();
  });

  test('expired: decided locally, the account is not read', async () => {
    const node = fakeNode();
    expect(await checkSessionEnded(connection, node.provider, VALID_UNTIL + 1)).toEqual({ reason: 'expired' });
    expect(node.reads).toBe(0);
  });

  test('still valid in its last second, as on the account', async () => {
    expect(await checkSessionEnded(connection, fakeNode().provider, VALID_UNTIL)).toBeNull();
  });

  test('gone from the account', async () => {
    expect(await checkSessionEnded(connection, fakeNode({ validUntil: 0 }).provider, NOW)).toEqual({ reason: 'gone' });
  });

  test('registered with another expiry', async () => {
    expect(await checkSessionEnded(connection, fakeNode({ validUntil: VALID_UNTIL + 60 }).provider, NOW)).toEqual({ reason: 'replaced' });
  });
});

describe('isSessionRefusal', () => {
  test('the refusal as text', () => {
    expect(isSessionRefusal(new Error("sponsor: execution reverted: 'Kamui: invalid session'"))).toBe(true);
    expect(isSessionRefusal('Kamui: invalid session')).toBe(true);
  });

  test('the refusal as the felt a node prints', () => {
    expect(isSessionRefusal(new Error('Transaction reverted: 0x4b616d75693a20696e76616c69642073657373696f6e'))).toBe(true);
    expect(isSessionRefusal({ revert_reason: '0x4B616D75693A20696E76616C69642073657373696F6E' })).toBe(true);
  });

  test('the refusal in an RPC error’s data', () => {
    const error = Object.assign(new Error('RPC: starknet_estimateFee'), { data: { execution_error: 'Kamui: invalid session' } });
    expect(isSessionRefusal(error)).toBe(true);
  });

  test('anything else', () => {
    expect(isSessionRefusal(new Error('sponsor: SPONSOR_CAP'))).toBe(false);
    expect(isSessionRefusal(new Error('Kamui: invalid signature'))).toBe(false);
    expect(isSessionRefusal(undefined)).toBe(false);
    expect(isSessionRefusal(null)).toBe(false);
  });
});

describe('watchSession: expiry', () => {
  test('an expired session ends at once, with no network', async () => {
    const node = fakeNode();
    const { ends, timers } = start(node, { now: () => VALID_UNTIL + 1 });
    expect(ends).toEqual([{ reason: 'expired' }]);
    await settle();
    expect(node.reads).toBe(0);
    expect(timers.pending.size).toBe(0);
  });

  test('a timer for the second after validUntil', async () => {
    let now = NOW;
    const { ends, timers } = start(fakeNode(), { now: () => now });
    await settle();
    expect(ends).toEqual([]);
    now = VALID_UNTIL + 1;
    timers.fire(3601 * 1000);
    expect(ends).toEqual([{ reason: 'expired' }]);
    expect(timers.pending.size).toBe(0);
  });

  test('a wait longer than a timer can hold is cut into pieces', async () => {
    let now = NOW;
    const far: Connection = { ...connection, session: { ...connection.session, validUntil: NOW + 40 * 86400 } };
    const timers = fakeTimers();
    const ends: SessionEnd[] = [];
    const node = fakeNode({ validUntil: far.session.validUntil });
    watchSession(far, node.provider, (end) => ends.push(end), { timers, now: () => now });
    await settle();
    const max = 2 ** 31 - 1;
    now += Math.floor(max / 1000);
    timers.fire(max);
    expect(ends).toEqual([]);
    now = far.session.validUntil + 1;
    const rest = [...timers.pending.values()].find((timer) => timer.ms !== POLL)!;
    expect(rest.ms).toBeLessThan(max);
    rest.run();
    expect(ends).toEqual([{ reason: 'expired' }]);
  });
});

describe('watchSession: polling', () => {
  test('the first look finds a session already gone', async () => {
    const { ends, timers } = start(fakeNode({ validUntil: 0 }));
    await settle();
    expect(ends).toEqual([{ reason: 'gone' }]);
    expect(timers.pending.size).toBe(0);
  });

  test('reads events from the block after the first look, and only new blocks after that', async () => {
    const node = fakeNode({ block: 100 });
    const { ends, timers } = start(node);
    await settle();
    expect(node.filters).toEqual([]);

    // No new block: nothing to read.
    timers.fire(POLL);
    await settle();
    expect(node.filters).toEqual([]);

    node.block = 103;
    timers.fire(POLL);
    await settle();
    expect(node.filters).toEqual([{ address: ACCOUNT, from_block: { block_number: 101 }, to_block: { block_number: 103 }, keys: SESSION_END_EVENT_KEYS, chunk_size: 100 }]);

    node.block = 104;
    timers.fire(POLL);
    await settle();
    expect(node.filters[1].from_block).toEqual({ block_number: 104 });
    expect(ends).toEqual([]);
    // One read of the session in all: the look at the start.
    expect(node.reads).toBe(1);
  });

  test('a revocation', async () => {
    const node = fakeNode();
    const { ends, timers } = start(node);
    await settle();
    node.block = 101;
    node.events.push(revoked());
    timers.fire(POLL);
    await settle();
    expect(ends).toEqual([{ reason: 'revoked', transactionHash: '0xa1', blockNumber: 101 }]);
    expect(timers.pending.size).toBe(0);
  });

  test('a new device', async () => {
    const node = fakeNode();
    const { ends, timers } = start(node);
    await settle();
    node.block = 102;
    node.events.push(ownerAdded('0xc1', 102), allRevoked('0xc1', 102));
    timers.fire(POLL);
    await settle();
    expect(ends).toEqual([{ reason: 'owners-changed', transactionHash: '0xc1', blockNumber: 102 }]);
  });

  test('revoke all sessions', async () => {
    const node = fakeNode();
    const { ends, timers } = start(node);
    await settle();
    node.block = 101;
    node.events.push(allRevoked());
    timers.fire(POLL);
    await settle();
    expect(ends.map((end) => end.reason)).toEqual(['all-revoked']);
  });

  test('revoked and registered again between two reads: not reported', async () => {
    const node = fakeNode();
    const { ends, timers } = start(node);
    await settle();
    node.block = 102;
    node.events.push(revoked(KEY, '0xd1', 101), keySet(VALID_UNTIL, KEY, '0xd2', 102));
    timers.fire(POLL);
    await settle();
    expect(ends).toEqual([]);
    expect(timers.pending.size).toBe(2);
  });

  test('follows continuation tokens', async () => {
    const node = fakeNode();
    node.pageSize = 2;
    const { ends, timers } = start(node);
    await settle();
    node.block = 101;
    node.events.push(revoked(OTHER_KEY), keySet(NOW + 5, OTHER_KEY), revoked(OTHER_KEY), ownerAdded('0xe1'), allRevoked('0xe1'));
    timers.fire(POLL);
    await settle();
    expect(node.filters.map((filter) => filter.continuation_token)).toEqual([undefined, '2', '4']);
    expect(ends.map((end) => end.reason)).toEqual(['owners-changed']);
  });

  test('a failed read is reported and tried again, over the same blocks', async () => {
    const node = fakeNode();
    const { ends, errors, timers } = start(node);
    await settle();
    node.block = 101;
    node.events.push(revoked());
    node.fail = new Error('rate limited');
    timers.fire(POLL);
    await settle();
    expect(errors).toEqual([node.fail]);
    expect(ends).toEqual([]);

    node.fail = null;
    timers.fire(POLL);
    await settle();
    expect(ends.map((end) => end.reason)).toEqual(['revoked']);
  });

  test('a failed first look is tried again', async () => {
    const node = fakeNode({ validUntil: 0 });
    node.fail = new Error('offline');
    const { ends, errors, timers } = start(node);
    await settle();
    expect(errors.length).toBe(1);
    node.fail = null;
    timers.fire(POLL);
    await settle();
    expect(ends).toEqual([{ reason: 'gone' }]);
  });

  test('stop: no timer left, and nothing is reported afterwards', async () => {
    const node = fakeNode();
    const { ends, timers, stop } = start(node);
    await settle();
    expect(timers.pending.size).toBe(2);
    stop();
    stop();
    expect(timers.pending.size).toBe(0);
    await settle();
    expect(ends).toEqual([]);
  });

  test('stop during a read: the answer is dropped', async () => {
    const node = fakeNode();
    const { ends, timers, stop } = start(node);
    await settle();
    node.block = 101;
    node.events.push(revoked());
    timers.fire(POLL);
    stop();
    await settle();
    expect(ends).toEqual([]);
    expect(timers.pending.size).toBe(0);
  });

  test('onEnded is called once', async () => {
    let now = NOW;
    const node = fakeNode();
    const { ends, timers } = start(node, { now: () => now });
    await settle();
    node.block = 101;
    node.events.push(revoked());
    timers.fire(POLL);
    await settle();
    now = VALID_UNTIL + 1;
    expect(timers.pending.size).toBe(0);
    expect(ends.length).toBe(1);
  });
});

describe('watchSession: pushed events', () => {
  function fakeChannel() {
    const channel = {
      params: [] as any[],
      handler: null as ((event: SessionEvent) => void) | null,
      unsubscribed: 0,
      async subscribeEvents(params: any) {
        channel.params.push(params);
        return {
          on(handler: (event: SessionEvent) => void) {
            channel.handler = handler;
          },
          async unsubscribe() {
            channel.unsubscribed += 1;
            return true;
          },
        };
      },
    };
    return channel;
  }

  test('starknet.js’s WebSocketChannel fits', () => {
    const fits = (channel: WebSocketChannel): SessionEventChannel => channel;
    expect(typeof fits).toBe('function');
  });

  test('subscribes to the account’s events and polls nothing', async () => {
    const node = fakeNode();
    const channel = fakeChannel();
    const { ends, timers } = start(node, { channel });
    await settle();
    expect(channel.params).toEqual([{ fromAddress: ACCOUNT, keys: SESSION_END_EVENT_KEYS }]);
    // Only the expiry timer.
    expect([...timers.pending.values()].map((timer) => timer.ms)).toEqual([3601 * 1000]);
    expect(node.filters).toEqual([]);

    channel.handler!(revoked(OTHER_KEY));
    expect(ends).toEqual([]);
    channel.handler!(ownerAdded('0xf1'));
    channel.handler!(allRevoked('0xf1'));
    expect(ends).toEqual([{ reason: 'owners-changed', transactionHash: '0xf1', blockNumber: 101 }]);
    expect(channel.unsubscribed).toBe(1);
    expect(timers.pending.size).toBe(0);

    channel.handler!(revoked());
    expect(ends.length).toBe(1);
  });

  test('still looks at the account once at the start', async () => {
    const node = fakeNode({ validUntil: 0 });
    const channel = fakeChannel();
    const { ends } = start(node, { channel });
    await settle();
    expect(ends).toEqual([{ reason: 'gone' }]);
    expect(channel.unsubscribed).toBe(1);
  });

  test('stop unsubscribes', async () => {
    const channel = fakeChannel();
    const { stop } = start(fakeNode(), { channel });
    await settle();
    stop();
    expect(channel.unsubscribed).toBe(1);
  });

  test('stopped before the subscription opened: it is closed', async () => {
    const channel = fakeChannel();
    const { stop } = start(fakeNode(), { channel });
    stop();
    await settle();
    expect(channel.unsubscribed).toBe(1);
    expect(channel.handler).toBeNull();
  });

  test('a subscription that cannot open is reported, and the events are polled instead', async () => {
    const failure = new Error('no websocket');
    const channel: SessionEventChannel = { subscribeEvents: async () => Promise.reject(failure) };
    const node = fakeNode();
    const { errors, ends, timers } = start(node, { channel });
    await settle();
    expect(errors).toEqual([failure]);
    node.block = 101;
    node.events.push(revoked());
    timers.fire(POLL);
    await settle();
    expect(ends.map((end) => end.reason)).toEqual(['revoked']);
  });

  test('a failed look at the start is tried again', async () => {
    const node = fakeNode({ validUntil: 0 });
    node.fail = new Error('offline');
    const channel = fakeChannel();
    const { errors, ends, timers } = start(node, { channel });
    await settle();
    expect(errors.length).toBe(1);
    node.fail = null;
    timers.fire(POLL);
    await settle();
    expect(ends).toEqual([{ reason: 'gone' }]);
  });
});
