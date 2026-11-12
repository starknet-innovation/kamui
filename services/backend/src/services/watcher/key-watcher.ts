// Kamui: the registry key watcher (plan decision D8).
//
// Whoever can write to the on-chain key registry can take over every account. This process
// checks every write: for each `KeySet` event it fetches the issuer's published keys itself,
// recomputes the modulus hash the way the contract does, and raises an alert when the hash
// differs or the issuer does not publish that kid.
//
// It is independent of the rotator on purpose. It holds no key, shares no state or cache with
// it, and never asks it anything: the point is to catch a wrong or malicious write, including
// one made with the rotator's own key. The two share only the arithmetic in jwk/modulus.ts.
// Run it somewhere else, under another identity, with another RPC provider if possible.
//
// What is checked:
// - Every currently published Google signing key is compared with registry storage, even
//   before a KeySet event exists. Missing keys or wrong moduli are availability alerts.
// - A write still in effect (the last event for its kid) is always checked. A mismatch, or a
//   kid the issuer does not publish, is an alert.
// - A write seen while watching (in a block after the watcher started) is checked the same way
//   even if it was removed again straight after: a bad key that was trusted for one block is
//   still an incident.
// - A write from before the watcher started that has since been removed or replaced cannot be
//   judged against today's keys: the issuer may have retired the kid, or changed its key. If
//   it does not match, it is reported as a warning ("unverifiable"), not an alert; otherwise
//   every normal rotation in the history would fail `--once` for ever.
// - A write whose event carries no hash (an older registry class) is checked against the key
//   read from the registry's storage, while it is in effect.
// - An event naming an issuer this code does not know is an alert.
// - If an issuer's keys cannot be fetched, nothing about that issuer is verified, and that is
//   reported as a failure (exit code 2 with --once), never as "ok".
//
// An alert is: a log line at error level (`event: "registry_key_alert"`), a POST of the alerts
// as JSON to WATCHER_WEBHOOK_URL when set, and with --once exit code 1.
//
// Run: bun run service:watcher (keeps watching), bun run watch:once (one pass, for cron and CI).
// Env: RPC_URL, <CHAIN>_REGISTRY_ADDRESS, <CHAIN>_REGISTRY_BLOCK, WATCHER_WEBHOOK_URL (optional),
//   WATCHER_POLL_SECONDS (60).
import { env, exitOnWrongChain, makeProvider, resolveChain } from '../../env';
import { filterEligibleKeys, modulusHash, registryEvents, storedKey, type RegistryEvent } from '../../jwk/modulus';
import { ISSUERS, fetchJwks, type Jwk } from '../../jwk/verification';
import { log } from '../../log';
import { fetchWithTimeout, type Fetch } from '../../net';

export type AlertReason = 'MODULUS_MISMATCH' | 'KID_NOT_PUBLISHED' | 'UNKNOWN_ISSUER' | 'NO_MODULUS_HASH' | 'REGISTRY_KEY_MISSING';
export type Alert = {
  /** Event incidents and current issuer publication lag have different evidence. */
  source: 'event' | 'issuer';
  reason: AlertReason;
  iss: string;
  kid: string;
  /** Event/storage hash and current issuer hash; publication alerts need no event. */
  onChainHash?: string;
  issuerHash?: string;
  blockNumber?: number;
  transactionHash?: string;
  /** False when a later event removed or replaced this write. */
  inEffect: boolean;
};
export type CheckResult = { alerts: Alert[]; unverifiable: RegistryEvent[]; verified: number; issuersUnavailable: string[] };

const hex = (value: bigint) => '0x' + value.toString(16);

/**
 * Checks `events` (oldest first, the registry's whole history or a tail of it) against the
 * issuers' keys. `jwks` holds each issuer's published keys, or null when the fetch failed.
 * Writes in blocks after `liveAfterBlock` are held to the strict rule; pass Infinity for a
 * one-off pass over history.
 */
