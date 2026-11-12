// Recovery jobs live in this api process. IDs are random bearer capabilities, sent only in
// POST bodies. Never log them. Only a fingerprint and the public result survive completion.
import { createHash } from 'node:crypto';
import { HttpError } from '../../http';
import { metrics } from '../../metrics';
import type { RecoverRequest, RecoverResult } from './recover';

export type RecoveryStatus =
  | { status: 'running' }
  | { status: 'succeeded'; result: RecoverResult }
  | { status: 'failed'; error: string; httpStatus: number };
type Job = { fingerprint: string; state: RecoveryStatus; finishedAt?: number };
export const JOB_ID = /^0x[0-9a-f]{62}$/;

export class RecoveryJobs {
  private jobs = new Map<string, Job>();
  constructor(private options: { maxActive?: number; maxRetained?: number; retentionMs?: number; now?: () => number } = {}) {}
  private now() { return (this.options.now ?? Date.now)(); }
  private prune() {
    const cutoff = this.now() - (this.options.retentionMs ?? 30 * 60_000);
    for (const [id, job] of this.jobs) if (job.finishedAt !== undefined && job.finishedAt <= cutoff) this.jobs.delete(id);
  }

  submit(id: string, request: RecoverRequest, work: () => Promise<RecoverResult>, failure: (e: unknown) => { status: number; error: string }): void {
    if (!JOB_ID.test(id)) throw new HttpError(400, 'BAD_JOB_ID');
    this.prune();
    const fingerprint = createHash('sha256').update(JSON.stringify([
      request.jwt, request.account, request.newPubkey, request.blinding, request.pepper,
      request.signature, request.keyProof, request.override ?? false,
    ])).digest('hex');
    const existing = this.jobs.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new HttpError(409, 'JOB_CONFLICT');
      return;
    }
    const active = [...this.jobs.values()].filter((j) => j.finishedAt === undefined).length;
    if (active >= (this.options.maxActive ?? 32) || this.jobs.size >= (this.options.maxRetained ?? 1000)) {
      metrics.recoveryJobs.inc({ result: 'refused' });
      throw new HttpError(503, 'RECOVERY_JOBS_FULL');
    }
    const job: Job = { fingerprint, state: { status: 'running' } };
    this.jobs.set(id, job);
    metrics.recoveryJobs.inc({ result: 'accepted' });
    // The task owns its lifetime, independent of the request's connection or abort signal.
    void Promise.resolve().then(work).then(
      (result) => {
        job.state = { status: 'succeeded', result };
        metrics.recoveryJobs.inc({ result: 'succeeded' });
      },
      (e) => {
        metrics.recoveryJobs.inc({ result: 'failed' });
        const described = failure(e);
        job.state = { status: 'failed', error: described.error, httpStatus: described.status };
      },
    ).finally(() => { job.finishedAt = this.now(); });
  }

  status(id: string): RecoveryStatus {
    if (!JOB_ID.test(id)) throw new HttpError(400, 'BAD_JOB_ID');
    this.prune();
    const job = this.jobs.get(id);
    if (!job) throw new HttpError(404, 'RECOVERY_JOB_NOT_FOUND');
    return job.state;
  }
}
