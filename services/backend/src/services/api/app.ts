// Kamui: the api's routes, apart from the process that serves them (index.ts), so tests can
// drive every route with fakes. Each POST route goes through the same wrapper:
//
//   1. rate limits, per client and then global, before the body is read or anything is called;
//   2. the body is parsed and its required string fields checked;
//   3. the handler runs;
//   4. the outcome is counted, and a failure is logged as one line holding the route, the
//      status and an error code. Never the body, the client address or a free-form message.
import { RpcError } from 'starknet';
import { HttpError } from '../../http';
import { MINUTE, type Limiter } from '../../limiter';
import { errorCode, log } from '../../log';
import { metrics, renderMetrics } from '../../metrics';
import { clientAddress } from '../../net';
import { ProverError } from '../prover/errors';
import { prepareRecovery, type RecoverContext, type RecoverRequest } from '../recovery/recover';
import { relayProof, parseRelayRequest, type RelayRequest } from '../recovery/relay';
import { sponsorOutsideExecution, type SponsorContext, type SponsorRequest } from '../recovery/sponsor';
import { listSessions, putSession, removeSession, type RegistryContext } from '../registry/registry';
import { RecoveryJobs } from '../recovery/jobs';
import { prepareDeployment } from '../recovery/authenticated-deploy';
import { APP_KEY_HEADER } from '../sponsor/budgets';

/** Attempts per minute: one client, and everyone together. */
export type RouteLimit = { perClient: number; global: number };
export type RouteName = 'recover' | 'poll' | 'relay' | 'deploy' | 'sponsor' | 'registry';

/**
 * Defaults. They bound attempts, not successes: budgets and hourly caps sit behind them.
 * /recover is the dearest (a pepper lookup, maybe a deployment, a proof of a minute or more).
 */
export const DEFAULT_LIMITS: Record<RouteName, RouteLimit> = {
  recover: { perClient: 6, global: 60 },
  poll: { perClient: 120, global: 6000 },
  relay: { perClient: 10, global: 120 },
  deploy: { perClient: 6, global: 60 },
  sponsor: { perClient: 30, global: 600 },
  registry: { perClient: 60, global: 1200 },
};

/** Reads RATE_LIMITS: `route=perClient/global` pairs separated by commas, e.g. `recover=3/30,sponsor=60/1200`. */
export function parseLimits(setting: string | undefined): Record<RouteName, RouteLimit> {
  const limits = structuredClone(DEFAULT_LIMITS);
  for (const part of (setting ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const match = /^([a-z]+)=(\d+)\/(\d+)$/.exec(part);
    if (!match || !(match[1]! in limits)) throw new Error(`RATE_LIMITS: cannot read "${part}"`);
    limits[match[1] as RouteName] = { perClient: Number(match[2]), global: Number(match[3]) };
  }
  return limits;
}

export type AppDeps = {
  chain: string;
  /** Historical test harness only. Public deployments never accept server proving. */
  enableServerProving?: boolean;
  recoveryJobs?: RecoveryJobs;
  ctx: RecoverContext;
  sponsor: SponsorContext;
  registry: RegistryContext;
  limiter: Limiter;
  limits?: Record<RouteName, RouteLimit>;
  /** How many of our own proxies sit in front; see `clientAddress`. */
  trustedProxyHops?: number;
  /**
   * GET /metrics on this port is off unless a token is set, and then needs
   * `Authorization: Bearer <token>`. index.ts serves the metrics on a separate port instead.
   */
  metricsToken?: string;
  health?: { prover?: () => Promise<unknown>; rotator?: () => Promise<unknown> };
};

type Handler = (body: any, client: string, req: Request) => Promise<unknown>;
type Route = { limit: RouteName; fields: string[]; handler: Handler; status?: number };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers });

