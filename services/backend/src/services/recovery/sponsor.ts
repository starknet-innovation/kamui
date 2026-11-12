// Kamui: POST /sponsor. The relayer pays for an `execute_from_outside_v2` call on a Kamui
// account: an owner approving a session or changing owners, or a session making a call.
//
// The default development relayer can be replaced by a separately running AVNU service,
// with per-app budgets: see
// ../sponsor/budgets.ts for what a budget and an app key are.
//
// What makes it safe to expose: the relayer only ever sends this one entry point, to contracts
// of the Kamui account class. The account checks the owner or session signature itself. The
// fee is estimated first, so a call the account would refuse fails here at no cost, and a call
// above the budget's ceiling is not sent. With AVNU this is preflight only; AVNU's own
// relayer bounds are external to this process (PAYMASTER.md).
//
// Order of work (audit finding #4): the cheap attempt limits run in the api's route wrapper
// before this is called; then the request is parsed, the class is read, a slot is reserved in
// the budget, the fee is estimated, and the transaction is sent. The slot is committed only
// when the transaction was submitted on the local path; every other local outcome releases it.
// For AVNU it is committed before sending, because even a failed answer may hide a submission.
import { RpcError } from 'starknet';
import { HttpError } from '../../http';
import { log } from '../../log';
import { metrics } from '../../metrics';
import type { SponsoredPaymaster } from '../sponsor/paymaster';
import { budgetFor, type Budgets, type SponsorLedger } from '../sponsor/budgets';
import { type RecoverContext } from './recover';

export type SponsorRequest = { account: string; calldata: string[] };
export type SponsorResult = { transaction_hash: string };
export type SponsorContext = Pick<RecoverContext, 'provider' | 'relayer' | 'classHash'> & { budgets: Budgets; ledger: SponsorLedger; paymaster?: SponsoredPaymaster };

const HEX = /^0x[0-9a-fA-F]{1,64}$/;
/** Generous for a multicall, small enough to bound what one request can cost. */
export const MAX_SPONSORED_CALLDATA = 600;

export function parseSponsorRequest(body: SponsorRequest): SponsorRequest {
  if (typeof body.account !== 'string' || !HEX.test(body.account)) throw new HttpError(400, 'BAD_ACCOUNT');
  if (!Array.isArray(body.calldata) || body.calldata.length === 0 || body.calldata.length > MAX_SPONSORED_CALLDATA) {
    throw new HttpError(400, 'BAD_CALLDATA');
  }
  if (!body.calldata.every((felt) => typeof felt === 'string' && HEX.test(felt))) throw new HttpError(400, 'BAD_CALLDATA');
  return { account: body.account, calldata: body.calldata };
}

function revertReason(e: RpcError): string {
  const text = JSON.stringify(e.baseError ?? e.message);
  const known = /(Kamui: [a-z =<>_]+|Spending: [a-z -]+|Owners: [a-z ]+|Session: [a-z ]+|Account: [a-z ]+)/.exec(text);
  return known ? known[1]! : 'the account refused the call';
}

type Bound = { max_amount: bigint | string | number; max_price_per_unit: bigint | string | number };
/** The most a transaction with these bounds can cost: what the relayer signs for. */
export function maxFee(estimate: { overall_fee: bigint | string | number; resourceBounds?: Record<string, Bound | undefined> }): bigint {
  const bounds = Object.values(estimate.resourceBounds ?? {}).filter((b): b is Bound => b !== undefined);
  const worst = bounds.reduce((sum, b) => sum + BigInt(b.max_amount) * BigInt(b.max_price_per_unit), 0n);
  const estimated = BigInt(estimate.overall_fee);
  return worst > estimated ? worst : estimated;
}

export async function sponsorOutsideExecution(body: SponsorRequest, appKey: string | null, ctx: SponsorContext): Promise<SponsorResult> {
  const req = parseSponsorRequest(body);
  const execution = ctx.paymaster?.prepare(req.calldata);
  const budget = budgetFor(ctx.budgets, appKey);
  if (!budget) {
    metrics.sponsor.inc({ budget: 'unknown', decision: 'unknown_app' });
    throw new HttpError(403, 'UNKNOWN_APP_KEY');
  }
  const decide = (decision: string) => metrics.sponsor.inc({ budget: budget.name, decision });
  if (budget.txPerPeriod === 0) {
    decide('disabled');
    throw new HttpError(403, 'SPONSOR_DISABLED');
  }

  let classHash: string;
  try {
    classHash = await ctx.provider.getClassHashAt(req.account);
  } catch (e) {
    if (e instanceof RpcError && e.isType('CONTRACT_NOT_FOUND')) throw new HttpError(400, 'ACCOUNT_NOT_DEPLOYED');
    throw e;
  }
  if (BigInt(classHash) !== BigInt(ctx.classHash)) throw new HttpError(400, 'WRONG_CLASS');

  const periodMs = budget.periodSeconds * 1000;
  const account = BigInt(req.account).toString(16);
  const accountSlot = await ctx.ledger.reserve(`${budget.name}:account:${account}`, budget.perAccountPerPeriod, periodMs);
  if (!accountSlot) {
    decide('refused_account_budget');
    throw new HttpError(429, 'ACCOUNT_BUDGET_SPENT');
  }
  const slot = await ctx.ledger.reserve(`${budget.name}:total`, budget.txPerPeriod, periodMs);
  if (!slot) {
    await accountSlot.release();
    decide('refused_budget');
    throw new HttpError(429, 'SPONSOR_CAP');
  }

  let submitted = false;
  try {
    const call = { contractAddress: req.account, entrypoint: 'execute_from_outside_v2', calldata: req.calldata };
    let estimate: Awaited<ReturnType<typeof ctx.relayer.estimateInvokeFee>>;
    try {
      estimate = await ctx.relayer.estimateInvokeFee(call);
    } catch (e) {
      if (e instanceof RpcError) {
        decide('reverted');
        throw new HttpError(400, `REVERTED: ${revertReason(e)}`);
      }
      throw e;
    }
    if (maxFee(estimate) > budget.maxFeePerTx) {
      decide('refused_fee');
      throw new HttpError(402, 'FEE_ABOVE_CEILING');
    }
    let transaction_hash: string;
    try {
      // The local path passes the estimate's bounds into the signed transaction. The AVNU
      // path cannot carry those bounds through SNIP-29; see PAYMASTER.md.
      if (ctx.paymaster && execution) {
        // External submission is not atomic with our ledger. Debit conservatively before
        // sending: a timeout or invalid answer may hide a submitted, paid transaction.
        submitted = true;
        await Promise.all([slot.commit(), accountSlot.commit()]);
        ({ transaction_hash } = await ctx.paymaster.execute(req.account, execution));
      } else {
        ({ transaction_hash } = await ctx.relayer.execute(call, { resourceBounds: estimate.resourceBounds }));
      }
    } catch (e) {
      if (e instanceof RpcError) {
        decide('reverted');
        throw new HttpError(400, `REVERTED: ${revertReason(e)}`);
      }
      throw e;
    }
    submitted = true;
    if (!ctx.paymaster) await Promise.all([slot.commit(), accountSlot.commit()]);
    decide('sponsored');
    if (!ctx.paymaster) metrics.relayerTransactions.inc({ kind: 'sponsor' });
    log('info', 'sponsored', { account: req.account, tx: transaction_hash, budget: budget.name });
    return { transaction_hash };
  } catch (e) {
    if (!(e instanceof HttpError)) decide('failed');
    throw e;
  } finally {
    if (!submitted) await Promise.all([slot.release(), accountSlot.release()]);
  }
}
