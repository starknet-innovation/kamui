// Host-owned state outside PGDATA. A stale PostgreSQL restore must never restore
// its own admission permission. The API mounts this file read-only.
import { readFileSync, lstatSync, mkdirSync, openSync, writeFileSync, fsyncSync, fchmodSync, closeSync, renameSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../http';

export type RestoreGate = {
  version: 1;
  state: 'blocked' | 'ready';
  generation: string;
  reason: 'fresh' | 'restore';
  changedAt: number;
  mode?: 'fresh' | 'restored';
  reviewRef?: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
export const RESTORE_REPLAY_WAIT_MS = 600_000;

export function readRestoreGate(path: string): RestoreGate {
  try {
    if (!isAbsolute(path)) throw new Error();
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error();
    const value = JSON.parse(readFileSync(path, 'utf8')) as RestoreGate;
    if (value.version !== 1 || !['blocked', 'ready'].includes(value.state) || !UUID.test(value.generation)
      || !['fresh', 'restore'].includes(value.reason) || !Number.isSafeInteger(value.changedAt) || value.changedAt <= 0
      || (value.state === 'ready' && (!['fresh', 'restored'].includes(value.mode!) || (value.mode === 'fresh') !== (value.reason === 'fresh') || (typeof value.reviewRef !== 'string' || !REF.test(value.reviewRef))))) throw new Error();
    return value;
  } catch { throw new HttpError(503, 'RESTORE_RECONCILIATION_REQUIRED'); }
}

/** Legacy developer setups may omit the gate; lean hosting must configure it. */
export function assertRestoreReady(env: Record<string, string | undefined>): void {
  if (!env.RESTORE_GATE_FILE) return;
  if (readRestoreGate(env.RESTORE_GATE_FILE).state !== 'ready') throw new HttpError(503, 'RESTORE_RECONCILIATION_REQUIRED');
}

function writeGate(path: string, value: RestoreGate): void {
  if (!isAbsolute(path)) throw new Error('RESTORE_GATE_PATH_INVALID');
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o750 });
  try { if (lstatSync(path).isSymbolicLink()) throw new Error('RESTORE_GATE_PATH_INVALID'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(directory, `.restore-gate-${randomUUID()}`);
  const descriptor = openSync(temporary, 'wx', 0o644);
  try { fchmodSync(descriptor, 0o644); writeFileSync(descriptor, JSON.stringify(value) + '\n'); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  try {
    renameSync(temporary, path);
    const dir = openSync(directory, 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { try { unlinkSync(temporary); } catch {} }
}

// An interrupted control command leaves this host-side lock behind and fails closed.
// Operators may remove it only after confirming that no gate command is still running.
function withGateLock<T>(path: string, work: () => T): T {
  if (!isAbsolute(path)) throw new Error('RESTORE_GATE_PATH_INVALID');
  mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
  const lock = join(dirname(path), '.restore-gate.lock');
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch { throw new Error('RESTORE_GATE_BUSY'); }
  try { return work(); } finally { rmdirSync(lock); }
}

export function blockRestoreGate(path: string, now = Date.now()): RestoreGate {
  return withGateLock(path, () => {
    const gate: RestoreGate = { version: 1, state: 'blocked', reason: 'restore', generation: randomUUID(), changedAt: now };
    writeGate(path, gate);
    return gate;
  });
}

export function initializeRestoreGate(path: string, now = Date.now()): RestoreGate {
  return withGateLock(path, () => {
  try { lstatSync(path); throw new Error('RESTORE_GATE_ALREADY_EXISTS'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const gate: RestoreGate = { version: 1, state: 'blocked', reason: 'fresh', generation: randomUUID(), changedAt: now };
  writeGate(path, gate);
  return gate;
  });
}

export type RestoreAcknowledgement = {
  version: 1;
  generation: string;
  mode: 'fresh' | 'restored';
  reviewRef: string;
  apiAndRotatorStopped: true;
  originalWriterCannotRestart: true;
  // For restored databases these are operator attestations, not chain proofs.
  signerHistoryReconciled?: true;
  uncertainIntentsRetained?: true;
  replayAndBudgetsConservative?: true;
};

export function acknowledgeRestoreGate(path: string, acknowledgement: RestoreAcknowledgement, now = Date.now()): RestoreGate {
  return withGateLock(path, () => {
  const gate = readRestoreGate(path);
  const a = acknowledgement;
  if (gate.state !== 'blocked' || a.version !== 1 || a.generation !== gate.generation || typeof a.reviewRef !== 'string' || !REF.test(a.reviewRef)
    || a.apiAndRotatorStopped !== true || a.originalWriterCannotRestart !== true || !['fresh', 'restored'].includes(a.mode)) throw new Error('RESTORE_ACKNOWLEDGEMENT_INVALID');
  if ((a.mode === 'fresh') !== (gate.reason === 'fresh')) throw new Error('RESTORE_ACKNOWLEDGEMENT_INVALID');
  if (a.mode === 'restored') {
    if (a.signerHistoryReconciled !== true || a.uncertainIntentsRetained !== true || a.replayAndBudgetsConservative !== true) throw new Error('RESTORE_RECONCILIATION_REQUIRED');
    if (now - gate.changedAt < RESTORE_REPLAY_WAIT_MS) throw new Error('RESTORE_REPLAY_WINDOW_ACTIVE');
  }
  const ready: RestoreGate = { version: 1, state: 'ready', reason: gate.reason, generation: gate.generation, changedAt: now, mode: a.mode, reviewRef: a.reviewRef };
  writeGate(path, ready);
  return ready;
  });
}
