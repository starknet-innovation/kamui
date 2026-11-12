import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RpcError, shortString } from 'starknet';
import { HttpError } from '../../http';
import { extractJwt, type Jwk } from '../../jwk/verification';
import { MemoryLimiter } from '../../limiter';
import { accountAddress, expectedNonce, extractIdentity, recoverMessageHash } from '../../social-account';
import { buildApp } from '../api/app';
import { ProofQueue } from '../prover/queue';
import { prepareDeployment } from './authenticated-deploy';
import { RecoveryJobs } from './jobs';
import { parseRelayRequest, checkRelay, type RelayRequest } from './relay';
import { signedTransactionHash } from './transaction';
import type { RecoverContext, RecoverRequest } from './recover';
import fixture from './fixtures/invoke-v3.json';

const AUD = 'kamui-client-proving-test';
const ISS = 'https://accounts.google.com';
const CLASS = '0x1234';
const IDENTITY = '0x9876';
const ACCOUNT = accountAddress(AUD, IDENTITY, CLASS);
const NEW_KEY = '0x5678';
const ANCHOR = '0x8765';
const PROGRAM = '0x1c7be3225dfb33359b3ba9ffbe1542b7da27879b6d89f47b967e512463fd324';
const HEADER = '020400098446bd35fd2272efe19bf43aac7037b3b7e25e86d94170d95198245bbb8dc7';
const id = (n: number) => '0x' + n.toString(16).padStart(62, '0');
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const accepted = { execution_status: 'SUCCEEDED', finality_status: 'ACCEPTED_ON_L2' };
function relay(): RelayRequest {
  return { account: ACCOUNT, newPubkey: NEW_KEY, signature: ['0x1', '0x2'], proof: Buffer.from(HEADER + '00', 'hex').toString('base64'), proofFacts: [
    shortString.encodeShortString('PROOF2'), shortString.encodeShortString('VIRTUAL_SNOS'), PROGRAM,
    shortString.encodeShortString('VIRTUAL_SNOS0'), '0x50', '0x123', '0x57ed4d5e20d617d8cc087a5882eae4f71d005172326be6439b2e1fd8b4dc57', '0x1',
    '0x' + recoverMessageHash(ACCOUNT, IDENTITY, NEW_KEY, ANCHOR, false).toString(16),
  ], override: false };
}
function temp() { const dir = mkdtempSync(join(tmpdir(), 'kamui-client-proof-')); return { path: join(dir, 'jobs.sqlite'), cleanup: () => rmSync(dir, { force: true, recursive: true }) }; }
function context() {
  const seen = { reads: 0, signed: 0, broadcasts: 0, lastHash: '', deployed: true, lostResponse: false, reject: false };
  const ctx = {
    provider: {
      getBlockNumber: async () => (seen.reads++, 100),
      getClassHashAt: async () => { seen.reads++; if (!seen.deployed) throw new RpcError({ code: 20, message: 'Contract not found' }, 'starknet_getClassHashAt', {}); return CLASS; },
      callContract: async ({ entrypoint }: { entrypoint: string }) => (seen.reads++, [entrypoint === 'identity' ? IDENTITY : ANCHOR]),
      getChainId: async () => fixture.chainId,
      waitForTransaction: async () => accepted,
      getTransactionReceipt: async () => accepted,
      invokeSignedTx: async (tx: any) => { seen.broadcasts++; seen.lastHash = signedTransactionHash(tx, fixture.chainId); if (seen.lostResponse) throw Error('socket lost'); return { transaction_hash: seen.lastHash }; },
    },
    relayer: { getSignedTransaction: async (_call: unknown, details: any) => {
      seen.signed++;
      if (seen.reject) throw new HttpError(400, 'REVERTED: SECRET_PROOF_ECHO_MUST_NOT_PERSIST');
      return { ...fixture.transaction, proof: details.proof, proof_facts: details.proofFacts };
    } },
    classHash: CLASS, audiences: { [ISS]: AUD }, pepper: { mainnet: false }, deploysPerHour: 10,
    limiter: new MemoryLimiter(), jwks: { keys: async () => [] }, proofs: new ProofQueue(),
  } as unknown as RecoverContext;
  return { ctx, seen };
}
function app(ctx: RecoverContext, jobs: RecoveryJobs) {
  const built = buildApp({ chain: 'SN_SEPOLIA', ctx, limiter: ctx.limiter, recoveryJobs: jobs } as any);
  return (path: string, body: unknown) => built.handle(new Request(`http://api.test${path}`, { method: 'POST', body: JSON.stringify(body) }), '192.0.2.1');
}

