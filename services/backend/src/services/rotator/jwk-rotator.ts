// JWK rotator service that mirrors the supported issuers' RS256 signing keys into the JwkRegistry contract
//
// How it works under the hood:
// One independent loop per issuer in `ISSUERS`:
// 1. Fetches the issuer's JWKS
// 2. Compiles the `JwkRegistry`s `KeySet` and `KeyRemoved` events for that issuer
// 3. Based on what gathered on chain, gathers a list of keys to add and keys to remove
// 4. Updates the contract
// 5. Sleeps for as long the `Cache-Control` header suggests and then repeats.
//
// GET /health on ROTATOR_PORT (3001) => { ok, chain, issuers: { [iss]: { lastSync, nextSync, error } } }
//   ok when every issuer has synced at least once and its last attempt succeeded.
// GET /live => { ok: true } whenever the process is up (Kamui).
//
// Env: 
// - RPC_URL, 
// - OWNER_ADDRESS, 
// - OWNER_PRIVATE_KEY
// - <CHAIN>_REGISTRY_ADDRESS 
// - <CHAIN>_REGISTRY_BLOCK.

import { Account, CallData, byteArray, type Call } from 'starknet';
import { env, exitOnWrongChain, makeProvider, resolveChain } from '../../env';
import { byteArraysFromFelts, filterEligibleKeys, modulusHash, modulusLimbs, registryEvents, storedKey } from '../../jwk/modulus';
import { ISSUERS, fetchJwks, type IssuerJwks } from '../../jwk/verification';
import { errorCode, log } from '../../log';
import { secretSource } from '../../secrets';
import { assertRestoreReady } from '../../storage/restore-fence';

// Kamui: the limb and hash arithmetic moved to jwk/modulus.ts, shared with the watcher.
export { byteArraysFromFelts, filterEligibleKeys, modulusLimbs, storedKey };

// Minimum retry time
const RETRY_MS = 5 * 60_000;

export function extractRefreshDelay(headers: Headers): number {
  const maxAgeHeader = headers.get('cache-control') ?? '';
  const maxAgeString = /max-age=(\d+)/.exec(maxAgeHeader)?.[1] ?? 3600;
  const maxAgeMS = Number(maxAgeString) * 1000;
  return Math.min(Math.max(maxAgeMS, RETRY_MS), 24 * 3_600_000); // delay in 5m..24h
}

/** What the rotator needs from the chain and the issuer; tests pass fakes. */
export type Ctx = {
  assertPaidAvailable?: () => void | Promise<void>;
  registryOwner: { execute(calls: Call[]): Promise<{ transaction_hash: string }> };
  provider: {
    getEvents: Parameters<typeof registryEvents>[0]['getEvents'];
    callContract(call: { contractAddress: string; entrypoint: string; calldata: string[] }): Promise<string[]>;
    waitForTransaction(hash: string): Promise<unknown>;
  };
  registryContractAddress: string;
  fromBlock: number;
  fetchJwks?: (iss: string) => Promise<IssuerJwks>;
};

export type SyncPlan = { add: string[]; replace: string[]; remove: string[] };

/**
 * Kamui (audit finding #2): what to write, from key material and not from key ids.
 * `issuer` is the issuer's current keys; `stored` is what the registry holds for each kid of
 * interest (null: nothing). A kid is replaced only when a limb really differs.
 */
export function planSync(issuer: Map<string, bigint[]>, stored: Map<string, bigint[] | null>): SyncPlan {
  const plan: SyncPlan = { add: [], replace: [], remove: [] };
  for (const [kid, limbs] of issuer) {
    const onChain = stored.get(kid) ?? null;
    if (onChain === null) plan.add.push(kid);
    else if (onChain.length !== limbs.length || onChain.some((limb, i) => limb !== limbs[i])) plan.replace.push(kid);
  }
  for (const [kid, onChain] of stored) {
    if (onChain !== null && !issuer.has(kid)) plan.remove.push(kid);
  }
  return plan;
}

// ponytail: one owner account, one nonce. Issuer loops run concurrently, so submissions are serialized.
let txLock: Promise<unknown> = Promise.resolve();
function submitKeyUpdates({ registryOwner, provider, assertPaidAvailable }: Ctx, calls: Call[]): Promise<string> {
  const run = txLock.then(async () => {
    await assertPaidAvailable?.();
    const { transaction_hash } = await registryOwner.execute(calls);
    await provider.waitForTransaction(transaction_hash);
    return transaction_hash;
  });
  txLock = run.catch(() => { });
  return run;
}

const hex = (value: bigint) => '0x' + value.toString(16);

/**
 * Mirrors one issuer's JWKS into the registry. Returns the delay until the next sync.
 *
 * Kamui (audit finding #2): upstream compared key ids only, so a different modulus published
 * under an existing kid was never installed and the old key stayed trusted. Now:
 * - the event history only says which kids to look at (it is the only way to list them);
 * - what the registry holds for each kid is read from storage and compared limb by limb;
 * - a kid whose material changed is removed and set again in one transaction. That counts as a
 *   revocation: it cancels every recovery proof in flight and every pending override, for all
 *   users. It happens only when the stored limbs differ, and it is logged at error level.
 */
