/** Manual operator signing. Read-only RPC + KMS signatures; deliberately no broadcast method. */
import { constants, hash, CallData, type Call, type InvocationsSignerDetails, type DeployAccountSignerDetails } from 'starknet';
import { constants as fsConstants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { KmsK1Signer, awsKmsPort, type KmsPort, type Review } from './signer';

const FIELD = (1n << 251n) + 17n * (1n << 192n) + 1n;
const SCHEMA = 'kamui.kms-operator.v1';
const LIMIT = 256 * 1024;
export type ReadMethod = 'starknet_chainId' | 'starknet_getBlockWithTxHashes'
  | 'starknet_getClassHashAt' | 'starknet_getNonce' | 'starknet_call' | 'starknet_getClass';
export interface ReadRpc { request(method: ReadMethod, params: Record<string, unknown>): Promise<unknown>; }
export class OperatorRpcError extends Error {
  constructor(readonly code: number) { super('OPERATOR_RPC_FAILED'); }
}
type WireBounds = Record<'l1_gas' | 'l2_gas' | 'l1_data_gas', { max_amount: string; max_price_per_unit: string }>;
export type OperatorInvokeDetails = Omit<InvocationsSignerDetails, 'resourceBounds'> & { resourceBounds: WireBounds };
export type OperatorDeployDetails = Omit<DeployAccountSignerDetails, 'resourceBounds'> & { resourceBounds: WireBounds };
export interface OperatorInput {
  schema: typeof SCHEMA; region: string; keyId: string; publicKey: string;
  accountAddress: string; classHash: string; maxFeeFri: string; rpcUrl: string;
  transaction: { kind: 'invoke'; calls: Call[]; details: OperatorInvokeDetails }
    | { kind: 'deploy'; details: OperatorDeployDetails };
}
export interface Observation { blockHash: string; chainId: string; account: string; classHash: string; nonce: string; }
export interface SignedArtifact {
  schema: 'kamui.kms-signed.v1'; kind: 'invoke' | 'deploy'; transactionHash: string;
  signature: string[]; account: string; classHash: string; chainId: string;
  transaction: OperatorInput['transaction']; observation: Observation;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OPERATOR_INPUT_INVALID');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key)))
    throw new Error('OPERATOR_INPUT_INVALID');
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error('OPERATOR_INPUT_INVALID');
  return value;
}
function numberString(value: unknown, max = FIELD, nonzero = false): string {
  const str = text(value);
  if (!/^(?:0x[0-9a-fA-F]+|0|[1-9][0-9]*)$/.test(str)) throw new Error('OPERATOR_INPUT_INVALID');
  const n = BigInt(str);
  if (n < 0n || n >= max || (nonzero && n === 0n)) throw new Error('OPERATOR_INPUT_INVALID');
  return str;
}
function calldata(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16384) throw new Error('OPERATOR_INPUT_INVALID');
  return value.map(n => numberString(n));
}
function details(raw: unknown, kind: 'invoke' | 'deploy'): Record<string, unknown> {
  const item = object(raw);
  const common = ['chainId', 'version', 'nonce', 'tip', 'resourceBounds', 'paymasterData',
    'accountDeploymentData', 'nonceDataAvailabilityMode', 'feeDataAvailabilityMode'];
  keys(item, [...common, ...(kind === 'invoke' ? ['walletAddress', 'cairoVersion']
    : ['contractAddress', 'classHash', 'addressSalt', 'constructorCalldata'])]);
  for (const name of ['chainId', 'version', 'nonce']) numberString(item[name]);
  numberString(item.tip, 1n << 64n);
  if (BigInt(item.chainId as string) !== BigInt(constants.StarknetChainId.SN_SEPOLIA)
    || ![3n, (1n << 128n) + 3n].includes(BigInt(item.version as string)))
    throw new Error('OPERATOR_DOMAIN_INVALID');
  if (item.nonceDataAvailabilityMode !== 'L1' || item.feeDataAvailabilityMode !== 'L1')
    throw new Error('OPERATOR_INPUT_INVALID');
  // This manual registry tool intentionally excludes paymasters and deployment/proof extensions.
  if (calldata(item.paymasterData).length || calldata(item.accountDeploymentData).length)
    throw new Error('OPERATOR_INPUT_INVALID');
  const bounds = object(item.resourceBounds);
  keys(bounds, ['l1_gas', 'l2_gas', 'l1_data_gas']);
  for (const name of ['l1_gas', 'l2_gas', 'l1_data_gas']) {
    const bound = object(bounds[name]); keys(bound, ['max_amount', 'max_price_per_unit']);
    numberString(bound.max_amount, 1n << 64n); numberString(bound.max_price_per_unit, 1n << 128n);
  }
  if (kind === 'invoke') {
    numberString(item.walletAddress, FIELD, true);
    if (item.cairoVersion !== '1') throw new Error('OPERATOR_INPUT_INVALID');
  } else {
    numberString(item.contractAddress, FIELD, true); numberString(item.classHash, FIELD, true);
    numberString(item.addressSalt);
    if (calldata(item.constructorCalldata).length !== 4 || BigInt(item.nonce as string) !== 0n)
      throw new Error('OPERATOR_INPUT_INVALID');
  }
  return item;
}
/** Exact schema rejects secret-key fields and arbitrary RPC/transaction extensions at every level. */
export function parseOperatorInput(raw: unknown): OperatorInput {
  const data = object(raw);
  keys(data, ['schema', 'region', 'keyId', 'publicKey', 'accountAddress', 'classHash', 'maxFeeFri', 'rpcUrl', 'transaction']);
  if (data.schema !== SCHEMA || !/^[a-z0-9-]{3,40}$/.test(text(data.region))) throw new Error('OPERATOR_INPUT_INVALID');
  text(data.keyId); text(data.publicKey);
  numberString(data.accountAddress, FIELD, true); numberString(data.classHash, FIELD, true);
  numberString(data.maxFeeFri, 1n << 256n, true);
  const url = new URL(text(data.rpcUrl));
  if (url.username || url.password || url.hash || !(url.protocol === 'https:'
    || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))))
    throw new Error('OPERATOR_RPC_URL_INVALID');
  const tx = object(data.transaction);
  if (tx.kind !== 'invoke' && tx.kind !== 'deploy') throw new Error('OPERATOR_INPUT_INVALID');
  keys(tx, tx.kind === 'invoke' ? ['kind', 'calls', 'details'] : ['kind', 'details']);
  details(tx.details, tx.kind);
  if (tx.kind === 'invoke') {
    if (!Array.isArray(tx.calls) || tx.calls.length < 1 || tx.calls.length > 64) throw new Error('OPERATOR_INPUT_INVALID');
    for (const rawCall of tx.calls) {
      const call = object(rawCall); keys(call, ['contractAddress', 'entrypoint', 'calldata']);
      numberString(call.contractAddress, FIELD, true);
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(text(call.entrypoint))) throw new Error('OPERATOR_INPUT_INVALID');
      calldata(call.calldata);
    }
  }
  return structuredClone(data) as unknown as OperatorInput;
}
export class HttpReadRpc implements ReadRpc {
  private id = 0;
  constructor(private readonly url: string, private readonly send: typeof fetch = fetch) {}
  async request(method: ReadMethod, params: Record<string, unknown>): Promise<unknown> {
    // Runtime guard as well as TypeScript: this transport cannot submit transactions.
    if (!['starknet_chainId', 'starknet_getBlockWithTxHashes', 'starknet_getClassHashAt',
      'starknet_getNonce', 'starknet_call', 'starknet_getClass'].includes(method))
      throw new Error('OPERATOR_RPC_METHOD_FORBIDDEN');
    const id = ++this.id;
    try {
      const response = await this.send(this.url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), redirect: 'error',
        signal: AbortSignal.timeout(15_000) });
      if (!response.ok || Number(response.headers.get('content-length') || 0) > 4 * 1024 * 1024)
        throw new Error();
      if (!response.body) throw new Error();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error(); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      const data = object(JSON.parse(body));
      if (data.id !== id || data.jsonrpc !== '2.0') throw new Error();
      if (data.error) {
        const error = object(data.error);
        throw new OperatorRpcError(Number.isInteger(error.code) ? error.code as number : -1);
      }
      if (!Object.hasOwn(data, 'result')) throw new Error();
      return data.result;
    } catch (error) {
      if (error instanceof OperatorRpcError) throw error;
      throw new Error('OPERATOR_RPC_FAILED');
    }
  }
}
function equalNumber(actual: unknown, expected: string): boolean {
  try { return BigInt(numberString(actual)) === BigInt(expected); } catch { return false; }
}
/** One accepted snapshot; no pending-state or continuing-custody guarantee. */
export async function preflight(input: OperatorInput, rpc: ReadRpc): Promise<Observation> {
  const pinned = new KmsK1Signer({} as KmsPort, { ...input, maxFeeFri: BigInt(input.maxFeeFri), approve: async () => false });
  const expected = pinned.constructorCalldata();
  if (input.transaction.kind === 'invoke' && !equalNumber(input.transaction.details.walletAddress, input.accountAddress))
    throw new Error('OPERATOR_ACCOUNT_MISMATCH');
  const chainId = await rpc.request('starknet_chainId', {});
  if (!equalNumber(chainId, constants.StarknetChainId.SN_SEPOLIA)) throw new Error('OPERATOR_CHAIN_MISMATCH');
  const block = object(await rpc.request('starknet_getBlockWithTxHashes', { block_id: 'latest' }));
  const blockHash = numberString(block.block_hash, FIELD, true);
  if (!['ACCEPTED_ON_L1', 'ACCEPTED_ON_L2'].includes(String(block.status))) throw new Error('OPERATOR_BLOCK_INVALID');
  const block_id = { block_hash: blockHash };
  const address = { block_id, contract_address: input.accountAddress };
  const tx = input.transaction;
  if (tx.kind === 'invoke') {
    const classHash = await rpc.request('starknet_getClassHashAt', address);
    if (!equalNumber(classHash, input.classHash)) throw new Error('OPERATOR_CLASS_MISMATCH');
    const key = await rpc.request('starknet_call', { block_id, request: {
      contract_address: input.accountAddress, entry_point_selector: hash.getSelectorFromName('get_public_key'), calldata: [],
    } });
    if (!Array.isArray(key) || key.length !== 4 || key.some((v, i) => !equalNumber(v, expected[i])))
      throw new Error('OPERATOR_PUBLIC_KEY_MISMATCH');
    const nonce = await rpc.request('starknet_getNonce', address);
    if (!equalNumber(nonce, String(tx.details.nonce))) throw new Error('OPERATOR_NONCE_MISMATCH');
    return { blockHash, chainId: String(chainId), account: input.accountAddress, classHash: input.classHash, nonce: String(nonce) };
  }
  const compiled = CallData.compile(tx.details.constructorCalldata);
  const predicted = hash.calculateContractAddressFromHash(tx.details.addressSalt, input.classHash, compiled, 0);
  if (!equalNumber(predicted, input.accountAddress) || !equalNumber(tx.details.contractAddress, input.accountAddress)
    || !equalNumber(tx.details.classHash, input.classHash) || compiled.length !== 4
    || compiled.some((value, i) => !equalNumber(value, expected[i]))) throw new Error('OPERATOR_DEPLOYMENT_MISMATCH');
  // Only the protocol's exact CONTRACT_NOT_FOUND response establishes absence; no other error does.
  try {
    await rpc.request('starknet_getClassHashAt', address);
  } catch (error) {
    if (!(error instanceof OperatorRpcError && error.code === 20)) throw error;
    const declared = await rpc.request('starknet_getClass', { block_id, class_hash: input.classHash });
    try {
      if (!equalNumber(hash.computeContractClassHash(declared as any), input.classHash))
        throw new Error();
    } catch { throw new Error('OPERATOR_CLASS_MISMATCH'); }
    return { blockHash, chainId: String(chainId), account: input.accountAddress, classHash: input.classHash, nonce: '0' };
  }
  throw new Error('OPERATOR_ACCOUNT_ALREADY_DEPLOYED');
}
export async function reviewAndSign(raw: OperatorInput, dependencies: {
  rpc: ReadRpc; kms: KmsPort; confirm: (review: Review) => Promise<boolean>;
}): Promise<SignedArtifact> {
  const input = parseOperatorInput(raw);
  let observation = await preflight(input, dependencies.rpc);
  let signedReview: Review | undefined;
  const signer = new KmsK1Signer(dependencies.kms, { ...input, maxFeeFri: BigInt(input.maxFeeFri),
    approve: async review => {
      if (await dependencies.confirm(structuredClone(review)) !== true) return false;
      // The operator may have left the prompt open: check again immediately before KMS access.
      observation = await preflight(input, dependencies.rpc);
      signedReview = structuredClone(review);
      return true;
    } });
  const tx = input.transaction;
  // JSON fee bounds are strings; starknet.js hash helpers require bigint resource bounds.
  const bounds = tx.details.resourceBounds;
  const resourceBounds = {
    l1_gas: { max_amount: BigInt(bounds.l1_gas.max_amount), max_price_per_unit: BigInt(bounds.l1_gas.max_price_per_unit) },
    l2_gas: { max_amount: BigInt(bounds.l2_gas.max_amount), max_price_per_unit: BigInt(bounds.l2_gas.max_price_per_unit) },
    l1_data_gas: { max_amount: BigInt(bounds.l1_data_gas.max_amount), max_price_per_unit: BigInt(bounds.l1_data_gas.max_price_per_unit) },
  };
  const signature = tx.kind === 'invoke' ? await signer.signTransaction(tx.calls, { ...tx.details, resourceBounds })
    : await signer.signDeployAccountTransaction({ ...tx.details, resourceBounds });
  if (!signedReview || !Array.isArray(signature) || signature.length !== 4) throw new Error('OPERATOR_SIGNATURE_INVALID');
  return { schema: 'kamui.kms-signed.v1', kind: tx.kind, transactionHash: signedReview.hash,
    signature: signature as string[], account: input.accountAddress, classHash: input.classHash,
    chainId: signedReview.chainId, transaction: tx, observation };
}
export async function readPrivateInput(path: string): Promise<OperatorInput> {
  if (!isAbsolute(path)) throw new Error('OPERATOR_PRIVATE_FILE_INVALID');
  let file;
  try {
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || info.size > LIMIT)
      throw new Error();
    const bytes = Buffer.alloc(LIMIT + 1); const count = await file.read(bytes, 0, bytes.length, 0);
    if (count.bytesRead > LIMIT) throw new Error();
    return parseOperatorInput(JSON.parse(bytes.subarray(0, count.bytesRead).toString('utf8')));
  } catch { throw new Error('OPERATOR_PRIVATE_FILE_INVALID'); }
  finally { await file?.close(); }
}
export async function reservePrivateOutput(path: string) {
  if (!isAbsolute(path)) throw new Error('OPERATOR_OUTPUT_INVALID');
  const directory = await lstat(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.()
    || (directory.mode & 0o077) !== 0) throw new Error('OPERATOR_OUTPUT_INVALID');
  return open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
}
const SAFE_CODES = new Set([
  'OPERATOR_INPUT_INVALID', 'OPERATOR_DOMAIN_INVALID', 'OPERATOR_RPC_URL_INVALID',
  'OPERATOR_RPC_FAILED', 'OPERATOR_RPC_METHOD_FORBIDDEN', 'OPERATOR_CHAIN_MISMATCH',
  'OPERATOR_BLOCK_INVALID', 'OPERATOR_CLASS_MISMATCH', 'OPERATOR_PUBLIC_KEY_MISMATCH',
  'OPERATOR_NONCE_MISMATCH', 'OPERATOR_DEPLOYMENT_MISMATCH', 'OPERATOR_ACCOUNT_ALREADY_DEPLOYED',
  'OPERATOR_PRIVATE_FILE_INVALID', 'OPERATOR_OUTPUT_INVALID', 'OPERATOR_SIGNATURE_INVALID',
  'OPERATOR_ACCOUNT_MISMATCH', 'OPERATOR_USAGE', 'OPERATOR_TTY_REQUIRED',
  'KMS_CONFIG_INVALID', 'KMS_FEE_INVALID', 'KMS_FEE_LIMIT', 'KMS_TRANSACTION_DOMAIN_INVALID',
  'KMS_ACCOUNT_MISMATCH', 'KMS_DEPLOYMENT_MISMATCH', 'KMS_NOT_APPROVED',
  'KMS_PUBLIC_KEY_UNAVAILABLE', 'KMS_KEY_METADATA_INVALID', 'KMS_PUBLIC_KEY_INVALID',
  'KMS_PUBLIC_KEY_MISMATCH', 'KMS_SIGN_UNAVAILABLE', 'KMS_SIGNATURE_INVALID',
]);
export function safeStatus(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return SAFE_CODES.has(message) ? message : 'OPERATOR_FAILED';
}
async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (!['check', 'sign'].includes(mode) || args.length !== (mode === 'check' ? 2 : 4)
    || args[0] !== '--input' || (mode === 'sign' && args[2] !== '--output')) throw new Error('OPERATOR_USAGE');
  if (mode === 'sign' && (!process.stdin.isTTY || !process.stderr.isTTY)) throw new Error('OPERATOR_TTY_REQUIRED');
  const input = await readPrivateInput(args[1]);
  const rpc = new HttpReadRpc(input.rpcUrl);
  if (mode === 'check') { await preflight(input, rpc); console.log('OPERATOR_PREFLIGHT_OK'); return; }
  // Reserve the destination before signing. On error keep an empty file: never silently retry/overwrite.
  const output = await reservePrivateOutput(args[3]);
  try {
    const artifact = await reviewAndSign(input, { rpc, kms: awsKmsPort(input.region), confirm: async review => {
      process.stderr.write(JSON.stringify(review, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      try { return (await terminal.question(`Type SIGN ${review.hash} to approve this exact signature: `)) === `SIGN ${review.hash}`; }
      finally { terminal.close(); }
    } });
    await output.writeFile(JSON.stringify(artifact, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
    await output.sync(); console.log('OPERATOR_SIGNED_NOT_BROADCAST');
  } finally { await output.close(); }
}
if (import.meta.main) main().catch(error => { console.error(safeStatus(error)); process.exitCode = 1; });
