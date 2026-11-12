// One recovery state machine for SQLite and PostgreSQL. Storage failures leave admission
// locked: a failed journal write is never permission to broadcast or repeat a payment.
import type { RpcProvider } from 'starknet';
import { metrics } from '../../metrics';
import { log } from '../../log';
import { ConfirmedTransactionReverted } from './transaction';
import type { RecoverResult } from './recover';
import type { RecoveryJournal, RecoveryStatus, TransactionIntent } from './jobs';

export type Awaitable<T> = T | Promise<T>;
export type RecoveryRow = { id: string; fingerprint: string; account: string; state: string; finished_at: number | null; intent: string | null };
export interface RecoveryPersistence {
  row(key: string): Awaitable<RecoveryRow | null>;
  unfinished(): Awaitable<RecoveryRow[]>;
  finish(key: string, state: RecoveryStatus, now: number): Awaitable<boolean>;
  setIntent(key: string, intent: TransactionIntent): Awaitable<void>;
  clearIntent(key: string): Awaitable<void>;
  markReconciling(row: RecoveryRow, hash: string): Awaitable<boolean>;
  finishExpected(row: RecoveryRow, state: RecoveryStatus, now: number): Awaitable<boolean>;
}
export type RecoveryWork = (journal?: RecoveryJournal) => Promise<RecoverResult>;
export type RecoveryFailure = (error: unknown) => { status: number; error: string };

export class RecoveryJobRunner {
  readonly active = new Set<string>();
  private reconciling = new Set<string>();
  private pendingAdmissions = new Map<string, number>();
  reserve(key: string): () => void {
    this.pendingAdmissions.set(key, (this.pendingAdmissions.get(key) ?? 0) + 1);
    return () => {
      const remaining = (this.pendingAdmissions.get(key) ?? 1) - 1;
      if (remaining) this.pendingAdmissions.set(key, remaining); else this.pendingAdmissions.delete(key);
    };
  }
  constructor(private store: RecoveryPersistence, private durable: boolean, private now: () => number) {}

  start(key: string, work: RecoveryWork, failure: RecoveryFailure): void {
    this.active.add(key);
    metrics.recoveryJobs.inc({ result: 'accepted' });
    const journal: RecoveryJournal = {
      beforeSend: (intent) => this.store.setIntent(key, intent),
      deploymentConfirmed: () => this.store.clearIntent(key),
    };
    void Promise.resolve().then(() => work(this.durable ? journal : undefined)).then(
      async (result) => {
        if (await this.store.finish(key, { status: 'succeeded', result }, this.now())) metrics.recoveryJobs.inc({ result: 'succeeded' });
      },
      async (error) => {
        const row = await this.store.row(key);
        if (!row || row.finished_at !== null) return;
        const intent = row.intent;
        if (intent && error instanceof ConfirmedTransactionReverted && BigInt(error.transactionHash) === BigInt((JSON.parse(intent) as TransactionIntent).transaction_hash)) {
          if (await this.store.finish(key, { status: 'failed', error: 'RECOVERY_REVERTED', httpStatus: 400, transaction_hash: error.transactionHash }, this.now())) metrics.recoveryJobs.inc({ result: 'failed' });
        } else if (intent) {
          // Missing/timeout/rejection does not prove that this hash was never accepted.
          await this.store.markReconciling(row, (JSON.parse(intent) as TransactionIntent).transaction_hash);
        } else {
          const described = failure(error);
          if (await this.store.finish(key, { status: 'failed', error: described.error, httpStatus: described.status }, this.now())) metrics.recoveryJobs.inc({ result: 'failed' });
        }
      },
    ).catch(() => {
      // No payload/error text: a driver error may contain connection credentials or values.
      log('error', 'recovery_journal_write_failed');
    }).finally(() => { this.active.delete(key); });
  }

