import { describe, expect, test } from 'bun:test';
import { RpcError } from 'starknet';
import { HttpError } from '../../http';
import { metrics, resetMetrics } from '../../metrics';
import { DEFAULT_MAX_FEE_PER_TX, MemoryLedger, budgetFor, defaultAnonymous, parseBudgets, type Budget, type Budgets } from '../sponsor/budgets';
import { MAX_SPONSORED_CALLDATA, maxFee, requireSignedFeeBounds, parseSponsorRequest, sponsorOutsideExecution, type SponsorContext } from './sponsor';

const ACCOUNT = '0x3ec3b3ead6762ecf0172e0d5e3f9df472e66608e3f483f300a784dc9652d193';
const OTHER_ACCOUNT = '0x4ec3b3ead6762ecf0172e0d5e3f9df472e66608e3f483f300a784dc9652d193';
const CLASS = '0x13c5e8166199db99e894da9e55ce642267e5258c42eae8851357747b6201fdc';
const APP_KEY = 'kamui_app_test_0123456789abcdef';
const code = (work: () => unknown) => {
  try {
    work();
    return 'ok';
  } catch (e) {
    return `${(e as HttpError).status} ${(e as Error).message}`;
  }
};
const status = (p: Promise<unknown>) => p.then(() => 'ok', (e: HttpError) => `${e.status} ${e.message}`);
const reverted = () => new RpcError({ code: 41, message: 'Transaction execution error', data: { execution_error: 'Kamui: invalid owner signature' } } as any, 'starknet_estimateFee', {});

const budget = (over: Partial<Budget> = {}): Budget => ({ name: 'anonymous', txPerPeriod: 1000, periodSeconds: 3600, perAccountPerPeriod: 1000, maxFeePerTx: DEFAULT_MAX_FEE_PER_TX, ...over });

/** A context whose relayer records what it was asked to send. `refuse` makes the fee estimate fail, as an invalid signature does. */
function context(over: { classHash?: string; anonymous?: Partial<Budget>; apps?: Record<string, Budget>; fee?: bigint } = {}) {
  const sent: any[] = [];
  const state = { refuse: false, estimates: 0, classReads: 0, estimateDetails: undefined as unknown, now: 1_000_000 };
  const bounds = { l2_gas: { max_amount: 1000n, max_price_per_unit: (over.fee ?? 1_000_000n) / 1000n } };
  const budgets: Budgets = { anonymous: budget(over.anonymous), byKey: new Map(Object.entries(over.apps ?? {})) };
  const ctx = {
    classHash: CLASS,
    budgets,
    ledger: new MemoryLedger(() => state.now),
    provider: { getClassHashAt: async () => (state.classReads++, over.classHash ?? CLASS) },
    relayer: {
      estimateInvokeFee: async (_call: unknown, details: unknown) => {
        state.estimateDetails=details;
        state.estimates += 1;
        if (state.refuse) throw reverted();
        return { overall_fee: over.fee ?? 1_000_000n, resourceBounds: bounds, unit: 'FRI' };
      },
      execute: async (call: unknown, details: unknown) => (sent.push({ call, details }), { transaction_hash: '0xabc' }),
    },
  } as unknown as SponsorContext;
  return { ctx, sent, state, bounds };
}
const call = (account = ACCOUNT) => ({ account, calldata: ['0x1', '0x2'] });

describe('sponsor request', () => {
  test('accepts an account and hex calldata', () => {
    expect(parseSponsorRequest({ account: ACCOUNT, calldata: ['0x1', '0x2'] })).toEqual({ account: ACCOUNT, calldata: ['0x1', '0x2'] });
  });

  test('refuses malformed requests', () => {
    expect(code(() => parseSponsorRequest({ account: 'x', calldata: ['0x1'] }))).toBe('400 BAD_ACCOUNT');
    expect(code(() => parseSponsorRequest({ account: ACCOUNT, calldata: [] }))).toBe('400 BAD_CALLDATA');
    expect(code(() => parseSponsorRequest({ account: ACCOUNT, calldata: ['1'] }))).toBe('400 BAD_CALLDATA');
    expect(code(() => parseSponsorRequest({ account: ACCOUNT, calldata: 'nope' as any }))).toBe('400 BAD_CALLDATA');
    const tooLong = Array.from({ length: MAX_SPONSORED_CALLDATA + 1 }, () => '0x1');
    expect(code(() => parseSponsorRequest({ account: ACCOUNT, calldata: tooLong }))).toBe('400 BAD_CALLDATA');
  });
});

