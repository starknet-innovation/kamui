// Kamui: the session and app registry. A list, per account, of the sessions its owner approved
// and for which site, so the keychain can show them and offer to revoke them. The account
// contract cannot enumerate its sessions, which is why the list is kept here.
//
// It is a convenience, not an authority: what a session may do is decided by the chain, and a
// reader must check each entry against the account. But the list is private (it says which
// sites a user connected to), so every request, including a read, needs an owner signature:
//
//   hash = poseidon('kamui.registry.v2', chainId, account, action, timestamp, nonce, subject, content)
//
// checked with the account's `is_valid_signature`. Exactly two signature elements are
// accepted: a session key signs with four and must never authorise a registry request, or any
// connected app could read where else the user is connected.
//
// `content` is a hash of the whole record for a `put` (0 otherwise), so the signature covers
// what is stored and not only which session it is about. `nonce` is a random felt, and each
// signed message is accepted once: a captured request cannot be sent again.
//
// Nothing here logs an account, an origin or a session key. Metrics count requests by action
// and result only.
import { RpcError, hash, shortString, uint256 } from 'starknet';
import { HttpError } from '../../http';
import { metrics } from '../../metrics';
import type { RecoverContext } from '../recovery/recover';
import type { ListedSession, RegistryStore, StoredSession } from './store';

export type RegistryAction = 'put' | 'list' | 'remove';
export type RegistryContext = Pick<RecoverContext, 'provider' | 'classHash'> & {
  /** The chain id felt, as hex. Part of the signed message, so a signature for one network is useless on another. */
  chainId: string;
  store: RegistryStore;
  /** Unix seconds. */
  now?: () => number;
};

export const MAX_CLOCK_SKEW_SECONDS = 300;
export const MAX_CALLS = 64;
export const MAX_LIMITS = 32;
export const MAX_APP_NAME_LENGTH = 60;
export const MAX_ORIGIN_LENGTH = 200;

const DOMAIN = shortString.encodeShortString('kamui.registry.v2');
const VALID = BigInt(shortString.encodeShortString('VALID'));
const HEX = /^0x[0-9a-fA-F]{1,64}$/;
const ENTRYPOINT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const bad = (what: string) => new HttpError(400, what);
const isHex = (value: unknown): value is string => typeof value === 'string' && HEX.test(value);
const isPositiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
/** One spelling per felt, so the same key written with other padding or case is the same entry. */
const felt = (value: string) => '0x' + BigInt(value).toString(16);

/** The Stark field prime. A value that enters the signed hash as one element must be below it. */
const PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;
const isFelt = (value: unknown): value is string => isHex(value) && BigInt(value) < PRIME;
const hex = (value: bigint | number) => '0x' + BigInt(value).toString(16);
const text = (value: string) => hex(hash.starknetKeccak(value));
const amount = (value: string) => {
  const { low, high } = uint256.bnToUint256(value);
  return [hex(BigInt(low)), hex(BigInt(high))];
};

/** A hash of everything a record says. Same as `registryContentHash` in the SDK. */
export function sessionContentHash(session: Omit<StoredSession, 'publicKey'>): string {
  return hash.computePoseidonHashOnElements([
    text(session.origin),
    session.appName !== undefined ? text(session.appName) : '0x0',
    hex(session.validUntil),
    hex(session.maxCalls),
    session.maxFeePerTx,
    hex(session.calls.length),
    ...session.calls.flatMap((call) => [call.to, hash.getSelectorFromName(call.entrypoint)]),
    hex(session.limits.length),
    ...session.limits.flatMap((limit) => [limit.token, ...amount(limit.maxPerCall), ...amount(limit.maxPerWindow), hex(limit.windowSeconds)]),
  ]);
}

/** The hash an owner key signs. Same as `registryMessageHash` in the SDK. `content` is 0 unless the action is `put`. */
export function registryMessageHash(chainId: string, account: string, action: RegistryAction, timestamp: number, nonce: string, subject: string, content = '0x0'): string {
  return hash.computePoseidonHashOnElements([DOMAIN, chainId, account, shortString.encodeShortString(action), hex(timestamp), nonce, subject, content]);
}

/** A real web origin: https, or http on localhost, and nothing after the host and port. */
export function isOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ORIGIN_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== value) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost');
}

/** Checks every field of a session and returns a copy holding only the known ones. */
export function parseSession(raw: any, now: number): StoredSession {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad('BAD_SESSION');
  if (!isFelt(raw.publicKey) || BigInt(raw.publicKey) === 0n) throw bad('BAD_PUBLIC_KEY');
  if (!isOrigin(raw.origin)) throw bad('BAD_ORIGIN');
  if (raw.appName !== undefined) {
    // Shown to the user: no control characters, so a name cannot break a line or hide text.
    if (typeof raw.appName !== 'string' || raw.appName.length === 0 || raw.appName.length > MAX_APP_NAME_LENGTH || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(raw.appName)) throw bad('BAD_APP_NAME');
  }
  if (!isPositiveInt(raw.validUntil)) throw bad('BAD_VALID_UNTIL');
  if (raw.validUntil <= now) throw bad('SESSION_EXPIRED');
  if (!isPositiveInt(raw.maxCalls)) throw bad('BAD_MAX_CALLS');
  if (!isFelt(raw.maxFeePerTx)) throw bad('BAD_MAX_FEE');
  if (!Array.isArray(raw.calls) || raw.calls.length > MAX_CALLS) throw bad('BAD_CALLS');
  if (!Array.isArray(raw.limits) || raw.limits.length > MAX_LIMITS) throw bad('BAD_LIMITS');
  const calls = raw.calls.map((call: any) => {
    if (!isFelt(call?.to) || typeof call.entrypoint !== 'string' || !ENTRYPOINT.test(call.entrypoint)) throw bad('BAD_CALLS');
    return { to: call.to, entrypoint: call.entrypoint };
  });
  const limits = raw.limits.map((limit: any) => {
    if (!isFelt(limit?.token) || !isHex(limit.maxPerCall) || !isHex(limit.maxPerWindow) || !isPositiveInt(limit.windowSeconds)) throw bad('BAD_LIMITS');
    return { token: limit.token, maxPerCall: limit.maxPerCall, maxPerWindow: limit.maxPerWindow, windowSeconds: limit.windowSeconds };
  });
  return {
    publicKey: felt(raw.publicKey),
    origin: raw.origin,
    ...(raw.appName !== undefined ? { appName: raw.appName } : {}),
    validUntil: raw.validUntil,
    maxCalls: raw.maxCalls,
    maxFeePerTx: raw.maxFeePerTx,
    calls,
    limits,
  };
}

