import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, chmod, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import { type KmsPort, digestBytes } from './signer';
import { challenge, parseLiveCheckInput, checkKmsInteroperability, runLiveCheck, readLiveCheckInput } from './live-check';
function fixture() {
  const key = secp256k1.utils.randomPrivateKey();
  const publicKey = `0x${Buffer.from(secp256k1.getPublicKey(key, false)).toString('hex')}`;
  const keyId = ['arn', 'aws', 'kms', 'eu-west-1', '0'.repeat(12), 'key/00000000-0000-0000-0000-000000000000'].join(':');
  const input = { region: 'eu-west-1', keyId, publicKey };
  const calls: string[] = [];
  const port: KmsPort = {
    async getPublicKey() { calls.push('getPublicKey'); return { KeyId: keyId, KeyUsage: 'SIGN_VERIFY', KeySpec: 'ECC_SECG_P256K1',
      SigningAlgorithms: ['ECDSA_SHA_256'], PublicKey: Buffer.from('3056301006072a8648ce3d020106052b8104000a034200' + publicKey.slice(2), 'hex'), $metadata: {} }; },
    async sign(_keyId, digest) { calls.push('sign'); const low = secp256k1.sign(digest, key);
      const high = new secp256k1.Signature(low.r, secp256k1.CURVE.n - low.s);
      return { KeyId: keyId, SigningAlgorithm: 'ECDSA_SHA_256', Signature: high.toDERRawBytes(), $metadata: {} }; },
  };
  return { input, port, calls };
}
test('high-s response verifies and result contains no KMS identifiers', async () => {
  const f = fixture(); let reserved = false;
  const result = await checkKmsInteroperability(f.input, f.port, async () => { reserved = true; expect(f.calls).toHaveLength(0); });
  expect(reserved).toBe(true); expect(f.calls).toEqual(['getPublicKey', 'sign']);
  expect(result.status).toBe('verified'); expect(result.starknetTransactionsSubmitted).toBe(0);
  expect(result.signature).toHaveLength(4);
  expect(JSON.stringify(result)).not.toContain(f.input.keyId);
  expect(JSON.stringify(result)).not.toContain('region');
});
test('failed reservation does not contact KMS', async () => {
  const f = fixture();
  await expect(checkKmsInteroperability(f.input, f.port, async () => { throw new Error('RESERVED'); })).rejects.toThrow('RESERVED');
  expect(f.calls).toHaveLength(0);
});
test('wrong metadata prevents signing, and SDK errors are sanitized', async () => {
  const f = fixture(); const get = f.port.getPublicKey;
  f.port.getPublicKey = async key => ({ ...await get(key), KeySpec: 'ECC_NIST_P256' });
  await expect(checkKmsInteroperability(f.input, f.port, async () => {})).rejects.toThrow('LIVE_KMS_METADATA_MISMATCH');
  expect(f.calls).toEqual(['getPublicKey']);
  f.port.getPublicKey = async () => { throw new Error('PRIVATE_RESOURCE_ERROR'); };
  await expect(checkKmsInteroperability(f.input, f.port, async () => {})).rejects.toThrow(/^LIVE_KMS_METADATA_UNAVAILABLE$/);
});
test('wrong key, malformed signature and signing error fail closed', async () => {
  const f = fixture(), other = fixture();
  const get = f.port.getPublicKey;
  f.port.getPublicKey = async key => ({ ...await other.port.getPublicKey(key), KeyId: f.input.keyId });
  await expect(checkKmsInteroperability(f.input, f.port, async () => {})).rejects.toThrow('LIVE_KMS_METADATA_MISMATCH');
  f.port.getPublicKey = get;
  f.port.sign = async () => ({ KeyId: f.input.keyId, SigningAlgorithm: 'ECDSA_SHA_256', Signature: new Uint8Array([1]), $metadata: {} });
  await expect(checkKmsInteroperability(f.input, f.port, async () => {})).rejects.toThrow('LIVE_KMS_SIGNATURE_INVALID');
  f.port.sign = async () => { throw new Error('PRIVATE_SIGN_ERROR'); };
  await expect(checkKmsInteroperability(f.input, f.port, async () => {})).rejects.toThrow(/^LIVE_KMS_SIGN_UNAVAILABLE$/);
});
test('challenge is domain separated, field bounded and fresh', () => {
  const first = challenge(), second = challenge();
  expect(first.nonce).not.toBe(second.nonce); expect(first.digest).not.toBe(second.digest);
  expect(digestBytes(first.digest)).toHaveLength(32);
  expect(challenge('0'.repeat(64))).toEqual(challenge('0'.repeat(64)));
  expect(() => challenge('not-random-bytes')).toThrow('LIVE_CHALLENGE_INVALID');
});
test('strict config rejects aliases, unknown fields, wrong Region and point', () => {
  const f = fixture(); expect(parseLiveCheckInput(f.input)).toEqual(f.input);
  expect(() => parseLiveCheckInput({ ...f.input, keyId: 'alias/example' })).toThrow();
  expect(() => parseLiveCheckInput({ ...f.input, region: 'us-east-1' })).toThrow();
  expect(() => parseLiveCheckInput({ ...f.input, privateKey: 'forbidden' })).toThrow();
  expect(() => parseLiveCheckInput({ ...f.input, publicKey: '0x04' + '00'.repeat(64) })).toThrow();
});
async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'kamui-kms-live-unit-'));
  try { await chmod(directory, 0o700); await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
test('exclusive durable reservation consumes one directory across restarts', async () => {
  await temporary(async directory => {
    const f = fixture(), inputFile = join(directory, 'input.json'), output = join(directory, 'output');
    await writeFile(inputFile, JSON.stringify(f.input), { mode: 0o600 }); await mkdir(output, { mode: 0o700 });
    await runLiveCheck(inputFile, output, f.port);
    expect(JSON.parse(await readFile(join(output, 'attempt.json'), 'utf8')).maxSigningCalls).toBe(1);
    expect(JSON.parse(await readFile(join(output, 'result.json'), 'utf8')).status).toBe('verified');
    await expect(runLiveCheck(inputFile, output, f.port)).rejects.toThrow();
    expect(f.calls).toEqual(['getPublicKey', 'sign']);
  });
});
test('uncertain signing retains reservation and never retries', async () => {
  await temporary(async directory => {
    const f = fixture(), inputFile = join(directory, 'input.json'), output = join(directory, 'output');
    await writeFile(inputFile, JSON.stringify(f.input), { mode: 0o600 }); await mkdir(output, { mode: 0o700 });
    f.port.sign = async () => { f.calls.push('sign'); throw new Error('uncertain'); };
    await expect(runLiveCheck(inputFile, output, f.port)).rejects.toThrow('LIVE_KMS_SIGN_UNAVAILABLE');
    await expect(runLiveCheck(inputFile, output, f.port)).rejects.toThrow();
    expect(f.calls).toEqual(['getPublicKey', 'sign']);
    expect(JSON.parse(await readFile(join(output, 'attempt.json'), 'utf8')).state).toBe('reserved');
  });
});
test('private input and output permissions checked before AWS request', async () => {
  await temporary(async directory => {
    const f = fixture(), inputFile = join(directory, 'input.json'), output = join(directory, 'output');
    await writeFile(inputFile, JSON.stringify(f.input), { mode: 0o644 }); await mkdir(output, { mode: 0o700 });
    await expect(runLiveCheck(inputFile, output, f.port)).rejects.toThrow('LIVE_INPUT_FILE_INVALID');
    await chmod(inputFile, 0o600); await chmod(output, 0o755);
    await expect(runLiveCheck(inputFile, output, f.port)).rejects.toThrow('LIVE_OUTPUT_DIRECTORY_INVALID');
    await symlink(inputFile, join(directory, 'link.json'));
    await expect(readLiveCheckInput(join(directory, 'link.json'))).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
});
