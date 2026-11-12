import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecoveryJobs, type TransactionIntent } from './jobs';
import { journaledTransaction, signedTransactionHash, withRelayerLock } from './transaction';
import type { RecoverRequest } from './recover';
import fixture from './fixtures/invoke-v3.json';

const id = (n = 1) => '0x' + n.toString(16).padStart(62, '0');
const request: RecoverRequest = { jwt: 'JWT_SENTINEL_NOT_FOR_DISK', account: '0x1', newPubkey: '0x2', blinding: '0x3', pepper: 'PEPPER_SENTINEL_NOT_FOR_DISK', signature: ['SIGNATURE_SENTINEL_NOT_FOR_DISK', '0x6'] };
const result = { address: '0x1', identity: '0x7', transaction_hash: '0x8' };
const failure = () => ({ status: 502, error: 'UPSTREAM_UNAVAILABLE' });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'kamui-recovery-test-'));
  return { path: join(dir, 'jobs.sqlite'), remove: () => rmSync(dir, { recursive: true, force: true }) };
}

async function crash(path: string, kind: 'working' | 'deploy' | 'recover') {
  const script = `import { RecoveryJobs } from ${JSON.stringify(join(import.meta.dir, 'jobs.ts'))};
    const jobs=new RecoveryJobs({path:process.argv[1]});
    jobs.submit(${JSON.stringify(id())},${JSON.stringify(request)},async(journal)=>{
      if(process.argv[2]!=='working')journal.beforeSend({...${JSON.stringify(result)},kind:process.argv[2],sender_address:'0xa',nonce:'0x4'});
      process.exit(0);
    },()=>({status:500,error:'INTERNAL'}));`;
  const child = Bun.spawn([process.execPath, '-e', script, path, kind], { stdout: 'ignore', stderr: 'pipe' });
  expect(await child.exited).toBe(0);
}

test('terminal state survives reopen, capabilities and secret request fields are absent from the database', async () => {
  const temp = directory();
  let jobs = new RecoveryJobs({ path: temp.path });
  try {
    jobs.submit(id(), request, async () => result, failure);
    await tick();
    jobs.close();
    const bytes = readFileSync(temp.path).toString();
    for (const value of [id(), request.jwt, request.pepper, request.signature[0]]) expect(bytes).not.toContain(value);
    expect(statSync(temp.path).mode & 0o777).toBe(0o600);
    jobs = new RecoveryJobs({ path: temp.path });
    expect(jobs.status(id())).toEqual({ status: 'succeeded', result });
    let called = false;
    jobs.submit(id(), request, async () => { called = true; return result; }, failure);
    await tick();
    expect(called).toBe(false);
  } finally { jobs.close(); temp.remove(); }
});

test('a process abruptly exited during proving needs a fresh sign-in and does not resume secret work', async () => {
  const temp = directory();
  await crash(temp.path, 'working');
  const jobs = new RecoveryJobs({ path: temp.path });
  try {
    let rpc = 0;
    await jobs.reconcile({ getTransactionReceipt: async () => { rpc++; throw Error('unexpected'); } } as any);
    expect(jobs.status(id())).toEqual({ status: 'failed', error: 'RECOVERY_INTERRUPTED', httpStatus: 409 });
    expect(rpc).toBe(0);
    jobs.submit(id(2), request, async () => result, failure);
    await tick();
    expect(jobs.status(id(2)).status).toBe('succeeded');
  } finally { jobs.close(); temp.remove(); }
});

test('a crash after journaling retains the account lock until the exact recovery receipt is confirmed', async () => {
  const temp = directory();
  await crash(temp.path, 'recover');
  const jobs = new RecoveryJobs({ path: temp.path });
  try {
    await jobs.reconcile({ getTransactionReceipt: async () => { throw Error('not found or unavailable'); } } as any);
    expect(jobs.status(id())).toEqual({ status: 'running', phase: 'reconciling', transaction_hash: result.transaction_hash });
    expect(() => jobs.submit(id(2), request, async () => result, failure)).toThrow('IN_PROGRESS');
    let resumed = false;
    jobs.submit(id(), request, async () => { resumed = true; return result; }, failure);
    await tick();
    expect(resumed).toBe(false);
    await jobs.reconcile({ getTransactionReceipt: async (hash: string) => { expect(hash).toBe(result.transaction_hash); return { execution_status: 'SUCCEEDED', finality_status: 'ACCEPTED_ON_L2' }; } } as any);
    expect(jobs.status(id())).toEqual({ status: 'succeeded', result });
  } finally { jobs.close(); temp.remove(); }
});

