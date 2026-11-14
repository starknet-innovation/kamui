// Sessions: the registry, and what the account says.
import {
  KamuiReader,
  SPENDING_ENTRYPOINTS,
  registryClient,
  type KeyPair,
  type RegistryEntry,
  type RegistrySession,
  type ScopedCall,
} from '../../sdk/src';
import { loadUnrecordedSessions, saveUnrecordedSessions, type AccountRecord } from './vault';
import { config } from './context';
import type { Limit } from './tokens';
import { sameFelt, within } from './ui';

/** How long the keychain waits for the session registry before going on without it. */
export const REGISTRY_TIMEOUT_MS = 5000;

export const registryFor = (device: KeyPair, record: AccountRecord) =>
  registryClient({ apiUrl: config.apiUrl, chainId: record.chainId, account: record.account, ownerPrivateKey: device.privateKey });

/**
 * Records an approved session in the registry, so it can be listed and revoked later. It never
 * throws and never takes long: the session exists on chain either way, and the user is on the
 * way back to the app. The session is written to this device's storage first and taken out
 * once the registry has it, so a registry that is down loses nothing: the account page shows
 * the session from here and sends it again.
 */
export async function recordSession(device: KeyPair, record: AccountRecord, session: RegistrySession): Promise<void> {
  try {
    const others = (await loadUnrecordedSessions()).filter((other) => !sameFelt(other.publicKey, session.publicKey));
    await saveUnrecordedSessions([...others, session]);
    await within(REGISTRY_TIMEOUT_MS, registryFor(device, record).put(session));
    await saveUnrecordedSessions((await loadUnrecordedSessions()).filter((other) => !sameFelt(other.publicKey, session.publicKey)));
  } catch {
    // Still in this device's storage, unless storing it is what failed.
  }
}

/** A session as the account page shows it. Everything but the site's names is read from the account. */
export type LiveSession = {
  publicKey: string;
  /** From the registry or this device's storage. The account does not know them. */
  origin: string;
  appName?: string;
  validUntil: number;
  maxCalls: number;
  maxFeePerTx: bigint;
  /** The calls the registry lists that the account confirms. */
  calls: ScopedCall[];
  /** How many permissions the account holds for the session. */
  scopeEntries: number;
  limits: Limit[];
  /** Tokens the session may spend with no limit. */
  unlimited: string[];
};

/** Reads from the account what a recorded session may really do. Null if it is dead. */
async function readLiveSession(reader: KamuiReader, claimed: RegistrySession): Promise<LiveSession | null> {
  const data = await reader.session(claimed.publicKey);
  if (!data.exists || data.validUntil < Math.floor(Date.now() / 1000)) return null;

  const allowed = await Promise.all(claimed.calls.map((call) => reader.isSessionCallAllowed(claimed.publicKey, call.to, call.entrypoint)));
  const calls = claimed.calls.filter((_, index) => allowed[index]);

  // Spending limits for every token the record names, and every token the session may spend.
  const spendable = calls.filter((call) => (SPENDING_ENTRYPOINTS as readonly string[]).includes(call.entrypoint)).map((call) => call.to);
  const tokens = [...new Set([...claimed.limits.map((limit) => limit.token), ...spendable].map((token) => BigInt(token)))].map((token) => `0x${token.toString(16)}`);
  const policies = await Promise.all(tokens.map((token) => reader.spendingPolicy(claimed.publicKey, token)));
  const limits: Limit[] = [];
  const unlimited: string[] = [];
  tokens.forEach((token, index) => {
    const policy = policies[index]!;
    if (policy.exists) limits.push({ token, maxPerCall: policy.maxPerCall, maxPerWindow: policy.maxPerWindow, windowSeconds: policy.windowSeconds });
    else if (spendable.some((other) => sameFelt(other, token))) unlimited.push(token);
  });

  return {
    publicKey: claimed.publicKey,
    origin: claimed.origin,
    appName: claimed.appName,
    validUntil: data.validUntil,
    maxCalls: data.maxCalls,
    maxFeePerTx: data.maxFeePerTx,
    calls,
    scopeEntries: data.scopeEntries,
    limits,
    unlimited,
  };
}

/**
 * The account's live sessions, as far as they can be found: those the registry lists and those
 * waiting in this device's storage, each checked against the account. Records of sessions that
 * no longer exist are removed, and waiting ones are sent to the registry again; `onFull` is
 * called, possibly after this returns, if the registry has no room for one.
 */
export async function loadSessions(device: KeyPair, record: AccountRecord, reader: KamuiReader, onFull: () => void): Promise<{ sessions: LiveSession[]; registryReachable: boolean }> {
  const registry = registryFor(device, record);
  const waiting = await loadUnrecordedSessions();
  let listed: RegistryEntry[] = [];
  let registryReachable = true;
  try {
    listed = await within(REGISTRY_TIMEOUT_MS, registry.list());
  } catch {
    registryReachable = false;
  }

  // This device's own record of a session wins over the registry's.
  const isWaiting = (publicKey: string) => waiting.some((session) => sameFelt(session.publicKey, publicKey));
  const claimed: RegistrySession[] = [...waiting, ...listed.filter((entry) => !isWaiting(entry.publicKey))];
  const read = await Promise.all(claimed.map((session) => readLiveSession(reader, session)));
  const sessions = read.filter((session): session is LiveSession => session !== null);
  const isLive = (publicKey: string) => sessions.some((session) => sameFelt(session.publicKey, publicKey));

  const stillWaiting = waiting.filter((session) => isLive(session.publicKey));
  if (stillWaiting.length !== waiting.length) await saveUnrecordedSessions(stillWaiting);

  if (registryReachable) {
    // Tidy the registry without holding the page up. Whatever fails is tried on the next visit.
    void (async () => {
      for (const entry of listed) {
        if (!isLive(entry.publicKey)) await registry.remove(entry.publicKey).catch(() => {});
      }
      for (const session of stillWaiting) {
        let settled = false;
        try {
          await registry.put(session);
          settled = true;
        } catch (error) {
          // The registry will never take a session that has expired. A full registry may take
          // it later; until then it stays in this device's storage, and the page says so.
          if ((error as Error).message.includes('SESSION_EXPIRED')) settled = true;
          else if ((error as Error).message.includes('REGISTRY_FULL')) onFull();
        }
        if (settled) await saveUnrecordedSessions((await loadUnrecordedSessions()).filter((other) => !sameFelt(other.publicKey, session.publicKey))).catch(() => {});
      }
    })();
  }
  return { sessions, registryReachable };
}