export function checkEvents(events: RegistryEvent[], jwks: Map<string, Jwk[] | null>, liveAfterBlock = Infinity): CheckResult {
  const result: CheckResult = { alerts: [], unverifiable: [], verified: 0, issuersUnavailable: [] };
  const lastIndex = new Map<string, number>();
  events.forEach((event, i) => lastIndex.set(`${event.iss}\n${event.kid}`, i));

  events.forEach((event, i) => {
    if (event.kind !== 'set') return;
    const inEffect = lastIndex.get(`${event.iss}\n${event.kid}`) === i;
    const live = event.blockNumber > liveAfterBlock;
    const alert = (reason: AlertReason, extra: Partial<Alert> = {}) =>
      result.alerts.push({ source: 'event', reason, iss: event.iss, kid: event.kid, blockNumber: event.blockNumber, transactionHash: event.transactionHash, inEffect, ...extra });

    if (!ISSUERS.some((issuer) => issuer.iss === event.iss)) return alert('UNKNOWN_ISSUER');
    const keys = jwks.get(event.iss);
    if (!keys) {
      if (!result.issuersUnavailable.includes(event.iss)) result.issuersUnavailable.push(event.iss);
      return;
    }
    const onChainHash = event.modulusHash === undefined ? undefined : hex(event.modulusHash);
    let published: bigint[] | undefined;
    try {
      // The same filter the registry's keys must pass: RS256, signing, e = 65537, 2048 bits.
      published = filterEligibleKeys(keys.filter((k) => k.kid === event.kid)).get(event.kid);
    } catch {
      published = undefined;
    }
    if (!published) {
      if (inEffect || live) alert('KID_NOT_PUBLISHED', { onChainHash });
      else result.unverifiable.push(event);
      return;
    }
    const issuerHash = hex(modulusHash(published));
    if (onChainHash === undefined) {
      // Nothing to compare: the contract did not say what it stored.
      if (inEffect || live) alert('NO_MODULUS_HASH', { issuerHash });
      else result.unverifiable.push(event);
    } else if (onChainHash !== issuerHash) {
      if (inEffect || live) alert('MODULUS_MISMATCH', { onChainHash, issuerHash });
      else result.unverifiable.push(event);
    } else {
      result.verified += 1;
    }
  });
  return result;
}

export type WatcherDeps = {
  provider: Parameters<typeof registryEvents>[0] & Parameters<typeof storedKey>[0]['provider'] & { getBlockNumber(): Promise<number> };
  registryAddress: string;
  fromBlock: number;
  /** Independently check every currently published key, even with no KeySet history. */
  publishedIssuers?: string[];
  /** One issuer's published keys. Throws when they cannot be fetched. */
  fetchKeys?: (iss: string) => Promise<Jwk[]>;
  webhookUrl?: string;
  send?: Fetch;
};

async function issuerKeys(deps: WatcherDeps, wanted: Set<string>): Promise<Map<string, Jwk[] | null>> {
  const fetchKeys = deps.fetchKeys ?? (async (iss: string) => (await fetchJwks(iss)).keys);
  const out = new Map<string, Jwk[] | null>();
  for (const { iss } of ISSUERS) {
    if (!wanted.has(iss)) continue;
    out.set(iss, await fetchKeys(iss).catch(() => null));
  }
  return out;
}

/**
 * A registry class older than the `modulus_hash` event key (the one on Sepolia today) says a
 * key was set but not which. For such a write that is still in effect, the key is read from the
 * registry's storage and hashed here instead. A removed or replaced write stays without a hash.
 */
export async function fillMissingHashes(events: RegistryEvent[], deps: Pick<WatcherDeps, 'provider' | 'registryAddress'>): Promise<void> {
  const last = new Map<string, RegistryEvent>();
  for (const event of events) last.set(`${event.iss}\n${event.kid}`, event);
  for (const event of last.values()) {
    if (event.kind !== 'set' || event.modulusHash !== undefined) continue;
    const key = await storedKey({ provider: deps.provider, registryContractAddress: deps.registryAddress }, event.iss, event.kid);
    if (key) event.modulusHash = modulusHash(key);
  }
}