describe('client proof validation', () => {
  test('the pinned V2 profile binds the deployed class, audience, key and owners anchor', () => {
    const request = parseRelayRequest(relay());
    const chain = { head: 100, classHash: CLASS, identity: IDENTITY, currentPubkey: ANCHOR };
    const ctx = { classHash: CLASS, audiences: { [ISS]: AUD } };
    expect(checkRelay(request, chain, ctx)).toBe(IDENTITY);
    expect(() => checkRelay(request, { ...chain, currentPubkey: '0x99' }, ctx)).toThrow('PROOF_MISMATCH');
    expect(() => checkRelay({ ...request, newPubkey: '0x99' }, chain, ctx)).toThrow('PROOF_MISMATCH');
    expect(() => checkRelay(request, { ...chain, classHash: '0x99' }, ctx)).toThrow('WRONG_CLASS');
    expect(() => checkRelay(request, chain, { ...ctx, audiences: { [ISS]: 'another-client' } })).toThrow('WRONG_AUDIENCE');
    expect(() => checkRelay(request, { ...chain, head: 85 }, ctx)).toThrow('PROOF_TOO_RECENT');
  });
  test('old/tampered circuits, invalid facts, noncanonical base64, oversized inputs and non-boolean overrides fail before admission', () => {
    for (const index of [0, 1, 2, 3, 6, 7]) {
      const r = relay(); r.proofFacts[index] = '0x2'; expect(() => parseRelayRequest(r)).toThrow('BAD_PROOF_FACTS');
    }
    for (const proof of [Buffer.from('wrong circuit').toString('base64'), Buffer.from(HEADER, 'hex').toString('base64')]) expect(() => parseRelayRequest({ ...relay(), proof })).toThrow('BAD_PROOF_PROFILE');
    expect(() => parseRelayRequest({ ...relay(), proof: Buffer.from(HEADER + '0000', 'hex').toString('base64').replace(/A==$/, 'B==') })).toThrow('BAD_PROOF');
    expect(() => parseRelayRequest({ ...relay(), proof: 'A'.repeat(640_004) })).toThrow('BAD_PROOF');
    expect(() => parseRelayRequest({ ...relay(), signature: [1, 2] as any })).toThrow('BAD_SIGNATURE_FORMAT');
    expect(() => parseRelayRequest({ ...relay(), account: '0x' + 'f'.repeat(1000) })).toThrow('BAD_ACCOUNT');
    expect(() => parseRelayRequest({ ...relay(), override: 'true' as any })).toThrow('BAD_OVERRIDE');
  });
});

test('lost relay response is retried and reconciled after reopen without signing or broadcasting twice; no proof/capability reaches disk', async () => {
  const t = temp(); let jobs = new RecoveryJobs({ path: t.path });
  const { ctx, seen } = context(); seen.lostResponse = true;
  let post = app(ctx, jobs);
  const body = { ...relay(), jobId: id(1) };
  try {
    expect((await post('/relay', body)).status).toBe(202);
    await tick();
    expect(jobs.status(body.jobId)).toMatchObject({ status: 'running', phase: 'reconciling', transaction_hash: seen.lastHash });
    expect((await post('/relay', body)).status).toBe(202);
    expect(seen.signed).toBe(1); expect(seen.broadcasts).toBe(1);
    expect((await post('/relay', { ...body, signature: ['0x3', '0x4'] })).status).toBe(409);
    expect((await post('/relay', { ...body, jobId: id(2) })).status).toBe(409);
    jobs.close(); jobs = new RecoveryJobs({ path: t.path }); post = app(ctx, jobs);
    const reads = seen.reads;
    expect((await post('/relay', body)).status).toBe(202);
    expect(seen.reads).toBe(reads);
    expect(await (await post('/recover/status', { jobId: body.jobId })).json()).toMatchObject({ status: 'succeeded', result: { transaction_hash: seen.lastHash } });
    expect(seen.signed).toBe(1); expect(seen.broadcasts).toBe(1);
    const disk = readFileSync(t.path).toString('latin1');
    expect(disk).not.toContain(body.proof); expect(disk).not.toContain(body.jobId);
  } finally { jobs.close(); t.cleanup(); }
});

test('RPC/revert text cannot enter the durable proof-submission status or SQLite', async () => {
  const t = temp(); const jobs = new RecoveryJobs({ path: t.path }); const { ctx, seen } = context(); seen.reject = true;
  try {
    const post = app(ctx, jobs);
    expect((await post('/relay', { ...relay(), jobId: id(1) })).status).toBe(202); await tick();
    expect(jobs.status(id(1))).toEqual({ status: 'failed', error: 'REVERTED', httpStatus: 400 });
    expect(readFileSync(t.path).toString('latin1')).not.toContain('SECRET_PROOF_ECHO');
    expect(seen.broadcasts).toBe(0);
  } finally { jobs.close(); t.cleanup(); }
});

