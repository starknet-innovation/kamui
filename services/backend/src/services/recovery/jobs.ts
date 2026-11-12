// Durable recovery metadata, not a secret/proof queue. JWTs, peppers, signatures and proofs
// never enter SQLite. Only a hash of the random job capability is stored.
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RpcProvider } from 'starknet';
import { HttpError } from '../../http';
import { metrics } from '../../metrics';
import { ConfirmedTransactionReverted } from './transaction';
import type { RecoverRequest, RecoverResult } from './recover';

export type RecoveryStatus =
  | { status: 'running'; phase?: 'reconciling'; transaction_hash?: string }
  | { status: 'succeeded'; result: RecoverResult }
  | { status: 'failed'; error: string; httpStatus: number; transaction_hash?: string };
export type TransactionIntent = RecoverResult & { kind: 'deploy' | 'recover'; sender_address?: string; nonce?: string };
export type RecoveryJournal = { beforeSend(intent: TransactionIntent): void; deploymentConfirmed(): void };
type Row = { id: string; fingerprint: string; account: string; state: string; finished_at: number | null; intent: string | null };
export const recoveryDbPath = () => process.env.RECOVERY_DB || join(dirname(process.env.REGISTRY_DB || `${import.meta.dir}/../../../data/registry.sqlite`), 'recovery.sqlite');
export const JOB_ID = /^0x[0-9a-f]{62}$/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class RecoveryJobs {
  private db: Database;
  private active = new Set<string>();
  private reconciling = new Set<string>();
  readonly durable: boolean;
  constructor(private options: { path?: string; journalMode?: string; binding?: string; maxActive?: number; maxRetained?: number; retentionMs?: number; now?: () => number } = {}) {
    const path = options.path ?? ':memory:';
    this.durable = path !== ':memory:';
    const mode = (options.journalMode ?? 'DELETE').toUpperCase();
    if (!['DELETE', 'TRUNCATE', 'WAL'].includes(mode)) throw new Error('RECOVERY_JOURNAL_MODE_INVALID');
    if (this.durable) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    if (this.durable) chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode = ${mode}`);
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS recovery_jobs (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, account TEXT NOT NULL,
      state TEXT NOT NULL, finished_at INTEGER, intent TEXT
    )`);
    this.db.exec('CREATE TABLE IF NOT EXISTS recovery_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    if (options.binding) {
      const binding = this.db.query("SELECT value FROM recovery_meta WHERE key = 'binding'").get() as { value: string } | null;
      if (binding && binding.value !== options.binding) { this.db.close(); throw new Error('RECOVERY_DB_NETWORK_MISMATCH'); }
      this.db.query("INSERT OR IGNORE INTO recovery_meta (key, value) VALUES ('binding', ?)").run(options.binding);
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS recovery_active_account ON recovery_jobs(account) WHERE finished_at IS NULL');
  }
  close() { this.db.close(); }
  private now() { return (this.options.now ?? Date.now)(); }
  private prune() {
    this.db.query('DELETE FROM recovery_jobs WHERE finished_at <= ?').run(this.now() - (this.options.retentionMs ?? 30 * 60_000));
  }
  private key(id: string) {
    if (!JOB_ID.test(id)) throw new HttpError(400, 'BAD_JOB_ID');
    return digest(id);
  }
  private row(key: string) { return this.db.query('SELECT * FROM recovery_jobs WHERE id = ?').get(key) as Row | null; }
  private finish(key: string, state: RecoveryStatus): boolean {
    return this.db.query('UPDATE recovery_jobs SET state = ?, finished_at = ?, intent = NULL WHERE id = ? AND finished_at IS NULL').run(JSON.stringify(state), this.now(), key).changes === 1;
  }

  /** Read-only guard for legacy routes; it does not reserve a browser-proof job. */
  assertAccountAvailable(account: string): void {
    if (this.db.query('SELECT 1 FROM recovery_jobs WHERE account = ? AND finished_at IS NULL').get(BigInt(account).toString(16))) throw new HttpError(409, 'IN_PROGRESS');
  }

  submit(id: string, request: RecoverRequest, work: (journal?: RecoveryJournal) => Promise<RecoverResult>, failure: (e: unknown) => { status: number; error: string }): void {
    const key = this.key(id);
    this.prune();
    const fingerprint = digest(JSON.stringify([request.jwt, request.account, request.newPubkey, request.blinding, request.pepper, request.signature, request.keyProof, request.override ?? false]));
    const existing = this.row(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new HttpError(409, 'JOB_CONFLICT');
      return;
    }
    const account = BigInt(request.account).toString(16);
    this.db.transaction(() => {
      const count = this.db.query('SELECT COUNT(*) AS total, SUM(finished_at IS NULL) AS active FROM recovery_jobs').get() as { total: number; active: number | null };
      if ((count.active ?? 0) >= (this.options.maxActive ?? 32) || count.total >= (this.options.maxRetained ?? 1000)) {
        metrics.recoveryJobs.inc({ result: 'refused' });
        throw new HttpError(503, 'RECOVERY_JOBS_FULL');
      }
      if (this.db.query('SELECT 1 FROM recovery_jobs WHERE account = ? AND finished_at IS NULL').get(account)) throw new HttpError(409, 'IN_PROGRESS');
      this.db.query('INSERT INTO recovery_jobs (id, fingerprint, account, state) VALUES (?, ?, ?, ?)').run(key, fingerprint, account, JSON.stringify({ status: 'running' }));
    })();
    this.active.add(key);
    metrics.recoveryJobs.inc({ result: 'accepted' });
    const journal: RecoveryJournal = {
      beforeSend: (intent) => {
        const changed = this.db.query('UPDATE recovery_jobs SET intent = ? WHERE id = ? AND finished_at IS NULL AND intent IS NULL').run(JSON.stringify(intent), key).changes;
        if (changed !== 1) throw new Error('RECOVERY_INTENT_CHANGED');
      },
      deploymentConfirmed: () => {
        const changed = this.db.query('UPDATE recovery_jobs SET intent = NULL WHERE id = ? AND finished_at IS NULL AND intent IS NOT NULL').run(key).changes;
        if (changed !== 1) throw new Error('RECOVERY_INTENT_CHANGED');
      },
    };
    void Promise.resolve().then(() => work(this.durable ? journal : undefined)).then(
      (result) => { if (this.finish(key, { status: 'succeeded', result })) metrics.recoveryJobs.inc({ result: 'succeeded' }); },
      (e) => {
        const current = this.row(key);
        if (!current || current.finished_at !== null) return;
        const described = failure(e);
        const intent = current.intent;
        if (intent && e instanceof ConfirmedTransactionReverted && BigInt(e.transactionHash) === BigInt((JSON.parse(intent) as TransactionIntent).transaction_hash)) {
          if (this.finish(key, { status: 'failed', error: 'RECOVERY_REVERTED', httpStatus: 400, transaction_hash: e.transactionHash })) metrics.recoveryJobs.inc({ result: 'failed' });
        } else if (intent) {
          // A timeout/rejection does not prove the node never accepted this exact hash.
          this.db.query('UPDATE recovery_jobs SET state = ? WHERE id = ? AND finished_at IS NULL AND intent = ?').run(JSON.stringify({ status: 'running', phase: 'reconciling', transaction_hash: JSON.parse(intent).transaction_hash }), key, intent);
        } else {
          if (this.finish(key, { status: 'failed', error: described.error, httpStatus: described.status })) metrics.recoveryJobs.inc({ result: 'failed' });
        }
      },
    ).finally(() => { this.active.delete(key); });
  }

  /** Reconcile only orphaned tasks. Never broadcast, re-prove or trust an owner claim. */
  async reconcile(provider: Pick<RpcProvider, 'getTransactionReceipt'>, id?: string): Promise<void> {
    const rows = id === undefined
      ? this.db.query('SELECT * FROM recovery_jobs WHERE finished_at IS NULL').all() as Row[]
      : [this.row(this.key(id))].filter((row): row is Row => row !== null && row.finished_at === null);
    await Promise.all(rows.map(async (row) => {
      if (this.active.has(row.id) || this.reconciling.has(row.id)) return;
      this.reconciling.add(row.id);
      try {
        if (!row.intent) {
          this.finish(row.id, { status: 'failed', error: 'RECOVERY_INTERRUPTED', httpStatus: 409 });
          return;
        }
        const intent = JSON.parse(row.intent) as TransactionIntent;
        const current = this.db.query('UPDATE recovery_jobs SET state = ? WHERE id = ? AND finished_at IS NULL AND intent = ?').run(JSON.stringify({ status: 'running', phase: 'reconciling', transaction_hash: intent.transaction_hash }), row.id, row.intent);
        if (current.changes !== 1) return;
        let receipt;
        try { receipt = await provider.getTransactionReceipt(intent.transaction_hash); }
        catch { return; } // Missing, pending or temporarily unavailable: keep the durable account lock.
        if (!('finality_status' in receipt) || !['ACCEPTED_ON_L2', 'ACCEPTED_ON_L1'].includes(receipt.finality_status)) return;
        if ('execution_status' in receipt && receipt.execution_status === 'SUCCEEDED') {
          if (intent.kind === 'recover') {
            const result = { address: intent.address, identity: intent.identity, transaction_hash: intent.transaction_hash };
            this.finish(row.id, { status: 'succeeded', result });
          } else {
            this.finish(row.id, { status: 'failed', error: 'RECOVERY_INTERRUPTED', httpStatus: 409, transaction_hash: intent.transaction_hash });
          }
        } else if ('execution_status' in receipt && receipt.execution_status === 'REVERTED') {
          this.finish(row.id, { status: 'failed', error: 'RECOVERY_REVERTED', httpStatus: 400, transaction_hash: intent.transaction_hash });
        }
      } finally { this.reconciling.delete(row.id); }
    }));
  }

  /** Operator-only resolution; no HTTP route. A finalized different transaction consuming the
   * exact sender/nonce proves this original hash can no longer enter the canonical chain. */
  async resolveSuperseded(originalHash: string, replacementHash: string, provider: Pick<RpcProvider, 'getTransactionReceipt' | 'getTransactionByHash'>): Promise<void> {
    if (BigInt(originalHash) === BigInt(replacementHash)) throw new Error('REPLACEMENT_MUST_DIFFER');
    const row = (this.db.query('SELECT * FROM recovery_jobs WHERE finished_at IS NULL AND intent IS NOT NULL').all() as Row[])
      .find((r) => BigInt((JSON.parse(r.intent!) as TransactionIntent).transaction_hash) === BigInt(originalHash));
    if (!row) throw new Error('RECOVERY_INTENT_NOT_FOUND');
    if (this.active.has(row.id)) throw new Error('RECOVERY_STILL_ACTIVE');
    const intent = JSON.parse(row.intent!) as TransactionIntent;
    if (!intent.sender_address || intent.nonce === undefined) throw new Error('RECOVERY_INTENT_MISSING_NONCE');
    const [receipt, transaction] = await Promise.all([provider.getTransactionReceipt(replacementHash), provider.getTransactionByHash(replacementHash)]);
    if (!('finality_status' in receipt) || receipt.finality_status !== 'ACCEPTED_ON_L1') throw new Error('REPLACEMENT_NOT_FINAL');
    if (!('sender_address' in transaction) || !('nonce' in transaction) || BigInt(transaction.sender_address) !== BigInt(intent.sender_address) || BigInt(transaction.nonce) !== BigInt(intent.nonce)) throw new Error('REPLACEMENT_NONCE_MISMATCH');
    this.db.transaction(() => {
      const current = this.row(row.id);
      if (!current || current.finished_at !== null || current.intent !== row.intent) throw new Error('RECOVERY_INTENT_CHANGED');
      this.finish(row.id, { status: 'failed', error: 'RECOVERY_SUPERSEDED', httpStatus: 409, transaction_hash: originalHash });
    })();
  }

  status(id: string): RecoveryStatus {
    const key = this.key(id);
    this.prune();
    const row = this.row(key);
    if (!row) throw new HttpError(404, 'RECOVERY_JOB_NOT_FOUND');
    return JSON.parse(row.state);
  }
}
