import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inputFromKmsMetadata, prepareLiveInput } from './live-prepare';
import vector from './public-vector.json';
function metadata() {
  const KeyId = ['arn', 'aws', 'kms', 'eu-west-1', '0'.repeat(12), 'key/00000000-0000-0000-0000-000000000000'].join(':');
  return { KeyId, KeySpec: 'ECC_SECG_P256K1', KeyUsage: 'SIGN_VERIFY', SigningAlgorithms: ['ECDSA_SHA_256'],
    PublicKey: Buffer.from('3056301006072a8648ce3d020106052b8104000a034200' + vector.publicKey.slice(2), 'hex').toString('base64') };
}
test('local AWS CLI metadata conversion produces exact public SEC1 key', () => {
  const value = metadata();
  expect(inputFromKmsMetadata(value, 'eu-west-1')).toEqual({ region: 'eu-west-1', keyId: value.KeyId, publicKey: vector.publicKey });
});
test('metadata conversion refuses wrong curve, corrupt SPKI, Region and unknown fields', () => {
  const value = metadata();
  expect(() => inputFromKmsMetadata({ ...value, KeySpec: 'ECC_NIST_P256' }, 'eu-west-1')).toThrow();
  expect(() => inputFromKmsMetadata({ ...value, PublicKey: value.PublicKey + '\n' }, 'eu-west-1')).toThrow();
  expect(() => inputFromKmsMetadata({ ...value, PublicKey: Buffer.alloc(88).toString('base64') }, 'eu-west-1')).toThrow();
  expect(() => inputFromKmsMetadata(value, 'us-east-1')).toThrow();
  expect(() => inputFromKmsMetadata({ ...value, PrivateKey: 'forbidden' }, 'eu-west-1')).toThrow();
});
test('metadata file conversion uses private exclusive output and never overwrites', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kamui-kms-metadata-unit-'));
  try {
    await chmod(directory, 0o700);
    const input = join(directory, 'metadata.json');
    await writeFile(input, JSON.stringify(metadata()), { mode: 0o600 });
    await prepareLiveInput(input, 'eu-west-1', directory);
    const output = JSON.parse(await readFile(join(directory, 'live-check.input.json'), 'utf8'));
    expect(output.publicKey).toBe(vector.publicKey);
    await expect(prepareLiveInput(input, 'eu-west-1', directory)).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
