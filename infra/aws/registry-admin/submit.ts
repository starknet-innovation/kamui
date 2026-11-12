/** Single-send Sepolia acceptance helper. No KMS, private keys, funding or registry mutations. */
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { secp256k1 } from '@noble/curves/secp256k1';
import { CallData, constants, hash, stark, transaction } from 'starknet';
import { digestBytes } from './signer';
import { parseOperatorInput, preflight, readPrivateInput, type OperatorInput, type ReadRpc, type ReadMethod,
  type SignedArtifact, OperatorRpcError } from './operator';
import { reserveAttempt, inspectBudget, reconcileAttempt, type Reservation, type Attempt } from './live-budget';
import { privateDirectory } from './live-check';

export const PING_TARGET = '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc';
const FIELD = (1n << 251n) + 17n * (1n << 192n) + 1n;
const LIMIT = 4 * 1024 * 1024;
export type SubmitMethod = ReadMethod | 'starknet_addInvokeTransaction' | 'starknet_addDeployAccountTransaction'
  | 'starknet_getTransactionReceipt';
export interface SubmitRpc { request(method: SubmitMethod, params: Record<string, unknown>): Promise<unknown>; }
export interface Prepared {
  artifact: SignedArtifact; input: OperatorInput; reservation: Reservation;
  method: 'starknet_addInvokeTransaction' | 'starknet_addDeployAccountTransaction';
  params: Record<string, unknown>;
}
export interface SendReview {
  transactionHash: string; kind: 'deploy' | 'ping'; sender: string; nonce: string;
  maxFeeFri: string; principalFri: '0'; chainId: string; transaction: OperatorInput['transaction'];
}
export type Outcome = { status: 'confirmed-success' | 'confirmed-revert' | 'pending' | 'ambiguous'; transactionHash: string };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SUBMIT_ARTIFACT_INVALID');
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).sort().join(',') !== expected.sort().join(',')) throw new Error('SUBMIT_ARTIFACT_INVALID');
}
function integer(value: unknown, max = FIELD): bigint {
  if (typeof value !== 'string' || !/^(?:0x[0-9a-fA-F]+|0|[1-9][0-9]*)$/.test(value)) throw new Error('SUBMIT_ARTIFACT_INVALID');
  const n = BigInt(value);
  if (n < 0n || n >= max) throw new Error('SUBMIT_ARTIFACT_INVALID');
  return n;
}
function feltHex(value: unknown): string {
  const n = integer(value);
  if (!n) throw new Error('SUBMIT_ARTIFACT_INVALID');
  return `0x${n.toString(16)}`;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function hex(value: string | bigint | number): string { return `0x${BigInt(value).toString(16)}`; }

/** Recompute from every signed field, verify the K1 signature, bind to exact operator input and operation. */
export function prepareSubmission(rawInput: OperatorInput, rawArtifact: unknown): Prepared {
  const input = parseOperatorInput(rawInput), artifact = record(structuredClone(rawArtifact));
  exactKeys(artifact, ['schema', 'kind', 'transactionHash', 'signature', 'account', 'classHash', 'chainId', 'transaction', 'observation']);
  if (artifact.schema !== 'kamui.kms-signed.v1' || artifact.kind !== input.transaction.kind
    || integer(artifact.account) !== integer(input.accountAddress) || integer(artifact.classHash) !== integer(input.classHash)
    || integer(artifact.chainId) !== BigInt(constants.StarknetChainId.SN_SEPOLIA)
    || stable(artifact.transaction) !== stable(input.transaction)) throw new Error('SUBMIT_ARTIFACT_MISMATCH');
  const observation = record(artifact.observation);
  exactKeys(observation, ['blockHash', 'chainId', 'account', 'classHash', 'nonce']);
  feltHex(observation.blockHash);
  if (integer(observation.chainId) !== BigInt(constants.StarknetChainId.SN_SEPOLIA)
    || integer(observation.account) !== integer(input.accountAddress) || integer(observation.classHash) !== integer(input.classHash)
    || integer(observation.nonce) !== BigInt(input.transaction.details.nonce)) throw new Error('SUBMIT_ARTIFACT_MISMATCH');
  const tx = input.transaction, details = tx.details;
  if (BigInt(details.version) !== 3n) throw new Error('SUBMIT_QUERY_FORBIDDEN');
  if (tx.kind === 'invoke' && (tx.calls.length !== 1
    || BigInt(tx.calls[0].contractAddress) !== BigInt(PING_TARGET) || tx.calls[0].entrypoint !== 'ping'
    || !Array.isArray(tx.calls[0].calldata) || tx.calls[0].calldata.length !== 0)) throw new Error('SUBMIT_OPERATION_FORBIDDEN');
  const rawBounds = details.resourceBounds;
  const bounds = {
    l1_gas: { max_amount: BigInt(rawBounds.l1_gas.max_amount), max_price_per_unit: BigInt(rawBounds.l1_gas.max_price_per_unit) },
    l2_gas: { max_amount: BigInt(rawBounds.l2_gas.max_amount), max_price_per_unit: BigInt(rawBounds.l2_gas.max_price_per_unit) },
    l1_data_gas: { max_amount: BigInt(rawBounds.l1_data_gas.max_amount), max_price_per_unit: BigInt(rawBounds.l1_data_gas.max_price_per_unit) },
  };
  const maximum = Object.values(bounds).reduce((n, bound) => n + bound.max_amount * bound.max_price_per_unit, 0n)
    + bounds.l2_gas.max_amount * BigInt(details.tip);
  if (maximum <= 0n || maximum > BigInt(input.maxFeeFri) || maximum > 5n * 10n ** 18n) throw new Error('SUBMIT_FEE_LIMIT');
  const common = { ...details, resourceBounds: bounds,
    nonceDataAvailabilityMode: stark.intDAM(details.nonceDataAvailabilityMode),
    feeDataAvailabilityMode: stark.intDAM(details.feeDataAvailabilityMode) };
  let computed: string, compiled: string[];
  if (tx.kind === 'invoke') {
    compiled = transaction.getExecuteCalldata(tx.calls, '1');
    computed = hash.calculateInvokeTransactionHash({ ...common, senderAddress: input.accountAddress, compiledCalldata: compiled });
  } else {
    compiled = CallData.compile(tx.details.constructorCalldata);
    // The deploy body has to commit to this exact immutable admin key, class, salt and address.
    const publicKey = input.publicKey;
    if (!/^0x04[0-9a-f]{128}$/i.test(publicKey)) throw new Error('SUBMIT_PUBLIC_KEY_INVALID');
    const x = BigInt(`0x${publicKey.slice(4, 68)}`), y = BigInt(`0x${publicKey.slice(68)}`), mask = (1n << 128n) - 1n;
    const expected = [x & mask, x >> 128n, y & mask, y >> 128n];
    if (compiled.length !== 4 || compiled.some((n, i) => BigInt(n) !== expected[i])
      || BigInt(tx.details.classHash) !== BigInt(input.classHash)
      || BigInt(tx.details.contractAddress) !== BigInt(input.accountAddress)
      || BigInt(hash.calculateContractAddressFromHash(tx.details.addressSalt, input.classHash, compiled, 0)) !== BigInt(input.accountAddress))
      throw new Error('SUBMIT_ARTIFACT_MISMATCH');
    computed = hash.calculateDeployAccountTransactionHash({ ...common,
      contractAddress: tx.details.contractAddress, classHash: tx.details.classHash,
      salt: tx.details.addressSalt, compiledConstructorCalldata: compiled });
  }
  if (integer(artifact.transactionHash) !== BigInt(computed)) throw new Error('SUBMIT_HASH_MISMATCH');
  if (!Array.isArray(artifact.signature) || artifact.signature.length !== 4) throw new Error('SUBMIT_SIGNATURE_INVALID');
  const limbs = artifact.signature.map(n => integer(n, 1n << 128n));
  const r = limbs[0] + (limbs[1] << 128n), s = limbs[2] + (limbs[3] << 128n);
  try {
    if (s > secp256k1.CURVE.n / 2n || !secp256k1.verify(new secp256k1.Signature(r, s), digestBytes(computed), input.publicKey.slice(2)))
      throw new Error();
  } catch { throw new Error('SUBMIT_SIGNATURE_INVALID'); }
  const resource_bounds = Object.fromEntries(Object.entries(bounds).map(([name, bound]) => [name,
    { max_amount: hex(bound.max_amount), max_price_per_unit: hex(bound.max_price_per_unit) }]));
  const wire = { version: '0x3', nonce: hex(BigInt(details.nonce)), signature: limbs.map(hex), resource_bounds,
    tip: hex(BigInt(details.tip)), paymaster_data: [], nonce_data_availability_mode: 'L1', fee_data_availability_mode: 'L1' };
  const params = tx.kind === 'invoke' ? { invoke_transaction: { ...wire, type: 'INVOKE', sender_address: hex(input.accountAddress),
    calldata: compiled.map(hex), account_deployment_data: [] } }
    : { deploy_account_transaction: { ...wire, type: 'DEPLOY_ACCOUNT', class_hash: hex(input.classHash),
      contract_address_salt: hex((tx as Extract<OperatorInput['transaction'], { kind: 'deploy' }>).details.addressSalt), constructor_calldata: compiled.map(hex) } };
  const checkedArtifact = artifact as unknown as SignedArtifact;
  return { input, artifact: checkedArtifact, reservation: { kind: tx.kind === 'invoke' ? 'ping' : 'deploy',
    sender: feltHex(input.accountAddress), nonce: String(BigInt(details.nonce)), transactionHash: hex(BigInt(computed)),
    maxFeeFri: String(maximum), principalFri: '0' }, method: tx.kind === 'invoke' ? 'starknet_addInvokeTransaction' : 'starknet_addDeployAccountTransaction', params };
}

/** Explicit transport: one HTTP request per call; no SDK or retry machinery. */
export class HttpSubmitRpc implements SubmitRpc {
  private id = 0;
  constructor(private readonly url: string, private readonly send: typeof fetch = fetch) {}
  async request(method: SubmitMethod, params: Record<string, unknown>): Promise<unknown> {
    if (!['starknet_chainId', 'starknet_getBlockWithTxHashes', 'starknet_getClassHashAt', 'starknet_getNonce',
      'starknet_call', 'starknet_getClass', 'starknet_addInvokeTransaction', 'starknet_addDeployAccountTransaction',
      'starknet_getTransactionReceipt'].includes(method)) throw new Error('SUBMIT_RPC_METHOD_FORBIDDEN');
    const id = ++this.id;
    try {
      const response = await this.send(this.url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!response.ok || !response.body || Number(response.headers.get('content-length') || 0) > LIMIT) throw new Error();
      const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength; if (size > LIMIT) { await reader.cancel(); throw new Error(); } chunks.push(chunk.value);
      } } finally { reader.releaseLock(); }
      const result = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      if (result.id !== id || result.jsonrpc !== '2.0') throw new Error();
      if (result.error) {
        const error = record(result.error);
        throw new OperatorRpcError(Number.isInteger(error.code) ? error.code as number : -1);
      }
      if (!Object.hasOwn(result, 'result')) throw new Error();
      return result.result;
    } catch (error) {
      if (error instanceof OperatorRpcError) throw error;
      throw new Error('SUBMIT_RPC_FAILED');
    }
  }
}
async function syncDirectory(path: string) {
  const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
function evidencePath(journal: string, tx: string): string {
  return join(dirname(journal), `kms-submit-${feltHex(tx).slice(2)}.jsonl`);
}
async function evidence(journal: string, tx: string, data: Record<string, unknown>, first = false) {
  await privateDirectory(dirname(journal));
  const flags = fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW | (first ? fsConstants.O_CREAT | fsConstants.O_EXCL : fsConstants.O_APPEND);
  const file = await open(evidencePath(journal, tx), flags, 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 65_536)
      throw new Error('SUBMIT_EVIDENCE_INVALID');
    await file.writeFile(JSON.stringify(data) + '\n'); await file.sync();
  } finally { await file.close(); }
  if (first) await syncDirectory(dirname(journal));
}
function assertReservation(actual: Attempt | undefined, expected: Reservation) {
  if (!actual || Object.entries(expected).some(([key, value]) => (actual as unknown as Record<string, unknown>)[key] !== value))
    throw new Error('SUBMIT_RESERVATION_MISMATCH');
}
function readOnly(rpc: SubmitRpc): ReadRpc { return { request: (method, params) => rpc.request(method, params) }; }
/** Existing reservation only, never sends or reserves again. Receipt failures retain the whole debit. */
export async function reconcileSubmission(prepared: Prepared, journal: string, rpc: SubmitRpc): Promise<Outcome> {
  const state = await inspectBudget(journal), expected = prepared.reservation;
  assertReservation(state.attempts.find(attempt => attempt.transactionHash === expected.transactionHash), expected);
  const chain = await rpc.request('starknet_chainId', {});
  if (integer(chain) !== BigInt(constants.StarknetChainId.SN_SEPOLIA)) throw new Error('SUBMIT_CHAIN_MISMATCH');
  let raw: unknown;
  try { raw = await rpc.request('starknet_getTransactionReceipt', { transaction_hash: expected.transactionHash }); }
  catch { return { status: 'pending', transactionHash: expected.transactionHash }; }
  let receipt: Record<string, unknown>;
  try {
    receipt = record(raw);
    if (integer(receipt.transaction_hash) !== BigInt(expected.transactionHash)
      || receipt.type !== (expected.kind === 'deploy' ? 'DEPLOY_ACCOUNT' : 'INVOKE')
      || !['ACCEPTED_ON_L1', 'ACCEPTED_ON_L2'].includes(String(receipt.finality_status))
      || !['SUCCEEDED', 'REVERTED'].includes(String(receipt.execution_status))) throw new Error();
    const actual = record(receipt.actual_fee);
    if (actual.unit !== 'FRI' || integer(actual.amount, 1n << 256n) > BigInt(expected.maxFeeFri)) throw new Error();
    feltHex(receipt.block_hash);
    if (expected.kind === 'deploy' && integer(receipt.contract_address) !== BigInt(expected.sender)) throw new Error();
    if (typeof receipt.block_number !== 'number' || !Number.isSafeInteger(receipt.block_number) || receipt.block_number < 0) throw new Error();
  } catch { return { status: 'ambiguous', transactionHash: expected.transactionHash }; }
  const block = record(await rpc.request('starknet_getBlockWithTxHashes', { block_id: { block_number: receipt.block_number } }));
  if (integer(block.block_hash) !== integer(receipt.block_hash) || block.block_number !== receipt.block_number
    || !['ACCEPTED_ON_L1', 'ACCEPTED_ON_L2'].includes(String(block.status))
    || !Array.isArray(block.transactions) || !block.transactions.some(tx => {
      try { return integer(tx) === BigInt(expected.transactionHash); } catch { return false; }
    })) throw new Error('SUBMIT_RECEIPT_INVALID');
  const status = receipt.execution_status === 'SUCCEEDED' ? 'confirmed-success' : 'confirmed-revert';
  const fee = String(integer(record(receipt.actual_fee).amount, 1n << 256n));
  await reconcileAttempt(journal, expected.transactionHash, status, fee, String(receipt.block_number));
  await evidence(journal, expected.transactionHash, { state: status, transactionHash: expected.transactionHash,
    actualFeeFri: fee, blockNumber: String(receipt.block_number), blockHash: feltHex(receipt.block_hash) });
  return { status, transactionHash: expected.transactionHash };
}
/** Reserve exact hash/fee/nonce before the one possible paid RPC; no automatic retry or resend. */
export async function submitSigned(rawInput: OperatorInput, rawArtifact: unknown, options: {
  journal: string; rpc: SubmitRpc; confirm: (review: SendReview) => Promise<boolean>;
}): Promise<Outcome> {
  const prepared = prepareSubmission(rawInput, rawArtifact);
  await preflight(prepared.input, readOnly(options.rpc));
  const r = prepared.reservation;
  const review: SendReview = { kind: r.kind as 'deploy' | 'ping', transactionHash: r.transactionHash,
    sender: r.sender, nonce: r.nonce, maxFeeFri: r.maxFeeFri, principalFri: '0',
    chainId: constants.StarknetChainId.SN_SEPOLIA, transaction: prepared.input.transaction };
  if (await options.confirm(structuredClone(review)) !== true) throw new Error('SUBMIT_NOT_APPROVED');
  await preflight(prepared.input, readOnly(options.rpc));
  // inspect/reserve requires an existing fixed-run journal; this helper has no initialization/reset path.
  const attempt = await reserveAttempt(options.journal, r);
  await evidence(options.journal, r.transactionHash, { schema: 'kamui.kms-submit.v1', state: 'reserved',
    transactionHash: r.transactionHash, attemptIndex: attempt.index, kind: r.kind, sender: r.sender,
    nonce: r.nonce, maxFeeFri: r.maxFeeFri, principalFri: '0' }, true);
  let response: unknown;
  try { response = await options.rpc.request(prepared.method, prepared.params); }
  catch {
    await evidence(options.journal, r.transactionHash, { state: 'ambiguous', reason: 'rpc_failure' });
    return { status: 'ambiguous', transactionHash: r.transactionHash };
  }
  let returned: string;
  try { returned = feltHex(record(response).transaction_hash); }
  catch {
    await evidence(options.journal, r.transactionHash, { state: 'ambiguous', reason: 'invalid_response' });
    return { status: 'ambiguous', transactionHash: r.transactionHash };
  }
  const matched = returned === r.transactionHash;
  await evidence(options.journal, r.transactionHash, { state: 'rpc-returned', returnedHash: returned, matchesExpectedHash: matched });
  if (!matched) return { status: 'ambiguous', transactionHash: r.transactionHash };
  return reconcileSubmission(prepared, options.journal, options.rpc);
}
async function readSigned(path: string): Promise<unknown> {
  if (!isAbsolute(path)) throw new Error('SUBMIT_PRIVATE_FILE_INVALID');
  const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 1024 * 1024)
      throw new Error('SUBMIT_PRIVATE_FILE_INVALID');
    const buffer = Buffer.alloc(1024 * 1024 + 1), result = await file.read(buffer, 0, buffer.length, 0);
    if (result.bytesRead > 1024 * 1024) throw new Error('SUBMIT_PRIVATE_FILE_INVALID');
    return JSON.parse(buffer.subarray(0, result.bytesRead).toString('utf8'));
  } finally { await file.close(); }
}
export async function main(args: string[]): Promise<number> {
  try {
    const [mode, inputFlag, inputPath, signedFlag, signedPath, journalFlag, journal, ...rest] = args;
    if (!['send', 'reconcile'].includes(mode) || inputFlag !== '--input' || signedFlag !== '--signed'
      || journalFlag !== '--journal' || !inputPath || !signedPath || !journal || rest.length) throw new Error();
    if (mode === 'send' && (!process.stdin.isTTY || !process.stderr.isTTY)) throw new Error('SUBMIT_TTY_REQUIRED');
    const input = await readPrivateInput(inputPath), artifact = await readSigned(signedPath), rpc = new HttpSubmitRpc(input.rpcUrl);
    const outcome = mode === 'send' ? await submitSigned(input, artifact, { journal, rpc, confirm: async review => {
      process.stderr.write(JSON.stringify(review, null, 2) + '\n');
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      try { return await terminal.question(`Type SEND ${review.transactionHash} to submit this exact paid test once: `) === `SEND ${review.transactionHash}`; }
      finally { terminal.close(); }
    } }) : await reconcileSubmission(prepareSubmission(input, artifact), journal, rpc);
    console.log(`SUBMIT_${outcome.status.toUpperCase().replaceAll('-', '_')}`);
    return outcome.status === 'confirmed-success' ? 0 : 1;
  } catch { console.error('SUBMIT_OPERATION_FAILED'); return 1; }
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