export async function syncOnce(ctx: Ctx, iss: string) {
  const { keys, headers } = await (ctx.fetchJwks ?? fetchJwks)(iss);
  const upToDateKeys = filterEligibleKeys(keys);
  const issuer = ISSUERS.find((i) => i.iss === iss)!.variant;

  // The latest event per kid: the hash of the last key set, or null after a removal.
  const history = new Map<string, bigint | null | undefined>();
  for (const event of await registryEvents(ctx.provider, ctx.registryContractAddress, ctx.fromBlock)) {
    if (event.iss === iss) history.set(event.kid, event.kind === 'set' ? event.modulusHash : null);
  }

  const stored = new Map<string, bigint[] | null>();
  for (const kid of new Set([...upToDateKeys.keys(), ...history.keys()])) {
    const onChain = await storedKey(ctx, iss, kid);
    stored.set(kid, onChain);
    // Storage is what the accounts read, so storage wins; a disagreement still deserves a look.
    const fromEvents = history.has(kid) ? history.get(kid) : null;
    const fromStorage = onChain ? modulusHash(onChain) : null;
    // undefined: the contract emitted no hash for that write, so there is nothing to compare.
    if (fromEvents !== undefined && fromEvents !== fromStorage) {
      log('error', 'registry_history_mismatch', { iss, kid, events_hash: fromEvents === null ? 'none' : hex(fromEvents), storage_hash: fromStorage === null ? 'none' : hex(fromStorage) });
    }
  }

  const plan = planSync(upToDateKeys, stored);
  const kidCalldata = (kid: string) => byteArray.byteArrayFromString(kid);
  const setKey = (kid: string): Call => ({
    contractAddress: ctx.registryContractAddress,
    entrypoint: 'set_key',
    calldata: CallData.compile([issuer, kidCalldata(kid), ...upToDateKeys.get(kid)!]),
  });
  const removeKey = (kid: string): Call => ({
    contractAddress: ctx.registryContractAddress,
    entrypoint: 'remove_key',
    calldata: CallData.compile([issuer, kidCalldata(kid)]),
  });

  for (const kid of plan.replace) {
    log('error', 'key_material_changed', {
      iss,
      kid,
      old_hash: hex(modulusHash(stored.get(kid)!)),
      new_hash: hex(modulusHash(upToDateKeys.get(kid)!)),
      note: 'the issuer published different key material under an existing kid; replacing it revokes in-flight recovery proofs and pending overrides for every user',
    });
  }
  // remove_key then set_key: exactly one revocation, on the deployed registry class and on the newer one.
  const calls: Call[] = [...plan.add.map(setKey), ...plan.replace.flatMap((kid) => [removeKey(kid), setKey(kid)]), ...plan.remove.map(removeKey)];

  if (calls.length === 0) {
    log('info', 'registry_in_sync', { iss, keys: upToDateKeys.size });
  } else {
    const tx = await submitKeyUpdates(ctx, calls);
    log(plan.replace.length ? 'error' : 'info', 'registry_updated', { iss, added: plan.add.length, replaced: plan.replace.length, removed: plan.remove.length, tx });
  }
  return extractRefreshDelay(headers);
}

type IssuerState = { lastSync: string | null; nextSync: string | null; error: string | null };
/** What /health reports, one entry per issuer loop. */
const state: Record<string, IssuerState> = {};

/** Syncs `iss` on its own cache cadence. Resolves only with `once`. */
async function syncForever(ctx: Ctx, iss: string, once: boolean) {
  const s: IssuerState = (state[iss] = { lastSync: null, nextSync: null, error: null });
  while (true) {
    let delay = RETRY_MS;
    try {
      delay = await syncOnce(ctx, iss);
      s.lastSync = new Date().toISOString();
      s.error = null;
    } catch (e) {
      // Kamui: a code or the error's class, in the log and in /health (which the api serves to
      // anyone). The message itself can quote the RPC URL or the request.
      s.error = errorCode(e);
      log('error', 'registry_sync_failed', { iss, error: s.error });
    }
    if (once) break;

    s.nextSync = new Date(Date.now() + delay).toISOString();
    await Bun.sleep(delay);
  }
}

// MAIN SCRIPT
async function main(): Promise<void> {
  try { assertRestoreReady(process.env); } catch { log('error', 'restore_reconciliation_required'); process.exit(1); }
  const provider = makeProvider();
  const { chain, confirmed } = await resolveChain(provider);
  exitOnWrongChain(confirmed);
  const ctx: Ctx = {
    assertPaidAvailable: () => assertRestoreReady(process.env),
    provider,
    registryOwner: new Account({
      provider,
      address: env('OWNER_ADDRESS'),
      // Kamui: through the secret source (secrets.ts).
      signer: await secretSource().get('OWNER_PRIVATE_KEY'),
    }),
    registryContractAddress: env(`${chain}_REGISTRY_ADDRESS`),
    fromBlock: Number(env(`${chain}_REGISTRY_BLOCK`)),
  };
  const once = process.argv.includes('--once');

  if (!once) {
    const server = Bun.serve({
      port: Number(process.env.ROTATOR_PORT ?? 3001),
      routes: {
        // Kamui: for a platform's liveness check. 200 whenever the process serves; /health says whether the syncs work.
        '/live': () => Response.json({ ok: true }),
        '/health': () =>
          Response.json({ ok: Object.values(state).every((s) => s.lastSync && !s.error), chain, issuers: state }),
      },
    });
    log('info', 'rotator_started', { port: server.port ?? 0, chain });
  }

  await Promise.all(ISSUERS.map((i) => syncForever(ctx, i.iss, once)));
}

if (import.meta.main) void main().catch(() => { log('error', 'rotator_startup_failed'); process.exit(1); });
