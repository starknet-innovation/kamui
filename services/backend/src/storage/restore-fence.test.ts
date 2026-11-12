import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acknowledgeRestoreGate, assertRestoreReady, blockRestoreGate, initializeRestoreGate, readRestoreGate, RESTORE_REPLAY_WAIT_MS } from './restore-fence';
function directory() { const dir = mkdtempSync(join(tmpdir(), 'kamui-restore-')); return { path: join(dir, 'state.json'), close: () => rmSync(dir, { recursive: true, force: true }) }; }
const acknowledgement = (generation: string) => ({ version: 1 as const, generation, mode: 'restored' as const, reviewRef: 'local-drill-2026-11-12', apiAndRotatorStopped: true as const, originalWriterCannotRestart: true as const, signerHistoryReconciled: true as const, uncertainIntentsRetained: true as const, replayAndBudgetsConservative: true as const });

test('missing, malformed, oversized and symlinked restore gates fail closed', () => {
  const temp = directory();
  try {
    const env = { RESTORE_GATE_FILE: temp.path };
    expect(() => assertRestoreReady({})).not.toThrow();
    expect(() => assertRestoreReady(env)).toThrow('RESTORE_RECONCILIATION_REQUIRED');
    writeFileSync(temp.path, '{}'); expect(() => assertRestoreReady(env)).toThrow();
    writeFileSync(temp.path, ' '.repeat(4097)); expect(() => assertRestoreReady(env)).toThrow();
    rmSync(temp.path); symlinkSync('/etc/hosts', temp.path); expect(() => assertRestoreReady(env)).toThrow();
    expect(() => blockRestoreGate(temp.path)).toThrow('RESTORE_GATE_PATH_INVALID');
  } finally { temp.close(); }
});

test('fresh gate requires explicit generation-matched acknowledgement and cannot be reinitialized', () => {
  const temp = directory();
  try {
    const gate = initializeRestoreGate(temp.path, 1000);
    expect(() => assertRestoreReady({ RESTORE_GATE_FILE: temp.path })).toThrow();
    expect(() => initializeRestoreGate(temp.path)).toThrow('RESTORE_GATE_ALREADY_EXISTS');
    expect(() => acknowledgeRestoreGate(temp.path, { ...acknowledgement(gate.generation), mode: 'fresh', originalWriterCannotRestart: false } as any, 2000)).toThrow();
    acknowledgeRestoreGate(temp.path, { ...acknowledgement(gate.generation), mode: 'fresh' }, 2000);
    expect(() => assertRestoreReady({ RESTORE_GATE_FILE: temp.path })).not.toThrow();
    expect(readRestoreGate(temp.path).reason).toBe('fresh');
    const blocked = blockRestoreGate(temp.path, 3000);
    expect(blocked.generation).not.toBe(gate.generation);
    expect(() => acknowledgeRestoreGate(temp.path, acknowledgement(gate.generation), 999999)).toThrow();
    expect(() => acknowledgeRestoreGate(temp.path, { ...acknowledgement(blocked.generation), mode: 'fresh' }, 999999)).toThrow();
  } finally { temp.close(); }
});

test('restored gate retains pause until replay window and reconciliation attestations hold', () => {
  const temp = directory();
  try {
    const gate = blockRestoreGate(temp.path, 1000);
    const ack = acknowledgement(gate.generation);
    expect(() => acknowledgeRestoreGate(temp.path, ack, 1000 + RESTORE_REPLAY_WAIT_MS - 1)).toThrow('RESTORE_REPLAY_WINDOW_ACTIVE');
    expect(() => acknowledgeRestoreGate(temp.path, { ...ack, signerHistoryReconciled: false } as any, 999999)).toThrow('RESTORE_RECONCILIATION_REQUIRED');
    expect(() => acknowledgeRestoreGate(temp.path, { ...ack, signerHistoryReconciled: 'false' } as any, 999999)).toThrow('RESTORE_RECONCILIATION_REQUIRED');
    expect(() => acknowledgeRestoreGate(temp.path, { ...ack, reviewRef: undefined } as any, 999999)).toThrow();
    acknowledgeRestoreGate(temp.path, ack, 1000 + RESTORE_REPLAY_WAIT_MS);
    expect(() => assertRestoreReady({ RESTORE_GATE_FILE: temp.path })).not.toThrow();
    expect(readRestoreGate(temp.path).mode).toBe('restored');
    const invalid = { ...readRestoreGate(temp.path), mode: 'fresh' };
    writeFileSync(temp.path, JSON.stringify(invalid));
    expect(() => assertRestoreReady({ RESTORE_GATE_FILE: temp.path })).toThrow('RESTORE_RECONCILIATION_REQUIRED');
  } finally { temp.close(); }
});


test('operator umask does not hide nonsecret gate metadata from the read-only API user', () => {
  const temp = directory();
  const old = process.umask(0o077);
  try {
    initializeRestoreGate(temp.path, 1000);
    expect(statSync(temp.path).mode & 0o777).toBe(0o644);
    blockRestoreGate(temp.path, 2000);
    expect(statSync(temp.path).mode & 0o777).toBe(0o644);
  } finally { process.umask(old); temp.close(); }
});