describe('sponsoring', () => {
  test('sends exactly one entry point, to the account, with the calldata given and the bounds that were checked', async () => {
    const { ctx, sent, bounds, state } = context();
    const result = await sponsorOutsideExecution(call(), null, ctx);
    expect(result).toEqual({ transaction_hash: '0xabc' });
    expect(state.estimateDetails).toEqual({skipValidate:false,tip:0n});
    expect(sent).toEqual([{ call: { contractAddress: ACCOUNT, entrypoint: 'execute_from_outside_v2', calldata: ['0x1', '0x2'] }, details: { resourceBounds: bounds, tip: 0n } }]);
  });

  test('refuses a contract that is not a Kamui account', async () => {
    const { ctx, sent, state } = context({ classHash: '0x1' });
    expect(await status(sponsorOutsideExecution(call(), null, ctx))).toBe('400 WRONG_CLASS');
    expect(sent).toHaveLength(0);
    expect(state.estimates).toBe(0);
  });

  test('is off when the budget is 0', async () => {
    const { ctx, sent, state } = context({ anonymous: { txPerPeriod: 0 } });
    expect(await status(sponsorOutsideExecution(call(), null, ctx))).toBe('403 SPONSOR_DISABLED');
    expect(sent).toHaveLength(0);
    expect(state.classReads).toBe(0);
  });
});