test('a confirmed deployment after restart does not reconstruct JWT or proof; reverted recovery is terminal', async () => {
  for (const kind of ['deploy', 'recover'] as const) {
    const temp = directory();
    await crash(temp.path, kind);
    const jobs = new RecoveryJobs({ path: temp.path });
    try {
      await jobs.reconcile({ getTransactionReceipt: async () => ({ execution_status: kind === 'deploy' ? 'SUCCEEDED' : 'REVERTED', finality_status: 'ACCEPTED_ON_L2' }) } as any);
      expect(jobs.status(id())).toMatchObject({ status: 'failed', error: kind === 'deploy' ? 'RECOVERY_INTERRUPTED' : 'RECOVERY_REVERTED', transaction_hash: result.transaction_hash });
      jobs.submit(id(2), request, async () => result, failure);
      await tick();
      expect(jobs.status(id(2)).status).toBe('succeeded');
    } finally { jobs.close(); temp.remove(); }
  }
});

test('active uncertainty does not expire under terminal retention or temporarily missing receipt status', async () => {
  const temp = directory();
  await crash(temp.path, 'recover');
  const jobs = new RecoveryJobs({ path: temp.path, now: () => 9999999999999, retentionMs: 1 });
  try {
    await jobs.reconcile({ getTransactionReceipt: async () => ({ finality_status: 'RECEIVED' }) } as any);
    expect(jobs.status(id()).status).toBe('running');
    expect(() => jobs.submit(id(2), request, async () => result, failure)).toThrow('IN_PROGRESS');
  } finally { jobs.close(); temp.remove(); }
});

test('wire transaction hash matches a real Sepolia receipt, including bigint normalization and proof-fact commitment', () => {
  const signed = fixture.transaction as any;
  expect(signedTransactionHash(signed, fixture.chainId)).toBe(fixture.transaction_hash);
  const withFacts = signedTransactionHash({ ...signed, proof_facts: ['0x123', '0x456'] }, fixture.chainId);
  expect(withFacts).not.toBe(fixture.transaction_hash);
  expect(withFacts).not.toBe(signedTransactionHash({ ...signed, proof_facts: ['0x123'] }, fixture.chainId));
});

test('intent is committed before broadcast, and a journal failure prevents the send', async () => {
  let intent: TransactionIntent | undefined;
  let sends = 0;
  const ctx = {
    relayer: { getSignedTransaction: async () => fixture.transaction },
    provider: { getChainId: async () => fixture.chainId, invokeSignedTx: async () => {
      sends++;
      expect(intent?.transaction_hash).toBe(fixture.transaction_hash);
      return { transaction_hash: fixture.transaction_hash };
    } },
  } as any;
  await journaledTransaction(ctx, { contractAddress: '0x1', entrypoint: 'recover' }, {}, { beforeSend: (value) => { intent = value; }, deploymentConfirmed() {} }, 'recover', result);
  expect(sends).toBe(1);
  await expect(journaledTransaction(ctx, { contractAddress: '0x1', entrypoint: 'recover' }, {}, { beforeSend() { throw Error('disk full'); }, deploymentConfirmed() {} }, 'recover', result)).rejects.toThrow('disk full');
  expect(sends).toBe(1);
});

test('shared relayer lock serializes preparation/send and releases on failure', async () => {
  const relayer = {} as any;
  const order: string[] = [];
  let release!: () => void;
  const first = withRelayerLock(relayer, async () => { order.push('first'); await new Promise<void>((resolve) => { release = resolve; }); throw Error('failed'); });
  const failure = first.catch(() => {});
  const next = withRelayerLock(relayer, async () => { order.push('next'); });
  await tick();
  expect(order).toEqual(['first']);
  release();
  await Promise.all([failure, next]);
  expect(order).toEqual(['first', 'next']);
});

