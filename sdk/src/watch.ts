// Learning that a session ended, without asking the account before every call.
//
// A session ends in three ways, and the account already says so for two of them:
//
//   it reaches `validUntil`            no event; the app knows the time, so a local timer fires
//   the user revokes it                `SessionKeyRevoked { #[key] session_key }`
//   the user revokes every session,    `AllSessionsRevoked { new_epoch }`, preceded in the same
//   or adds or removes a device        transaction by `OwnerAdded` / `OwnerRemoved` for a device
//
// `SessionKeySet { #[key] session_key, valid_until, .. }` is also read: a session registered
// again under the same key with another expiry no longer accepts this app's signatures, and one
// registered again with the same expiry is alive whatever came before it.
//
// The events are emitted by the account itself (the component events are flattened), so they are
// read with `starknet_getEvents` on the account's address, or pushed by a WebSocket node.
import { hash, type ProviderInterface } from 'starknet';
import type { Connection } from './keychain';
import { KamuiReader } from './reader';
import { sameFelt } from './utils';

export type SessionEndReason =
  /** `validUntil` has passed. */
  | 'expired'
  /** The user revoked this session. */
  | 'revoked'
  /** The user revoked every session on the account. */
  | 'all-revoked'
  /** The user added or removed a device, which revokes every session. */
  | 'owners-changed'
  /** The same session key was registered again with another expiry. */
  | 'replaced'
  /** The account no longer has the session; what ended it was not seen. */
  | 'gone';

export type SessionEnd = {
  reason: SessionEndReason;
  /** The transaction that ended the session, when an event told. */
  transactionHash?: string;
  /** The block of that transaction, when the node gave it. */
  blockNumber?: number;
};

/** An event as a node returns it. Only these fields are read. */
export type SessionEvent = { keys: string[]; data: string[]; transaction_hash?: string; block_number?: number };

const selector = (name: string) => BigInt(hash.getSelectorFromName(name));
const SESSION_KEY_SET = selector('SessionKeySet');
const SESSION_KEY_REVOKED = selector('SessionKeyRevoked');
const ALL_SESSIONS_REVOKED = selector('AllSessionsRevoked');
const OWNER_ADDED = selector('OwnerAdded');
const OWNER_REMOVED = selector('OwnerRemoved');

/** The first-key filter for the events that can end a session. */
export const SESSION_END_EVENT_KEYS: string[][] = [
  ['SessionKeySet', 'SessionKeyRevoked', 'AllSessionsRevoked', 'OwnerAdded', 'OwnerRemoved'].map((name) => hash.getSelectorFromName(name)),
];

/**
 * Follows a session through the account's events, in the order they were emitted. Feed it every
 * event; `ended` is what they add up to so far, or null while the session is alive.
 */
export function sessionEventTracker(session: { publicKey: string; validUntil: number }) {
  const ownerChanges = new Set<string>();
  let ended: SessionEnd | null = null;
  return {
    get ended(): SessionEnd | null {
      return ended;
    },
    push(event: SessionEvent): void {
      if (event.keys.length === 0) return;
      const name = BigInt(event.keys[0]!);
      const where = { transactionHash: event.transaction_hash, blockNumber: event.block_number };
      const mine = event.keys.length > 1 && sameFelt(event.keys[1]!, session.publicKey);
      if (name === OWNER_ADDED || name === OWNER_REMOVED) {
        if (event.transaction_hash) ownerChanges.add(event.transaction_hash);
      } else if (name === ALL_SESSIONS_REVOKED) {
        const byOwners = event.transaction_hash !== undefined && ownerChanges.has(event.transaction_hash);
        ended = { reason: byOwners ? 'owners-changed' : 'all-revoked', ...where };
      } else if (name === SESSION_KEY_REVOKED && mine) {
        ended = { reason: 'revoked', ...where };
      } else if (name === SESSION_KEY_SET && mine && event.data.length > 0) {
        ended = BigInt(event.data[0]!) === BigInt(session.validUntil) ? null : { reason: 'replaced', ...where };
      }
    },
  };
}

/**
 * One look at the session: null while it is alive, or why it is not. Local for an expired
 * session, one read of the account otherwise. Use it when a stored connection is loaded and when
 * a call fails. It cannot tell a revocation from a change of devices: both read as `gone`.
 */
export async function checkSessionEnded(connection: Connection, provider: ProviderInterface, now = Math.floor(Date.now() / 1000)): Promise<SessionEnd | null> {
  if (now > connection.session.validUntil) return { reason: 'expired' };
  const data = await new KamuiReader(provider, connection.account).session(connection.session.publicKey);
  if (!data.exists) return { reason: 'gone' };
  if (data.validUntil !== connection.session.validUntil) return { reason: 'replaced' };
  return null;
}

