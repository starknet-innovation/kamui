/** Local-only conversion of private AWS CLI GetPublicKey output; never calls AWS or RPC. */
import { parseLiveCheckInput, privateDirectory, readPrivateJson, writeExclusive, type LiveCheckInput } from './live-check';
const PREFIX = Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex');
export function inputFromKmsMetadata(raw: unknown, region: string): LiveCheckInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('LIVE_METADATA_INVALID');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !['KeyId', 'KeyUsage', 'KeySpec', 'CustomerMasterKeySpec', 'SigningAlgorithms', 'PublicKey'].includes(key))
    || value.KeySpec !== 'ECC_SECG_P256K1' || value.KeyUsage !== 'SIGN_VERIFY'
    || (value.CustomerMasterKeySpec !== undefined && value.CustomerMasterKeySpec !== value.KeySpec)
    || !Array.isArray(value.SigningAlgorithms) || !value.SigningAlgorithms.includes('ECDSA_SHA_256')
    || typeof value.PublicKey !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.PublicKey))
    throw new Error('LIVE_METADATA_INVALID');
  const bytes = Buffer.from(value.PublicKey, 'base64');
  if (bytes.toString('base64') !== value.PublicKey || bytes.length !== PREFIX.length + 65
    || !bytes.subarray(0, PREFIX.length).equals(PREFIX)) throw new Error('LIVE_METADATA_INVALID');
  return parseLiveCheckInput({ region, keyId: value.KeyId, publicKey: `0x${bytes.subarray(PREFIX.length).toString('hex')}` });
}
export async function prepareLiveInput(metadataPath: string, region: string, outputDirectory: string): Promise<void> {
  const input = inputFromKmsMetadata(await readPrivateJson(metadataPath), region);
  await privateDirectory(outputDirectory);
  await writeExclusive(outputDirectory, 'live-check.input.json', input);
}
export async function main(args: string[]): Promise<number> {
  try {
    if (args.length !== 6 || args[0] !== '--metadata' || args[2] !== '--region' || args[4] !== '--output-directory')
      throw new Error('LIVE_ARGUMENTS_INVALID');
    await prepareLiveInput(args[1], args[3], args[5]);
    process.stdout.write('KMS_LIVE_INPUT_PREPARED\n');
    return 0;
  } catch {
    process.stderr.write('KMS_LIVE_INPUT_PREPARATION_FAILED\n');
    return 1;
  }
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
