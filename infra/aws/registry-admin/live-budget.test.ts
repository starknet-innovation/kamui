import { test, expect } from 'bun:test';
import { mkdtemp, chmod, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BUDGET_FILE, STRK, initializeBudget, inspectBudget, reserveAttempt, reconcileAttempt, reservedTotal, type Reservation } from './live-budget';
async function temporary(run: (journal: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'kamui-kms-budget-unit-'));
  try { await chmod(dir, 0o700); await run(join(dir, BUDGET_FILE)); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
function input(index = 1, fee = STRK, principal = 0n): Reservation {
  return { kind: principal > 0n ? 'fund' : 'ping', sender: '0x123', nonce: String(index),
    transactionHash: `0x${index.toString(16)}`, maxFeeFri: String(fee), principalFri: String(principal) };
}
test('fixed budget initializes once and reopens after a normal restart', async () => {
  await temporary(async path => {
    await initializeBudget(path); await reserveAttempt(path, input());
    expect((await inspectBudget(path)).attempts).toHaveLength(1);
    await expect(initializeBudget(path)).rejects.toThrow();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await inspectBudget(path)).attempts).toHaveLength(1);
  });
});
test('four attempts exhausted independently of actual fee and receipt state', async () => {
  await temporary(async path => {
    await initializeBudget(path);
    for (let n = 1; n <= 4; n++) await reserveAttempt(path, input(n));
    await reconcileAttempt(path, '0x1', 'confirmed-success', '0', '123');
    await expect(reserveAttempt(path, input(5))).rejects.toThrow('LIVE_BUDGET_EXHAUSTED');
    expect(reservedTotal(await inspectBudget(path))).toBe(4n * STRK);
  });
});
test('total cap includes principal and all signed fee maxima, even after success', async () => {
  await temporary(async path => {
    await initializeBudget(path);
    await reserveAttempt(path, input(1, 2n * STRK, 5n * STRK));
    await reserveAttempt(path, input(2, 5n * STRK));
    await reconcileAttempt(path, '0x1', 'confirmed-success', '1', '123');
    await expect(reserveAttempt(path, input(3, 1n))).rejects.toThrow('LIVE_BUDGET_EXHAUSTED');
    expect(reservedTotal(await inspectBudget(path))).toBe(12n * STRK);
  });
});
test('per attempt 5 STRK cap and operation principal restrictions enforced', async () => {
  await temporary(async path => {
    await initializeBudget(path);
    await expect(reserveAttempt(path, input(1, 5n * STRK + 1n))).rejects.toThrow('LIVE_BUDGET_INPUT_INVALID');
    await expect(reserveAttempt(path, { ...input(), kind: 'deploy', principalFri: '1' })).rejects.toThrow();
    await expect(reserveAttempt(path, { ...input(), kind: 'fund' })).rejects.toThrow();
    expect((await inspectBudget(path)).attempts).toHaveLength(0);
  });
});
test('same transaction hash or same sender nonce cannot reserve a retry', async () => {
  await temporary(async path => {
    await initializeBudget(path); await reserveAttempt(path, input());
    await expect(reserveAttempt(path, { ...input(2), transactionHash: '0x1' })).rejects.toThrow('LIVE_BUDGET_REPLAY');
    await expect(reserveAttempt(path, { ...input(2), nonce: '1' })).rejects.toThrow('LIVE_BUDGET_REPLAY');
    await reconcileAttempt(path, '0x1', 'confirmed-revert', '1', '10');
    await expect(reserveAttempt(path, { ...input(2), nonce: '1' })).rejects.toThrow('LIVE_BUDGET_REPLAY');
  });
});
test('exclusive serialization lock prevents concurrent state loss', async () => {
  await temporary(async path => {
    await initializeBudget(path);
    const results = await Promise.allSettled([reserveAttempt(path, input(1)), reserveAttempt(path, input(2))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await inspectBudget(path)).attempts).toHaveLength(1);
    await writeFile(path + '.lock', '{}', { mode: 0o600 });
    await expect(reserveAttempt(path, input(3))).rejects.toThrow();
    const state = JSON.parse(await readFile(path, 'utf8'));
    expect(state.attempts).toHaveLength(1);
  });
});
test('reconciliation is idempotent, retains reservations and refuses conflicting receipts', async () => {
  await temporary(async path => {
    await initializeBudget(path); await reserveAttempt(path, input());
    await reconcileAttempt(path, '0x1', 'confirmed-success', '1', '5');
    await reconcileAttempt(path, '0x1', 'confirmed-success', '1', '5');
    await expect(reconcileAttempt(path, '0x1', 'confirmed-revert', '1', '5')).rejects.toThrow('LIVE_BUDGET_RECEIPT_CONFLICT');
    await expect(reconcileAttempt(path, '0x2', 'confirmed-success', '1', '5')).rejects.toThrow('LIVE_BUDGET_RECEIPT_INVALID');
    expect(reservedTotal(await inspectBudget(path))).toBe(STRK);
  });
});
test('over-bound receipt and corrupted budget fail closed, no cap reset', async () => {
  await temporary(async path => {
    await initializeBudget(path); await reserveAttempt(path, input());
    await expect(reconcileAttempt(path, '0x1', 'confirmed-success', String(STRK + 1n), '5')).rejects.toThrow('LIVE_BUDGET_RECEIPT_INVALID');
    const state = JSON.parse(await readFile(path, 'utf8')); state.maxAttempts = 5;
    await writeFile(path, JSON.stringify(state));
    await expect(inspectBudget(path)).rejects.toThrow('LIVE_BUDGET_CORRUPT');
    await expect(initializeBudget(path)).rejects.toThrow();
  });
});
test('strict fixed filename and private file permissions enforced', async () => {
  await temporary(async path => {
    await expect(initializeBudget(path + '.other')).rejects.toThrow('LIVE_BUDGET_PATH_INVALID');
    await initializeBudget(path); await chmod(path, 0o644);
    await expect(reserveAttempt(path, input())).rejects.toThrow('LIVE_BUDGET_FILE_INVALID');
  });
});

test('explicit uncapped Sepolia authorization retains replay and receipt accounting', async () => {
  await temporary(async path => {
    await initializeBudget(path, true);
    const large = { ...input(1), kind: 'declare' as const, maxFeeFri: String(8n * STRK) };
    await reserveAttempt(path, large);
    await reserveAttempt(path, { ...input(2), maxFeeFri: String(8n * STRK) });
    expect(reservedTotal(await inspectBudget(path))).toBe(16n * STRK);
    expect((await inspectBudget(path)).authorization).toBe('user-explicit-sepolia-strk-2026-11-12');
    await expect(reserveAttempt(path, large)).rejects.toThrow('LIVE_BUDGET_REPLAY');
    await reconcileAttempt(path, '0x1', 'confirmed-success', String(7n * STRK), '1');
    expect(reservedTotal(await inspectBudget(path))).toBe(16n * STRK);
    await expect(initializeBudget(path, true)).rejects.toThrow();
  });
});
