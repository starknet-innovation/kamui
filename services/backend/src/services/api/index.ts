// The backend API. The routes are in app.ts; this file reads the settings and serves them.
//
// POST /recover {jwt, account, newPubkey, blinding, pepper, signature: [r, s], keyProof?, override?} => { address, identity, transaction_hash }
//   Deploys the account when missing, runs prove_jwt, relays recover. See recovery/recover.ts.
//   With override: true the account was created under another aud; it must exist and recover only
//   records a pending recovery that finalize_override_recovery completes after the delay.
// POST /deploy {aud, identity} => { address, transaction_hash | null }
//   Deploys the social account for a browser that proves locally. See recovery/deploy.ts.
// POST /relay {account, newPubkey, signature: [r, s], proof, proofFacts, override?} => { address, identity, transaction_hash, override }
//   Relays recover with a browser-generated proof. The JWT never arrives here. See recovery/relay.ts.
// Kamui: POST /sponsor {account, calldata}, optional x-kamui-app-key header => { transaction_hash }. See recovery/sponsor.ts.
// Kamui: POST /registry/sessions, /registry/sessions/list, /registry/sessions/remove. See registry/registry.ts.
// GET /health/api => { ok: true, chain, deploys, pepper_service, sponsor, proofs }
// GET /health/prover => { ok, reason? }                     the docker prover answers its JSON-RPC ping
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
import { PROVER_TIMEOUT_MS, proverHealth } from '../prover/prove';
import { ProofQueue } from '../prover/queue';
import { pepperSettings } from '../recovery/pepper';
import { type RecoverContext } from '../recovery/recover';
import { RegistryStore } from '../registry/store';
import { MemoryLedger, loadBudgets } from '../sponsor/budgets';
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
  prover: {
    account: new Account({ provider, address: env('PROVER_ACCOUNT_ADDRESS'), signer: await secrets.get('PROVER_ACCOUNT_PRIVATE_KEY') }),
    url: process.env.PROVER_URL ?? 'http://localhost:9900',
  },
  classHash: env('KAMUI_ACCOUNT_CLASS_HASH'),
  audiences: {
    'https://accounts.google.com': env('AUTHORIZED_GOOGLE_RECOVERY_CLIENT_ID'),
    'https://appleid.apple.com': env('AUTHORIZED_APPLE_RECOVERY_CLIENT_ID'),
  },
  deploysPerHour: number('DEPLOYS_PER_HOUR', 30),
  pepper: pepperSettings(chain, process.env.PEPPER_SERVICE_URL),
  jwks: new JwksCache(),
  limiter,
  proofs: new ProofQueue({
    concurrency: number('PROVER_CONCURRENCY', 1),
    maxQueued: number('PROVER_QUEUE_MAX', 4),
    maxWaitMs: number('PROVER_QUEUE_WAIT_MS', 5 * 60_000),
  }),
  proverTimeoutMs: number('PROVER_TIMEOUT_MS', PROVER_TIMEOUT_MS),
};
const rotatorUrl = process.env.ROTATOR_URL ?? 'http://localhost:3001';
const store = new RegistryStore(process.env.REGISTRY_DB || undefined, undefined, process.env.REGISTRY_JOURNAL_MODE || 'DELETE');

/** The rotator's own answer, or why it could not be asked. */
async function rotatorHealth(): Promise<unknown> {
  try {
    const res = await fetchWithTimeout(`${rotatorUrl}/health`, {}, 3_000);
    return await res.json();
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

const app = buildApp({
  chain,
  ctx,
  sponsor: { ...ctx, budgets: loadBudgets(chain, { file: process.env.SPONSOR_BUDGETS_FILE, sponsoredPerHour: process.env.SPONSORED_PER_HOUR }), ledger },
  registry: { provider, classHash: ctx.classHash, chainId, store },
  limiter,
  limits: parseLimits(process.env.RATE_LIMITS),
  // TRUST_PROXY=true is the pepper service's spelling of one trusted proxy.
  trustedProxyHops: process.env.TRUSTED_PROXY_HOPS ? number('TRUSTED_PROXY_HOPS', 0) : process.env.TRUST_PROXY === 'true' ? 1 : 0,
  metricsToken: process.env.METRICS_TOKEN || undefined,
  health: { prover: () => proverHealth(ctx.prover.url), rotator: rotatorHealth },
});

// Expired registry entries are also dropped whenever their account is read or written.
store.dropExpired(Math.floor(Date.now() / 1000));
setInterval(() => store.dropExpired(Math.floor(Date.now() / 1000)), 3_600_000).unref();

const server = Bun.serve({
  port: number('PORT', 3000),
  // A relayed proof is up to 480,000 bytes, 640 KB as base64.
  maxRequestBodySize: 1_000_000,
  // A backend proof takes a minute or more; 255 seconds is Bun's maximum. A client that needs
  // longer than this should poll the chain for the recovery instead of holding the request.
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
log('info', 'api_started', { port: server.port ?? 0, metrics_port: metricsPort, journal_mode: store.journalMode, chain, confirmation_service: Boolean(ctx.pepper.serviceUrl) });
