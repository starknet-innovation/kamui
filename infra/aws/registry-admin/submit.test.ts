import { test, expect } from 'bun:test';
import { secp256k1 } from '@noble/curves/secp256k1';
import { constants, hash, stark, transaction } from 'starknet';
import { mkdtemp, chmod, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { BUDGET_FILE, STRK, initializeBudget, inspectBudget, reserveAttempt, reservedTotal } from './live-budget';
import { KmsK1Signer, digestBytes, signatureFelts, type KmsPort } from './signer';
import { parseOperatorInput, preflight, OperatorRpcError, type OperatorInput, type SignedArtifact } from './operator';
import { PING_TARGET, prepareSubmission, submitSigned, reconcileSubmission, HttpSubmitRpc, type SubmitRpc, type SubmitMethod } from './submit';
async function temporary(run: (journal: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'kamui-kms-submit-unit-'));
  try { await chmod(directory, 0o700); const journal = join(directory, BUDGET_FILE); await initializeBudget(journal); await run(journal); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
function fixture(deploy = false, maximumScale = 1n) {
  const secret = secp256k1.utils.randomPrivateKey();
  const publicKey = `0x${Buffer.from(secp256k1.getPublicKey(secret, false)).toString('hex')}`;
  const keyId = ['arn', 'aws', 'kms', 'eu-west-1', '0'.repeat(12), 'key/00000000-0000-0000-0000-000000000000'].join(':');
  const declared = { sierra_program: [], contract_class_version: '0.1.0', entry_points_by_type: { EXTERNAL: [], CONSTRUCTOR: [], L1_HANDLER: [] }, abi: '[]' };
  const classHash = hash.computeContractClassHash({ ...declared, abi: [] } as any);
  const signer = new KmsK1Signer({} as KmsPort, { keyId, publicKey, accountAddress: '0x123', classHash,
    maxFeeFri: 5n * STRK, approve: async () => false });
  const constructor = signer.constructorCalldata();
  const accountAddress = deploy ? hash.calculateContractAddressFromHash('9', classHash, constructor, 0) : '0x123';
  const common = { chainId: constants.StarknetChainId.SN_SEPOLIA, version: '0x3', nonce: deploy ? '0' : '1', tip: '2',
    resourceBounds: { l1_gas: { max_amount: '2', max_price_per_unit: String(3n * maximumScale) },
      l2_gas: { max_amount: '4', max_price_per_unit: String(5n * maximumScale) },
      l1_data_gas: { max_amount: '6', max_price_per_unit: String(7n * maximumScale) } },
    paymasterData: [], accountDeploymentData: [], nonceDataAvailabilityMode: 'L1', feeDataAvailabilityMode: 'L1' };
  const tx = deploy ? { kind: 'deploy', details: { ...common, contractAddress: accountAddress, classHash, addressSalt: '9', constructorCalldata: constructor } }
    : { kind: 'invoke', calls: [{ contractAddress: PING_TARGET, entrypoint: 'ping', calldata: [] }],
      details: { ...common, walletAddress: accountAddress, cairoVersion: '1' } };
  const input = parseOperatorInput({ schema: 'kamui.kms-operator.v1', region: 'eu-west-1', keyId, publicKey, accountAddress,
    classHash, maxFeeFri: String(5n * STRK), rpcUrl: 'https://rpc.invalid', transaction: tx });
  const bounds = Object.fromEntries(Object.entries(common.resourceBounds).map(([name, bound]) => [name,
    { max_amount: BigInt(bound.max_amount), max_price_per_unit: BigInt(bound.max_price_per_unit) }])) as any;
  const details = { ...tx.details, resourceBounds: bounds, nonceDataAvailabilityMode: 0, feeDataAvailabilityMode: 0 } as any;
  const txHash = deploy ? hash.calculateDeployAccountTransactionHash({ ...details, salt: '9', compiledConstructorCalldata: constructor })
    : hash.calculateInvokeTransactionHash({ ...details, senderAddress: accountAddress,
      compiledCalldata: transaction.getExecuteCalldata((tx as any).calls, '1') });
  const artifact: SignedArtifact = { schema: 'kamui.kms-signed.v1', kind: deploy ? 'deploy' : 'invoke', transactionHash: txHash,
    signature: signatureFelts(secp256k1.sign(digestBytes(txHash), secret).toDERRawBytes()), account: accountAddress, classHash,
    chainId: constants.StarknetChainId.SN_SEPOLIA, transaction: structuredClone(input.transaction),
    observation: { blockHash: '0xabc', chainId: constants.StarknetChainId.SN_SEPOLIA, account: accountAddress, classHash, nonce: deploy ? '0' : '1' } };
  const history: { method: SubmitMethod; params: Record<string, unknown> }[] = [];
  let beforeSend: (() => Promise<void>) | undefined;
  const receipt = { type: deploy ? 'DEPLOY_ACCOUNT' : 'INVOKE', transaction_hash: txHash, finality_status: 'ACCEPTED_ON_L2', execution_status: 'SUCCEEDED',
    actual_fee: { amount: '0x2', unit: 'FRI' }, block_hash: '0xddd', block_number: 101,
    ...(deploy ? { contract_address: accountAddress } : {}) };
  const rpc: SubmitRpc = { async request(method, params) {
    history.push({ method, params });
    if (method === 'starknet_chainId') return constants.StarknetChainId.SN_SEPOLIA;
    if (method === 'starknet_getBlockWithTxHashes') return (params.block_id === 'latest')
      ? { status: 'ACCEPTED_ON_L2', block_hash: '0xabc', block_number: 100, transactions: [] }
      : { status: 'ACCEPTED_ON_L2', block_hash: '0xddd', block_number: 101, transactions: [txHash] };
    if (method === 'starknet_getClassHashAt') { if (deploy) throw new OperatorRpcError(20); return classHash; }
    if (method === 'starknet_getClass') return declared;
    if (method === 'starknet_getNonce') return '0x1';
    if (method === 'starknet_call') return constructor;
    if (method === 'starknet_getTransactionReceipt') return receipt;
    if (method === 'starknet_addInvokeTransaction' || method === 'starknet_addDeployAccountTransaction') {
      await beforeSend?.(); return { transaction_hash: txHash };
    }
    throw new Error('unexpected RPC');
  } };
  return { input, artifact, rpc, history, receipt, beforeSend(callback: () => Promise<void>) { beforeSend = callback; } };
}
function paid(f: ReturnType<typeof fixture>) { return f.history.filter(call => call.method.startsWith('starknet_add')); }
for (const deploy of [false, true]) {
  test(`${deploy ? 'deploy' : 'ping'} sends exact verified body once after durable maximum-fee reservation`, async () => {
    await temporary(async journal => {
      const f = fixture(deploy), prepared = prepareSubmission(f.input, f.artifact);
      expect(prepared.reservation.maxFeeFri).toBe('76'); // all three resources plus L2 tip
      expect(prepared.reservation.principalFri).toBe('0');
      f.beforeSend(async () => {
        const state = await inspectBudget(journal);
        expect(state.attempts).toHaveLength(1); expect(state.attempts[0]).toMatchObject(prepared.reservation);
        expect(state.attempts[0].status).toBe('reserved');
      });
      const result = await submitSigned(f.input, f.artifact, { journal, rpc: f.rpc, confirm: async review => {
        expect(review.transactionHash).toBe(f.artifact.transactionHash); expect(review.maxFeeFri).toBe('76');
        // Callback cannot mutate the verified body or claimed hash.
        review.transactionHash = '0x1'; return true;
      } });
      expect(result.status).toBe('confirmed-success'); expect(paid(f)).toHaveLength(1);
      expect(paid(f)[0].params).toEqual(prepared.params);
      const state = await inspectBudget(journal);
      expect(state.attempts[0].actualFeeFri).toBe('2'); expect(reservedTotal(state)).toBe(76n);
      const evidence = join(dirname(journal), `kms-submit-${BigInt(f.artifact.transactionHash).toString(16)}.jsonl`);
      expect((await stat(evidence)).mode & 0o777).toBe(0o600);
      const events = (await readFile(evidence, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(events.map(event => event.state)).toEqual(['reserved', 'rpc-returned', 'confirmed-success']);
      expect(events[1].returnedHash).toBe(f.artifact.transactionHash);
      await expect(submitSigned(f.input, f.artifact, { journal, rpc: f.rpc, confirm: async () => true })).rejects.toThrow('LIVE_BUDGET_REPLAY');
      expect(paid(f)).toHaveLength(1);
    });
  });
}
for (const mutation of ['hash', 'signature', 'calls', 'details', 'query', 'fee-cap', 'registry', 'target', 'calldata', 'schema'] as const) {
  test(`rejects ${mutation} before any RPC send or reservation`, async () => {
    await temporary(async journal => {
      const f = fixture();
      if (mutation === 'hash') f.artifact.transactionHash = '0x1';
      if (mutation === 'signature') f.artifact.signature = ['1', '0', '1', '0'];
      if (mutation === 'calls' && f.artifact.transaction.kind === 'invoke') f.artifact.transaction.calls[0].calldata = ['1'];
      if (mutation === 'details') { f.input.transaction.details.nonce = '2'; f.artifact.transaction.details.nonce = '2'; f.artifact.observation.nonce = '2'; }
      if (mutation === 'query') { f.input.transaction.details.version = '0x100000000000000000000000000000003'; f.artifact.transaction.details.version = f.input.transaction.details.version; }
      if (mutation === 'fee-cap') f.input.maxFeeFri = '75';
      if (mutation === 'schema') (f.artifact as any).keyId = 'not accepted';
      if (['registry', 'target', 'calldata'].includes(mutation) && f.input.transaction.kind === 'invoke' && f.artifact.transaction.kind === 'invoke') {
        const call = f.input.transaction.calls[0];
        if (mutation === 'registry') call.entrypoint = 'grant_role';
        if (mutation === 'target') call.contractAddress = '0x999';
        if (mutation === 'calldata') call.calldata = ['1'];
        f.artifact.transaction.calls = structuredClone(f.input.transaction.calls);
      }
      await expect(submitSigned(f.input, f.artifact, { journal, rpc: f.rpc, confirm: async () => true })).rejects.toThrow();
      expect(f.history).toHaveLength(0); expect((await inspectBudget(journal)).attempts).toHaveLength(0);
    });
  });
}
test('reject confirmation and stale nonce after confirmation before reservation or send', async () => {
  await temporary(async journal => {
    const f = fixture();
    await expect(submitSigned(f.input, f.artifact, { journal, rpc: f.rpc, confirm: async () => false })).rejects.toThrow('SUBMIT_NOT_APPROVED');
    const original = f.rpc.request;
    await expect(submitSigned(f.input, f.artifact, { journal, rpc: f.rpc, confirm: async () => {
      f.rpc.request = async (method, params) => method === 'starknet_getNonce' ? '0x2' : original(method, params); return true;
    } })).rejects.toThrow('OPERATOR_NONCE_MISMATCH');
    expect(paid(f)).toHaveLength(0); expect((await inspectBudget(journal)).attempts).toHaveLength(0);
  });
});
for (const failure of ['timeout', 'wrong-hash', 'malformed-response', 'pending', 'wrong-unit', 'excess-fee', 'wrong-receipt-hash'] as const) {
  test(`${failure} retains full reservation across process-style reopen and never resends`, async () => {
    await temporary(async journal => {
      const f = fixture(), original = f.rpc.request;
      f.rpc.request = async (method, params) => {
        if (method === 'starknet_addInvokeTransaction') {
          f.history.push({ method, params });
          if (failure === 'timeout') throw new Error('RAW_PRIVATE_PROVIDER_ERROR');
          if (failure === 'wrong-hash') return { transaction_hash: '0xbeef' };
          if (failure === 'malformed-response') return { unexpected: true };
          return { transaction_hash: f.artifact.transactionHash };
        }
        if (method === 'starknet_getTransactionReceipt') {
          if (failure === 'pending') throw new OperatorRpcError(29);
          if (failure === 'wrong-unit') return { ...f.receipt, actual_fee: { amount: '0x2', unit: 'WEI' } };
          if (failure === 'excess-fee') return { ...f.receipt, actual_fee: { amount: '0x100', unit: 'FRI' } };
          if (failure === 'wrong-receipt-hash') return { ...f.receipt, transaction_hash: '0xbeef' };
        }
        return original(method, params);
      };
      const outcome = await submitSigned(f.input, f.artifact, { journal, rpc: f.rpc, confirm: async () => true });
      expect(['ambiguous', 'pending']).toContain(outcome.status);
      expect((await inspectBudget(journal)).attempts[0].status).toBe('reserved');
      expect(reservedTotal(await inspectBudget(journal))).toBe(76n);
      expect(paid(f)).toHaveLength(1);
      await expect(submitSigned(f.input, f.artifact, { journal, rpc: f.rpc, confirm: async () => true })).rejects.toThrow('LIVE_BUDGET_REPLAY');
      expect(paid(f)).toHaveLength(1);
      // Later receipt lookup reconciles the original hash without any add RPC.
      f.rpc.request = original;
      const before = paid(f).length;
      expect((await reconcileSubmission(prepareSubmission(f.input, f.artifact), journal, f.rpc)).status).toBe('confirmed-success');
      expect(paid(f)).toHaveLength(before);
      expect(reservedTotal(await inspectBudget(journal))).toBe(76n);
    });
  });
}
test('accepted revert records actual fee and consumes its full attempt/maximum forever', async () => {
  await temporary(async journal => {
    const f = fixture(); f.receipt.execution_status = 'REVERTED';
    expect((await submitSigned(f.input, f.artifact, { journal, rpc: f.rpc, confirm: async () => true })).status).toBe('confirmed-revert');
    expect((await inspectBudget(journal)).attempts[0].status).toBe('confirmed-revert');
    expect(reservedTotal(await inspectBudget(journal))).toBe(76n);
  });
});
test('missing receipt block inclusion cannot confirm a reservation', async () => {
  await temporary(async journal => {
    const f = fixture(), original = f.rpc.request;
    f.rpc.request = async (method, params) => method === 'starknet_getBlockWithTxHashes' && params.block_id !== 'latest'
      ? { block_hash: '0xddd', block_number: 101, status: 'ACCEPTED_ON_L2', transactions: [] } : original(method, params);
    await expect(submitSigned(f.input, f.artifact, { journal, rpc: f.rpc, confirm: async () => true })).rejects.toThrow('SUBMIT_RECEIPT_INVALID');
    expect((await inspectBudget(journal)).attempts[0].status).toBe('reserved'); expect(paid(f)).toHaveLength(1);
  });
});
test('exhausted attempts and aggregate signed maxima prevent the network operation', async () => {
  await temporary(async journal => {
    for (let n = 1; n <= 4; n++) await reserveAttempt(journal, { kind: 'ping', sender: '0x999', nonce: String(n), transactionHash: `0x${n}`, maxFeeFri: '1', principalFri: '0' });
    const f = fixture(); await expect(submitSigned(f.input, f.artifact, { journal, rpc: f.rpc, confirm: async () => true })).rejects.toThrow('LIVE_BUDGET_EXHAUSTED');
    expect(paid(f)).toHaveLength(0);
  });
  await temporary(async journal => {
    for (let n = 1; n <= 2; n++) await reserveAttempt(journal, { kind: 'ping', sender: '0x999', nonce: String(n), transactionHash: `0x${n}`, maxFeeFri: String(5n * STRK), principalFri: '0' });
    const f = fixture(false, STRK / 20n); // 3.4 STRK + tip, under 5 per attempt but over remaining 2.
    await expect(submitSigned(f.input, f.artifact, { journal, rpc: f.rpc, confirm: async () => true })).rejects.toThrow('LIVE_BUDGET_EXHAUSTED');
    expect(paid(f)).toHaveLength(0);
  });
});
test('evidence-file failure after reservation prevents send and keeps the consumed reservation', async () => {
  await temporary(async journal => {
    const f = fixture();
    await writeFile(join(dirname(journal), `kms-submit-${BigInt(f.artifact.transactionHash).toString(16)}.jsonl`), 'existing evidence', { mode: 0o600 });
    await expect(submitSigned(f.input, f.artifact, { journal, rpc: f.rpc, confirm: async () => true })).rejects.toThrow();
    expect(paid(f)).toHaveLength(0); expect((await inspectBudget(journal)).attempts[0].status).toBe('reserved');
  });
});
test('RPC transport makes no retries, preserves exact not-found code, and sanitizes raw errors', async () => {
  let count = 0;
  const rpc = new HttpSubmitRpc('https://rpc.invalid', (async () => { count++; throw new Error('SECRET_PROVIDER_TEXT'); }) as unknown as typeof fetch);
  await expect(rpc.request('starknet_addInvokeTransaction', {})).rejects.toThrow('SUBMIT_RPC_FAILED'); expect(count).toBe(1);
  const absent = new HttpSubmitRpc('https://rpc.invalid', (async (_url: unknown, options?: RequestInit) => {
    const request = JSON.parse(options!.body as string);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: 20, message: 'PRIVATE_PROVIDER_TEXT' } }));
  }) as unknown as typeof fetch);
  try { await absent.request('starknet_getClassHashAt', {}); throw new Error('missing rejection'); }
  catch (error) { expect(error).toBeInstanceOf(OperatorRpcError); expect((error as OperatorRpcError).code).toBe(20); expect((error as Error).message).toBe('OPERATOR_RPC_FAILED'); }
  await expect(rpc.request('starknet_addDeclareTransaction' as SubmitMethod, {})).rejects.toThrow('SUBMIT_RPC_METHOD_FORBIDDEN'); expect(count).toBe(1);
});