const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
const JWK: Jwk = { kid: 'client-proving-kid', kty: 'RSA', n: exported.n!, e: exported.e! };
async function deployment(bad = false): Promise<RecoverRequest> {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ alg: 'RS256', kid: JWK.kid }); const now = Math.floor(Date.now() / 1000);
  const payload = b64({ iss: ISS, aud: AUD, sub: 'client-deploy-user', exp: now + 3600, iat: now - 5, nonce: '0x' + expectedNonce(NEW_KEY, '0x3').toString(16) });
  const signature = bad ? new Uint8Array(256) : new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${header}.${payload}`)));
  const jwt = `${header}.${payload}.${Buffer.from(signature).toString('base64url')}`;
  return { jwt, account: accountAddress(AUD, extractIdentity(extractJwt(jwt), '0x4'), CLASS), newPubkey: NEW_KEY, blinding: '0x3', pepper: '0x4', signature: ['0x1', '0x2'], keyProof: ['0x5', '0x6'] };
}

test('authenticated first deployment rejects invalid tokens/nonces/accounts before chain or pepper calls', async () => {
  const { ctx, seen } = context(); ctx.jwks = { keys: async () => [JWK] }; seen.deployed = false;
  await expect(prepareDeployment(await deployment(true), 'client', ctx)).rejects.toThrow('BAD_SIGNATURE');
  await expect(prepareDeployment({ ...await deployment(), blinding: '0x9' }, 'client', ctx)).rejects.toThrow('NONCE_MISMATCH');
  await expect(prepareDeployment({ ...await deployment(), account: '0x9' }, 'client', ctx)).rejects.toThrow('WRONG_ACCOUNT');
  expect(seen.reads).toBe(0); expect(seen.signed).toBe(0);
});

test('first deployment confirms pepper, respects the paid cap and journals a prepare intent; existing accounts skip pepper', async () => {
  const { ctx, seen } = context(); ctx.jwks = { keys: async () => [JWK] }; seen.deployed = false;
  const req = await deployment(); const originalFetch = globalThis.fetch;
  let pepperCalls = 0; let intents: any[] = [];
  ctx.pepper = { mainnet: false, serviceUrl: 'https://pepper.invalid' };
  globalThis.fetch = (async () => { pepperCalls++; return Response.json({ pepper: '0x9' }); }) as unknown as typeof fetch;
  const journal = { beforeSend: (intent: unknown) => { intents.push(intent); }, deploymentConfirmed() {} };
  try {
    await expect((await prepareDeployment(req, 'client', ctx))(journal)).rejects.toThrow('WRONG_PEPPER');
    expect(seen.signed).toBe(0); expect(intents.length).toBe(0);
    globalThis.fetch = (async () => { pepperCalls++; return Response.json({ pepper: req.pepper }); }) as unknown as typeof fetch;
    ctx.deploysPerHour = 0;
    await expect((await prepareDeployment(req, 'client', ctx))(journal)).rejects.toThrow('DEPLOY_DISABLED');
    expect(seen.signed).toBe(0);
    ctx.deploysPerHour = 1;
    expect(await (await prepareDeployment(req, 'client', ctx))(journal)).toMatchObject({ address: req.account, transaction_hash: seen.lastHash });
    expect(intents[0]).toMatchObject({ kind: 'prepare', address: req.account, sender_address: fixture.transaction.sender_address, nonce: fixture.transaction.nonce });
    expect(seen.broadcasts).toBe(1);
    await expect((await prepareDeployment(req, 'another-client', ctx))(journal)).rejects.toThrow('DEPLOY_CAP');
    const before = pepperCalls; seen.deployed = true;
    expect(await (await prepareDeployment(req, 'client', ctx))(journal)).toMatchObject({ transaction_hash: '0x0' });
    expect(pepperCalls).toBe(before); expect(seen.broadcasts).toBe(1);
  } finally { globalThis.fetch = originalFetch; }
});

test('authenticated deployment lost response survives restart and retry skips token verification', async () => {
  const t = temp(); let jobs = new RecoveryJobs({ path: t.path }); const { ctx, seen } = context(); seen.deployed = false; seen.lostResponse = true;
  let verified = 0; ctx.jwks = { keys: async () => (verified++, [JWK]) };
  const body = { ...await deployment(), jobId: id(1) }; let post = app(ctx, jobs);
  try {
    expect((await post('/deploy/authenticated', body)).status).toBe(202); await tick();
    expect(seen.broadcasts).toBe(1); expect(verified).toBe(1);
    jobs.close(); jobs = new RecoveryJobs({ path: t.path }); post = app(ctx, jobs);
    ctx.jwks = { keys: async () => { throw Error('issuer now down'); } };
    expect((await post('/deploy/authenticated', body)).status).toBe(202);
    expect(await (await post('/recover/status', { jobId: body.jobId })).json()).toMatchObject({ status: 'succeeded', result: { address: body.account, transaction_hash: seen.lastHash } });
    expect(seen.broadcasts).toBe(1);
    const disk = readFileSync(t.path).toString('latin1'); expect(disk).not.toContain(body.jwt); expect(disk).not.toContain(body.jobId);
  } finally { jobs.close(); t.cleanup(); }
});
