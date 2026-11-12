/** Explicitly authorized one-run Sepolia harness. No key/credential CLI inputs or raw errors. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Account, RpcProvider, CallData, constants, hash, json, transaction, config } from 'starknet';
import { env } from '../../../services/backend/src/env';
import { secretSource } from '../../../services/backend/src/secrets';
import { readPrivateJson, writeExclusive, privateDirectory } from './live-check';
import { KmsK1Signer, awsKmsPort } from './signer';
import { initializeBudget, inspectBudget, reserveAttempt, reconcileAttempt, STRK, BUDGET_FILE } from './live-budget';
import { PING_TARGET } from './submit';
import { canonicalClassHash, parseOperatorInput } from './operator';
const ROOT = join(homedir(), '.kamui-admin-sepolia');
const DIR = join(ROOT, 'kms-sepolia-live');
const JOURNAL = join(DIR, BUDGET_FILE);
const RPC = 'https://api.zan.top/public/starknet-sepolia/rpc/v0_10';
const CHAIN = constants.StarknetChainId.SN_SEPOLIA;
const RELAYER = '0x5bf22a824e3d20dfe018fab5de043a9cab41c45361f4ded0f2e2fc51776118e';
const TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const ARTIFACT = join(import.meta.dir, '../../../contracts/target/dev/kamui_KmsK1Admin');
const OLD_CLASS = '0x1e128dae2cb709cac9263afa1c6fdb33f7f1f5c2d969547d9739326d08399f6';
const SALT = '0x6b616d75695f6b6d735f6b315f7631';
const hex = (v: any) => `0x${BigInt(v).toString(16)}`;
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
let stage = 'start';
class RpcFailure extends Error { constructor(public code: number) { super('RPC_FAILED'); } }
async function rpc(method: string, params: any): Promise<any> {
  const response = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), redirect: 'error', signal: AbortSignal.timeout(25_000) });
  const value = await response.json() as any;
  if (value.error) {
    await writeExclusive(DIR, `rpc-error-${Date.now()}-${method}.json`, { stage, error: value.error });
    throw new RpcFailure(value.error.code);
  }
  if (!response.ok || !('result' in value)) throw new Error('RPC_FAILED');
  return value.result;
}
const provider = new RpcProvider({ nodeUrl: RPC, baseFetch: ((url: any, options: any) => fetch(url, {
  ...options, signal: AbortSignal.timeout(25_000), redirect: 'error' })) as any });
async function chain() { if (BigInt(await rpc('starknet_chainId', {})) !== BigInt(CHAIN)) throw new Error('WRONG_CHAIN'); }
async function balance(address: string) {
  const result = await rpc('starknet_call', { block_id: 'latest', request: { contract_address: TOKEN,
    entry_point_selector: hash.getSelectorFromName('balance_of'), calldata: [address] } });
  return BigInt(result[0]) + (BigInt(result[1]) << 128n);
}
async function artifacts() {
  const source = await Bun.file(ARTIFACT + '.contract_class.json').text();
  const compiled = await Bun.file(ARTIFACT + '.compiled_contract_class.json').text();
  const contract = json.parse(source), casm = json.parse(compiled);
  const head = await rpc('starknet_getBlockWithTxHashes', { block_id: 'latest' });
  const classHash = hash.computeContractClassHash(contract);
  const compiledClassHash = hash.computeCompiledClassHash(casm, head.starknet_version);
  if (hash.computeContractClassHash(json.parse(await Bun.file(join(import.meta.dir,
      '../../../contracts/target/dev/kamui_KamuiAccount.contract_class.json')).text())) !== OLD_CLASS) throw new Error('USER_ACCOUNT_CLASS_CHANGED');
  return { contract, casm, classHash, compiledClassHash, sourceSha256: sha(source), casmSha256: sha(compiled), starknetVersion: head.starknet_version };
}
async function manifest() {
  const plan = await readPrivateJson(join(DIR, 'manifest.json')) as any;
  const current = await artifacts();
  for (const k of ['classHash', 'compiledClassHash', 'sourceSha256', 'casmSha256'] as const) if (current[k] !== plan[k]) throw new Error('ARTIFACT_CHANGED');
  return { plan, current };
}
async function payer() {
  if (BigInt(env('RELAYER_ADDRESS')) !== BigInt(RELAYER)) throw new Error('PAYER_CHANGED');
  // Same approved SecretSource path as backend API; never serialize or print this key.
  return new Account({ provider, address: RELAYER, signer: await secretSource().get('RELAYER_PRIVATE_KEY'), cairoVersion: '1' });
}
function maxFee(bounds: any): bigint {
  let result = 0n;
  for (const name of ['l1_gas', 'l2_gas', 'l1_data_gas']) {
    const b = bounds[name];
    if (!b || BigInt(b.max_amount) < 0n || BigInt(b.max_amount) >= 1n << 64n || BigInt(b.max_price_per_unit) < 0n || BigInt(b.max_price_per_unit) >= 1n << 128n) throw new Error('FEE_INVALID');
    result += BigInt(b.max_amount) * BigInt(b.max_price_per_unit);
  }
  if (result <= 0n || result >= 1n << 256n) throw new Error('FEE_LIMIT');
  return result;
}
function details(address: string, nonce: any, resourceBounds: any) {
  return { walletAddress: address, cairoVersion: '1', chainId: CHAIN, version: '0x3', nonce,
    resourceBounds, tip: 0, paymasterData: [], accountDeploymentData: [], nonceDataAvailabilityMode: 'L1', feeDataAvailabilityMode: 'L1', skipValidate: false } as any;
}
async function preflight() {
  await chain(); const built = await artifacts();
  const kms = await readPrivateJson(join(ROOT, 'kms-config/live-check.input.json')) as any;
  const signer = new KmsK1Signer({} as any, { ...kms, accountAddress: '0x1', classHash: built.classHash,
    maxFeeFri: 5n * STRK, approve: async () => false });
  const constructorCalldata = signer.constructorCalldata();
  const account = hash.calculateContractAddressFromHash(SALT, built.classHash, constructorCalldata, 0);
  let declared = false;
  try { const cls = await rpc('starknet_getClass', { block_id: 'latest', class_hash: built.classHash });
    if (canonicalClassHash(cls) !== built.classHash) throw new Error('CLASS_MISMATCH'); declared = true;
  } catch (error) { if (!(error instanceof RpcFailure && error.code === 28)) throw error; }
  try { await rpc('starknet_getClassHashAt', { block_id: 'latest', contract_address: account }); throw new Error('ACCOUNT_ALREADY_EXISTS_REVIEW_REQUIRED'); }
  catch (error) { if (!(error instanceof RpcFailure && error.code === 20)) throw error; }
  const relayerNonce = await rpc('starknet_getNonce', { block_id: 'latest', contract_address: RELAYER });
  const relayerClass = await rpc('starknet_getClassHashAt', { block_id: 'latest', contract_address: RELAYER });
  const ping = await rpc('starknet_call', { block_id: 'latest', request: { contract_address: PING_TARGET, entry_point_selector: hash.getSelectorFromName('count'), calldata: [] } });
  const plan = { schema: 'kamui.kms-sepolia-live.v1', classHash: built.classHash, compiledClassHash: built.compiledClassHash,
    sourceSha256: built.sourceSha256, casmSha256: built.casmSha256, starknetVersion: built.starknetVersion,
    account, salt: SALT, constructorCalldata, declared, relayer: RELAYER, relayerNonce, relayerClass,
    relayerBalanceFri: String(await balance(RELAYER)), adminBalanceFri: String(await balance(account)), pingCountBefore: ping[0] };
  await writeExclusive(DIR, 'manifest.json', plan); console.log(JSON.stringify(plan));
}
async function estimateBootstrap(kind: 'declare' | 'fund') {
  await chain(); const { plan, current } = await manifest(); const account = await payer(); const nonce = await account.getNonce('latest');
  config.set('resourceBoundsOverhead', Object.fromEntries(['l1_gas', 'l2_gas', 'l1_data_gas'].map(k => [k, { max_amount: 15, max_price_per_unit: 15 }])) as any);
  const principal = kind === 'fund' ? BigInt(process.env.KAMUI_FUNDING_FRI || '0') : 0n;
  if (kind === 'fund' && (principal <= 0n || principal > 5n * STRK)) throw new Error('PRINCIPAL_LIMIT');
  const calls = kind === 'fund' ? [{ contractAddress: TOKEN, entrypoint: 'transfer', calldata: CallData.compile({ recipient: plan.account, amount: { low: principal, high: 0n } }) }] : [];
  const payload = { contract: current.contract, casm: current.casm, classHash: plan.classHash, compiledClassHash: plan.compiledClassHash };
  const estimate = kind === 'declare' ? await account.estimateDeclareFee(payload, { nonce, skipValidate: false, tip: 0 }) : await account.estimateInvokeFee(calls, { nonce, skipValidate: false, tip: 0 });
  const d = details(RELAYER, nonce, estimate.resourceBounds);
  const rawMaximum = Object.values(estimate.resourceBounds).reduce((sum: bigint, b: any) => sum + BigInt(b.max_amount) * BigInt(b.max_price_per_unit), 0n);
  console.log(JSON.stringify({ kind, estimateFeeFri: String(estimate.overall_fee), estimatedMaximumFeeFri: String(rawMaximum), bounds: Object.fromEntries(Object.entries(estimate.resourceBounds).map(([k,b]: any) => [k, {max_amount:String(b.max_amount), max_price_per_unit:String(b.max_price_per_unit)}])) }));
  const maximum = maxFee(d.resourceBounds);
  const signed = kind === 'declare' ? await account.buildDeclarePayload(payload, d) : await account.buildInvocation(calls, d);
  const method = kind === 'declare' ? 'starknet_addDeclareTransaction' : 'starknet_addInvokeTransaction';
  const wire = await (provider.channel as any).buildTransaction({ type: kind === 'declare' ? 'DECLARE' : 'INVOKE', ...signed, ...d }, 'transaction');
  const txHash = kind === 'declare' ? hash.calculateDeclareTransactionHash({ ...d, classHash: plan.classHash,
    compiledClassHash: plan.compiledClassHash, senderAddress: RELAYER, nonceDataAvailabilityMode: 0, feeDataAvailabilityMode: 0 })
    : hash.calculateInvokeTransactionHash({ ...d, senderAddress: RELAYER, compiledCalldata: transaction.getExecuteCalldata(calls, '1'), nonceDataAvailabilityMode: 0, feeDataAvailabilityMode: 0 });
  const record = { kind, nonce: String(nonce), transactionHash: txHash, maximumFeeFri: String(maximum), principalFri: String(principal),
    estimateFeeFri: String(estimate.overall_fee), method, params: kind === 'declare' ? { declare_transaction: wire } : { invoke_transaction: wire } };
  await writeExclusive(DIR, kind + '-signed.json', record);
  console.log(JSON.stringify({ kind, nonce: String(nonce), transactionHash: txHash, maximumFeeFri: String(maximum), principalFri: String(principal), estimateFeeFri: String(estimate.overall_fee) }));
}
async function largePrivateJson(path: string): Promise<any> {
  const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 2 * 1024 * 1024) throw new Error('PRIVATE_FILE_INVALID');
    const data = Buffer.alloc(2 * 1024 * 1024 + 1); const read = await file.read(data, 0, data.length, 0);
    if (read.bytesRead > 2 * 1024 * 1024) throw new Error('PRIVATE_FILE_INVALID');
    return JSON.parse(data.subarray(0, read.bytesRead).toString('utf8'));
  } finally { await file.close(); }
}
async function sendBootstrap(kind: 'declare' | 'fund') {
  await chain(); const { plan } = await manifest(); const signed = await largePrivateJson(join(DIR, kind + '-signed.json')) as any;
  if (signed.kind !== kind || signed.maximumFeeFri === undefined || BigInt(signed.maximumFeeFri) >= 1n << 256n) throw new Error('SIGNED_ARTIFACT_INVALID');
  const wire = kind === 'declare' ? signed.params.declare_transaction : signed.params.invoke_transaction;
  if (BigInt(wire.sender_address) !== BigInt(RELAYER) || BigInt(wire.version) !== 3n || BigInt(wire.tip) !== 0n || maxFee(wire.resource_bounds) !== BigInt(signed.maximumFeeFri)) throw new Error('PAYLOAD_CHANGED');
  if (BigInt(await rpc('starknet_getClassHashAt', { block_id: 'latest', contract_address: RELAYER })) !== BigInt(plan.relayerClass)) throw new Error('PAYER_CLASS_CHANGED');
  if (BigInt(await rpc('starknet_getNonce', { block_id: 'latest', contract_address: RELAYER })) !== BigInt(signed.nonce)) throw new Error('PAYER_NONCE_CHANGED');
  if (kind === 'declare' && (BigInt(wire.compiled_class_hash) !== BigInt(plan.compiledClassHash) || canonicalClassHash(wire.contract_class) !== plan.classHash)) throw new Error('DECLARATION_CHANGED');
  if (kind === 'fund') {
    const principal = BigInt(signed.principalFri);
    if (principal <= 0n || principal > 5n * STRK) throw new Error('PRINCIPAL_LIMIT');
    const calls = [{ contractAddress: TOKEN, entrypoint: 'transfer', calldata: CallData.compile({ recipient: plan.account, amount: { low: principal, high: 0n } }) }];
    if (JSON.stringify(wire.calldata.map(hex)) !== JSON.stringify(transaction.getExecuteCalldata(calls, '1').map(hex))) throw new Error('FUNDING_CALL_CHANGED');
  }
  const common = { version: '0x3', nonce: wire.nonce, chainId: CHAIN, tip: wire.tip,
    resourceBounds: Object.fromEntries(Object.entries(wire.resource_bounds).map(([k, v]: any) => [k, { max_amount: BigInt(v.max_amount), max_price_per_unit: BigInt(v.max_price_per_unit) }])),
    accountDeploymentData: [], paymasterData: [], nonceDataAvailabilityMode: 0, feeDataAvailabilityMode: 0 } as any;
  if (wire.account_deployment_data.length || wire.paymaster_data.length || wire.nonce_data_availability_mode !== 'L1' || wire.fee_data_availability_mode !== 'L1') throw new Error('EXTENSION_FORBIDDEN');
  const recomputed = kind === 'declare' ? hash.calculateDeclareTransactionHash({ ...common, classHash: plan.classHash, compiledClassHash: plan.compiledClassHash, senderAddress: RELAYER }) : hash.calculateInvokeTransactionHash({ ...common, senderAddress: RELAYER, compiledCalldata: wire.calldata });
  if (BigInt(recomputed) !== BigInt(signed.transactionHash)) throw new Error('SIGNED_HASH_CHANGED');
  if (!Array.isArray(wire.signature) || wire.signature.length !== 2) throw new Error('PAYER_SIGNATURE_INVALID');
  if (await balance(RELAYER) < BigInt(signed.maximumFeeFri) + BigInt(signed.principalFri)) throw new Error('PAYER_BALANCE_TOO_LOW');
  const checked = await rpc('starknet_call', { block_id: 'latest', request: { contract_address: RELAYER, entry_point_selector: hash.getSelectorFromName('is_valid_signature'), calldata: [recomputed, hex(wire.signature.length), ...wire.signature].map(hex) } });
  if (BigInt(checked[0]) !== BigInt('0x56414c4944')) throw new Error('PAYER_SIGNATURE_INVALID');
  await reserveAttempt(JOURNAL, { kind, sender: RELAYER, nonce: String(BigInt(signed.nonce)), transactionHash: recomputed, maxFeeFri: signed.maximumFeeFri, principalFri: signed.principalFri });
  const result = await rpc(kind === 'declare' ? 'starknet_addDeclareTransaction' : 'starknet_addInvokeTransaction', signed.params);
  await writeExclusive(DIR, kind + '-submitted.json', result);
  if (BigInt(result.transaction_hash) !== BigInt(recomputed)) throw new Error('RETURNED_HASH_MISMATCH');
  console.log(JSON.stringify({ kind, transactionHash: recomputed, status: 'submitted' }));
}
async function receiptBootstrap(kind: 'declare' | 'fund') {
  await chain(); const signed = await largePrivateJson(join(DIR, kind + '-signed.json')) as any;
  const receipt = await rpc('starknet_getTransactionReceipt', { transaction_hash: signed.transactionHash });
  if (!['ACCEPTED_ON_L1', 'ACCEPTED_ON_L2'].includes(receipt.finality_status)) throw new Error('RECEIPT_PENDING');
  const block = await rpc('starknet_getBlockWithTxHashes', { block_id: { block_number: receipt.block_number } });
  if (block.block_hash !== receipt.block_hash || !block.transactions.some((v: string) => BigInt(v) === BigInt(signed.transactionHash)) || BigInt(receipt.transaction_hash) !== BigInt(signed.transactionHash)) throw new Error('RECEIPT_NOT_CANONICAL');
  if (receipt.actual_fee.unit !== 'FRI' || !['SUCCEEDED','REVERTED'].includes(receipt.execution_status)) throw new Error('WRONG_RECEIPT');
  await reconcileAttempt(JOURNAL, signed.transactionHash, receipt.execution_status === 'SUCCEEDED' ? 'confirmed-success' : 'confirmed-revert', String(BigInt(receipt.actual_fee.amount)), String(receipt.block_number));
  await writeExclusive(DIR, kind + '-receipt.json', receipt);
  console.log(JSON.stringify({ kind, transactionHash: signed.transactionHash, execution: receipt.execution_status, finality: receipt.finality_status, actualFeeFri: String(BigInt(receipt.actual_fee.amount)), block: receipt.block_number }));
}
async function estimateNative(kind: 'deploy' | 'ping') {
  await chain(); const { plan } = await manifest();
  const kms = await readPrivateJson(join(ROOT, 'kms-config/live-check.input.json')) as any;
  const calls = [{ contractAddress: PING_TARGET, entrypoint: 'ping', calldata: [] }];
  const signer = new KmsK1Signer(awsKmsPort(kms.region), { ...kms, accountAddress: plan.account,
    classHash: plan.classHash, maxFeeFri: 100n * STRK, approve: async review => {
      if (BigInt(review.details.version) !== (1n << 128n) + 3n || review.account !== plan.account) return false;
      if (kind === 'deploy' && review.kind !== 'deploy') return false;
      if (kind === 'ping' && (review.kind !== 'invoke' || JSON.stringify(review.calls) !== JSON.stringify(calls))) return false;
      await writeExclusive(DIR, `${kind}-query-review-${Date.now()}.json`, JSON.parse(JSON.stringify(review, (_k,v) => typeof v === 'bigint' ? String(v) : v)));
      return true;
    } });
  const account = new Account({ provider, address: plan.account, signer, cairoVersion: '1' });
  config.set('resourceBoundsOverhead', Object.fromEntries(['l1_gas', 'l2_gas', 'l1_data_gas'].map(k => [k, { max_amount: 15, max_price_per_unit: 15 }])) as any);
  const nonce = kind === 'deploy' ? '0' : await account.getNonce('latest');
  const payload = { classHash: plan.classHash, addressSalt: plan.salt, constructorCalldata: plan.constructorCalldata, contractAddress: plan.account };
  const estimate = kind === 'deploy' ? await account.estimateAccountDeployFee(payload, { nonce, skipValidate: false, tip: 0 })
    : await account.estimateInvokeFee(calls, { nonce, skipValidate: false, tip: 0 });
  const resourceBounds = Object.fromEntries(Object.entries(estimate.resourceBounds).map(([k,v]: any) => [k, { max_amount: String(v.max_amount), max_price_per_unit: String(v.max_price_per_unit) }]));
  const common = { chainId: CHAIN, version: '0x3', nonce: String(BigInt(nonce)), tip: '0', resourceBounds,
    paymasterData: [], accountDeploymentData: [], nonceDataAvailabilityMode: 'L1', feeDataAvailabilityMode: 'L1' };
  const input = parseOperatorInput({ schema: 'kamui.kms-operator.v1', ...kms, accountAddress: plan.account, classHash: plan.classHash,
    maxFeeFri: String(maxFee(resourceBounds)), rpcUrl: RPC,
    transaction: kind === 'deploy' ? { kind: 'deploy', details: { ...common, ...payload } }
      : { kind: 'invoke', calls, details: { ...common, walletAddress: plan.account, cairoVersion: '1' } } });
  await writeExclusive(DIR, `${kind}-input.json`, input);
  console.log(JSON.stringify({ kind, nonce: common.nonce, maximumFeeFri: input.maxFeeFri, estimateFeeFri: String(estimate.overall_fee) }));
}
async function verifyNative() {
  await chain(); const { plan } = await manifest();
  const block = await rpc('starknet_getBlockWithTxHashes', { block_id: 'latest' });
  if (!['ACCEPTED_ON_L1', 'ACCEPTED_ON_L2'].includes(block.status)) throw new Error('BLOCK_NOT_ACCEPTED');
  const block_id = { block_hash: block.block_hash };
  const call = (address: string, entrypoint: string, calldata: string[] = []) => rpc('starknet_call', { block_id,
    request: { contract_address: address, entry_point_selector: hash.getSelectorFromName(entrypoint), calldata: calldata.map(hex) } });
  if (BigInt(await rpc('starknet_getClassHashAt', { block_id, contract_address: plan.account })) !== BigInt(plan.classHash)) throw new Error('CLASS_MISMATCH');
  const publicLimbs = await call(plan.account, 'get_public_key');
  if (JSON.stringify(publicLimbs.map(hex)) !== JSON.stringify(plan.constructorCalldata.map(hex))) throw new Error('PUBLIC_KEY_MISMATCH');
  const probe = await readPrivateJson(join(ROOT, 'kms-live-attempt-1/result.json')) as any;
  const vector = await Bun.file(join(import.meta.dir, 'public-vector.json')).json();
  if (vector.publicKey === probe.publicKey) throw new Error('NEGATIVE_KEY_NOT_DISTINCT');
  const check = async (digest: string, signature: string[]) => BigInt((await call(plan.account, 'is_valid_signature', [digest, hex(signature.length), ...signature]))[0]);
  const positive = await check(probe.challenge.digest, probe.signature);
  const changed = await check(hex(BigInt(probe.challenge.digest) ^ 1n), probe.signature);
  const different = await check(vector.digest, vector.felts);
  if (positive !== BigInt('0x56414c4944') || changed !== 0n || different !== 0n) throw new Error('SIGNATURE_CHECK_FAILED');
  const nonce = await rpc('starknet_getNonce', { block_id, contract_address: plan.account });
  const ping = BigInt((await call(PING_TARGET, 'count'))[0]);
  if (BigInt(nonce) !== 2n || ping !== BigInt(plan.pingCountBefore) + 1n) throw new Error('POST_STATE_UNEXPECTED');
  const tokenBalance = async (address: string) => { const v = await call(TOKEN, 'balance_of', [address]); return BigInt(v[0]) + (BigInt(v[1]) << 128n); };
  const adminBalance = await tokenBalance(plan.account), relayerBalance = await tokenBalance(RELAYER);
  const journal = await inspectBudget(JOURNAL);
  if (journal.attempts.length !== 4 || journal.attempts.some(a => a.status !== 'confirmed-success')) throw new Error('ATTEMPTS_NOT_RECONCILED');
  let total = 0n, adminFees = 0n, payerFees = 0n, funded = 0n;
  const receipts = [];
  for (const attempt of journal.attempts) {
    const receipt = await rpc('starknet_getTransactionReceipt', { transaction_hash: attempt.transactionHash });
    const canonical = await rpc('starknet_getBlockWithTxHashes', { block_id: { block_number: receipt.block_number } });
    if (receipt.execution_status !== 'SUCCEEDED' || !['ACCEPTED_ON_L1','ACCEPTED_ON_L2'].includes(receipt.finality_status)
      || receipt.block_hash !== canonical.block_hash || !canonical.transactions.includes(receipt.transaction_hash)
      || BigInt(receipt.transaction_hash) !== BigInt(attempt.transactionHash) || receipt.actual_fee.unit !== 'FRI'
      || BigInt(receipt.actual_fee.amount) !== BigInt(attempt.actualFeeFri!)) throw new Error('RECEIPT_NOT_CANONICAL');
    const fee = BigInt(receipt.actual_fee.amount); total += fee;
    if (BigInt(attempt.sender) === BigInt(plan.account)) adminFees += fee; else payerFees += fee;
    funded += BigInt(attempt.principalFri);
    receipts.push({ kind: attempt.kind, transactionHash: attempt.transactionHash, blockNumber: receipt.block_number,
      blockHash: receipt.block_hash, execution: receipt.execution_status, finality: receipt.finality_status,
      maximumFeeFri: attempt.maxFeeFri, actualFeeFri: String(fee), principalFri: attempt.principalFri });
  }
  if (BigInt(plan.adminBalanceFri) + funded - adminFees !== adminBalance
    || BigInt(plan.relayerBalanceFri) - funded - payerFees !== relayerBalance) throw new Error('BALANCE_DELTA_MISMATCH');
  const result = { schema: 'kamui.kms-sepolia-acceptance.v1', date: '2026-11-12', chainId: CHAIN,
    classHash: plan.classHash, compiledClassHash: plan.compiledClassHash, account: plan.account,
    sourceSha256: plan.sourceSha256, casmSha256: plan.casmSha256, starknetVersion: plan.starknetVersion,
    publicKey: probe.publicKey, constructorCalldata: publicLimbs.map(hex), blockNumber: block.block_number, blockHash: block.block_hash,
    queryEstimationValidated: { deploy: true, ping: true }, signatureChecks: { original: true, changedDigestRejected: true, differentKeyRejected: true },
    nonce: String(BigInt(nonce)), pingCountBefore: String(BigInt(plan.pingCountBefore)), pingCountAfter: String(ping),
    totalActualFeeFri: String(total), fundingPrincipalFri: String(funded), adminBalanceFri: String(adminBalance), relayerBalanceFri: String(relayerBalance),
    balanceDeltasMatched: true, registryRolesTransferred: false, receipts };
  await writeExclusive(DIR, 'verified.json', result); console.log(JSON.stringify(result));
}
async function main() {
  const command = process.argv[2]; stage = command || 'start'; await privateDirectory(DIR);
  if (command === 'estimate-deploy' || command === 'estimate-ping') return estimateNative(command === 'estimate-deploy' ? 'deploy' : 'ping');
  if (command === 'verify') return verifyNative();
  if (command === 'preflight') return preflight();
  if (command === 'init-budget') { await initializeBudget(JOURNAL, true); console.log('BUDGET_INITIALIZED'); return; }
  if (command === 'budget') { console.log(JSON.stringify(await inspectBudget(JOURNAL))); return; }
  if (command === 'estimate-declare' || command === 'estimate-fund') return estimateBootstrap(command === 'estimate-declare' ? 'declare' : 'fund');
  if (command === 'send-declare' || command === 'send-fund') return sendBootstrap(command === 'send-declare' ? 'declare' : 'fund');
  if (command === 'receipt-declare' || command === 'receipt-fund') return receiptBootstrap(command === 'receipt-declare' ? 'declare' : 'fund');
  throw new Error('COMMAND_NOT_SUPPORTED');
}
if (import.meta.main) main().catch(error => { console.error(JSON.stringify({ status: 'failed', stage, code: error instanceof RpcFailure ? `RPC_${error.code}` : /^[A-Z_]+$/.test(error?.message || '') ? error.message : 'LIVE_PHASE_FAILED' })); process.exitCode = 1; });
