/** Single-attempt KMS interoperability check. No Starknet RPC or transaction submission. */
import { constants as fsConstants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { awsKmsPort, digestBytes, signatureFelts, type KmsPort } from './signer';

const FIELD = (1n << 251n) + 17n * (1n << 192n) + 1n;
const DOMAIN = 'Kamui KMS secp256k1 interoperability check v1';
const SPKI_PREFIX = '3056301006072a8648ce3d020106052b8104000a034200';
export interface LiveCheckInput { region: string; keyId: string; publicKey: string }
export interface LiveCheckResult {
  schema: 'kamui.kms-interoperability.v1';
  status: 'verified';
  challenge: { domain: typeof DOMAIN; nonce: string; digest: string };
  publicKey: string;
  signature: string[];
  signingCalls: 1;
  starknetTransactionsSubmitted: 0;
}

export function parseLiveCheckInput(raw: unknown): LiveCheckInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('LIVE_INPUT_INVALID');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'keyId,publicKey,region'
    || typeof value.region !== 'string' || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(value.region)
    || typeof value.keyId !== 'string'
    || !/^arn:[a-z-]+:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/.test(value.keyId)
    || value.keyId.split(':')[3] !== value.region
    || typeof value.publicKey !== 'string' || !/^0x04[0-9a-f]{128}$/i.test(value.publicKey))
    throw new Error('LIVE_INPUT_INVALID');
  try { secp256k1.ProjectivePoint.fromHex(value.publicKey.slice(2)).assertValidity(); }
  catch { throw new Error('LIVE_INPUT_INVALID'); }
  return { region: value.region, keyId: value.keyId, publicKey: value.publicKey.toLowerCase() };
}

export function challenge(nonce = randomBytes(32).toString('hex')) {
  if (!/^[0-9a-f]{64}$/.test(nonce)) throw new Error('LIVE_CHALLENGE_INVALID');
  const sha = createHash('sha256').update(DOMAIN).update('\0').update(nonce, 'hex').digest('hex');
  const digest = `0x${(BigInt(`0x${sha}`) % FIELD).toString(16)}`;
  return { domain: DOMAIN, nonce, digest } as const;
}

/** The reservation callback must durably succeed before the first AWS request. */
export async function checkKmsInteroperability(
  input: LiveCheckInput,
  kms: KmsPort,
  reserve: (probe: ReturnType<typeof challenge>) => Promise<void>,
): Promise<LiveCheckResult> {
  const config = parseLiveCheckInput(input);
  const probe = challenge();
  await reserve(probe);
  let metadata;
  try { metadata = await kms.getPublicKey(config.keyId); }
  catch { throw new Error('LIVE_KMS_METADATA_UNAVAILABLE'); }
  const expected = Buffer.from(SPKI_PREFIX + config.publicKey.slice(2), 'hex');
  if (metadata.KeyId !== config.keyId || metadata.KeySpec !== 'ECC_SECG_P256K1'
    || metadata.KeyUsage !== 'SIGN_VERIFY' || !metadata.SigningAlgorithms?.includes('ECDSA_SHA_256')
    || !metadata.PublicKey || !Buffer.from(metadata.PublicKey).equals(expected))
    throw new Error('LIVE_KMS_METADATA_MISMATCH');
  const digest = digestBytes(probe.digest);
  let signed;
  try { signed = await kms.sign(config.keyId, digest); }
  catch { throw new Error('LIVE_KMS_SIGN_UNAVAILABLE'); }
  if (signed.KeyId !== config.keyId || signed.SigningAlgorithm !== 'ECDSA_SHA_256' || !signed.Signature)
    throw new Error('LIVE_KMS_SIGNATURE_INVALID');
  let signature: string[];
  try {
    signature = signatureFelts(signed.Signature);
    const r = BigInt(signature[0]) + (BigInt(signature[1]) << 128n);
    const s = BigInt(signature[2]) + (BigInt(signature[3]) << 128n);
    if (!secp256k1.verify(new secp256k1.Signature(r, s), digest, config.publicKey.slice(2))) throw new Error();
  } catch { throw new Error('LIVE_KMS_SIGNATURE_INVALID'); }
  return { schema: 'kamui.kms-interoperability.v1', status: 'verified', challenge: probe,
    publicKey: config.publicKey, signature, signingCalls: 1, starknetTransactionsSubmitted: 0 };
}

export async function privateDirectory(path: string) {
  if (!isAbsolute(path)) throw new Error('LIVE_OUTPUT_DIRECTORY_INVALID');
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error('LIVE_OUTPUT_DIRECTORY_INVALID');
}
export async function writeExclusive(directory: string, name: string, data: unknown) {
  const file = await open(join(directory, name), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(data, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  const dir = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
}
export async function readPrivateJson(path: string): Promise<unknown> {
  if (!isAbsolute(path)) throw new Error('LIVE_INPUT_FILE_INVALID');
  const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 16_384)
      throw new Error('LIVE_INPUT_FILE_INVALID');
    try { return JSON.parse(await file.readFile('utf8')); }
    catch { throw new Error('LIVE_INPUT_FILE_INVALID'); }
  } finally { await file.close(); }
}
export async function readLiveCheckInput(path: string): Promise<LiveCheckInput> {
  return parseLiveCheckInput(await readPrivateJson(path));
}

/** Only one attempt can consume this directory. Failed/uncertain checks never retry. */
export async function runLiveCheck(inputPath: string, outputDirectory: string, port?: KmsPort): Promise<void> {
  const input = await readLiveCheckInput(inputPath);
  await privateDirectory(outputDirectory);
  const result = await checkKmsInteroperability(input, port ?? awsKmsPort(input.region), async probe => {
    await writeExclusive(outputDirectory, 'attempt.json', {
      schema: 'kamui.kms-interoperability-attempt.v1', state: 'reserved',
      startedAt: new Date().toISOString(), challenge: probe,
      maxSigningCalls: 1, starknetTransactionsSubmitted: 0,
    });
  });
  await writeExclusive(outputDirectory, 'result.json', result);
}

export async function main(args: string[]): Promise<number> {
  try {
    if (args.length !== 5 || args[0] !== '--input' || args[2] !== '--output-directory' || args[4] !== '--confirm-kms-sign')
      throw new Error('LIVE_ARGUMENTS_INVALID');
    await runLiveCheck(args[1], args[3]);
    process.stdout.write(JSON.stringify({ status: 'kms_interoperability_verified', signingCalls: 1, starknetTransactionsSubmitted: 0 }) + '\n');
    return 0;
  } catch {
    // Raw SDK/filesystem/config errors can contain account identifiers; never print them.
    process.stderr.write('KMS_INTEROPERABILITY_CHECK_FAILED\n');
    return 1;
  }
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
