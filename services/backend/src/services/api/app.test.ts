// Kamui: the routes together, driven as HTTP requests with fakes behind them: rate limits on
// every route that does work, the error mapping, /metrics, and what the logs hold.
import { describe, expect, test } from 'bun:test';
import { RpcError } from 'starknet';
import { JwksCache } from '../../jwk/verification';
import { MemoryLimiter } from '../../limiter';
import { setLogSink } from '../../log';
import { resetMetrics } from '../../metrics';
import { ProofQueue } from '../prover/queue';
import { RegistryStore } from '../registry/store';
import { DEFAULT_MAX_FEE_PER_TX, MemoryLedger } from '../sponsor/budgets';
import { DEFAULT_LIMITS, buildApp, describeError, metricsResponse, parseLimits, type AppDeps, type RouteName } from './app';

const CLASS = '0x13c5e8166199db99e894da9e55ce642267e5258c42eae8851357747b6201fdc';
const ACCOUNT = '0x3ec3b3ead6762ecf0172e0d5e3f9df472e66608e3f483f300a784dc9652d193';
const APP_KEY = 'kamui_app_test_0123456789abcdef';

function app(over: Partial<AppDeps> = {}, limits: Partial<Record<RouteName, { perClient: number; global: number }>> = {}) {
  const seen = { rpc: 0, issuer: 0, sent: 0, estimateFails: false };
  const provider: any = {
    getClassHashAt: async () => (seen.rpc++, CLASS),
    callContract: async () => (seen.rpc++, ['0x0']),
    getBlockNumber: async () => (seen.rpc++, 1000),
    waitForTransaction: async () => ({}),
  };
  const relayer: any = {
    estimateInvokeFee: async () => {
      if (seen.estimateFails) throw new RpcError({ code: 41, message: 'x', data: 'Kamui: invalid owner signature' } as any, 'starknet_estimateFee', {});
      return { overall_fee: 1000n, resourceBounds: {} };
    },
    execute: async () => (seen.sent++, { transaction_hash: '0xabc' }),
  };
  const limiter = new MemoryLimiter();
  const ctx: any = {
    provider,
    relayer,
    prover: { account: {}, url: 'http://prover.test' },
    classHash: CLASS,
    audiences: { 'https://accounts.google.com': 'aud' },
    deploysPerHour: 30,
    pepper: { mainnet: false },
    jwks: new JwksCache({ send: async () => (seen.issuer++, Response.json({ keys: [] })) }),
    limiter,
    proofs: new ProofQueue(),
  };
  const anonymous = { name: 'anonymous', txPerPeriod: 1000, periodSeconds: 3600, perAccountPerPeriod: 1000, maxFeePerTx: DEFAULT_MAX_FEE_PER_TX };
  const built = buildApp({
    chain: 'SN_SEPOLIA',
    ctx,
    sponsor: { ...ctx, budgets: { anonymous, byKey: new Map([[APP_KEY, { ...anonymous, name: 'demo', txPerPeriod: 1 }]]) }, ledger: new MemoryLedger() },
    registry: { provider, classHash: CLASS, chainId: '0x534e5f5345504f4c4941', store: new RegistryStore(':memory:') },
    limiter,
    limits: { ...DEFAULT_LIMITS, ...limits },
    ...over,
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}, ip = '203.0.113.1') =>
    built.handle(new Request(`http://api.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), ip);
  const get = (path: string, headers: Record<string, string> = {}) => built.handle(new Request(`http://api.test${path}`, { headers }), '203.0.113.1');
  return { post, get, seen };
}

/** A body that passes each route's field check and then fails early in its handler. */
const BODIES: Record<string, unknown> = {
  '/recover/status': { jobId: '0x' + 'a'.repeat(62) },
  '/recover': { jobId: '0x' + 'a'.repeat(62), jwt: 'a.b.c', account: ACCOUNT, newPubkey: '0x1', blinding: '0x2', pepper: '0x3', signature: ['0x1', '0x2'] },
  '/relay': { account: ACCOUNT, newPubkey: '0x1', proof: 'AAAA', signature: ['0x1', '0x2'], proofFacts: [] },
  '/deploy': { aud: 'not-ours', identity: '0x1' },
  '/sponsor': { account: ACCOUNT, calldata: ['0x1'] },
  '/registry/sessions': { account: ACCOUNT, timestamp: 1, nonce: '0x1', signature: ['0x1', '0x2'], session: {} },
  '/registry/sessions/list': { account: ACCOUNT, timestamp: 1, nonce: '0x1', signature: ['0x1', '0x2'] },
  '/registry/sessions/remove': { account: ACCOUNT, timestamp: 1, nonce: '0x1', signature: ['0x1', '0x2'], publicKey: '0x1' },
};

async function quietly<T>(work: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const previous = setLogSink((line) => lines.push(line));
  try {
    return { result: await work(), lines };
  } finally {
    setLogSink(previous);
  }
}

describe('rate limits', () => {
  for (const [path, body] of Object.entries(BODIES)) {
    test(`${path}: a client over its limit is refused before any work, others are not`, async () => {
      const tight = { perClient: 2, global: 100 };
      const { post, seen } = app({}, { recover: tight, poll: tight, relay: tight, deploy: tight, sponsor: tight, registry: tight });
      await quietly(async () => {
        await post(path, body);
        await post(path, body);
        const before = { ...seen };
        const refused = await post(path, body);
        expect(refused.status).toBe(429);
        expect(await refused.json()).toEqual({ error: 'RATE_LIMITED' });
        expect(refused.headers.get('retry-after')).toBe('60');
        expect(seen).toEqual(before);
        expect((await post(path, body, {}, '203.0.113.2')).status).not.toBe(429);
      });
    });
  }

  test('the global limit holds across clients', async () => {
    const { post } = app({}, { sponsor: { perClient: 100, global: 3 } });
    await quietly(async () => {
      for (let i = 0; i < 3; i++) expect((await post('/sponsor', BODIES['/sponsor'], {}, `198.51.100.${i}`)).status).toBe(200);
      expect((await post('/sponsor', BODIES['/sponsor'], {}, '198.51.100.9')).status).toBe(429);
      // Another route has its own count.
      expect((await post('/deploy', BODIES['/deploy'], {}, '198.51.100.9')).status).toBe(400);
    });
  });

  test('finding #4: repeated malformed sponsor attempts from one client are throttled before any RPC work', async () => {
    const { post, seen } = app({}, { sponsor: { perClient: 5, global: 1000 } });
    seen.estimateFails = true;
    await quietly(async () => {
      for (let i = 0; i < 5; i++) expect((await post('/sponsor', BODIES['/sponsor'])).status).toBe(400);
      const rpcBefore = seen.rpc;
      for (let i = 0; i < 20; i++) expect((await post('/sponsor', BODIES['/sponsor'])).status).toBe(429);
      expect(seen.rpc).toBe(rpcBefore);
      // The rejected calls spent nothing: another client is sponsored.
      seen.estimateFails = false;
      expect((await post('/sponsor', BODIES['/sponsor'], {}, '203.0.113.50')).status).toBe(200);
    });
  });

  test('behind a trusted proxy the limit follows the forwarded client, not the proxy', async () => {
    const { post } = app({ trustedProxyHops: 1 }, { sponsor: { perClient: 1, global: 100 } });
    await quietly(async () => {
      const from = (client: string) => post('/sponsor', BODIES['/sponsor'], { 'x-forwarded-for': `9.9.9.9, ${client}` }, '10.0.0.1');
      expect((await from('203.0.113.7')).status).toBe(200);
      expect((await from('203.0.113.7')).status).toBe(429);
      expect((await from('203.0.113.8')).status).toBe(200);
    });
  });

  test('RATE_LIMITS is read strictly', () => {
    expect(parseLimits(undefined)).toEqual(DEFAULT_LIMITS);
    expect(parseLimits('recover=3/30, sponsor=60/1200')).toMatchObject({ recover: { perClient: 3, global: 30 }, sponsor: { perClient: 60, global: 1200 }, relay: DEFAULT_LIMITS.relay });
    expect(() => parseLimits('nothing=1/2')).toThrow();
    expect(() => parseLimits('recover=lots')).toThrow();
  });
});

describe('sponsor over HTTP', () => {
  test('the app key header selects the budget', async () => {
    const { post } = app();
    await quietly(async () => {
      const headers = { 'x-kamui-app-key': APP_KEY };
      expect(await (await post('/sponsor', BODIES['/sponsor'], headers)).json()).toEqual({ transaction_hash: '0xabc' });
      const spent = await post('/sponsor', BODIES['/sponsor'], headers);
      expect([spent.status, await spent.json()]).toEqual([429, { error: 'SPONSOR_CAP' }]);
      expect((await post('/sponsor', BODIES['/sponsor'])).status).toBe(200);
      const unknown = await post('/sponsor', BODIES['/sponsor'], { 'x-kamui-app-key': 'kamui_app_nobody_0123456789' });
      expect([unknown.status, await unknown.json()]).toEqual([403, { error: 'UNKNOWN_APP_KEY' }]);
    });
  });
});

describe('answers', () => {
  test('errors are { error } with a status; unknown routes and methods are refused', async () => {
    const { post, get } = app();
    await quietly(async () => {
      const bad = await post('/recover', { jwt: 'x' });
      expect([bad.status, (await bad.json()).error]).toEqual([400, 'BAD_REQUEST']);
      const jwt = await post('/recover', BODIES['/recover']);
      expect([jwt.status, await jwt.json()]).toEqual([400, { error: 'BAD_JWT' }]);
      const stale = await post('/registry/sessions/list', BODIES['/registry/sessions/list']);
      expect([stale.status, await stale.json()]).toEqual([401, { error: 'STALE_TIMESTAMP' }]);
      expect((await get('/nope')).status).toBe(404);
      expect((await get('/recover')).status).toBe(405);
      expect((await post('/health/api', {})).status).toBe(405);
      expect(await (await get('/health/api')).json()).toMatchObject({ ok: true, chain: 'SN_SEPOLIA', sponsor: true });
    });
  });

  test('only our own codes reach the client; an RPC or unknown error does not echo its text', () => {
    const rpc = new RpcError({ code: 1, message: 'boom', data: 'calldata 0xdeadbeef' } as any, 'starknet_call', { secret: '0xdeadbeef' });
    expect(describeError(rpc)).toEqual({ status: 502, error: 'RPC_ERROR' });
    expect(describeError(new Error('WRONG_ACCOUNT'))).toEqual({ status: 400, error: 'WRONG_ACCOUNT' });
    expect(describeError(new SyntaxError('Unexpected token eyJhbGciOi'))).toEqual({ status: 500, error: 'INTERNAL' });
    expect(describeError(new Error('The operation timed out'))).toEqual({ status: 502, error: 'UPSTREAM_UNAVAILABLE' });
  });
});

describe('metrics and logs', () => {
  test('/metrics reports requests, rate limits and sponsor decisions, and nothing from a request', async () => {
    resetMetrics();
    const { post } = app({}, { recover: { perClient: 1, global: 10 } });
    const marker = '0xfeedfacefeedface';
    const { lines } = await quietly(async () => {
      await post('/sponsor', BODIES['/sponsor']);
      await post('/recover', { ...(BODIES['/recover'] as object), pepper: marker, jwt: `${marker}.b.c` });
      await post('/recover', BODIES['/recover']);
      await post('/registry/sessions', { ...(BODIES['/registry/sessions'] as object), session: { origin: 'https://secret-site.example' } });
    });
    const response = metricsResponse();
    expect(response.headers.get('content-type')).toContain('text/plain');
    const text = await response.text();
    expect(text).toContain('kamui_http_requests_total{route="/sponsor",outcome="ok"} 1');
    expect(text).toContain('kamui_http_requests_total{route="/recover",outcome="rejected"} 1');
    expect(text).toContain('kamui_http_requests_total{route="/recover",outcome="rate_limited"} 1');
    expect(text).toContain('kamui_rate_limited_total{route="/recover",scope="client"} 1');
    expect(text).toContain('kamui_sponsor_decisions_total{budget="anonymous",decision="sponsored"} 1');
    expect(text).toContain('kamui_registry_requests_total{action="put",result="refused"} 1');
    for (const output of [text, lines.join('\n')]) {
      expect(output).not.toContain(marker);
      expect(output).not.toContain('203.0.113.1');
      expect(output).not.toContain('secret-site');
      expect(output).not.toContain(APP_KEY);
    }
    // The registry's log lines name no account.
    for (const line of lines.map((l) => JSON.parse(l)).filter((l) => String(l.route).startsWith('/registry'))) {
      expect(JSON.stringify(line)).not.toContain(ACCOUNT);
    }
    expect(lines.every((line) => !line.includes('\n') && typeof JSON.parse(line).event === 'string')).toBe(true);
    resetMetrics();
  });

  test('/metrics is not on the public port unless a token is set, and then needs it', async () => {
    expect((await app().get('/metrics')).status).toBe(404);
    expect(await (await app().get('/live')).json()).toEqual({ ok: true });
    const { get } = app({ metricsToken: 'scrape-me' });
    expect((await get('/metrics')).status).toBe(401);
    expect((await get('/metrics', { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await get('/metrics', { authorization: 'Bearer scrape-me' })).status).toBe(200);
  });
});