test('receipt block must match canonical block at its number, not an orphan queried by hash', async () => {
  await temporary(async journal => {
    const f = fixture(), original = f.rpc.request;
    f.rpc.request = async (method, params) => {
      if (method === 'starknet_getBlockWithTxHashes' && params.block_id !== 'latest') {
        expect(params.block_id).toEqual({ block_number: 101 });
        return { block_hash: '0xeee', block_number: 101, status: 'ACCEPTED_ON_L2', transactions: [f.artifact.transactionHash] };
      }
      return original(method, params);
    };
    await expect(submitSigned(f.input, f.artifact, { journal, rpc: f.rpc, confirm: async () => true })).rejects.toThrow('SUBMIT_RECEIPT_INVALID');
    expect((await inspectBudget(journal)).attempts[0].status).toBe('reserved'); expect(paid(f)).toHaveLength(1);
  });
});
test('mocked HTTP transport preserves not-found code through actual deploy preflight', async () => {
  const f = fixture(true); let httpCount = 0;
  const rpc = new HttpSubmitRpc('https://rpc.invalid', (async (_url: unknown, options?: RequestInit) => {
    httpCount++;
    const request = JSON.parse(options!.body as string);
    try {
      const result = await f.rpc.request(request.method, request.params);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    } catch (error) {
      if (!(error instanceof OperatorRpcError)) throw error;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: error.code, message: 'CONTRACT_NOT_FOUND_FROM_MOCK' } }));
    }
  }) as unknown as typeof fetch);
  expect((await preflight(f.input, rpc)).nonce).toBe('0');
  expect(httpCount).toBe(4); expect(paid(f)).toHaveLength(0);
});
