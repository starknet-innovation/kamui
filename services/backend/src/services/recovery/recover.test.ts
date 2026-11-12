// Kamui: /recover with fakes for the issuer, the chain, the prover and the relayer.
// Audit finding #3: nothing outbound happens per request before the token is authenticated.
import { describe, expect, test } from 'bun:test';
import { RpcError } from 'starknet';
import { HttpError } from '../../http';
import { JwksCache, extractJwt, type Jwk } from '../../jwk/verification';
import { MemoryLimiter } from '../../limiter';
import { metrics, resetMetrics } from '../../metrics';
import { accountAddress, expectedNonce, extractIdentity } from '../../social-account';
import { ProofQueue } from '../prover/queue';
import { recoverAccount, type RecoverContext, type RecoverRequest } from './recover';

const GOOGLE = 'https://accounts.google.com';
const AUD = 'client-id.apps.example';
const CLASS = '0x13c5e8166199db99e894da9e55ce642267e5258c42eae8851357747b6201fdc';
const NEW_KEY = '0x1234';
const BLINDING = '0x5678';
const PEPPER = '0x9abc';
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
const JWK: Jwk = { kid: 'kid-1', kty: 'RSA', alg: 'RS256', use: 'sig', n: exported.n!, e: exported.e! };

async function token(options: { kid?: string; signed?: boolean; aud?: string } = {}): Promise<string> {
  const header = b64({ alg: 'RS256', kid: options.kid ?? JWK.kid, typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const nonce = '0x' + expectedNonce(NEW_KEY, BLINDING).toString(16);
  const payload = b64({ iss: GOOGLE, aud: options.aud ?? AUD, sub: 'user-1', nonce, iat: now - 10, exp: now + 3600 });
  const signature = options.signed === false
    ? crypto.getRandomValues(new Uint8Array(256))
    : new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${header}.${payload}`)));
  return `${header}.${payload}.${Buffer.from(signature).toString('base64url')}`;
}

function request(jwt: string): RecoverRequest {
  const identity = extractIdentity(extractJwt(jwt), PEPPER);
  return { jwt, account: accountAddress(AUD, identity, CLASS), newPubkey: NEW_KEY, blinding: BLINDING, pepper: PEPPER, signature: ['0x1', '0x2'] };
}

function context(over: Partial<RecoverContext> = {}) {
  const seen = { issuerFetches: 0, rpc: 0, proofs: 0, sent: [] as any[] };
  const send = async () => {
    seen.issuerFetches += 1;
    return Response.json({ keys: [JWK] });
  };
  const ctx = {
    provider: {
      getClassHashAt: async () => (seen.rpc++, CLASS),
      callContract: async () => (seen.rpc++, ['0x1']),
      waitForTransaction: async () => ({}),
    },
    relayer: { execute: async (call: unknown, details: unknown) => (seen.sent.push({ call, details }), { transaction_hash: '0xfeed' }) },
    prover: { account: {}, url: 'http://prover.test' },
    classHash: CLASS,
    audiences: { [GOOGLE]: AUD },
    deploysPerHour: 0,
    pepper: { mainnet: false },
    jwks: new JwksCache({ send }),
    limiter: new MemoryLimiter(),
    proofs: new ProofQueue(),
    prove: async () => (seen.proofs++, { proof: Buffer.from('proof').toString('base64'), proof_facts: ['0x1'] }),
    ...over,
  } as unknown as RecoverContext;
  return { ctx, seen };
}
const status = (p: Promise<unknown>) => p.then(() => 'ok', (e: HttpError) => `${e.status ?? ''} ${e.message}`.trim());

describe('finding #3: work before authentication', () => {
  test('repeated unsigned tokens cause one issuer fetch, not one each, and nothing else', async () => {
    const { ctx, seen } = context();
    for (let i = 0; i < 5; i++) expect(await status(recoverAccount(request(await token({ signed: false })), ctx))).toBe('BAD_SIGNATURE');
    expect(seen.issuerFetches).toBe(1);
    expect(seen.rpc).toBe(0);
    expect(seen.proofs).toBe(0);
    expect(seen.sent).toHaveLength(0);
  });

  test('unsigned tokens with made-up kids do not cause a fetch each either', async () => {
    const { ctx, seen } = context();
    for (let i = 0; i < 5; i++) expect(await status(recoverAccount(request(await token({ signed: false, kid: `fake-${i}` })), ctx))).toBe('UNKNOWN_KID');
    expect(seen.issuerFetches).toBe(1);
  });

  test('a token for another audience, an expired one or a wrong nonce is refused with no fetch at all', async () => {
    const { ctx, seen } = context();
    expect(await status(recoverAccount(request(await token({ aud: 'someone-else' })), ctx))).toBe('400 WRONG_AUDIENCE');
    expect(await status(recoverAccount({ ...request(await token()), blinding: '0x1' }, ctx))).toBe('400 NONCE_MISMATCH');
    expect(await status(recoverAccount({ ...request(await token()), jwt: 'a.b.c' }, ctx))).toBe('400 BAD_JWT');
    expect(await status(recoverAccount({ ...request(await token()), jwt: 'x'.repeat(9000) }, ctx))).toBe('400 BAD_JWT');
    expect(seen.issuerFetches).toBe(0);
  });

  test('an issuer that does not answer is a bounded 502', async () => {
    const jwks = new JwksCache({ send: () => new Promise<Response>(() => {}), timeoutMs: 30 });
    const { ctx } = context({ jwks });
    const started = Date.now();
    expect(await status(recoverAccount(request(await token()), ctx))).toBe('502 JWKS_UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('pepper confirmation and deployment', () => {
  /** A pepper service nobody answers at: any attempt to ask it is a 502. */
  const unreachable = { serviceUrl: 'http://127.0.0.1:9', mainnet: false };
  const notDeployed = () => {
    throw new RpcError({ code: 20, message: 'Contract not found' } as any, 'starknet_getClassHashAt', {});
  };

  test('an existing account recovers without the pepper service being asked', async () => {
    // This is the recovery-file case: the pepper service may be unavailable or lost.
    const { ctx, seen } = context({ pepper: unreachable });
    const withProof = { ...request(await token()), keyProof: undefined };
    expect(await status(recoverAccount(withProof, ctx))).toBe('ok');
    expect(seen.proofs).toBe(1);
    // Only `recover` was sent: no deployment.
    expect(seen.sent).toHaveLength(1);
  });

  test('a new account is not deployed unless the pepper service confirms the pepper', async () => {
    const { ctx, seen } = context({ pepper: unreachable });
    (ctx.provider as any).getClassHashAt = async () => notDeployed();
    const result = await status(recoverAccount({ ...request(await token()), keyProof: ['0x1', '0x2'] }, ctx));
    expect(result).toBe('502 PEPPER_SERVICE_UNAVAILABLE');
    expect(seen.sent).toHaveLength(0);
    expect(seen.proofs).toBe(0);
  });

  test('a new account without a key proof is refused before anything is paid for', async () => {
    const { ctx, seen } = context({ pepper: unreachable });
    (ctx.provider as any).getClassHashAt = async () => notDeployed();
    expect(await status(recoverAccount(request(await token()), ctx))).toBe('400 KEY_PROOF_REQUIRED');
    expect(seen.sent).toHaveLength(0);
  });

  test('pepper 0 is refused on mainnet even for an existing account', async () => {
    const { ctx, seen } = context({ pepper: { serviceUrl: 'http://127.0.0.1:9', mainnet: true } });
    const zero = { ...request(await token()), pepper: '0x0' };
    expect(await status(recoverAccount(zero, ctx))).toBe('400 PEPPER_REQUIRED');
    expect(seen.proofs).toBe(0);
  });
});

describe('recover', () => {
  test('a valid token is proven once and relayed, and the proof is counted', async () => {
    resetMetrics();
    const { ctx, seen } = context();
    const req = request(await token());
    const result = await recoverAccount(req, ctx);
    expect(result).toMatchObject({ address: req.account, transaction_hash: '0xfeed' });
    expect(seen.proofs).toBe(1);
    expect(seen.sent).toHaveLength(1);
    expect(seen.sent[0].call.entrypoint).toBe('recover');
    expect(metrics.proofs.get({ result: 'started' })).toBe(1);
    expect(metrics.proofs.get({ result: 'succeeded' })).toBe(1);
  });

  test('refuses before paying for anything when the prover queue is full', async () => {
    const proofs = new ProofQueue({ concurrency: 1, maxQueued: 0 });
    let release!: () => void;
    const busy = proofs.run(() => new Promise<void>((resolve) => (release = resolve)));
    const { ctx, seen } = context({ proofs });
    expect(await status(recoverAccount(request(await token()), ctx))).toBe('503 PROVER_BUSY');
    expect(seen.rpc).toBe(0);
    expect(seen.sent).toHaveLength(0);
    release();
    await busy;
  });

  test('one recovery per account at a time', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { ctx } = context({ prove: async () => (await held, { proof: 'cHJvb2Y=', proof_facts: ['0x1'] }) });
    const req = request(await token());
    const first = recoverAccount(req, ctx);
    await Bun.sleep(20);
    expect(await status(recoverAccount(req, ctx))).toBe('409 IN_PROGRESS');
    release();
    await first;
  });

  test('a failed proof is counted as failed', async () => {
    resetMetrics();
    const { ctx } = context({ prove: async () => { throw new Error('prover died'); } });
    expect(await status(recoverAccount(request(await token()), ctx))).toBe('prover died');
    expect(metrics.proofs.get({ result: 'failed' })).toBe(1);
    expect(metrics.outboundFailures.get({ target: 'prover' })).toBe(1);
  });
});

describe('recovery jobs over HTTP', () => {
  test('a slow proof survives an aborted submission connection; retries do not deploy, prove or relay twice', async () => {
    const { buildApp } = await import('../api/app');
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    let proofs = 0;
    const { ctx, seen } = context({ prove: async () => {
      proofs++;
      await gate;
      return { proof: Buffer.from('proof').toString('base64'), proof_facts: ['0x1'] };
    } });
    const app = buildApp({ ctx, limiter: ctx.limiter, chain: 'SN_SEPOLIA' } as any);
    const req = { ...request(await token()), jobId: '0x' + 'a'.repeat(62) };
    const controller = new AbortController();
    const post = (path: string, body: unknown) => app.handle(new Request(`http://api.test${path}`, {
      method: 'POST', body: JSON.stringify(body), signal: controller.signal,
    }), '203.0.113.1');
    const accepted = await post('/recover', req);
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get('cache-control')).toBe('no-store');
    expect(await accepted.json()).toEqual({ jobId: req.jobId });
    controller.abort();
    const poll = () => app.handle(new Request('http://api.test/recover/status', { method: 'POST', body: JSON.stringify({ jobId: req.jobId }) }), '203.0.113.1');
    expect(await (await poll()).json()).toEqual({ status: 'running' });
    // A new connection sends the exact same submission.
    expect((await app.handle(new Request('http://api.test/recover', { method: 'POST', body: JSON.stringify(req) }))).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(proofs).toBe(1);
    finish();
    let state: any;
    for (let i = 0; i < 100; i++) {
      state = await (await poll()).json();
      if (state.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(state).toMatchObject({ status: 'succeeded', result: { address: req.account, transaction_hash: '0xfeed' } });
    expect(seen.sent).toHaveLength(1);
  });

  test('SDK polls the real HTTP handler and receives a sanitized terminal failure', async () => {
    const { buildApp } = await import('../api/app');
    const { httpRecoverBackend } = await import('../../../../../sdk/src/login');
    const { ctx, seen } = context({ prove: async () => { throw new Error('upstream JWT secret'); } });
    const app = buildApp({ ctx, limiter: ctx.limiter, chain: 'SN_SEPOLIA' } as any);
    const req = request(await token());
    const backend = httpRecoverBackend('http://api.test', (url, init) => app.handle(new Request(url, init)), { pollIntervalMs: 1 });
    await expect(backend.recover(req as any)).rejects.toThrow('recover API: INTERNAL');
    expect(seen.sent).toHaveLength(0);
  });
});