/** Current issuer publications are availability evidence, not historical transactions.
 * Reads storage directly; an UNKNOWN_KID is absence, while all other RPC failures
 * propagate so a broken check can never be reported as healthy.
 */
export async function checkPublishedKeys(deps: WatcherDeps, jwks: Map<string, Jwk[] | null>): Promise<CheckResult> {
  const result: CheckResult = { alerts: [], unverifiable: [], verified: 0, issuersUnavailable: [] };
  for (const iss of new Set(deps.publishedIssuers ?? [])) {
    if (!ISSUERS.some(issuer => issuer.iss === iss)) throw new Error('WATCHER_ISSUER_UNSUPPORTED');
    const published = jwks.get(iss);
    if (!published) { result.issuersUnavailable.push(iss); continue; }
    let keys: Map<string, bigint[]>;
    try { keys = filterEligibleKeys(published); }
    catch { result.issuersUnavailable.push(iss); continue; }
    if (!keys.size) { result.issuersUnavailable.push(iss); continue; }
    for (const [kid, limbs] of keys) {
      const issuerHash = hex(modulusHash(limbs));
      const stored = await storedKey({ provider: deps.provider, registryContractAddress: deps.registryAddress }, iss, kid);
      if (!stored) {
        result.alerts.push({ source: 'issuer', reason: 'REGISTRY_KEY_MISSING', iss, kid, issuerHash, inEffect: true });
      } else {
        const onChainHash = hex(modulusHash(stored));
        if (onChainHash !== issuerHash) result.alerts.push({ source: 'issuer', reason: 'MODULUS_MISMATCH', iss, kid, onChainHash, issuerHash, inEffect: true });
        else result.verified++;
      }
    }
  }
  return result;
}

/** One fresh independent JWKS fetch per wanted issuer per pass; never use rotator state. */
async function checkPass(deps: WatcherDeps, liveAfterBlock = Infinity): Promise<CheckResult> {
  const events = await history(deps);
  const wanted = new Set([...events.map(event => event.iss), ...(deps.publishedIssuers ?? [])]);
  const jwks = await issuerKeys(deps, wanted);
  const result = checkEvents(events, jwks, liveAfterBlock);
  const current = await checkPublishedKeys(deps, jwks);
  result.alerts.push(...current.alerts);
  result.verified += current.verified;
  result.issuersUnavailable = [...new Set([...result.issuersUnavailable, ...current.issuersUnavailable])];
  return result;
}

/** Include source and comparison material so a changed issuer key is a new incident. */
export function alertIdentity(alert: Alert): string {
  return JSON.stringify([alert.source, alert.reason, alert.transactionHash ?? null, alert.iss, alert.kid, alert.onChainHash ?? null, alert.issuerHash ?? null]);
}

async function history(deps: WatcherDeps): Promise<RegistryEvent[]> {
  const events = await registryEvents(deps.provider, deps.registryAddress, deps.fromBlock);
  await fillMissingHashes(events, deps);
  return events;
}

/** Tells the outside world. The log line is the alert of record; the webhook is best effort and its failure is logged. */
export async function raise(alerts: Alert[], deps: Pick<WatcherDeps, 'webhookUrl' | 'send'>): Promise<void> {
  for (const alert of alerts) {
    log('error', 'registry_key_alert', { source: alert.source, reason: alert.reason, iss: alert.iss, kid: alert.kid, on_chain_hash: alert.onChainHash, issuer_hash: alert.issuerHash, block: alert.blockNumber, tx: alert.transactionHash, in_effect: alert.inEffect });
  }
  if (!alerts.length || !deps.webhookUrl) return;
  try {
    const text = `Kamui key registry: ${alerts.length} alert(s). ${alerts.map((a) => `${a.reason} ${a.source} ${a.iss} kid ${a.kid}${a.transactionHash ? ` tx ${a.transactionHash}` : ''}`).join('; ')}`;
    const res = await fetchWithTimeout(deps.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, alerts }) }, 10_000, deps.send);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    log('error', 'watcher_webhook_failed', { alerts: alerts.length });
  }
}

