import { describe, expect, test } from 'bun:test';
import { typedData } from 'starknet';
import { ownerOutsideExecution, outsideExecutionHash, sessionOutsideExecution } from '../../../../../sdk/src/outside';
import { newKeyPair } from '../../../../../sdk/src/utils';
import { HttpError } from '../../http';
import { sponsorOutsideExecution, type SponsorContext } from '../recovery/sponsor';
import { MemoryLedger } from './budgets';
import { avnuPaymaster, decodeOutsideExecution, paymasterFromEnvironment } from './paymaster';

const chainId = '0x534e5f5345504f4c4941';
const account = '0x123';
const key = newKeyPair();
const calls = [{ contractAddress: '0x456', entrypoint: 'transfer', calldata: ['0x789', '0x1', '0x0'] }];
const window = { executeAfter: 5, executeBefore: 2000000000 };
const call = ownerOutsideExecution({ account, chainId, calls, ownerPrivateKey: key.privateKey, nonce: '0x41', window });
const calldata = call.calldata as string[];
const request = { account, calldata };
const code = (work: Promise<unknown>) => work.then(() => 'ok', (e) => e.message);

function context() {
  const sent: any[] = [];
  const state = { local: 0, fee: 1n, classHash: '0xabc', uncertain: false };
  const budget = { name: 'anonymous', txPerPeriod: 1, perAccountPerPeriod: 1, periodSeconds: 3600, maxFeePerTx: 100n };
  const ctx: SponsorContext = {
    classHash: '0xabc',
    provider: { getClassHashAt: async () => state.classHash } as any,
    relayer: {
      estimateInvokeFee: async () => ({ overall_fee: state.fee }),
      execute: async () => { state.local++; return { transaction_hash: '0xdead' }; },
    } as any,
    budgets: { anonymous: budget, byKey: new Map() }, ledger: new MemoryLedger(),
    paymaster: {
      prepare: (data) => decodeOutsideExecution(data, chainId),
      execute: async (address, execution) => {
        sent.push({ address, execution });
        if (state.uncertain) throw new HttpError(502, 'PAYMASTER_SUBMISSION_UNCERTAIN');
        return { transaction_hash: '0xbeef' };
      },
    },
  };
  return { ctx, state, sent };
}

describe('signed outside execution for the paymaster', () => {
  test('preserves the exact signed owner payload and message hash', () => {
    const decoded = decodeOutsideExecution(calldata, chainId);
    expect(typedData.getMessageHash(decoded.typedData, account)).toBe(outsideExecutionHash(chainId, account, calls, '0x41', window));
    expect(decoded.signature).toEqual(calldata.slice(-2));
    expect(decoded.typedData.message).toMatchObject({ 'Execute After': '0x5', 'Execute Before': '0x77359400' });
  });

  test('preserves a session signature and its reserved nonce', () => {
    const session = { ...key, validUntil: 2000000000 };
    const call = sessionOutsideExecution({ account, chainId, calls, session, nonce: '0xdeadbeef', window });
    const decoded = decodeOutsideExecution(call.calldata as string[], chainId);
    expect(typedData.getMessageHash(decoded.typedData, account)).toBe(outsideExecutionHash(chainId, account, calls, '0xdeadbeef', window));
    expect(decoded.signature).toEqual((call.calldata as string[]).slice(-4));
  });

  test('refuses truncated data, trailing data, huge lengths and explicit callers', () => {
    for (const data of [calldata.slice(0, -1), [...calldata, '0x1'], [...calldata.slice(0, 4), '0xffff', ...calldata.slice(5)]]) {
      expect(() => decodeOutsideExecution(data, chainId)).toThrow('BAD_CALLDATA');
    }
    expect(() => decodeOutsideExecution(['0x1', ...calldata.slice(1)], chainId)).toThrow('PAYMASTER_CALLER_MUST_BE_ANY');
    expect(() => decodeOutsideExecution([...calldata.slice(0, 3), '0x20000000000000', ...calldata.slice(4)], chainId)).toThrow('BAD_OUTSIDE_WINDOW');
  });
});