/** Status and the text the client gets. Only our own codes are echoed. */
export function describeError(e: unknown): { status: number; error: string } {
  if (e instanceof HttpError) return { status: e.status, error: e.message };
  if (e instanceof ProverError) return { status: 502, error: 'PROVER_FAILED' };
  // An RPC error's message repeats the request it was for (calldata, a proof), so it is not passed on.
  if (e instanceof RpcError) return { status: 502, error: 'RPC_ERROR' };
  const message = e instanceof Error ? e.message : '';
  if (/^[A-Z][A-Z0-9_]{2,40}$/.test(message)) return { status: 400, error: message };
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError' || /timed out|fetch failed|ECONN|socket/i.test(message))) return { status: 502, error: 'UPSTREAM_UNAVAILABLE' };
  return { status: 500, error: 'INTERNAL' };
}

/** The metrics as a Prometheus scrape answer. */
export const metricsResponse = () => new Response(renderMetrics(), { headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' } });

const describeJobError = (e: unknown) => {
  const described = describeError(e);
  // HttpError can wrap a remote error; jobs/status must never retain its free-form text.
  return { ...described, error: errorCode(new Error(described.error)) };
};

const outcome = (status: number) => (status < 400 ? 'ok' : status === 429 ? 'rate_limited' : status < 500 ? 'rejected' : 'failed');

export function buildApp(deps: AppDeps) {
  const jobs = deps.recoveryJobs ?? new RecoveryJobs();
  const ctx: RecoverContext = { ...deps.ctx, assertRecoveryAvailable: (account) => jobs.assertAccountAvailable(account) };
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const hops = deps.trustedProxyHops ?? 0;

  const posts: Record<string, Route> = {
    '/recover': { limit: 'recover', fields: ['jobId', 'jwt', 'account', 'newPubkey', 'blinding', 'pepper'], status: 202, handler: async (b: RecoverRequest & { jobId: string }) => {
      if (!deps.enableServerProving) throw new HttpError(410, 'CLIENT_PROVING_REQUIRED');
      const work = await prepareRecovery(b, ctx);
      jobs.submit(b.jobId, b, work, (e) => {
        const described = describeError(e);
        if (e instanceof RpcError) metrics.outboundFailures.inc({ target: 'rpc' });
        log(described.status >= 500 ? 'error' : 'info', 'request_failed', { route: '/recover', status: described.status, error: errorCode(e) });
        // Only a code is retained; never store arbitrary upstream text in a job.
        return { ...described, error: errorCode(new Error(described.error)) };
      });
      return { jobId: b.jobId };
    } },
    '/recover/status': { limit: 'poll', fields: ['jobId'], handler: async (b) => { await jobs.reconcile(ctx.provider, b.jobId); return jobs.status(b.jobId); } },
    '/deploy': { limit: 'deploy', fields: ['aud', 'identity'], handler: async () => { throw new HttpError(410, 'AUTHENTICATED_DEPLOYMENT_REQUIRED'); } },
    '/deploy/authenticated': { limit: 'deploy', fields: ['jobId', 'jwt', 'account', 'newPubkey', 'blinding', 'pepper'], status: 202, handler: async (b: RecoverRequest & { jobId: string }, client) => {
      if (!jobs.durable) throw new HttpError(503, 'DURABLE_JOURNAL_REQUIRED');
      const request = { account: b.account, operation: 'deployment' as const, payload: [b.jwt, b.newPubkey, b.blinding, b.pepper, b.signature, b.keyProof, b.override ?? false] };
      if (!jobs.hasSubmission(b.jobId, request)) {
        const work = await prepareDeployment(b, client, ctx);
        jobs.submit(b.jobId, request, work, describeJobError);
      }
      return { jobId: b.jobId };
    } },
    '/relay': { limit: 'relay', fields: ['jobId', 'account', 'newPubkey', 'proof'], status: 202, handler: async (b: RelayRequest & { jobId: string }, client) => {
      parseRelayRequest(b);
      const request = { account: b.account, operation: 'relay' as const, payload: [b.newPubkey, b.signature, b.proof, b.proofFacts, b.override ?? false] };
      if (!jobs.hasSubmission(b.jobId, request)) jobs.assertAccountAvailable(b.account);
      if (!jobs.durable) throw new HttpError(503, 'DURABLE_JOURNAL_REQUIRED');
      jobs.submit(b.jobId, request, (journal) => relayProof(b, client, { ...ctx, journal }), describeJobError);
      return { jobId: b.jobId };
    } },
    '/sponsor': { limit: 'sponsor', fields: ['account'], handler: (b: SponsorRequest, _client, req) => sponsorOutsideExecution(b, req.headers.get(APP_KEY_HEADER), deps.sponsor) },
    '/registry/sessions': { limit: 'registry', fields: ['account'], handler: (b) => putSession(b, deps.registry) },
    '/registry/sessions/list': { limit: 'registry', fields: ['account'], handler: (b) => listSessions(b, deps.registry) },
    '/registry/sessions/remove': { limit: 'registry', fields: ['account', 'publicKey'], handler: (b) => removeSession(b, deps.registry) },
  };

  const gets: Record<string, (req: Request) => Promise<Response> | Response> = {
    '/health/api': () =>
      json({
        ok: true,
        chain: deps.chain,
        deploys: ctx.deploysPerHour > 0,
        pepper_service: Boolean(ctx.pepper.serviceUrl),
        sponsor: deps.sponsor.budgets.anonymous.txPerPeriod > 0 || deps.sponsor.budgets.byKey.size > 0,
        proving: 'browser',
      }),
    '/health/prover': async () => json((await deps.health?.prover?.()) ?? { ok: false, reason: 'not configured' }),
    '/health/rotator': async () => json((await deps.health?.rotator?.()) ?? { ok: false, reason: 'not configured' }),
    // No dependencies: for a platform's liveness check.
    '/live': () => json({ ok: true }),
    '/metrics': (req) => {
      if (!deps.metricsToken) return json({ error: 'NOT_FOUND' }, 404);
      if (req.headers.get('authorization') !== `Bearer ${deps.metricsToken}`) return new Response('unauthorized\n', { status: 401 });
      return metricsResponse();
    },
  };

  async function post(path: string, route: Route, req: Request, socketAddress: string | undefined): Promise<Response> {
    const client = clientAddress(socketAddress, req.headers.get('x-forwarded-for'), hops);
    const limit = limits[route.limit];
    for (const [scope, key, max] of [['client', `${route.limit}:${client}`, limit.perClient], ['global', `${route.limit}:*`, limit.global]] as const) {
      if (!(await deps.limiter.take(`route:${key}`, max, MINUTE))) {
        metrics.rateLimited.inc({ route: path, scope });
        return json({ error: 'RATE_LIMITED' }, 429, { 'retry-after': '60' });
      }
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || route.fields.some((f) => typeof body[f] !== 'string')) {
      return json({ error: 'BAD_REQUEST', detail: `body must be {${route.fields.join(', ')}}` }, 400);
    }
    try {
      return json(await route.handler(body, client, req), route.status ?? 200);
    } catch (e) {
      const { status, error } = describeError(e);
      if (e instanceof RpcError) metrics.outboundFailures.inc({ target: 'rpc' });
      log(status >= 500 ? 'error' : 'info', 'request_failed', { route: path, status, error: errorCode(e) });
      return json({ error }, status, status === 503 || status === 429 ? { 'retry-after': '60' } : {});
    }
  }

  return {
    /** `socketAddress` is the peer of the connection, from the server. */
    async handle(req: Request, socketAddress?: string): Promise<Response> {
      const path = new URL(req.url).pathname;
      const route: Route | undefined = posts[path];
      const get: ((req: Request) => Promise<Response> | Response) | undefined = gets[path];
      if (!route && !get) return json({ error: 'NOT_FOUND' }, 404);
      if (req.method !== (route ? 'POST' : 'GET')) return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
      let response: Response;
      try {
        response = route ? await post(path, route, req, socketAddress) : await get!(req);
      } catch (e) {
        log('error', 'request_failed', { route: path, status: 500, error: errorCode(e) });
        response = json({ error: 'INTERNAL' }, 500);
      }
      if (['/recover', '/recover/status', '/relay', '/deploy/authenticated'].includes(path)) response.headers.set('cache-control', 'no-store');
      if (path !== '/metrics' && path !== '/live') metrics.requests.inc({ route: path, outcome: outcome(response.status) });
      return response;
    },
  };
}
