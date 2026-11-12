// Keep signed payloads in memory only. Journal their deterministic hash before broadcasting,
// so a lost response can be reconciled without persisting a proof or signing a second tx.
import { HttpError } from '../../http';
import { hash, stark, type Account, type Call, type RpcProvider } from 'starknet';
import type { RecoveryJournal } from './jobs';
import type { RecoverResult } from './recover';

export class ConfirmedTransactionReverted extends HttpError {
  constructor(readonly transactionHash: string) { super(400, 'RECOVERY_REVERTED'); }
}

/** Acceptance and execution are separate: an accepted transaction may have reverted. */
export async function waitForAcceptedTransaction(provider: Pick<RpcProvider, 'waitForTransaction'>, transactionHash: string): Promise<void> {
  const receipt = await provider.waitForTransaction(transactionHash);
  const accepted = 'finality_status' in receipt && ['ACCEPTED_ON_L2', 'ACCEPTED_ON_L1'].includes(receipt.finality_status);
  if (accepted && 'execution_status' in receipt && receipt.execution_status === 'REVERTED') throw new ConfirmedTransactionReverted(transactionHash);
  if (!accepted || !('execution_status' in receipt) || receipt.execution_status !== 'SUCCEEDED') throw new HttpError(503, 'TRANSACTION_NOT_ACCEPTED');
}

const relayerLocks = new WeakMap<Account, Promise<void>>();
export async function withRelayerLock<T>(relayer: Account, work: () => Promise<T>): Promise<T> {
  const previous = relayerLocks.get(relayer) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  relayerLocks.set(relayer, tail);
  await previous;
  try { return await work(); } finally { release(); if (relayerLocks.get(relayer) === tail) relayerLocks.delete(relayer); }
}

type Signed = Awaited<ReturnType<Account['getSignedTransaction']>>;
export function signedTransactionHash(tx: Signed, chainId: string): string {
  return hash.calculateInvokeTransactionHash({
    senderAddress: tx.sender_address, version: tx.version,
    compiledCalldata: tx.calldata, chainId: chainId as Parameters<typeof hash.calculateInvokeTransactionHash>[0]['chainId'], nonce: tx.nonce,
    accountDeploymentData: tx.account_deployment_data,
    nonceDataAvailabilityMode: stark.intDAM(tx.nonce_data_availability_mode),
    feeDataAvailabilityMode: stark.intDAM(tx.fee_data_availability_mode),
    resourceBounds: Object.fromEntries(Object.entries(tx.resource_bounds).map(([key, bound]) => [key, { max_amount: BigInt(bound.max_amount), max_price_per_unit: BigInt(bound.max_price_per_unit) }])) as Parameters<typeof hash.calculateInvokeTransactionHash>[0]['resourceBounds'], tip: tx.tip, paymasterData: tx.paymaster_data,
    proofFacts: 'proof_facts' in tx ? tx.proof_facts as string[] : undefined,
  });
}

export async function journaledTransaction(
  ctx: { relayer: Account; provider: RpcProvider },
  call: Call,
  details: Parameters<Account['getSignedTransaction']>[1],
  journal: RecoveryJournal,
  kind: 'deploy' | 'recover' | 'prepare',
  result: Omit<RecoverResult, 'transaction_hash'>,
): Promise<string> {
  return withRelayerLock(ctx.relayer, async () => {
  const signed = await ctx.relayer.getSignedTransaction(call, details);
  const transaction_hash = signedTransactionHash(signed, await ctx.provider.getChainId());
  journal.beforeSend({ kind, ...result, transaction_hash, sender_address: signed.sender_address, nonce: signed.nonce });
  const response = await ctx.provider.invokeSignedTx(signed);
  if (!('transaction_hash' in response) || BigInt(response.transaction_hash) !== BigInt(transaction_hash)) throw new Error('TRANSACTION_HASH_MISMATCH');
  return transaction_hash;
  });
}