// 'Kamui: invalid session', as text and as the felt a node prints in a revert reason.
const REFUSAL_TEXT = 'Kamui: invalid session';
const REFUSAL_FELT = Array.from(new TextEncoder().encode(REFUSAL_TEXT), (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * Whether an error carries the account's refusal of a sponsored session call
 * (`Kamui: invalid session`). The account gives that one answer for an ended session, a call
 * outside the scope and a nonce outside the session's range, so follow it with
 * `checkSessionEnded` to know which. An error that does not carry it proves nothing: a relayer
 * may hide the reason, and a self-paid transaction is refused at validation without it.
 */
export function isSessionRefusal(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${JSON.stringify((error as { data?: unknown }).data ?? '')}` : typeof error === 'string' ? error : JSON.stringify(error ?? '');
  return text.includes(REFUSAL_TEXT) || text.toLowerCase().includes(REFUSAL_FELT);
}

/** The part of starknet.js's `WebSocketChannel` that `watchSession` uses. */
export type SessionEventChannel = {
  subscribeEvents(params: { fromAddress: string; keys: string[][] }): Promise<{
    on(handler: (event: SessionEvent) => void): void;
    unsubscribe(): Promise<unknown>;
  }>;
};

export type WatchSessionOptions = {
  /** Milliseconds between two reads of the account's events. Default 30 000. */
  pollIntervalMs?: number;
  /**
   * A starknet.js `WebSocketChannel` on a node that serves `starknet_subscribeEvents`. With it
   * the events are pushed and nothing is polled. If the subscription cannot be opened, the
   * watcher reads the events at `pollIntervalMs` instead. Events emitted while the socket is
   * down are not replayed.
   */
  channel?: SessionEventChannel;
  /** Told about a failed read. The watcher keeps going and tries again at the next interval. */
  onError?: (error: unknown) => void;
  /** Unix seconds. Defaults to this machine's clock. */
  now?: () => number;
  /** For tests. Defaults to the global timers. */
  timers?: { setTimeout(run: () => void, ms: number): unknown; clearTimeout(timer: unknown): void };
};

export const DEFAULT_SESSION_POLL_INTERVAL_MS = 30_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const EVENTS_CHUNK = 100;

/**
 * Calls `onEnded` once, when the session ends, and then stops. Returns a function that stops
 * the watcher early.
 *
 * - Expiry: a local timer, no network.
 * - Revocation and device changes: the account's events, read every `pollIntervalMs` with one
 *   `starknet_getEvents` from the last block seen, or pushed over `channel`.
 * - A session that ended before the watcher started: one read of the account at the start,
 *   reported as `gone` (or `replaced`).
 *
 * What it reports comes from the node it is given, so it is a hint for the interface, not a
 * check: the account decides on every call. Events are read up to the latest accepted block;
 * the local timer follows this machine's clock, the account follows block time.
 */
export function watchSession(
  connection: Connection,
  provider: ProviderInterface,
  onEnded: (end: SessionEnd) => void,
  options: WatchSessionOptions = {},
): () => void {
  const interval = options.pollIntervalMs ?? DEFAULT_SESSION_POLL_INTERVAL_MS;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const timers = options.timers ?? { setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) };
  const { session, account } = connection;
  const tracker = sessionEventTracker(session);

  let stopped = false;
  let expiryTimer: unknown;
  let pollTimer: unknown;
  let subscription: { unsubscribe(): Promise<unknown> } | undefined;
  /** First block whose events have not been read. Unset until the first look at the account. */
  let nextBlock: number | undefined;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    timers.clearTimeout(expiryTimer);
    timers.clearTimeout(pollTimer);
    subscription?.unsubscribe().catch(() => {});
  };
  const end = (result: SessionEnd) => {
    if (stopped) return;
    stop();
    onEnded(result);
  };
  const report = (error: unknown) => {
    if (!stopped) options.onError?.(error);
  };

  // Expiry. The account accepts the session while block time <= validUntil. Long waits are cut
  // into pieces: a timer cannot be set further than about 24.8 days ahead.
  const armExpiry = () => {
    const remaining = (session.validUntil + 1 - now()) * 1000;
    if (remaining <= 0) return end({ reason: 'expired' });
    expiryTimer = timers.setTimeout(armExpiry, Math.min(remaining, MAX_TIMER_MS));
  };

  /** The first look: where the events start, and whether the session is already gone. */
  const look = async () => {
    const latest = await provider.getBlockNumber();
    const state = await checkSessionEnded(connection, provider, now());
    if (state) return end(state);
    nextBlock = latest + 1;
  };

  const readEvents = async () => {
    const latest = await provider.getBlockNumber();
    if (latest < nextBlock!) return;
    const events: SessionEvent[] = [];
    let continuation_token: string | undefined;
    do {
      const page = await provider.getEvents({
        address: account,
        from_block: { block_number: nextBlock! },
        to_block: { block_number: latest },
        keys: SESSION_END_EVENT_KEYS,
        chunk_size: EVENTS_CHUNK,
        ...(continuation_token ? { continuation_token } : {}),
      });
      events.push(...(page.events as SessionEvent[]));
      continuation_token = page.continuation_token;
    } while (continuation_token && !stopped);
    if (stopped) return;
    // The whole range is applied before deciding, so a session revoked and registered again
    // between two reads is not reported.
    for (const event of events) tracker.push(event);
    nextBlock = latest + 1;
    if (tracker.ended) end(tracker.ended);
  };

  const poll = async () => {
    try {
      if (nextBlock === undefined) await look();
      else await readEvents();
    } catch (error) {
      report(error);
    }
    if (!stopped) pollTimer = timers.setTimeout(poll, interval);
  };

  const subscribe = async (channel: SessionEventChannel) => {
    let opened: Awaited<ReturnType<SessionEventChannel['subscribeEvents']>>;
    try {
      opened = await channel.subscribeEvents({ fromAddress: account, keys: SESSION_END_EVENT_KEYS });
    } catch (error) {
      // No subscription on this node: read the events instead.
      report(error);
      return void poll();
    }
    if (stopped) return void opened.unsubscribe().catch(() => {});
    subscription = opened;
    opened.on((event) => {
      tracker.push(event);
      if (tracker.ended) end(tracker.ended);
    });
    // After subscribing, so nothing falls between the look and the first pushed event.
    const lookOnce = async () => {
      try {
        await look();
      } catch (error) {
        report(error);
        if (!stopped) pollTimer = timers.setTimeout(lookOnce, interval);
      }
    };
    await lookOnce();
  };

  armExpiry();
  if (!stopped) {
    if (options.channel) void subscribe(options.channel);
    else void poll();
  }
  return stop;
}
