// The backend API. The routes are in app.ts; this file reads the settings and serves them.
//
// POST /deploy/authenticated {jobId, jwt, account, newPubkey, blinding, pepper, signature, keyProof?}
//   Authenticates/pepper-confirms a first deployment. No execution or proving here.
// POST /relay {jobId, account, newPubkey, signature, proof, proofFacts, override?}
//   Accepts a browser-generated pinned V2 proof. Both routes return 202 {jobId}.
// POST /recover/status {jobId} => running | succeeded (result) | failed (code, httpStatus).
//   Capability-protected durable status and receipt reconciliation, never re-proving.
// POST /recover and legacy /deploy are disabled in this process (410).
// Kamui: POST /sponsor {account, calldata}, optional x-kamui-app-key header => { transaction_hash }. See recovery/sponsor.ts.
// Kamui: POST /registry/sessions, /registry/sessions/list, /registry/sessions/remove. See registry/registry.ts.
// GET /health/api => { ok: true, chain, deploys, pepper_service, sponsor, proving: "browser" }
// GET /health/prover => { ok: false, reason: "not configured" } (historical health route)
// GET /health/rotator => { ok, chain?, issuers?, reason? }  the rotator's own /health, proxied (see rotator/jwk-rotator.ts)
// Kamui: GET /live => { ok: true }, no dependencies.
// Kamui: GET /metrics => Prometheus text, on METRICS_PORT (9464), not on the public port unless METRICS_TOKEN is set. See metrics.ts.
//
// Run: bun run service:api. Settings: .env.example.

import { Account } from 'starknet';
import { env, exitOnWrongChain, makeProvider, resolveChain } from '../../env';
import { JwksCache } from '../../jwk/verification';
import { MemoryLimiter } from '../../limiter';
import { log } from '../../log';
import { fetchWithTimeout } from '../../net';
import { secretSource } from '../../secrets';
import { ProofQueue } from '../prover/queue';
import { pepperSettings } from '../recovery/pepper';
import { openBackendStorage } from '../../storage/backend-storage';
import { type RecoverContext } from '../recovery/recover';
import { MemoryLedger, loadBudgets } from '../sponsor/budgets';
import { paymasterFromEnvironment } from '../sponsor/paymaster';
import { buildApp, metricsResponse, parseLimits } from './app';

const number = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a number`);
  return value;
};

const provider = makeProvider();
// Kamui: with CHAIN_ID set the api starts without the RPC and checks the chain in the background.
const { chain, chainId, confirmed } = await resolveChain(provider);
exitOnWrongChain(confirmed);
// Kamui: signing keys come from the secret source (secrets.ts), not straight from the environment.
const secrets = secretSource();
// Kamui: in process. Replace both with shared implementations when the api is replicated.
const limiter = new MemoryLimiter();
const ledger = new MemoryLedger();

const ctx: RecoverContext = {
  provider,
  relayer: new Account({ provider, address: env('RELAYER_ADDRESS'), signer: await secrets.get('RELAYER_PRIVATE_KEY') }),
  classHash: env('KAMUI_ACCOUNT_CLASS_HASH'),
  audiences: {
    'https://accounts.google.com': env('AUTHORIZED_GOOGLE_RECOVERY_CLIENT_ID'),
    ...(process.env.AUTHORIZED_APPLE_RECOVERY_CLIENT_ID ? { 'https://appleid.apple.com': process.env.AUTHORIZED_APPLE_RECOVERY_CLIENT_ID } : {}),
  },
  deploysPerHour: number('DEPLOYS_PER_HOUR', 30),
  pepper: pepperSettings(chain, process.env.PEPPER_SERVICE_URL),
  jwks: new JwksCache(),
  limiter,
  proofs: new ProofQueue(), // Historical context only; no public proving route.
};
const rotatorUrl = process.env.ROTATOR_URL ?? 'http://localhost:3001';
const storage = await openBackendStorage(process.env, `${chainId}:${ctx.classHash}`, () => {
  log('error', 'postgres_writer_lease_lost');
  process.exit(1);
}).catch(() => { log('error', 'storage_startup_failed'); process.exit(1); });
const { store, recoveryJobs } = storage;

/** The rotator's own answer, or why it could not be asked. */
async function rotatorHealth(): Promise<unknown> {
  try {
    const res = await fetchWithTimeout(`${rotatorUrl}/health`, {}, 3_000);
    return await res.json();
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

// Only orphaned metadata is reconciled. No JWT, pepper or proof is resumed from disk.
void recoveryJobs.reconcile(provider).catch(() => log('error', 'recovery_reconciliation_failed'));
setInterval(() => { void recoveryJobs.reconcile(provider).catch(() => log('error', 'recovery_reconciliation_failed')); }, 15_000).unref();

const app = buildApp({
  recoveryJobs,
  chain,
  ctx,
  sponsor: { ...ctx, budgets: loadBudgets(chain, { file: process.env.SPONSOR_BUDGETS_FILE, sponsoredPerHour: process.env.SPONSORED_PER_HOUR }), ledger, paymaster: paymasterFromEnvironment(chainId) },
  registry: { provider, classHash: ctx.classHash, chainId, store },
  limiter,
  limits: parseLimits(process.env.RATE_LIMITS),
  // TRUST_PROXY=true is the pepper service's spelling of one trusted proxy.
  trustedProxyHops: process.env.TRUSTED_PROXY_HOPS ? number('TRUSTED_PROXY_HOPS', 0) : process.env.TRUST_PROXY === 'true' ? 1 : 0,
  metricsToken: process.env.METRICS_TOKEN || undefined,
  health: { rotator: rotatorHealth },
});

// Expired registry entries are also dropped whenever their account is read or written.
await Promise.resolve(store.dropExpired(Math.floor(Date.now() / 1000))).catch(() => { log('error', 'registry_prune_failed'); process.exit(1); });
setInterval(() => { void Promise.resolve(store.dropExpired(Math.floor(Date.now() / 1000))).catch(() => log('error', 'registry_prune_failed')); }, 3_600_000).unref();

const server = Bun.serve({
  port: number('PORT', 3000),
  // A relayed proof is up to 480,000 bytes, 640 KB as base64.
  maxRequestBodySize: 1_000_000,
  // Recovery proofs run as jobs; this timeout no longer bounds their lifetime.
  idleTimeout: 255,
  fetch: (req, srv) => app.handle(req, srv.requestIP(req)?.address),
});
// Kamui: metrics are served on their own port, which is not the public one. Do not publish it;
// let the scraper reach it inside the network. METRICS_PORT=0 turns the listener off.
const metricsPort = number('METRICS_PORT', 9464);
if (metricsPort > 0) {
  Bun.serve({
    port: metricsPort,
    hostname: process.env.METRICS_HOST ?? '0.0.0.0',
    fetch: (req) => (new URL(req.url).pathname === '/metrics' && req.method === 'GET' ? metricsResponse() : new Response('not found\n', { status: 404 })),
  });
}
log('info', 'api_started', { port: server.port ?? 0, metrics_port: metricsPort, storage: storage.backend, journal_mode: store.journalMode, chain, confirmation_service: Boolean(ctx.pepper.serviceUrl) });

// Stopping releases the writer lease only as the process exits. In-flight jobs remain
// interrupted/reconcilable metadata; no saved proof or automatic rebroadcast.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  server.stop(true);
  void storage.close().finally(() => process.exit(0));
});