test('operator resolution requires a different finalized transaction with the exact sender and nonce', async () => {
  const temp = directory();
  await crash(temp.path, 'recover');
  const jobs = new RecoveryJobs({ path: temp.path });
  try {
    let finality = 'ACCEPTED_ON_L2';
    let nonce = '0x4';
    const provider = { getTransactionReceipt: async () => ({ finality_status: finality }), getTransactionByHash: async () => ({ sender_address: '0xa', nonce }) } as any;
    await expect(jobs.resolveSuperseded('0x8', '0x8', provider)).rejects.toThrow('REPLACEMENT_MUST_DIFFER');
    await expect(jobs.resolveSuperseded('0x8', '0x9', provider)).rejects.toThrow('REPLACEMENT_NOT_FINAL');
    finality = 'ACCEPTED_ON_L1'; nonce = '0x5';
    await expect(jobs.resolveSuperseded('0x8', '0x9', provider)).rejects.toThrow('REPLACEMENT_NONCE_MISMATCH');
    nonce = '0x4';
    await jobs.resolveSuperseded('0x8', '0x9', provider);
    expect(jobs.status(id())).toMatchObject({ status: 'failed', error: 'RECOVERY_SUPERSEDED' });
    jobs.submit(id(2), request, async () => result, failure);
    await tick();
    expect(jobs.status(id(2)).status).toBe('succeeded');
  } finally { jobs.close(); temp.remove(); }
});

test('a database bound to a network/class cannot silently be reused for another deployment', () => {
  const temp = directory();
  const jobs = new RecoveryJobs({ path: temp.path, binding: 'chain-a:class-a' });
  jobs.close();
  try { expect(() => new RecoveryJobs({ path: temp.path, binding: 'chain-b:class-a' })).toThrow('RECOVERY_DB_NETWORK_MISMATCH'); }
  finally { temp.remove(); }
});

test('wire hash with proof facts verifies the actual SDK signer signature; dropping facts does not', async () => {
  const { Signer, ec, transaction } = await import('starknet');
  const privateKey = ec.starkCurve.utils.randomPrivateKey();
  const signer = new Signer(privateKey);
  const calls = [{ contractAddress: '0x321', entrypoint: 'ping', calldata: ['0x9'] }];
  const resourceBounds = { l1_gas: { max_amount: 1n, max_price_per_unit: 2n }, l2_gas: { max_amount: 3n, max_price_per_unit: 4n }, l1_data_gas: { max_amount: 5n, max_price_per_unit: 6n } };
  const details = { walletAddress: '0x456', cairoVersion: '1', chainId: fixture.chainId, nonce: '0x3', version: '0x3', resourceBounds, tip: 0, paymasterData: [], accountDeploymentData: [], nonceDataAvailabilityMode: 'L1', feeDataAvailabilityMode: 'L1', proofFacts: ['0x123', '0x456'] } as any;
  const raw = await signer.signTransaction(calls, details);
  const signature = Array.isArray(raw) ? raw : ['0x' + BigInt(raw.r).toString(16), '0x' + BigInt(raw.s).toString(16)];
  const wire = { sender_address: '0x456', version: '0x3', nonce: '0x3', calldata: transaction.getExecuteCalldata(calls, '1'), signature,
    resource_bounds: Object.fromEntries(Object.entries(resourceBounds).map(([key, bound]) => [key, { max_amount: '0x' + bound.max_amount.toString(16), max_price_per_unit: '0x' + bound.max_price_per_unit.toString(16) }])),
    tip: '0x0', paymaster_data: [], account_deployment_data: [], nonce_data_availability_mode: 'L1', fee_data_availability_mode: 'L1', proof_facts: details.proofFacts } as any;
  const sig = new ec.starkCurve.Signature(BigInt(signature[0]!), BigInt(signature[1]!));
  const publicKey = ec.starkCurve.getPublicKey(privateKey);
  expect(ec.starkCurve.verify(sig, signedTransactionHash(wire, fixture.chainId), publicKey)).toBe(true);
  expect(ec.starkCurve.verify(sig, signedTransactionHash({ ...wire, proof_facts: [] }, fixture.chainId), publicKey)).toBe(false);
});