  /** Reconcile only orphaned tasks. Never broadcast, re-prove or trust an owner claim. */
  async reconcile(provider: Pick<RpcProvider, 'getTransactionReceipt'>, key?: string): Promise<void> {
    const single = key === undefined ? null : await this.store.row(key);
    const rows = key === undefined ? await this.store.unfinished() : single && single.finished_at === null ? [single] : [];
    await Promise.all(rows.map(async (row) => {
      if (this.active.has(row.id) || this.pendingAdmissions.has(row.id) || this.reconciling.has(row.id)) return;
      this.reconciling.add(row.id);
      try {
        if (!row.intent) {
          await this.store.finishExpected(row, { status: 'failed', error: 'RECOVERY_INTERRUPTED', httpStatus: 409 }, this.now());
          return;
        }
        const intent = JSON.parse(row.intent) as TransactionIntent;
        if (!await this.store.markReconciling(row, intent.transaction_hash)) return;
        let receipt;
        try { receipt = await provider.getTransactionReceipt(intent.transaction_hash); }
        catch { return; }
        if (!('finality_status' in receipt) || !['ACCEPTED_ON_L2', 'ACCEPTED_ON_L1'].includes(receipt.finality_status)) return;
        if ('execution_status' in receipt && receipt.execution_status === 'SUCCEEDED') {
          if (intent.kind === 'recover' || intent.kind === 'prepare') {
            const result = { address: intent.address, identity: intent.identity, transaction_hash: intent.transaction_hash };
            await this.store.finishExpected(row, { status: 'succeeded', result }, this.now());
          } else {
            await this.store.finishExpected(row, { status: 'failed', error: 'RECOVERY_INTERRUPTED', httpStatus: 409, transaction_hash: intent.transaction_hash }, this.now());
          }
        } else if ('execution_status' in receipt && receipt.execution_status === 'REVERTED') {
          await this.store.finishExpected(row, { status: 'failed', error: 'RECOVERY_REVERTED', httpStatus: 400, transaction_hash: intent.transaction_hash }, this.now());
        }
      } finally { this.reconciling.delete(row.id); }
    }));
  }

  /** API must be stopped before operator resolution. Compare-and-swap still protects stale snapshots. */
  async resolveSuperseded(originalHash: string, replacementHash: string, provider: Pick<RpcProvider, 'getTransactionReceipt' | 'getTransactionByHash'>): Promise<void> {
    if (BigInt(originalHash) === BigInt(replacementHash)) throw new Error('REPLACEMENT_MUST_DIFFER');
    const row = (await this.store.unfinished()).find((row) => row.intent && BigInt((JSON.parse(row.intent) as TransactionIntent).transaction_hash) === BigInt(originalHash));
    if (!row) throw new Error('RECOVERY_INTENT_NOT_FOUND');
    if (this.active.has(row.id)) throw new Error('RECOVERY_STILL_ACTIVE');
    const intent = JSON.parse(row.intent!) as TransactionIntent;
    if (!intent.sender_address || intent.nonce === undefined) throw new Error('RECOVERY_INTENT_MISSING_NONCE');
    const [receipt, transaction] = await Promise.all([provider.getTransactionReceipt(replacementHash), provider.getTransactionByHash(replacementHash)]);
    if (!('finality_status' in receipt) || receipt.finality_status !== 'ACCEPTED_ON_L1') throw new Error('REPLACEMENT_NOT_FINAL');
    if (!('sender_address' in transaction) || !('nonce' in transaction) || BigInt(transaction.sender_address) !== BigInt(intent.sender_address) || BigInt(transaction.nonce) !== BigInt(intent.nonce)) throw new Error('REPLACEMENT_NONCE_MISMATCH');
    if (!await this.store.finishExpected(row, { status: 'failed', error: 'RECOVERY_SUPERSEDED', httpStatus: 409, transaction_hash: originalHash }, this.now())) throw new Error('RECOVERY_INTENT_CHANGED');
  }
}