describe('preflight refusals are free; possible paid sends consume the budget', () => {
  test('rejected calls do not use the budget', async () => {
    resetMetrics();
    const { ctx, sent, state } = context({ anonymous: { txPerPeriod: 3 } });
    state.refuse = true;
    // The audit's reproduction: far more refused calls than the cap, from several accounts.
    for (let i = 0; i < 120; i++) {
      expect(await status(sponsorOutsideExecution(call(i % 2 ? ACCOUNT : OTHER_ACCOUNT), null, ctx))).toBe('400 REVERTED: Kamui: invalid owner signature');
    }
    expect(await ctx.ledger.used('anonymous:total', 3_600_000)).toBe(0);
    state.refuse = false;
    expect(await status(sponsorOutsideExecution(call(), null, ctx))).toBe('ok');
    expect(sent).toHaveLength(1);
    expect(metrics.sponsor.get({ budget: 'anonymous', decision: 'reverted' })).toBe(120);
    expect(metrics.sponsor.get({ budget: 'anonymous', decision: 'sponsored' })).toBe(1);
  });

  test('an uncertain local submission consumes budget and cannot be retried as free', async () => {
    const { ctx } = context({ anonymous: { txPerPeriod: 1 } });
    const execute = ctx.relayer.execute;
    (ctx.relayer as any).execute = async () => { throw new Error('socket hang up'); };
    await expect(sponsorOutsideExecution(call(), null, ctx)).rejects.toThrow('socket hang up');
    (ctx.relayer as any).execute = execute;
    expect(await ctx.ledger.used('anonymous:total', 3_600_000)).toBe(1);
    expect(await status(sponsorOutsideExecution(call(), null, ctx))).toBe('429 SPONSOR_CAP');
  });

  test('submitted transactions count, the cap holds, and it frees up after the period', async () => {
    const { ctx, sent, state } = context({ anonymous: { txPerPeriod: 3 } });
    for (let i = 0; i < 3; i++) expect(await status(sponsorOutsideExecution(call(), null, ctx))).toBe('ok');
    expect(await status(sponsorOutsideExecution(call(), null, ctx))).toBe('429 SPONSOR_CAP');
    expect(await status(sponsorOutsideExecution(call(OTHER_ACCOUNT), null, ctx))).toBe('429 SPONSOR_CAP');
    expect(sent).toHaveLength(3);
    state.now += 3_600_000;
    expect(await status(sponsorOutsideExecution(call(), null, ctx))).toBe('ok');
  });

  test('concurrent requests cannot overspend the budget', async () => {
    const { ctx, sent } = context({ anonymous: { txPerPeriod: 5 } });
    const results = await Promise.all(Array.from({ length: 20 }, () => status(sponsorOutsideExecution(call(), null, ctx))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(5);
    expect(results.filter((r) => r === '429 SPONSOR_CAP')).toHaveLength(15);
    expect(sent).toHaveLength(5);
  });
});

describe('budgets', () => {
  const app = budget({ name: 'demo', txPerPeriod: 2, perAccountPerPeriod: 2 });

  test('an app key selects its budget; without one the request uses the anonymous budget', async () => {
    const { ctx } = context({ anonymous: { txPerPeriod: 1 }, apps: { [APP_KEY]: app } });
    expect(await status(sponsorOutsideExecution(call(), APP_KEY, ctx))).toBe('ok');
    expect(await status(sponsorOutsideExecution(call(), APP_KEY, ctx))).toBe('ok');
    expect(await status(sponsorOutsideExecution(call(OTHER_ACCOUNT), APP_KEY, ctx))).toBe('429 SPONSOR_CAP');
    // The app's budget being spent does not touch the anonymous one, and the reverse.
    expect(await status(sponsorOutsideExecution(call(), null, ctx))).toBe('ok');
    expect(await status(sponsorOutsideExecution(call(), null, ctx))).toBe('429 SPONSOR_CAP');
  });

  test('an unknown app key is refused, not treated as anonymous', async () => {
    const { ctx, sent, state } = context();
    expect(await status(sponsorOutsideExecution(call(), 'kamui_app_nobody_0123456789', ctx))).toBe('403 UNKNOWN_APP_KEY');
    expect(await status(sponsorOutsideExecution(call(), 'short', ctx))).toBe('403 UNKNOWN_APP_KEY');
    expect(sent).toHaveLength(0);
    expect(state.classReads).toBe(0);
  });

  test('one account cannot take more than its share of a budget', async () => {
    const { ctx } = context({ anonymous: { txPerPeriod: 10, perAccountPerPeriod: 2 } });
    expect(await status(sponsorOutsideExecution(call(), null, ctx))).toBe('ok');
    expect(await status(sponsorOutsideExecution(call(), null, ctx))).toBe('ok');
    expect(await status(sponsorOutsideExecution(call(), null, ctx))).toBe('429 ACCOUNT_BUDGET_SPENT');
    expect(await status(sponsorOutsideExecution(call(OTHER_ACCOUNT), null, ctx))).toBe('ok');
  });

  test('the relayer does not pay above the fee ceiling, and the refusal costs no budget', async () => {
    const { ctx, sent } = context({ anonymous: { maxFeePerTx: 999_999n, txPerPeriod: 1 }, fee: 1_000_000n });
    expect(await status(sponsorOutsideExecution(call(), null, ctx))).toBe('402 FEE_ABOVE_CEILING');
    expect(sent).toHaveLength(0);
    expect(await ctx.ledger.used('anonymous:total', 3_600_000)).toBe(0);
  });

  test('the ceiling is compared with the most the bounds allow, not only the estimate', () => {
    const bounds = { l1_gas: { max_amount: 10n, max_price_per_unit: 5n }, l2_gas: { max_amount: '0x64', max_price_per_unit: 3 }, l1_data_gas: { max_amount: 0n, max_price_per_unit: 9n } };
    expect(maxFee({ overall_fee: 200n, resourceBounds: bounds })).toBe(350n);
    expect(maxFee({ overall_fee: 500n, resourceBounds: bounds })).toBe(500n);
    expect(maxFee({ overall_fee: 7n })).toBe(7n);
  });

  test('the budgets file is read strictly', () => {
    const anonymous = defaultAnonymous('SN_SEPOLIA', undefined);
    const budgets = parseBudgets({ anonymous: { txPerPeriod: 10 }, apps: [{ name: 'demo', key: APP_KEY, txPerPeriod: 500, periodSeconds: 86400, perAccountPerPeriod: 20, maxFeePerTx: '250000000000000000' }] }, anonymous);
    expect(budgets.anonymous).toMatchObject({ name: 'anonymous', txPerPeriod: 10, periodSeconds: 3600 });
    expect(budgetFor(budgets, APP_KEY)).toEqual({ name: 'demo', txPerPeriod: 500, periodSeconds: 86400, perAccountPerPeriod: 20, maxFeePerTx: 250000000000000000n });
    expect(budgetFor(budgets, null)?.name).toBe('anonymous');
    expect(budgetFor(budgets, 'kamui_app_nobody_0123456789')).toBeNull();
    expect(() => parseBudgets({ apps: [{ name: 'demo', key: 'short', txPerPeriod: 1 }] }, anonymous)).toThrow('key');
    expect(() => parseBudgets({ apps: [{ name: 'demo', key: APP_KEY }] }, anonymous)).toThrow('txPerPeriod');
    expect(() => parseBudgets({ apps: [{ name: 'a', key: APP_KEY, txPerPeriod: 1 }, { name: 'b', key: APP_KEY, txPerPeriod: 1 }] }, anonymous)).toThrow('reuses');
    expect(() => parseBudgets({ apps: [{ name: 'a', key: APP_KEY, txPerPeriod: 1, maxFeePerTx: 5 }] }, anonymous)).toThrow('maxFeePerTx');
    expect(() => parseBudgets({ apps: [{ name: 'anonymous', key: APP_KEY, txPerPeriod: 1 }] }, anonymous)).toThrow('twice');
  });

  test('the example file is valid and holds no real key', async () => {
    const example = await Bun.file(`${import.meta.dir}/../../../sponsor-budgets.example.json`).json();
    const budgets = parseBudgets(example, defaultAnonymous('SN_SEPOLIA', undefined));
    expect(budgets.byKey.size).toBeGreaterThan(0);
    for (const key of budgets.byKey.keys()) expect(key).toContain('example');
  });

  test('anonymous default: off on mainnet, on elsewhere, and settable', () => {
    expect(defaultAnonymous('SN_MAIN', undefined).txPerPeriod).toBe(0);
    expect(defaultAnonymous('SN_SEPOLIA', undefined).txPerPeriod).toBe(120);
    expect(defaultAnonymous('SN_MAIN', '50').txPerPeriod).toBe(50);
    expect(defaultAnonymous('SN_SEPOLIA', '0').txPerPeriod).toBe(0);
    expect(() => defaultAnonymous('SN_SEPOLIA', 'lots')).toThrow();
  });
});


test('durable local sponsorship refuses partial/malformed bounds before debit or send', async () => {
  const complete={l1_gas:{max_amount:0n,max_price_per_unit:1n},l2_gas:{max_amount:2n,max_price_per_unit:5n},l1_data_gas:{max_amount:0n,max_price_per_unit:1n}};
  expect(()=>requireSignedFeeBounds({overall_fee:10n,resourceBounds:complete})).not.toThrow();
  for(const resourceBounds of [undefined,{}, {l2_gas:complete.l2_gas}, {...complete,l1_gas:{max_amount:2n**64n,max_price_per_unit:1n}}, {...complete,l1_data_gas:{max_amount:1n,max_price_per_unit:-1n}}, {...complete,l2_gas:{max_amount:1n,max_price_per_unit:'private-malformed-fixture'}}, {...complete,unexpected:complete.l1_gas}] as any[]) {
    const {ctx,sent}=context();let debits=0;
    ctx.funding={authorizeApp(){},debit:async()=>{debits++;}};
    (ctx.relayer as any).estimateInvokeFee=async()=>({overall_fee:10n,resourceBounds});
    await expect(sponsorOutsideExecution(call(),null,ctx)).rejects.toThrow('SIGNED_FEE_BOUNDS_REQUIRED');
    expect(debits).toBe(0);expect(sent).toHaveLength(0);
  }
});
