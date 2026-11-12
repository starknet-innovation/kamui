/** Durable single-run paid-attempt reservation. Never sends, signs, retries or refunds. */
import { constants as fsConstants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, basename, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDirectory } from './live-check';
export const RUN_ID = 'kamui-kms-sepolia-2026-11-12-v1';
export const BUDGET_FILE = 'kms-sepolia-budget.json';
export const STRK = 10n ** 18n;
const FIELD = (1n << 251n) + 17n * (1n << 192n) + 1n;
export type Kind = 'declare' | 'fund' | 'deploy' | 'ping';
export interface Reservation {
  kind: Kind; sender: string; nonce: string; transactionHash: string;
  maxFeeFri: string; principalFri: string;
}
export interface Attempt extends Reservation {
  index: number; status: 'reserved' | 'confirmed-success' | 'confirmed-revert';
  actualFeeFri?: string; receiptBlock?: string;
}
export interface Budget {
  schema: 'kamui.kms-live-budget.v1'; runId: typeof RUN_ID; chainId: '0x534e5f5345504f4c4941';
  maxAttempts: 4; maxTotalFri: '12000000000000000000'; maxFeePerAttemptFri: '5000000000000000000';
  attempts: Attempt[];
}
function uint(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new Error('LIVE_BUDGET_INPUT_INVALID');
  return BigInt(value);
}
function felt(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/.test(value)) throw new Error('LIVE_BUDGET_INPUT_INVALID');
  const n = BigInt(value);
  if (n <= 0n || n >= FIELD) throw new Error('LIVE_BUDGET_INPUT_INVALID');
  return `0x${n.toString(16)}`;
}
export function reservation(input: Reservation): Reservation {
  if (!input || !['declare', 'fund', 'deploy', 'ping'].includes(input.kind)) throw new Error('LIVE_BUDGET_INPUT_INVALID');
  const maxFee = uint(input.maxFeeFri), principal = uint(input.principalFri), nonce = uint(input.nonce);
  if (maxFee <= 0n || maxFee > 5n * STRK || nonce >= FIELD
    || (input.kind !== 'fund' && principal !== 0n) || (input.kind === 'fund' && principal === 0n))
    throw new Error('LIVE_BUDGET_INPUT_INVALID');
  return { kind: input.kind, sender: felt(input.sender), nonce: String(nonce), transactionHash: felt(input.transactionHash),
    maxFeeFri: String(maxFee), principalFri: String(principal) };
}
function empty(): Budget {
  return { schema: 'kamui.kms-live-budget.v1', runId: RUN_ID, chainId: '0x534e5f5345504f4c4941',
    maxAttempts: 4, maxTotalFri: '12000000000000000000', maxFeePerAttemptFri: '5000000000000000000', attempts: [] };
}
export function reservedTotal(state: Budget): bigint {
  return state.attempts.reduce((sum, attempt) => sum + uint(attempt.maxFeeFri) + uint(attempt.principalFri), 0n);
}
function parse(raw: unknown): Budget {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('LIVE_BUDGET_CORRUPT');
  const value = raw as Budget, initial = empty();
  if (Object.keys(value).sort().join(',') !== Object.keys(initial).sort().join(',')
    || value.schema !== initial.schema || value.runId !== RUN_ID || value.chainId !== initial.chainId
    || value.maxAttempts !== 4 || value.maxTotalFri !== initial.maxTotalFri
    || value.maxFeePerAttemptFri !== initial.maxFeePerAttemptFri || !Array.isArray(value.attempts) || value.attempts.length > 4)
    throw new Error('LIVE_BUDGET_CORRUPT');
  const hashes = new Set(), nonces = new Set();
  for (const [index, attempt] of value.attempts.entries()) {
    const checked = reservation(attempt);
    if (Object.entries(checked).some(([key, val]) => (attempt as any)[key] !== val)
      || attempt.index !== index + 1 || !['reserved', 'confirmed-success', 'confirmed-revert'].includes(attempt.status))
      throw new Error('LIVE_BUDGET_CORRUPT');
    const keys = ['kind', 'sender', 'nonce', 'transactionHash', 'maxFeeFri', 'principalFri', 'index', 'status'];
    if (attempt.status !== 'reserved') {
      keys.push('actualFeeFri', 'receiptBlock');
      if (uint(attempt.actualFeeFri) > uint(attempt.maxFeeFri)) throw new Error('LIVE_BUDGET_CORRUPT');
      uint(attempt.receiptBlock);
    }
    if (Object.keys(attempt).sort().join(',') !== keys.sort().join(',')) throw new Error('LIVE_BUDGET_CORRUPT');
    const nonce = `${attempt.sender}:${attempt.nonce}`;
    if (hashes.has(attempt.transactionHash) || nonces.has(nonce)) throw new Error('LIVE_BUDGET_CORRUPT');
    hashes.add(attempt.transactionHash); nonces.add(nonce);
  }
  if (reservedTotal(value) > 12n * STRK) throw new Error('LIVE_BUDGET_CORRUPT');
  return value;
}
async function syncDirectory(directory: string) {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function checkedPath(path: string) {
  if (!isAbsolute(path) || basename(path) !== BUDGET_FILE) throw new Error('LIVE_BUDGET_PATH_INVALID');
  await privateDirectory(dirname(path));
}
async function withLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  await checkedPath(path);
  const lock = await open(`${path}.lock`, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await lock.writeFile(JSON.stringify({ runId: RUN_ID, pid: process.pid }) + '\n'); await lock.sync(); await syncDirectory(dirname(path));
    return await run();
  } finally {
    await lock.close(); await unlink(`${path}.lock`); await syncDirectory(dirname(path));
  }
}
async function readBudget(path: string): Promise<Budget> {
  const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 65_536)
      throw new Error('LIVE_BUDGET_FILE_INVALID');
    return parse(JSON.parse(await file.readFile('utf8')));
  } finally { await file.close(); }
}
async function replace(path: string, state: Budget) {
  const temp = join(dirname(path), `.kms-budget-${randomUUID()}.tmp`);
  const file = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(state, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(temp, path); await syncDirectory(dirname(path));
}
export async function initializeBudget(path: string): Promise<void> {
  await withLock(path, async () => {
    const file = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify(empty(), null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await syncDirectory(dirname(path));
  });
}
export async function inspectBudget(path: string): Promise<Budget> {
  return withLock(path, () => readBudget(path));
}
export async function reserveAttempt(path: string, input: Reservation): Promise<Attempt> {
  const checked = reservation(input);
  return withLock(path, async () => {
    const state = await readBudget(path);
    if (state.attempts.length >= 4 || reservedTotal(state) + uint(checked.maxFeeFri) + uint(checked.principalFri) > 12n * STRK)
      throw new Error('LIVE_BUDGET_EXHAUSTED');
    if (state.attempts.some(a => a.transactionHash === checked.transactionHash || (a.sender === checked.sender && a.nonce === checked.nonce)))
      throw new Error('LIVE_BUDGET_REPLAY');
    const attempt: Attempt = { ...checked, index: state.attempts.length + 1, status: 'reserved' };
    state.attempts.push(attempt); await replace(path, state); return attempt;
  });
}
export async function reconcileAttempt(path: string, transactionHash: string, status: 'confirmed-success' | 'confirmed-revert', actualFeeFri: string, receiptBlock: string): Promise<void> {
  const tx = felt(transactionHash), fee = uint(actualFeeFri), block = uint(receiptBlock);
  if (!['confirmed-success', 'confirmed-revert'].includes(status)) throw new Error('LIVE_BUDGET_INPUT_INVALID');
  await withLock(path, async () => {
    const state = await readBudget(path), attempt = state.attempts.find(a => a.transactionHash === tx);
    if (!attempt || fee > uint(attempt.maxFeeFri)) throw new Error('LIVE_BUDGET_RECEIPT_INVALID');
    if (attempt.status !== 'reserved') {
      if (attempt.status !== status || attempt.actualFeeFri !== String(fee) || attempt.receiptBlock !== String(block))
        throw new Error('LIVE_BUDGET_RECEIPT_CONFLICT');
      return;
    }
    attempt.status = status; attempt.actualFeeFri = String(fee); attempt.receiptBlock = String(block);
    await replace(path, state);
  });
}
export async function main(args: string[]): Promise<number> {
  try {
    const [action, flag, path, ...rest] = args;
    if (flag !== '--journal' || !path) throw new Error('LIVE_BUDGET_ARGUMENTS_INVALID');
    if (action === 'init' && rest.length === 0) await initializeBudget(path);
    else if (action === 'inspect' && rest.length === 0) {
      const state = await inspectBudget(path);
      process.stdout.write(JSON.stringify({ status: 'budget_observed', attemptsReserved: state.attempts.length,
        reservedTotalFri: String(reservedTotal(state)), maxAttempts: 4, maxTotalFri: state.maxTotalFri }) + '\n');
      return 0;
    } else if (action === 'reserve' && rest.length === 7) {
      const [kind, sender, nonce, transactionHash, maxFeeFri, principalFri, approval] = rest;
      if (approval !== '--confirm-exact-reservation') throw new Error('LIVE_BUDGET_ARGUMENTS_INVALID');
      await reserveAttempt(path, { kind: kind as Kind, sender, nonce, transactionHash, maxFeeFri, principalFri });
    } else if (action === 'reconcile' && rest.length === 4) {
      const [transactionHash, status, fee, block] = rest;
      await reconcileAttempt(path, transactionHash, status as 'confirmed-success' | 'confirmed-revert', fee, block);
    } else throw new Error('LIVE_BUDGET_ARGUMENTS_INVALID');
    process.stdout.write('LIVE_BUDGET_RECORDED\n'); return 0;
  } catch {
    process.stderr.write('LIVE_BUDGET_OPERATION_FAILED\n'); return 1;
  }
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