/**
 * One pass over the registry's history. Returns the process exit code: 0 everything in effect
 * is verified, 1 at least one alert, 2 something could not be checked.
 */
export async function watchOnce(deps: WatcherDeps): Promise<{ code: 0 | 1 | 2; result: CheckResult }> {
  const result = await checkPass(deps);
  report(result);
  await raise(result.alerts, deps);
  return { code: result.alerts.length ? 1 : result.issuersUnavailable.length ? 2 : 0, result };
}

function report(result: CheckResult): void {
  for (const event of result.unverifiable) log('warn', 'registry_key_unverifiable', { iss: event.iss, kid: event.kid, block: event.blockNumber, tx: event.transactionHash });
  for (const iss of result.issuersUnavailable) log('error', 'watcher_issuer_unavailable', { iss });
  log(result.alerts.length || result.issuersUnavailable.length ? 'error' : 'info', 'registry_keys_checked', { verified: result.verified, alerts: result.alerts.length, unverifiable: result.unverifiable.length, issuers_unavailable: result.issuersUnavailable.length });
}

/**
 * Keeps watching. Each poll re-reads the whole history (it is small: a few events per key
 * rotation) so "in effect" is always judged on the full picture, and raises each alert once.
 * An alert about a write still in effect is raised again every `repeatMs` until it is fixed.
 */
export async function watchForever(deps: WatcherDeps, pollMs: number, repeatMs = 3_600_000): Promise<never> {
  const startBlock = await deps.provider.getBlockNumber();
  const raised = new Map<string, number>();
  const reported = new Set<string>();
  log('info', 'watcher_started', { from_block: deps.fromBlock, live_after_block: startBlock });
  while (true) {
    try {
      const result = await checkPass(deps, startBlock);
      const now = Date.now();
      const fresh = result.alerts.filter((alert) => {
        const id = alertIdentity(alert);
        const last = raised.get(id);
        if (last !== undefined && (!alert.inEffect || now - last < repeatMs)) return false;
        raised.set(id, now);
        return true;
      });
      result.unverifiable = result.unverifiable.filter((event) => {
        const id = `${event.transactionHash}:${event.iss}:${event.kid}`;
        return !reported.has(id) && Boolean(reported.add(id));
      });
      report({ ...result, alerts: fresh });
      await raise(fresh, deps);
    } catch (e) {
      log('error', 'watcher_poll_failed', { error: e instanceof Error ? e.constructor.name : 'UNKNOWN' });
    }
    await Bun.sleep(pollMs);
  }
}

async function main(): Promise<void> {
  const provider = makeProvider();
  const { chain, confirmed } = await resolveChain(provider);
  exitOnWrongChain(confirmed);
  const deps: WatcherDeps = {
    provider,
    registryAddress: env(`${chain}_REGISTRY_ADDRESS`),
    fromBlock: Number(env(`${chain}_REGISTRY_BLOCK`)),
    publishedIssuers: ['https://accounts.google.com'],
    webhookUrl: process.env.WATCHER_WEBHOOK_URL || undefined,
  };
  if (process.argv.includes('--once')) {
    let code = 2;
    try {
      ({ code } = await watchOnce(deps));
    } catch (e) {
      log('error', 'watcher_poll_failed', { error: e instanceof Error ? e.constructor.name : 'UNKNOWN' });
    }
    process.exit(code);
  }
  await watchForever(deps, Number(process.env.WATCHER_POLL_SECONDS ?? 60) * 1000);
}

if (import.meta.main) void main().catch(() => { log('error', 'watcher_startup_failed'); process.exit(1); });
