import { describe, expect, test, spyOn } from 'bun:test';
import { KMSClient, GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms';
import { secp256k1 } from '@noble/curves/secp256k1';
import { constants, hash, stark, transaction, type InvocationsSignerDetails, type DeployAccountSignerDetails } from 'starknet';
import { KmsK1Signer, awsKmsPort, digestBytes, signatureFelts, type Config, type KmsPort, type Review } from './signer';
function fixture(approve: Config['approve'] = async () => true) {
  // Ephemeral synthetic key lives only in this test; never serialized or printed.
  const key = secp256k1.utils.randomPrivateKey();
  const publicKey = `0x${Buffer.from(secp256k1.getPublicKey(key, false)).toString('hex')}`;
  const der = Buffer.from('3056301006072a8648ce3d020106052b8104000a034200' + publicKey.slice(2), 'hex');
  const keyId = ['arn', 'aws', 'kms', 'eu-west-1', '0'.repeat(12), 'key/00000000-0000-0000-0000-000000000000'].join(':');
  const requests: Uint8Array[] = [];
  const port: KmsPort = {
    async getPublicKey() { return { KeyId: keyId, KeySpec: 'ECC_SECG_P256K1', KeyUsage: 'SIGN_VERIFY',
      SigningAlgorithms: ['ECDSA_SHA_256'], PublicKey: der, $metadata: {} }; },
    async sign(_id, digest) {
      requests.push(digest);
      const low = secp256k1.sign(digest, key);
      // KMS can return high-s. The adapter must normalize before Cairo verification.
      const high = new secp256k1.Signature(low.r, secp256k1.CURVE.n - low.s);
      return { KeyId: keyId, SigningAlgorithm: 'ECDSA_SHA_256', Signature: high.toDERRawBytes(), $metadata: {} };
    },
  };
  const config: Config = { keyId, publicKey, accountAddress: '0x123', classHash: '0x456', maxFeeFri: 1000n, approve };
  const signer = new KmsK1Signer(port, config);
  const details: InvocationsSignerDetails = {
    walletAddress: config.accountAddress, chainId: constants.StarknetChainId.SN_SEPOLIA,
    cairoVersion: '1', version: '0x3', nonce: 1, tip: 0,
    resourceBounds: { l1_gas: { max_amount: 2n, max_price_per_unit: 3n },
      l2_gas: { max_amount: 4n, max_price_per_unit: 5n }, l1_data_gas: { max_amount: 6n, max_price_per_unit: 7n } },
    paymasterData: [], accountDeploymentData: [], nonceDataAvailabilityMode: 'L1', feeDataAvailabilityMode: 'L1',
  };
  const calls = [{ contractAddress: '0xabc', entrypoint: 'set_key', calldata: ['1', '2'] }];
  return { signer, config, port, requests, details, calls };
}
function fromFelts(data: string[]) {
  return new secp256k1.Signature(BigInt(data[0]) + (BigInt(data[1]) << 128n), BigInt(data[2]) + (BigInt(data[3]) << 128n));
}
describe('operator KMS k1 signer', () => {
  test('signs exact v3 digest and returns canonical four-limb Cairo signature', async () => {
    let reviewed: Review | undefined;
    const f = fixture(async value => { reviewed = value; return true; });
    expect(await f.signer.getPubKey()).toBe(`0x${f.config.publicKey.slice(4)}`);
    const result = await f.signer.signTransaction(f.calls, f.details) as string[];
    const expectedHash = hash.calculateInvokeTransactionHash({ ...f.details,
      senderAddress: f.details.walletAddress, compiledCalldata: transaction.getExecuteCalldata(f.calls, '1'),
      nonceDataAvailabilityMode: stark.intDAM(f.details.nonceDataAvailabilityMode),
      feeDataAvailabilityMode: stark.intDAM(f.details.feeDataAvailabilityMode) });
    expect(f.requests).toEqual([digestBytes(expectedHash)]);
    expect(reviewed?.hash).toBe(expectedHash);
    expect(reviewed?.maxFeeFri).toBe('68');
    expect(result).toHaveLength(4);
    const signature = fromFelts(result);
    expect(signature.s <= secp256k1.CURVE.n / 2n).toBe(true);
    expect(secp256k1.verify(signature, f.requests[0], f.config.publicKey.slice(2))).toBe(true);
  });
  test('review rejection does not contact KMS', async () => {
    const f = fixture(async () => false);
    f.port.getPublicKey = async () => { throw new Error('must not contact'); };
    await expect(f.signer.signTransaction(f.calls, f.details)).rejects.toThrow('KMS_NOT_APPROVED');
    expect(f.requests).toHaveLength(0);
  });
  test('snapshots details and calls before async review', async () => {
    let review: Review | undefined;
    const f = fixture(async value => {
      review = value; f.calls[0].calldata[0] = '999'; f.details.nonce = 999;
      value.hash = '0x1'; return true;
    });
    await f.signer.signTransaction(f.calls, f.details);
    expect(f.requests[0]).not.toEqual(digestBytes('0x1'));
    expect(review?.details.nonce).toBe(1);
  });
  for (const change of ['chain', 'version', 'account', 'cairo', 'fee', 'tip', 'missing-bound'] as const) {
    test(`refuses ${change} before KMS`, async () => {
      const f = fixture();
      if (change === 'chain') f.details.chainId = constants.StarknetChainId.SN_MAIN;
      if (change === 'version') (f.details as any).version = '0x0';
      if (change === 'account') f.details.walletAddress = '0x124';
      if (change === 'cairo') f.details.cairoVersion = '0';
      if (change === 'fee') f.details.resourceBounds.l1_data_gas.max_amount = 1000n;
      if (change === 'tip') f.details.tip = 1000;
      if (change === 'missing-bound') delete (f.details.resourceBounds as any).l1_data_gas;
      await expect(f.signer.signTransaction(f.calls, f.details)).rejects.toThrow();
      expect(f.requests).toHaveLength(0);
    });
  }
  test('rejects wrong key type and mismatched public key', async () => {
    const f = fixture(); const get = f.port.getPublicKey;
    f.port.getPublicKey = async id => ({ ...await get(id), KeySpec: 'ECC_NIST_P256' });
    await expect(f.signer.getPubKey()).rejects.toThrow('KMS_KEY_METADATA_INVALID');
    const other = fixture(); f.port.getPublicKey = async id => ({ ...await other.port.getPublicKey(id), KeyId: f.config.keyId });
    await expect(f.signer.getPubKey()).rejects.toThrow('KMS_PUBLIC_KEY_MISMATCH');
  });
  test('malformed, unrelated signatures and SDK errors fail closed without raw errors', async () => {
    const f = fixture();
    f.port.sign = async () => ({ KeyId: f.config.keyId, SigningAlgorithm: 'ECDSA_SHA_256', Signature: new Uint8Array([1]), $metadata: {} });
    await expect(f.signer.signTransaction(f.calls, f.details)).rejects.toThrow('KMS_SIGNATURE_INVALID');
    const other = fixture(); f.port.sign = async (_id, digest) => other.port.sign(other.config.keyId, digest);
    await expect(f.signer.signTransaction(f.calls, f.details)).rejects.toThrow('KMS_SIGNATURE_INVALID');
    f.port.sign = async () => { throw new Error('PRIVATE_AWS_ERROR'); };
    await expect(f.signer.signTransaction(f.calls, f.details)).rejects.toThrow(/^KMS_SIGN_UNAVAILABLE$/);
  });
  test('deployment is bound to key, salt, class and predicted address', async () => {
    const f = fixture(); const calldata = f.signer.constructorCalldata();
    const address = hash.calculateContractAddressFromHash(9, f.config.classHash, calldata, 0);
    const signer = new KmsK1Signer(f.port, { ...f.config, accountAddress: address });
    const { walletAddress, cairoVersion, ...common } = f.details;
    const details: DeployAccountSignerDetails = { ...common, classHash: f.config.classHash,
      addressSalt: 9, contractAddress: address, constructorCalldata: calldata };
    expect(await signer.signDeployAccountTransaction(details)).toHaveLength(4);
    await expect(signer.signDeployAccountTransaction({ ...details, contractAddress: '0x1' })).rejects.toThrow('KMS_DEPLOYMENT_MISMATCH');
    await expect(signer.signDeployAccountTransaction({ ...details, classHash: '0x457' })).rejects.toThrow('KMS_DEPLOYMENT_MISMATCH');
    await expect(signer.signDeployAccountTransaction({ ...details, addressSalt: 10 })).rejects.toThrow('KMS_DEPLOYMENT_MISMATCH');
    await expect(signer.signDeployAccountTransaction({ ...details, constructorCalldata: ['1', '0', '1', '0'] })).rejects.toThrow('KMS_DEPLOYMENT_MISMATCH');
  });
  test('query hash differs and generic message/declaration signing disabled', async () => {
    const f = fixture(); await f.signer.signTransaction(f.calls, f.details);
    await f.signer.signTransaction(f.calls, { ...f.details, version: '0x100000000000000000000000000000003' });
    expect(f.requests[0]).not.toEqual(f.requests[1]);
    await expect(f.signer.signMessage({} as any, '0x123')).rejects.toThrow('KMS_MESSAGE_SIGNING_DISABLED');
    await expect(f.signer.signDeclareTransaction({} as any)).rejects.toThrow('KMS_DECLARE_SIGNING_DISABLED');
  });
  test('DER is strict; digest is 32 bytes, big endian and field bounded', () => {
    expect(Buffer.from(digestBytes('0x123')).toString('hex')).toBe('0'.repeat(61) + '123');
    expect(() => digestBytes('-1')).toThrow(); expect(() => digestBytes(`0x1${'0'.repeat(64)}`)).toThrow();
    expect(() => signatureFelts(new Uint8Array([0x30, 0]))).toThrow('KMS_SIGNATURE_INVALID');
  });
});

test('public DER vector matches the shared Cairo signature', async () => {
  const vector = await Bun.file(new URL('./public-vector.json', import.meta.url)).json();
  expect(signatureFelts(Buffer.from(vector.der, 'hex'))).toEqual(vector.felts);
  expect(secp256k1.verify(fromFelts(vector.felts), digestBytes(vector.digest), vector.publicKey.slice(2))).toBe(true);
});

test('AWS SDK port sends DIGEST with ECDSA_SHA_256 and performs no other operations', async () => {
  const sent: unknown[] = [];
  const send = spyOn(KMSClient.prototype, 'send').mockImplementation((async (command: unknown) => {
    sent.push(command); return { $metadata: {} };
  }) as any);
  try {
    const port = awsKmsPort('eu-west-1');
    const digest = digestBytes('0x123');
    await port.getPublicKey('test-reference');
    await port.sign('test-reference', digest);
    expect(sent[0]).toBeInstanceOf(GetPublicKeyCommand);
    expect(sent[1]).toBeInstanceOf(SignCommand);
    expect((sent[1] as SignCommand).input).toEqual({ KeyId: 'test-reference',
      Message: digest, MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' });
    expect(sent).toHaveLength(2);
  } finally { send.mockRestore(); }
});