describe('SNIP-29 transport', () => {
  test('sends only the signed invoke in sponsored mode, with a server-side key', async () => {
    let body: any;
    let headers: any;
    const paymaster = avnuPaymaster({ url: 'http://localhost:12777', chainId, apiKey: 'test-only-key', send: async (_url, init) => {
      body = JSON.parse(init!.body as string); headers = init!.headers;
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { transaction_hash: '0xabc' } });
    } });
    expect(await paymaster.execute(account, paymaster.prepare(calldata))).toEqual({ transaction_hash: '0xabc' });
    expect(body.method).toBe('paymaster_executeTransaction');
    expect(body.params.parameters).toEqual({ version: '0x1', fee_mode: { mode: 'sponsored' } });
    expect(body.params.transaction.invoke.signature).toEqual(calldata.slice(-2));
    expect(body.params.transaction.invoke.user_address).toBe(account);
    expect(body.params.transaction.invoke.typed_data.message.Nonce).toBe('0x41');
    expect(headers['x-paymaster-api-key']).toBe('test-only-key');
  });

  test('invalid or error responses are uncertain, never echoed and never retried', async () => {
    for (const answer of [{ error: { message: 'secret key' } }, { result: { transaction_hash: 'garbage' } }, { id: 'wrong', result: { transaction_hash: '0x1' } }]) {
      let sent = 0;
      const p = avnuPaymaster({ url: 'https://paymaster.test', chainId, send: async (_url, init) => {
        sent++; const { id } = JSON.parse(init!.body as string);
        return Response.json({ jsonrpc: '2.0', id, ...answer });
      } });
      expect(await code(p.execute(account, p.prepare(calldata)))).toBe('PAYMASTER_SUBMISSION_UNCERTAIN');
      expect(sent).toBe(1);
    }
  });

  test('the deadline bounds even a transport that ignores abort', async () => {
    const p = avnuPaymaster({ url: 'https://paymaster.test', chainId, timeoutMs: 10, send: () => new Promise(() => {}) });
    expect(await code(p.execute(account, p.prepare(calldata)))).toBe('PAYMASTER_SUBMISSION_UNCERTAIN');
  });

  test('the deadline also bounds a response whose headers arrive but body stalls', async () => {
    const p = avnuPaymaster({ url: 'https://paymaster.test', chainId, timeoutMs: 10, send: async () =>
      new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } })) });
    expect(await code(p.execute(account, p.prepare(calldata)))).toBe('PAYMASTER_SUBMISSION_UNCERTAIN');
  });

  test('is off by default and rejects mainnet and credential-bearing URLs', () => {
    expect(paymasterFromEnvironment(chainId, {})).toBeUndefined();
    expect(() => paymasterFromEnvironment('0x534e5f4d41494e', { PAYMASTER_URL: 'https://paymaster.test' })).toThrow('only on Sepolia');
    for (const url of ['http://remote.test', 'https://user:pass@example.com', 'https://example.com?key=secret']) {
      expect(() => avnuPaymaster({ url, chainId })).toThrow();
    }
  });
});

describe('paymaster through the sponsorship controls', () => {
  test('class and fee checks run before the paymaster; refusal releases the budget', async () => {
    const { ctx, state, sent } = context();
    state.classHash = '0x999';
    expect(await code(sponsorOutsideExecution(request, null, ctx))).toBe('WRONG_CLASS');
    state.classHash = ctx.classHash; state.fee = 101n;
    expect(await code(sponsorOutsideExecution(request, null, ctx))).toBe('FEE_ABOVE_CEILING');
    expect(sent).toHaveLength(0);
    state.fee = 1n;
    expect(await sponsorOutsideExecution(request, null, ctx)).toEqual({ transaction_hash: '0xbeef' });
    expect(sent).toHaveLength(1);
    expect(state.local).toBe(0);
    expect(await code(sponsorOutsideExecution(request, null, ctx))).toBe('ACCOUNT_BUDGET_SPENT');
  });

  test('uncertain submissions consume budget and never fall back to the local relayer', async () => {
    const { ctx, state, sent } = context(); state.uncertain = true;
    expect(await code(sponsorOutsideExecution(request, null, ctx))).toBe('PAYMASTER_SUBMISSION_UNCERTAIN');
    expect(await ctx.ledger.used('anonymous:total', 3600000)).toBe(1);
    expect(await code(sponsorOutsideExecution(request, null, ctx))).toBe('ACCOUNT_BUDGET_SPENT');
    expect(state.local).toBe(0); expect(sent).toHaveLength(1);
  });
});
