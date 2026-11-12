import { expect, test } from 'bun:test';
import { secp256k1 } from '@noble/curves/secp256k1';
import { constants, hash } from 'starknet';
import { mkdtemp, writeFile, chmod, symlink, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KmsK1Signer, type KmsPort } from './signer';
import { HttpReadRpc, OperatorRpcError, parseOperatorInput, preflight, reviewAndSign,
  readPrivateInput, reservePrivateOutput, safeStatus, type OperatorInput, type ReadRpc, type ReadMethod } from './operator';
function fixture() {
  const secret = secp256k1.utils.randomPrivateKey();
  const publicKey = `0x${Buffer.from(secp256k1.getPublicKey(secret, false)).toString('hex')}`;
  const keyId = ['arn', 'aws', 'kms', 'eu-west-1', '0'.repeat(12), 'key/00000000-0000-0000-0000-000000000000'].join(':');
  let kmsRequests = 0;
  const kms: KmsPort = {
    async getPublicKey() {
      kmsRequests++;
      return { $metadata: {}, KeyId: keyId, KeySpec: 'ECC_SECG_P256K1', KeyUsage: 'SIGN_VERIFY',
        SigningAlgorithms: ['ECDSA_SHA_256'],
        PublicKey: Buffer.from('3056301006072a8648ce3d020106052b8104000a034200' + publicKey.slice(2), 'hex') };
    },
    async sign(_id, digest) {
      kmsRequests++;
      return { $metadata: {}, KeyId: keyId, SigningAlgorithm: 'ECDSA_SHA_256',
        Signature: secp256k1.sign(digest, secret).toDERRawBytes() };
    },
  };
  const input = parseOperatorInput({ schema: 'kamui.kms-operator.v1', region: 'eu-west-1', keyId, publicKey,
    accountAddress: '0x123', classHash: '0x456', maxFeeFri: '1000', rpcUrl: 'https://rpc.invalid',
    transaction: { kind: 'invoke', calls: [{ contractAddress: '0x789', entrypoint: 'set_key', calldata: ['1', '2'] }],
      details: { walletAddress: '0x123', cairoVersion: '1', chainId: constants.StarknetChainId.SN_SEPOLIA,
        version: '0x3', nonce: '7', tip: '0', resourceBounds: {
          l1_gas: { max_amount: '2', max_price_per_unit: '3' }, l2_gas: { max_amount: '4', max_price_per_unit: '5' },
          l1_data_gas: { max_amount: '6', max_price_per_unit: '7' } }, paymasterData: [], accountDeploymentData: [],
        nonceDataAvailabilityMode: 'L1', feeDataAvailabilityMode: 'L1' } } });
  const signer = new KmsK1Signer(kms, { ...input, maxFeeFri: 1000n, approve: async () => false });
  const calls: { method: ReadMethod; params: Record<string, unknown> }[] = [];
  const rpc: ReadRpc = { async request(method, params) {
    calls.push({ method, params });
    switch (method) {
      case 'starknet_chainId': return constants.StarknetChainId.SN_SEPOLIA;
      case 'starknet_getBlockWithTxHashes': return { block_hash: '0xabc', status: 'ACCEPTED_ON_L2' };
      case 'starknet_getClassHashAt': return input.classHash;
      case 'starknet_call': return signer.constructorCalldata();
      case 'starknet_getNonce': return '0x7';
      default: throw new Error('unexpected method');
    }
  } };
  return { input, rpc, kms, calls, signer, kmsRequests: () => kmsRequests };
}
test('one accepted snapshot checks chain/class/full key/nonce without KMS access', async () => {
  const f = fixture(); const observed = await preflight(f.input, f.rpc);
  expect(observed.blockHash).toBe('0xabc'); expect(observed.nonce).toBe('0x7');
  expect(f.kmsRequests()).toBe(0);
  const reads = f.calls.filter(call => !['starknet_chainId', 'starknet_getBlockWithTxHashes'].includes(call.method));
  expect(reads).toHaveLength(3);
  for (const read of reads) expect(read.params.block_id).toEqual({ block_hash: '0xabc' });
});
for (const failure of ['chain', 'block', 'class', 'key', 'nonce', 'rpc'] as const) {
  test(`preflight rejects ${failure} before any KMS signing`, async () => {
    const f = fixture(); const original = f.rpc.request;
    f.rpc.request = async (method, params) => {
      if (failure === 'chain' && method === 'starknet_chainId') return constants.StarknetChainId.SN_MAIN;
      if (failure === 'block' && method === 'starknet_getBlockWithTxHashes') return { block_hash: '0xabc', status: 'PRE_CONFIRMED' };
      if (failure === 'class' && method === 'starknet_getClassHashAt') return '0x999';
      if (failure === 'key' && method === 'starknet_call') return ['1', '0', '1', '0'];
      if (failure === 'nonce' && method === 'starknet_getNonce') return '0x8';
      if (failure === 'rpc') throw new Error('UNTRUSTED_PROVIDER_TEXT');
      return original(method, params);
    };
    await expect(reviewAndSign(f.input, { rpc: f.rpc, kms: f.kms, confirm: async () => true })).rejects.toThrow();
    expect(f.kmsRequests()).toBe(0);
  });
}
test('exact review hash is signed, input/review mutation cannot alter the artifact', async () => {
  const f = fixture(); let reviewedHash = '';
  const artifact = await reviewAndSign(f.input, { rpc: f.rpc, kms: f.kms, confirm: async review => {
    reviewedHash = review.hash;
    expect(review.details.nonce).toBe('7'); expect(review.maxFeeFri).toBe('68');
    expect(review.calls).toEqual(f.input.transaction.kind === 'invoke' ? f.input.transaction.calls : []);
    review.hash = '0x1';
    if (f.input.transaction.kind === 'invoke') f.input.transaction.calls[0].calldata = ['999'];
    return true;
  } });
  expect(artifact.schema).toBe('kamui.kms-signed.v1'); expect(artifact.transactionHash).toBe(reviewedHash);
  expect(artifact.signature).toHaveLength(4); expect(f.kmsRequests()).toBe(2);
  expect(f.calls.filter(call => call.method === 'starknet_chainId')).toHaveLength(2);
  const serialized = JSON.stringify(artifact);
  expect(serialized).not.toContain('keyId'); expect(serialized).not.toContain(f.input.keyId);
  expect(serialized).not.toContain('rpc.invalid'); expect(serialized).not.toContain('999');
});
test('approval rejection and changed state during review prevent KMS access', async () => {
  const f = fixture();
  await expect(reviewAndSign(f.input, { rpc: f.rpc, kms: f.kms, confirm: async () => false })).rejects.toThrow('KMS_NOT_APPROVED');
  const original = f.rpc.request;
  await expect(reviewAndSign(f.input, { rpc: f.rpc, kms: f.kms, confirm: async () => {
    f.rpc.request = async (method, params) => method === 'starknet_getNonce' ? '8' : original(method, params);
    return true;
  } })).rejects.toThrow('OPERATOR_NONCE_MISMATCH');
  expect(f.kmsRequests()).toBe(0);
});
function deployment(f: ReturnType<typeof fixture>) {
  const declared = { sierra_program: [], contract_class_version: '0.1.0',
    entry_points_by_type: { EXTERNAL: [], CONSTRUCTOR: [], L1_HANDLER: [] }, abi: '[]' };
  const classHash = hash.computeContractClassHash(declared as any);
  const calldata = f.signer.constructorCalldata();
  const address = hash.calculateContractAddressFromHash('9', classHash, calldata, 0);
  const { walletAddress, cairoVersion, ...common } = f.input.transaction.details as any;
  const input = parseOperatorInput({ ...f.input, accountAddress: address, classHash,
    transaction: { kind: 'deploy', details: { ...common, nonce: '0', classHash,
      contractAddress: address, addressSalt: '9', constructorCalldata: calldata } } });
  const original = f.rpc.request;
  const rpc: ReadRpc = { request: async (method, params) => {
    if (method === 'starknet_getClassHashAt') throw new OperatorRpcError(20);
    if (method === 'starknet_getClass') return declared;
    return original(method, params);
  } };
  return { input, rpc, declared };
}
test('deploy preflight checks predicted address/key/class and declared class, then can sign', async () => {
  const f = fixture(), d = deployment(f);
  expect((await preflight(d.input, d.rpc)).nonce).toBe('0');
  const signed = await reviewAndSign(d.input, { rpc: d.rpc, kms: f.kms, confirm: async () => true });
  expect(signed.kind).toBe('deploy'); expect(signed.account).toBe(d.input.accountAddress);
});
for (const failure of ['wrong-error', 'already-deployed', 'class', 'address', 'key'] as const) {
  test(`deploy preflight rejects ${failure}`, async () => {
    const f = fixture(), d = deployment(f); const original = d.rpc.request;
    if (d.input.transaction.kind !== 'deploy') throw new Error();
    if (failure === 'address') d.input.accountAddress = '0x123';
    if (failure === 'key') d.input.transaction.details.constructorCalldata = ['1', '0', '1', '0'];
    d.rpc.request = async (method, params) => {
      if (failure === 'wrong-error' && method === 'starknet_getClassHashAt') throw new OperatorRpcError(24);
      if (failure === 'already-deployed' && method === 'starknet_getClassHashAt') return d.input.classHash;
      if (failure === 'class' && method === 'starknet_getClass') return { ...d.declared, abi: '[1]' };
      return original(method, params);
    };
    await expect(preflight(d.input, d.rpc)).rejects.toThrow(); expect(f.kmsRequests()).toBe(0);
  });
}
test('input schema rejects secret fields, extensions, untrusted URL syntax and numeric JSON ambiguity', () => {
  const f = fixture();
  for (const patch of [{ privateKey: 'never-accepted' }, { rpcUrl: 'http://public.invalid' },
    { rpcUrl: 'https://name:password@rpc.invalid' }, { maxFeeFri: 1000 }])
    expect(() => parseOperatorInput({ ...f.input, ...patch })).toThrow();
  const raw = structuredClone(f.input) as any;
  raw.transaction.details.privateKey = 'never-accepted'; expect(() => parseOperatorInput(raw)).toThrow();
  delete raw.transaction.details.privateKey; raw.transaction.calls[0].jwt = 'never-accepted';
  expect(() => parseOperatorInput(raw)).toThrow(); delete raw.transaction.calls[0].jwt;
  raw.transaction.details.paymasterData = ['1']; expect(() => parseOperatorInput(raw)).toThrow();
});
test('read-only RPC rejects broadcasting and sanitizes errors, validates response id', async () => {
  let count = 0;
  const port = new HttpReadRpc('https://rpc.invalid', (async (_url: unknown, options?: RequestInit) => {
    count++; const request = JSON.parse(options!.body as string);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: 20, message: 'PRIVATE_RPC_RESPONSE' } }));
  }) as unknown as typeof fetch);
  await expect(port.request('starknet_addInvokeTransaction' as ReadMethod, {})).rejects.toThrow('OPERATOR_RPC_METHOD_FORBIDDEN');
  expect(count).toBe(0);
  try { await port.request('starknet_getClassHashAt', {}); throw new Error('missing rejection'); }
  catch (error) { expect(error).toBeInstanceOf(OperatorRpcError); expect(safeStatus(error)).toBe('OPERATOR_RPC_FAILED'); }
  const invalid = new HttpReadRpc('https://rpc.invalid', (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 999, result: '0x1' }))) as unknown as typeof fetch);
  await expect(invalid.request('starknet_chainId', {})).rejects.toThrow('OPERATOR_RPC_FAILED');
  expect(safeStatus(new Error('OPERATOR_PRIVATE_PROVIDER_ERROR'))).toBe('OPERATOR_FAILED');
});
test('private files reject symlinks/public mode and signed output cannot overwrite', async () => {
  const f = fixture(); const directory = await mkdtemp(join(tmpdir(), 'kamui-kms-operator-'));
  await chmod(directory, 0o700);
  try {
    const input = join(directory, 'input.json'), link = join(directory, 'link.json'), output = join(directory, 'signed.json');
    await writeFile(input, JSON.stringify(f.input), { mode: 0o600 });
    expect((await readPrivateInput(input)).accountAddress).toBe(f.input.accountAddress);
    await symlink(input, link); await expect(readPrivateInput(link)).rejects.toThrow('OPERATOR_PRIVATE_FILE_INVALID');
    await chmod(input, 0o644); await expect(readPrivateInput(input)).rejects.toThrow('OPERATOR_PRIVATE_FILE_INVALID');
    const handle = await reservePrivateOutput(output); await handle.writeFile('test'); await handle.close();
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    await expect(reservePrivateOutput(output)).rejects.toThrow(); expect(await readFile(output, 'utf8')).toBe('test');
    await chmod(directory, 0o755); await expect(reservePrivateOutput(join(directory, 'other.json'))).rejects.toThrow('OPERATOR_OUTPUT_INVALID');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('RPC bounds streaming responses without trusting Content-Length', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  const rpc = new HttpReadRpc('https://rpc.invalid', (async () => new Response(stream)) as unknown as typeof fetch);
  await expect(rpc.request('starknet_chainId', {})).rejects.toThrow('OPERATOR_RPC_FAILED');
  expect(cancelled).toBe(true);
});
