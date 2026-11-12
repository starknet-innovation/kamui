// Same metadata-only journal as SQLite. Byte-exact JSON is retained for migration/CAS.
import type { SQL } from 'bun';
import type { RpcProvider } from 'starknet';
import { HttpError } from '../../http';
import { metrics } from '../../metrics';
import { digest, fingerprintOf, JOB_ID, type JobRequest, type RecoveryJobOptions, type RecoveryJobsService, type RecoveryStatus } from './jobs';
import { RecoveryJobRunner, type RecoveryPersistence, type RecoveryRow, type RecoveryWork, type RecoveryFailure } from './job-runner';

export const RECOVERY_POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS recovery_jobs (
  id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, account TEXT NOT NULL,
  state TEXT NOT NULL, finished_at BIGINT, intent TEXT
);
CREATE TABLE IF NOT EXISTS recovery_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS recovery_active_account ON recovery_jobs(account) WHERE finished_at IS NULL;
`;
const rowValue = (row: RecoveryRow | undefined): RecoveryRow | null => row ? { ...row, finished_at: row.finished_at === null ? null : Number(row.finished_at) } : null;

export class PostgresRecoveryJobs implements RecoveryJobsService {
  readonly durable = true;
  private runner: RecoveryJobRunner;
  private constructor(private sql: SQL, private options: RecoveryJobOptions) {
    const store: RecoveryPersistence = {
      row: (key) => this.row(key),
      unfinished: async () => (await sql`SELECT * FROM recovery_jobs WHERE finished_at IS NULL`).map((row: RecoveryRow) => rowValue(row)!),
      finish: async (key, state, now) => (await sql`UPDATE recovery_jobs SET state = ${JSON.stringify(state)}, finished_at = ${now}, intent = NULL WHERE id = ${key} AND finished_at IS NULL RETURNING id`).length === 1,
      setIntent: async (key, intent) => {
        if ((await sql`UPDATE recovery_jobs SET intent = ${JSON.stringify(intent)} WHERE id = ${key} AND finished_at IS NULL AND intent IS NULL RETURNING id`).length !== 1) throw new Error('RECOVERY_INTENT_CHANGED');
      },
      clearIntent: async (key) => {
        if ((await sql`UPDATE recovery_jobs SET intent = NULL WHERE id = ${key} AND finished_at IS NULL AND intent IS NOT NULL RETURNING id`).length !== 1) throw new Error('RECOVERY_INTENT_CHANGED');
      },
      markReconciling: async (row, hash) => (await sql`UPDATE recovery_jobs SET state = ${JSON.stringify({ status: 'running', phase: 'reconciling', transaction_hash: hash })} WHERE id = ${row.id} AND finished_at IS NULL AND intent = ${row.intent} RETURNING id`).length === 1,
      finishExpected: async (row, state, now) => (await sql`UPDATE recovery_jobs SET state = ${JSON.stringify(state)}, finished_at = ${now}, intent = NULL WHERE id = ${row.id} AND fingerprint = ${row.fingerprint} AND account = ${row.account} AND finished_at IS NULL AND intent IS NOT DISTINCT FROM ${row.intent} RETURNING id`).length === 1,
    };
    this.runner = new RecoveryJobRunner(store, true, () => this.now());
  }

  /** Caller bootstraps schema; this method verifies immutable network/class binding. */
  static async create(sql: SQL, options: RecoveryJobOptions & { binding: string }): Promise<PostgresRecoveryJobs> {
    if (!options.binding) throw new Error('RECOVERY_DB_BINDING_REQUIRED');
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(1262570837, 2)`;
      await tx`INSERT INTO recovery_meta (key, value) VALUES ('binding', ${options.binding}) ON CONFLICT (key) DO NOTHING`;
      if ((await tx`SELECT value FROM recovery_meta WHERE key = 'binding'`)[0]?.value !== options.binding) throw new Error('RECOVERY_DB_NETWORK_MISMATCH');
    });
    return new PostgresRecoveryJobs(sql, options);
  }
  // Shared SQL pool is owned by API startup, not either logical store.
  close(): void {}
  private now() { return (this.options.now ?? Date.now)(); }
  private key(id: string) {
    if (!JOB_ID.test(id)) throw new HttpError(400, 'BAD_JOB_ID');
    return digest(id);
  }
  private async row(key: string): Promise<RecoveryRow | null> { return rowValue((await this.sql`SELECT * FROM recovery_jobs WHERE id = ${key}`)[0]); }
  private async prune(): Promise<void> {
    await this.sql`DELETE FROM recovery_jobs WHERE finished_at <= ${this.now() - (this.options.retentionMs ?? 30 * 60_000)}`;
  }
  async assertAccountAvailable(account: string): Promise<void> {
    if ((await this.sql`SELECT 1 FROM recovery_jobs WHERE account = ${BigInt(account).toString(16)} AND finished_at IS NULL`).length) throw new HttpError(409, 'IN_PROGRESS');
  }
  async hasSubmission(id: string, request: JobRequest): Promise<boolean> {
    const key = this.key(id);
    await this.prune();
    const row = await this.row(key);
    if (!row) return false;
    if (row.fingerprint !== fingerprintOf(request)) throw new HttpError(409, 'JOB_CONFLICT');
    return true;
  }
  async submit(id: string, request: JobRequest, work: RecoveryWork, failure: RecoveryFailure): Promise<void> {
    const key = this.key(id), fingerprint = fingerprintOf(request), account = BigInt(request.account).toString(16);
    const cutoff = this.now() - (this.options.retentionMs ?? 30 * 60_000);
    // Protect the async commit boundary from in-process orphan reconciliation.
    const releaseAdmission = this.runner.reserve(key);
    let admitted = false;
    try {
      admitted = await this.sql.begin(async (tx) => {
        // Global admission lock serializes quota/count checks across pool connections.
        await tx`SELECT pg_advisory_xact_lock(1262570837, 2)`;
        await tx`DELETE FROM recovery_jobs WHERE finished_at <= ${cutoff}`;
        const existing = (await tx`SELECT fingerprint FROM recovery_jobs WHERE id = ${key}`)[0];
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw new HttpError(409, 'JOB_CONFLICT');
          return false;
        }
        const [count] = await tx`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE finished_at IS NULL) AS active FROM recovery_jobs`;
        if (Number(count.active) >= (this.options.maxActive ?? 32) || Number(count.total) >= (this.options.maxRetained ?? 1000)) {
          metrics.recoveryJobs.inc({ result: 'refused' });
          throw new HttpError(503, 'RECOVERY_JOBS_FULL');
        }
        if ((await tx`SELECT 1 FROM recovery_jobs WHERE account = ${account} AND finished_at IS NULL`).length) throw new HttpError(409, 'IN_PROGRESS');
        await tx`INSERT INTO recovery_jobs (id, fingerprint, account, state) VALUES (${key}, ${fingerprint}, ${account}, ${JSON.stringify({ status: 'running' })})`;
        return true;
      });
      if (admitted) this.runner.start(key, work, failure);
    } finally { releaseAdmission(); }
  }
  async status(id: string): Promise<RecoveryStatus> {
    const key = this.key(id);
    await this.prune();
    const row = await this.row(key);
    if (!row) throw new HttpError(404, 'RECOVERY_JOB_NOT_FOUND');
    return JSON.parse(row.state);
  }
  async reconcile(provider: Pick<RpcProvider, 'getTransactionReceipt'>, id?: string): Promise<void> { await this.runner.reconcile(provider, id === undefined ? undefined : this.key(id)); }
  async resolveSuperseded(originalHash: string, replacementHash: string, provider: Pick<RpcProvider, 'getTransactionReceipt' | 'getTransactionByHash'>): Promise<void> { await this.runner.resolveSuperseded(originalHash, replacementHash, provider); }
}
