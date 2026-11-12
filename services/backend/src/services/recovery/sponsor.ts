// Kamui: POST /sponsor. The relayer pays for an `execute_from_outside_v2` call on a Kamui
// account: an owner approving a session or changing owners, or a session making a call.
//
// This is a development stand-in for the paymaster (plan, Phase 2 step 3). It has a global and a
// per-address cap and nothing else: no per-app budgets, no accounting. It is off on mainnet
// unless SPONSORED_PER_HOUR is set.
//
// What makes it safe to expose at all: the relayer only ever sends this one entry point, to
// contracts of the Kamui account class. The account checks the owner or session signature
// itself, and starknet.js estimates the fee first, so a call the account would refuse fails
// here at no cost.
import { RpcError } from 'starknet';
import { HOUR, HttpError, allow } from '../../http';
import { type RecoverContext } from './recover';

export type SponsorRequest = { account: string; calldata: string[] };
export type SponsorResult = { transaction_hash: string };

const HEX = /^0x[0-9a-fA-F]{1,64}$/;
/** Generous for a multicall, small enough to bound what one request can cost. */
export const MAX_SPONSORED_CALLDATA = 600;
const SPONSORED_PER_IP = 60;

export function parseSponsorRequest(body: SponsorRequest): SponsorRequest {
  if (typeof body.account !== 'string' || !HEX.test(body.account)) throw new HttpError(400, 'BAD_ACCOUNT');
  if (!Array.isArray(body.calldata) || body.calldata.length === 0 || body.calldata.length > MAX_SPONSORED_CALLDATA) {
    throw new HttpError(400, 'BAD_CALLDATA');
  }
  if (!body.calldata.every((felt) => typeof felt === 'string' && HEX.test(felt))) throw new HttpError(400, 'BAD_CALLDATA');
  return { account: body.account, calldata: body.calldata };
}

/** Default cap: off on mainnet, 120 an hour elsewhere. */
export function sponsoredPerHour(chain: string, setting: string | undefined): number {
  if (setting !== undefined && setting !== '') {
    const value = Number(setting);
    if (!Number.isInteger(value) || value < 0) throw new Error('SPONSORED_PER_HOUR must be a whole number');
    return value;
  }
  return chain === 'SN_MAIN' ? 0 : 120;
}

function revertReason(e: RpcError): string {
  const text = JSON.stringify(e.baseError ?? e.message);
  const known = /(Kamui: [a-z =<>_]+|Spending: [a-z -]+|Owners: [a-z ]+|Session: [a-z ]+|Account: [a-z ]+)/.exec(text);
  return known ? known[1]! : 'the account refused the call';
}

export async function sponsorOutsideExecution(
  body: SponsorRequest,
  ip: string,
  ctx: RecoverContext & { sponsoredPerHour: number },
): Promise<SponsorResult> {
  const req = parseSponsorRequest(body);
  if (ctx.sponsoredPerHour === 0) throw new HttpError(403, 'SPONSOR_DISABLED');

  let classHash: string;
  try {
    classHash = await ctx.provider.getClassHashAt(req.account);
  } catch (e) {
    if (e instanceof RpcError && e.isType('CONTRACT_NOT_FOUND')) throw new HttpError(400, 'ACCOUNT_NOT_DEPLOYED');
    throw e;
  }
  if (BigInt(classHash) !== BigInt(ctx.classHash)) throw new HttpError(400, 'WRONG_CLASS');

  if (!allow(`sponsor:${ip}`, SPONSORED_PER_IP, HOUR)) throw new HttpError(429, 'RATE_LIMITED');
  if (!allow('sponsor', ctx.sponsoredPerHour, HOUR)) throw new HttpError(429, 'SPONSOR_CAP');

  try {
    const { transaction_hash } = await ctx.relayer.execute({
      contractAddress: req.account,
      entrypoint: 'execute_from_outside_v2',
      calldata: req.calldata,
    });
    console.log(new Date().toISOString(), `sponsored ${req.account} tx ${transaction_hash}`);
    return { transaction_hash };
  } catch (e) {
    if (e instanceof RpcError) throw new HttpError(400, `REVERTED: ${revertReason(e)}`);
    throw e;
  }
}