test('pre-confirmed success or revert never releases the durable account lock; accepted receipts settle it', async () => {
  for (const [kind, execution] of [['recover', 'SUCCEEDED'], ['recover', 'REVERTED'], ['deploy', 'SUCCEEDED']] as const) {
    const temp = directory();
    await crash(temp.path, kind);
    const jobs = new RecoveryJobs({ path: temp.path });
    try {
      let finality = 'PRE_CONFIRMED';
      const provider = { getTransactionReceipt: async () => ({ execution_status: execution, finality_status: finality }) } as any;
      await jobs.reconcile(provider);
      expect(jobs.status(id())).toMatchObject({ status: 'running', phase: 'reconciling' });
      expect(() => jobs.submit(id(2), request, async () => result, failure)).toThrow('IN_PROGRESS');
      finality = 'ACCEPTED_ON_L2';
      await jobs.reconcile(provider);
      expect(jobs.status(id()).status).toBe(kind === 'recover' && execution === 'SUCCEEDED' ? 'succeeded' : 'failed');
    } finally { jobs.close(); temp.remove(); }
  }
});

test('an active journaled send with an accepted revert settles as RECOVERY_REVERTED without a restart', async () => {
  const { waitForAcceptedTransaction } = await import('./transaction');
  const temp = directory();
  const jobs = new RecoveryJobs({ path: temp.path });
  try {
    jobs.submit(id(), request, async (journal) => {
      journal!.beforeSend({ ...result, kind: 'recover' });
      await waitForAcceptedTransaction({ waitForTransaction: async () => ({ execution_status: 'REVERTED', finality_status: 'ACCEPTED_ON_L2' }) } as any, result.transaction_hash);
      return result;
    }, failure);
    await tick();
    expect(jobs.status(id())).toEqual({ status: 'failed', error: 'RECOVERY_REVERTED', httpStatus: 400, transaction_hash: result.transaction_hash });
    jobs.submit(id(2), request, async () => result, failure);
    await tick();
    expect(jobs.status(id(2)).status).toBe('succeeded');
  } finally { jobs.close(); temp.remove(); }
});

test('a second-connection resolution fences an old deployment continuation and both late terminal callbacks', async () => {
  for (const completion of ['success', 'failure'] as const) {
    const temp = directory();
    const api = new RecoveryJobs({ path: temp.path });
    const operator = new RecoveryJobs({ path: temp.path });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let sends = 0;
    let clearRefused = false;
    let newIntentRefused = false;
    api.submit(id(), request, async (journal) => {
      journal!.beforeSend({ ...result, kind: 'deploy', sender_address: '0xa', nonce: '0x4' });
      // Simulate old work paused after waiting on its deployment, before continuing.
      await gate;
      try { journal!.deploymentConfirmed(); } catch { clearRefused = true; }
      try {
        journal!.beforeSend({ ...result, transaction_hash: '0x10', kind: 'recover', sender_address: '0xa', nonce: '0x5' });
        sends++;
      } catch { newIntentRefused = true; }
      if (completion === 'failure') throw Error('late work error');
      return result;
    }, failure);
    try {
      await tick();
      await operator.resolveSuperseded('0x8', '0x9', {
        getTransactionReceipt: async () => ({ finality_status: 'ACCEPTED_ON_L1', execution_status: 'SUCCEEDED' }),
        getTransactionByHash: async () => ({ sender_address: '0xa', nonce: '0x4' }),
      } as any);
      release();
      await tick();
      expect(clearRefused).toBe(true);
      expect(newIntentRefused).toBe(true);
      expect(sends).toBe(0);
      expect(api.status(id())).toEqual({ status: 'failed', error: 'RECOVERY_SUPERSEDED', httpStatus: 409, transaction_hash: '0x8' });
    } finally { api.close(); operator.close(); temp.remove(); }
  }
});
