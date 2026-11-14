// Durable recovery metadata, not a secret/proof queue. JWTs, peppers, signatures and proofs
// never enter durable storage. Only a hash of the random job capability is stored.
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RpcProvider } from 'starknet';
import { HttpError } from '../../http';
import { metrics } from '../../metrics';
import { isNetworkVolume, type VolumeProbe } from '../../storage/volume';
import { RecoveryJobRunner, type RecoveryPersistence, type RecoveryRow as Row, type Awaitable, type RecoveryWork, type RecoveryFailure } from './job-runner';
import type { RecoverRequest, RecoverResult } from './recover';

export type RecoveryStatus =
  | { status: 'running'; phase?: 'reconciling'; transaction_hash?: string }
  | { status: 'succeeded'; result: RecoverResult }
  | { status: 'failed'; error: string; httpStatus: number; transaction_hash?: string };
export type TransactionIntent = RecoverResult & { kind: 'deploy' | 'recover' | 'prepare'; sender_address?: string; nonce?: string };
export type RecoveryJournal = { beforeSend(intent: TransactionIntent): Awaitable<void>; deploymentConfirmed(): Awaitable<void> };
export type RecoveryJobOptions = { binding?: string; maxActive?: number; maxRetained?: number; retentionMs?: number; now?: () => number };
export interface RecoveryJobsService {
  readonly durable: boolean;
  hasSubmission(id: string, request: JobRequest): Awaitable<boolean>;
  submit(id: string, request: JobRequest, work: RecoveryWork, failure: RecoveryFailure): Awaitable<void>;
  status(id: string): Awaitable<RecoveryStatus>;
  assertAccountAvailable(account: string): Awaitable<void>;
  reconcile(provider: Pick<RpcProvider, 'getTransactionReceipt'>, id?: string): Promise<void>;
  resolveSuperseded(originalHash: string, replacementHash: string, provider: Pick<RpcProvider, 'getTransactionReceipt' | 'getTransactionByHash'>): Promise<void>;
  close(): Awaitable<void>;
}
export const recoveryDbPath = () => process.env.RECOVERY_DB || join(dirname(process.env.REGISTRY_DB || `${import.meta.dir}/../../../data/registry.sqlite`), 'recovery.sqlite');
export const JOB_ID = /^0x[0-9a-f]{62}$/;
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export type JobRequest = RecoverRequest | { account: string; operation: 'relay' | 'deployment'; payload: unknown };
export const fingerprintOf = (r: JobRequest) => digest(JSON.stringify('operation' in r ? [r.operation, r.account, r.payload] : [r.jwt, r.account, r.newPubkey, r.blinding, r.pepper, r.signature, r.keyProof, r.override ?? false]));

export class RecoveryJobs {
  private db: Database;
  private runner: RecoveryJobRunner;
  readonly durable: boolean;
  constructor(private options: { path?: string; journalMode?: string; isNetworkVolume?: VolumeProbe; binding?: string; maxActive?: number; maxRetained?: number; retentionMs?: number; now?: () => number } = {}) {
    const path = options.path ?? ':memory:';
    this.durable = path !== ':memory:';
    const mode = (options.journalMode ?? 'DELETE').toUpperCase();
    if (!['DELETE', 'TRUNCATE', 'WAL'].includes(mode)) throw new Error('RECOVERY_JOURNAL_MODE_INVALID');
    if (this.durable) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // WAL needs shared memory a network volume (NFS, EFS) does not give: see storage/volume.ts.
    if (this.durable && mode === 'WAL' && (options.isNetworkVolume ?? isNetworkVolume)(dirname(path))) throw new Error('RECOVERY_JOURNAL_MODE_NETWORK_VOLUME');
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
    const persistence: RecoveryPersistence = {
      row: (key) => this.row(key),
      unfinished: () => this.db.query('SELECT * FROM recovery_jobs WHERE finished_at IS NULL').all() as Row[],
      finish: (key, state, now) => this.db.query('UPDATE recovery_jobs SET state = ?, finished_at = ?, intent = NULL WHERE id = ? AND finished_at IS NULL').run(JSON.stringify(state), now, key).changes === 1,
      setIntent: (key, intent) => {
        if (this.db.query('UPDATE recovery_jobs SET intent = ? WHERE id = ? AND finished_at IS NULL AND intent IS NULL').run(JSON.stringify(intent), key).changes !== 1) throw new Error('RECOVERY_INTENT_CHANGED');
      },
      clearIntent: (key) => {
        if (this.db.query('UPDATE recovery_jobs SET intent = NULL WHERE id = ? AND finished_at IS NULL AND intent IS NOT NULL').run(key).changes !== 1) throw new Error('RECOVERY_INTENT_CHANGED');
      },
      markReconciling: (row, hash) => this.db.query('UPDATE recovery_jobs SET state = ? WHERE id = ? AND finished_at IS NULL AND intent = ?').run(JSON.stringify({ status: 'running', phase: 'reconciling', transaction_hash: hash }), row.id, row.intent).changes === 1,
      finishExpected: (row, state, now) => this.db.query('UPDATE recovery_jobs SET state = ?, finished_at = ?, intent = NULL WHERE id = ? AND fingerprint = ? AND account = ? AND finished_at IS NULL AND intent IS ?').run(JSON.stringify(state), now, row.id, row.fingerprint, row.account, row.intent).changes === 1,
    };
    this.runner = new RecoveryJobRunner(persistence, this.durable, () => this.now());
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


  /** Read-only guard for legacy routes; it does not reserve a browser-proof job. */
  assertAccountAvailable(account: string): void {
    if (this.db.query('SELECT 1 FROM recovery_jobs WHERE account = ? AND finished_at IS NULL').get(BigInt(account).toString(16))) throw new HttpError(409, 'IN_PROGRESS');
  }

  /** Retry checks happen before authentication/chain reads, including after token expiry. */
  hasSubmission(id: string, request: JobRequest): boolean {
    this.prune();
    const row = this.row(this.key(id));
    if (!row) return false;
    if (row.fingerprint !== fingerprintOf(request)) throw new HttpError(409, 'JOB_CONFLICT');
    return true;
  }

  submit(id: string, request: JobRequest, work: (journal?: RecoveryJournal) => Promise<RecoverResult>, failure: (e: unknown) => { status: number; error: string }): void {
    const key = this.key(id);
    this.prune();
    const fingerprint = fingerprintOf(request);
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
    this.runner.start(key, work, failure);
  }

  async reconcile(provider: Pick<RpcProvider, 'getTransactionReceipt'>, id?: string): Promise<void> {
    await this.runner.reconcile(provider, id === undefined ? undefined : this.key(id));
  }

  async resolveSuperseded(originalHash: string, replacementHash: string, provider: Pick<RpcProvider, 'getTransactionReceipt' | 'getTransactionByHash'>): Promise<void> {
    await this.runner.resolveSuperseded(originalHash, replacementHash, provider);
  }

  status(id: string): RecoveryStatus {
    const key = this.key(id);
    this.prune();
    const row = this.row(key);
    if (!row) throw new HttpError(404, 'RECOVERY_JOB_NOT_FOUND');
    return JSON.parse(row.state);
  }
}
