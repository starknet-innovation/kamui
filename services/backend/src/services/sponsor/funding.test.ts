import { describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { createHash, randomUUID } from 'node:crypto';
import { FUNDING_SCHEMA_SQL, PostgresFunding, disabledFundingPolicy, parseFundingPolicy, sponsorBudgetsFromFundingPolicy, type FundingLimit, type FundingPolicy } from './funding';
import { MemoryLedger } from './budgets';
import { sponsorOutsideExecution, type SponsorContext } from '../recovery/sponsor';
import { journaledTransaction, signedMaxFee } from '../recovery/transaction';
import fixture from '../recovery/fixtures/invoke-v3.json';

const url = process.env.KAMUI_TEST_POSTGRES_URL;
const appKey = 'kamui_approved_test_app';
const credential = 'TEST_ONLY_SERVER_CREDENTIAL_NOT_FOR_DISK';
const credentialHash = createHash('sha256').update(credential).digest('hex');
const bound = (v: Partial<FundingLimit> = {}): FundingLimit => ({ periodSeconds: 3600, txPerPeriod: 10, perAccountPerPeriod: 10, maxFeePerTx: 100n, maxFeePerPeriod: 1000n, perAccountMaxFeePerPeriod: 1000n, ...v });
const policy = (): FundingPolicy => ({ global: bound(), operations: { sponsor: bound(), deployment: bound(), recovery: bound() }, apps: { [appKey]: { ...bound(), credentialHash } }, allowExternalPaymaster: false });
const sponsorDebit = (over: Record<string, unknown> = {}) => ({ kind: 'sponsor' as const, account: '0x1', appKey, credential, maxFee: 10n, ...over });
async function withDatabase(work: (sql: SQL, other: SQL) => Promise<void>, initiallyPaused = false) {
  const schema = `kamui_funding_${randomUUID().replaceAll('-', '')}`;
  const admin = new SQL(url!);
  let sql: SQL | undefined, other: SQL | undefined;
  try {
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    sql = new SQL(url!, { max: 4, connection: { search_path: schema } });
    other = new SQL(url!, { max: 4, connection: { search_path: schema } });
    await sql.unsafe(FUNDING_SCHEMA_SQL);
    if (!initiallyPaused) await sql`UPDATE funding_control SET paused = false WHERE key = 'global'`;
    await work(sql, other);
  } finally {
    await sql?.close(); await other?.close();
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.close();
  }
}
function sponsorContext(sql: SQL, p: FundingPolicy, execute: () => Promise<{ transaction_hash: string }>): SponsorContext {
  return { funding: new PostgresFunding(sql, p), budgets: sponsorBudgetsFromFundingPolicy(p), ledger: new MemoryLedger(), classHash: '0x99',
    provider: { getClassHashAt: async () => '0x99' },
    relayer: { estimateInvokeFee: async () => ({ overall_fee: 10n, resourceBounds: { l1_gas: { max_amount: 0n, max_price_per_unit: 1n }, l2_gas: { max_amount: 2n, max_price_per_unit: 5n }, l1_data_gas: { max_amount: 0n, max_price_per_unit: 1n } } }), execute },
  } as unknown as SponsorContext;
}

test('funding policy is explicitly disabled by default and malformed configuration fails closed', async () => {
  const off = disabledFundingPolicy();
  expect(off.global.txPerPeriod).toBe(0);
  expect(off.operations.deployment.txPerPeriod).toBe(0);
  expect(off.allowExternalPaymaster).toBe(false);
  const serialized = JSON.parse(JSON.stringify(policy(), (_, value) => typeof value === 'bigint' ? value.toString() : value));
  expect(parseFundingPolicy(serialized).global.maxFeePerPeriod).toBe(1000n);
  serialized.global.periodSeconds = Number.MAX_SAFE_INTEGER;
  expect(() => parseFundingPolicy(serialized)).toThrow('FUNDING_POLICY_INVALID');
  expect(() => parseFundingPolicy({})).toThrow('FUNDING_POLICY_INVALID');
  expect(sponsorBudgetsFromFundingPolicy(policy()).anonymous.txPerPeriod).toBe(0);
  const invalid = JSON.parse(JSON.stringify(policy(), (_, value) => typeof value === 'bigint' ? value.toString() : value));
  invalid.apps[appKey].credentialHash = createHash('sha256').update('').digest('hex');
  expect(() => parseFundingPolicy(invalid)).toThrow('FUNDING_POLICY_INVALID');
  const overlong = 'x'.repeat(4097);
  const p = policy(); p.apps[appKey]!.credentialHash = createHash('sha256').update(overlong).digest('hex');
  await expect(new PostgresFunding({} as SQL, p).authorizeApp(appKey, overlong)).rejects.toThrow('APP_AUTH_REQUIRED');
});

describe.skipIf(!url)('PostgreSQL spending controls (explicit disposable database)', () => {
  test('new database starts paused and schema reinitialization preserves the operator decision', async () => {
    await withDatabase(async sql => {
      const funding = new PostgresFunding(sql, policy());
      expect(await funding.isPaused()).toBe(true);
      await expect(funding.debit(sponsorDebit())).rejects.toThrow('SPENDING_PAUSED');
      await funding.setPaused(false);
      await sql.unsafe(FUNDING_SCHEMA_SQL);
      expect(await funding.isPaused()).toBe(false);
    }, true);
  });
  test('concurrent cross-connection debits enforce the combined global count atomically', async () => {
    await withDatabase(async (sql, other) => {
      const p = policy(); p.global.txPerPeriod = 3;
      const first = new PostgresFunding(sql, p), second = new PostgresFunding(other, p);
      const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second).debit(sponsorDebit({ account: `0x${i + 1}` }))));
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(3);
      expect(Number((await sql`SELECT COUNT(*) AS n FROM funding_debits`)[0].n)).toBe(3);
    });
  });
  test('canonical account caps and per-app fee caps survive a new instance', async () => {
    await withDatabase(async (sql, other) => {
      const p = policy(); p.apps[appKey]!.perAccountPerPeriod = 1; p.apps[appKey]!.maxFeePerPeriod = 15n;
      const funding = new PostgresFunding(sql, p);
      await funding.debit(sponsorDebit());
      const reopened = new PostgresFunding(other, p);
      await expect(reopened.debit(sponsorDebit({ account: '0x0001', maxFee: 1n }))).rejects.toThrow('ACCOUNT_FUNDING_CAP');
      await expect(reopened.debit(sponsorDebit({ account: '0x2' }))).rejects.toThrow('FUNDING_CAP');
      expect(Number((await sql`SELECT COUNT(*) AS n FROM funding_debits`)[0].n)).toBe(1);
    });
  });
  test('deployment and recovery have separate fee/count limits and share the overall cap', async () => {
    await withDatabase(async (sql) => {
      const p = policy(); p.operations.deployment.txPerPeriod = 1; p.operations.recovery.maxFeePerTx = 5n; p.global.maxFeePerPeriod = 20n;
      const funding = new PostgresFunding(sql, p);
      await funding.debit({ kind: 'deployment', account: '0x1', maxFee: 10n });
      await expect(funding.debit({ kind: 'deployment', account: '0x2', maxFee: 1n })).rejects.toThrow('FUNDING_CAP');
      await expect(funding.debit({ kind: 'recovery', account: '0x2', maxFee: 6n })).rejects.toThrow('FUNDING_FEE_CEILING');
      await funding.debit({ kind: 'recovery', account: '0x2', maxFee: 5n });
      await expect(funding.debit(sponsorDebit({ account: '0x3', maxFee: 6n }))).rejects.toThrow('FUNDING_CAP');
    });
  });
  test('operator pause persists across restart; resume preserves prior debits', async () => {
    await withDatabase(async (sql, other) => {
      const p = policy(); p.global.txPerPeriod = 1;
      const funding = new PostgresFunding(sql, p);
      await funding.setPaused(true);
      const reopened = new PostgresFunding(other, p);
      expect(await reopened.isPaused()).toBe(true);
      await expect(reopened.debit(sponsorDebit())).rejects.toThrow('SPENDING_PAUSED');
      await reopened.setPaused(false);
      await reopened.debit(sponsorDebit());
      await funding.setPaused(true); await funding.setPaused(false);
      await expect(reopened.debit(sponsorDebit())).rejects.toThrow('FUNDING_CAP');
    });
  });
  test('only natural period expiry replenishes caps; duplicate signed hashes never resubmit', async () => {
    await withDatabase(async (sql, other) => {
      const p = policy(); p.global.txPerPeriod = 1; p.global.periodSeconds = 1;
      let now = 1000;
      const funding = new PostgresFunding(sql, p, () => now);
      await funding.debit({ kind: 'deployment', account: '0x1', maxFee: 1n, id: '0x001' });
      const reopened = new PostgresFunding(other, p, () => now);
      await expect(reopened.debit({ kind: 'deployment', account: '0x1', maxFee: 1n, id: '0x1' })).rejects.toThrow('FUNDING_ALREADY_DEBITED');
      await expect(reopened.debit({ kind: 'deployment', account: '0x2', maxFee: 1n })).rejects.toThrow('FUNDING_CAP');
      now = 2000;
      await reopened.debit({ kind: 'recovery', account: '0x2', maxFee: 1n });
      expect(Number((await sql`SELECT COUNT(*) AS n FROM funding_debits`)[0].n)).toBe(2);
      await expect(reopened.debit({ kind: 'deployment', account: '0x1', maxFee: 1n, id: '0x1' })).rejects.toThrow('FUNDING_ALREADY_DEBITED');
    });
  });
  test('public app identifiers and anonymous callers are refused before RPC; credentials never enter rows', async () => {
    await withDatabase(async sql => {
      let sends = 0;
      const ctx = sponsorContext(sql, policy(), async () => { sends++; return { transaction_hash: '0x5' }; });
      ctx.provider.getClassHashAt = async () => { throw Error('AUTH_MUST_PRECEDE_RPC'); };
      for (const [key, token] of [[null, null], [appKey, null], [appKey, 'wrong'], ['other_public_app_123', credential]]) {
        await expect(sponsorOutsideExecution({ account: '0x1', calldata: ['0x1'] }, key!, ctx, token)).rejects.toThrow('APP_AUTH_REQUIRED');
      }
      ctx.provider.getClassHashAt = async () => '0x99';
      await sponsorOutsideExecution({ account: '0x1', calldata: ['0x1'] }, appKey, ctx, credential);
      expect(sends).toBe(1);
      const bytes = JSON.stringify(await sql`SELECT * FROM funding_debits`, (_, v) => typeof v === 'bigint' ? v.toString() : v);
      expect(bytes).not.toContain(credential); expect(bytes).not.toContain(credentialHash); expect(bytes).not.toContain(appKey);
    });
  });
  test('uncertain local submissions stay debited even with a fresh in-memory ledger', async () => {
    await withDatabase(async (sql, other) => {
      const p = policy(); p.global.txPerPeriod = 1;
      let sends = 0;
      const execute = async () => { sends++; throw Error('local socket lost after acceptance'); };
      await expect(sponsorOutsideExecution({ account: '0x1', calldata: ['0x1'] }, appKey, sponsorContext(sql, p, execute), credential)).rejects.toThrow('local socket lost');
      await expect(sponsorOutsideExecution({ account: '0x1', calldata: ['0x1'] }, appKey, sponsorContext(other, p, execute), credential)).rejects.toThrow('FUNDING_CAP');
      expect(sends).toBe(1);
    });
  });
  test('AVNU requires explicit external-control review and uncertain sends retain preflight debit', async () => {
    await withDatabase(async (sql, other) => {
      const p = policy(); p.global.txPerPeriod = 1;
      let sends = 0;
      const ctx = sponsorContext(sql, p, async () => { throw Error('LOCAL_FALLBACK_FORBIDDEN'); });
      ctx.paymaster = { prepare: () => ({} as any), execute: async () => { sends++; throw Error('PAYMASTER_SUBMISSION_UNCERTAIN'); } };
      await expect(sponsorOutsideExecution({ account: '0x1', calldata: ['0x1'] }, appKey, ctx, credential)).rejects.toThrow('EXTERNAL_SPENDING_CONTROLS_REQUIRED');
      expect(sends).toBe(0);
      p.allowExternalPaymaster = true;
      await expect(sponsorOutsideExecution({ account: '0x1', calldata: ['0x1'] }, appKey, ctx, credential)).rejects.toThrow('PAYMASTER_SUBMISSION_UNCERTAIN');
      ctx.funding = new PostgresFunding(other, p); ctx.ledger = new MemoryLedger();
      await expect(sponsorOutsideExecution({ account: '0x1', calldata: ['0x1'] }, appKey, ctx, credential)).rejects.toThrow('FUNDING_CAP');
      expect(sends).toBe(1);
      expect((await sql`SELECT external FROM funding_debits`)[0].external).toBe(true);
    });
  });
  test('signed recovery is debited and journaled before broadcast; disabled funds never strand an intent', async () => {
    await withDatabase(async sql => {
      const p = policy(); const fee = signedMaxFee(fixture.transaction as any);
      p.global = bound({ maxFeePerTx: fee, maxFeePerPeriod: fee, perAccountMaxFeePerPeriod: fee });
      p.operations.recovery = { ...p.global };
      const order: string[] = [];
      const ctx: any = { funding: new PostgresFunding(sql, p), relayer: { getSignedTransaction: async () => fixture.transaction }, provider: { getChainId: async () => fixture.chainId,
        invokeSignedTx: async () => { order.push('send'); return { transaction_hash: fixture.transaction_hash }; } } };
      const journal = { beforeSend: async () => { expect(Number((await sql`SELECT COUNT(*) AS n FROM funding_debits`)[0].n)).toBe(1); order.push('journal'); }, deploymentConfirmed() {} };
      await journaledTransaction(ctx, {} as any, {}, journal, 'recover', { address: '0x1', identity: '0x2' });
      expect(order).toEqual(['journal', 'send']);
      ctx.funding = new PostgresFunding(sql, disabledFundingPolicy()); order.length = 0;
      ctx.relayer.getSignedTransaction = async () => ({ ...fixture.transaction, nonce: '0x999' });
      await expect(journaledTransaction(ctx, {} as any, {}, journal, 'prepare', { address: '0x3', identity: '0x2' })).rejects.toThrow('FUNDING_DISABLED');
      expect(order).toEqual([]);
    });
  });
  test('a restore guard appearing after journaling prevents the prepared paid send', async () => {
    await withDatabase(async sql => {
      const p = policy(); const fee = signedMaxFee(fixture.transaction as any);
      p.global = bound({ maxFeePerTx: fee, maxFeePerPeriod: fee, perAccountMaxFeePerPeriod: fee }); p.operations.recovery = { ...p.global };
      let restored = false, sends = 0;
      const ctx: any = { funding: new PostgresFunding(sql, p), assertPaidAvailable: () => { if (restored) throw Error('RESTORE_RECONCILIATION_REQUIRED'); }, relayer: { getSignedTransaction: async () => fixture.transaction }, provider: { getChainId: async () => fixture.chainId, invokeSignedTx: async () => { sends++; return { transaction_hash: fixture.transaction_hash }; } } };
      await expect(journaledTransaction(ctx, {} as any, {}, { beforeSend() { restored = true; }, deploymentConfirmed() {} }, 'recover', { address: '0x1', identity: '0x2' })).rejects.toThrow('RESTORE_RECONCILIATION_REQUIRED');
      expect(sends).toBe(0); expect(Number((await sql`SELECT COUNT(*) AS n FROM funding_debits`)[0].n)).toBe(1);
    });
  });
});