type Envelope = { account?: unknown; timestamp?: unknown; nonce?: unknown; signature?: unknown };

/**
 * Throws unless the request is signed by an owner key of a Kamui account, for exactly this
 * action, subject and content, with a timestamp near the server's clock, and has not been
 * accepted before. Returns the canonical account. The cheap checks come first; the chain is
 * asked last.
 */
export async function authorise(body: Envelope, action: RegistryAction, subject: string, content: string, ctx: RegistryContext, now: number): Promise<string> {
  if (!isFelt(body.account)) throw bad('BAD_ACCOUNT');
  if (!isPositiveInt(body.timestamp)) throw bad('BAD_TIMESTAMP');
  if (!isFelt(body.nonce)) throw bad('BAD_NONCE');
  // Exactly two: a session signature has four elements and `is_valid_signature` would accept it.
  if (!Array.isArray(body.signature) || body.signature.length !== 2 || !body.signature.every(isHex)) throw bad('BAD_SIGNATURE_FORMAT');
  if (Math.abs(now - body.timestamp) > MAX_CLOCK_SKEW_SECONDS) throw new HttpError(401, 'STALE_TIMESTAMP');

  let classHash: string;
  try {
    classHash = await ctx.provider.getClassHashAt(body.account);
  } catch (e) {
    if (e instanceof RpcError && e.isType('CONTRACT_NOT_FOUND')) throw bad('ACCOUNT_NOT_DEPLOYED');
    throw e;
  }
  if (BigInt(classHash) !== BigInt(ctx.classHash)) throw bad('WRONG_CLASS');

  const message = registryMessageHash(ctx.chainId, body.account, action, body.timestamp, body.nonce, subject, content);
  let answer: string[];
  try {
    answer = await ctx.provider.callContract({ contractAddress: body.account, entrypoint: 'is_valid_signature', calldata: [message, '0x2', ...(body.signature as string[])] });
  } catch (e) {
    // The account panics on some malformed signatures; that is a refusal, not an outage.
    if (e instanceof RpcError && e.isType('CONTRACT_ERROR')) throw new HttpError(401, 'BAD_SIGNATURE');
    throw e;
  }
  if (answer.length !== 1 || !isHex(answer[0]) || BigInt(answer[0]) !== VALID) throw new HttpError(401, 'BAD_SIGNATURE');
  // Once per signed message, and only after the signature held, so nobody can use up another
  // account's messages. Keyed on the message, not the signature: (r, -s) signs the same message.
  // The entry is kept for as long as the timestamp check would still let the message in.
  if (!ctx.store.useOnce(felt(message), body.timestamp + MAX_CLOCK_SKEW_SECONDS, now)) throw new HttpError(401, 'REPLAYED');
  return felt(body.account);
}

const clock = (ctx: RegistryContext) => (ctx.now ?? (() => Math.floor(Date.now() / 1000)))();

async function counted<T>(action: RegistryAction, work: () => Promise<T>): Promise<T> {
  try {
    const result = await work();
    metrics.registryWrites.inc({ action, result: 'ok' });
    return result;
  } catch (e) {
    metrics.registryWrites.inc({ action, result: e instanceof HttpError && e.status < 500 ? 'refused' : 'failed' });
    throw e;
  }
}

/** POST /registry/sessions */
export function putSession(body: Envelope & { session?: unknown }, ctx: RegistryContext): Promise<{ ok: true }> {
  return counted('put', async () => {
    const now = clock(ctx);
    const session = parseSession(body.session, now);
    const account = await authorise(body, 'put', session.publicKey, sessionContentHash(session), ctx, now);
    if (!ctx.store.put(account, session, now)) throw new HttpError(409, 'REGISTRY_FULL');
    return { ok: true as const };
  });
}

/** POST /registry/sessions/list */
export function listSessions(body: Envelope, ctx: RegistryContext): Promise<{ sessions: ListedSession[] }> {
  return counted('list', async () => {
    const now = clock(ctx);
    const account = await authorise(body, 'list', '0x0', '0x0', ctx, now);
    return { sessions: ctx.store.list(account, now) };
  });
}

/** POST /registry/sessions/remove */
export function removeSession(body: Envelope & { publicKey?: unknown }, ctx: RegistryContext): Promise<{ ok: true }> {
  return counted('remove', async () => {
    const now = clock(ctx);
    if (!isFelt(body.publicKey)) throw bad('BAD_PUBLIC_KEY');
    const account = await authorise(body, 'remove', body.publicKey, '0x0', ctx, now);
    ctx.store.remove(account, felt(body.publicKey));
    return { ok: true as const };
  });
}
