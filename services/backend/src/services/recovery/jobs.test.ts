import { expect, test } from 'bun:test';
import { RecoveryJobs } from './jobs';
import { metrics } from '../../metrics';
import type { RecoverRequest, RecoverResult } from './recover';

const id = (n: number) => '0x' + n.toString(16).padStart(62, '0');
const request: RecoverRequest = { jwt: 'sensitive', account: '0x1', newPubkey: '0x2', blinding: '0x3', pepper: '0x4', signature: ['0x5', '0x6'] };
const result: RecoverResult = { address: '0x1', identity: '0x7', transaction_hash: '0x8' };
const failure = () => ({ status: 502, error: 'PROVER_FAILED' });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('retries join the existing job, changed input conflicts, and an unknown capability discloses nothing', async () => {
  const jobs = new RecoveryJobs();
  const acceptedBefore = metrics.recoveryJobs.get({ result: 'accepted' });
  let runs = 0;
  let finish!: (r: RecoverResult) => void;
  const work = () => (runs++, new Promise<RecoverResult>((resolve) => { finish = resolve; }));
  jobs.submit(id(1), request, work, failure);
  jobs.submit(id(1), request, work, failure);
  await tick();
  expect(runs).toBe(1);
  expect(metrics.recoveryJobs.get({ result: 'accepted' })).toBe(acceptedBefore + 1);
  expect(jobs.status(id(1))).toEqual({ status: 'running' });
  expect(() => jobs.submit(id(1), { ...request, newPubkey: '0x9' }, work, failure)).toThrow('JOB_CONFLICT');
  expect(() => jobs.status(id(2))).toThrow('RECOVERY_JOB_NOT_FOUND');
  expect(() => jobs.submit('short', request, work, failure)).toThrow('BAD_JOB_ID');
  finish(result);
  await tick();
  jobs.submit(id(1), request, work, failure);
  expect(runs).toBe(1);
  expect(jobs.status(id(1))).toEqual({ status: 'succeeded', result });
});

test('failures are terminal and active and retained job counts are bounded', async () => {
  let now = 0;
  const jobs = new RecoveryJobs({ maxActive: 1, maxRetained: 2, retentionMs: 100, now: () => now });
  let reject!: (e: Error) => void;
  jobs.submit(id(1), request, () => new Promise((_, fail) => { reject = fail; }), failure);
  expect(() => jobs.submit(id(2), request, async () => result, failure)).toThrow('RECOVERY_JOBS_FULL');
  await tick();
  reject(new Error('JWT and upstream secret'));
  await tick();
  expect(jobs.status(id(1))).toEqual({ status: 'failed', error: 'PROVER_FAILED', httpStatus: 502 });
  jobs.submit(id(2), request, async () => result, failure);
  await tick();
  expect(() => jobs.submit(id(3), request, async () => result, failure)).toThrow('RECOVERY_JOBS_FULL');
  now = 100;
  expect(() => jobs.status(id(1))).toThrow('RECOVERY_JOB_NOT_FOUND');
  jobs.submit(id(3), request, async () => result, failure);
  await tick();
  expect(jobs.status(id(3)).status).toBe('succeeded');
});
