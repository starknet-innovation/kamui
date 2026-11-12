// Owner-authorized wallet maintenance only. An app's generic calls use /sponsor instead.
// The account remains authority; this service only limits which signed actions it funds.
import { RpcError, hash, shortString, typedData, type Account, type RpcProvider } from 'starknet';
import { HttpError } from '../../http';
import { log } from '../../log';
import { metrics } from '../../metrics';
import { decodeOutsideExecution, type SponsoredPaymaster } from '../sponsor/paymaster';
import type { FundingController } from '../sponsor/funding';
import { maxFee, requireSignedFeeBounds, parseSponsorRequest, type SponsorRequest, type SponsorResult } from './sponsor';
import { withRelayerLock } from './transaction';

export type WalletSponsorContext = {
  provider: Pick<RpcProvider, 'getClassHashAt' | 'getChainId' | 'callContract'>;
  relayer: Pick<Account, 'estimateInvokeFee' | 'execute'>;
  classHash: string;
  chainId: string;
  funding?: FundingController;
  paymaster?: SponsoredPaymaster;
  assertPaidAvailable?: () => void | Promise<void>;
  /** Unix seconds; tests may inject a clock. */
  now?: () => number;
};
export const MAX_WALLET_CALLS = 33;
export const MAX_WALLET_OUTSIDE_SECONDS = 900;
const CONTRACT_BOUND = 1n << 251n;
const FELT_BOUND = (1n << 251n) + 17n * (1n << 192n) + 1n;
const VALID = BigInt(shortString.encodeShortString('VALID'));
const selectors = Object.fromEntries([
  'add_or_update_session_key', 'add_or_update_scoped_session_key', 'set_spending_policy',
  'remove_spending_policy', 'revoke_session_key', 'revoke_all_sessions', 'add_owner', 'remove_owner',
].map(name => [hash.getSelectorFromName(name), name]));
const blockedScope = new Set([
  'upgrade', 'add_or_update_session_key', 'revoke_session_key', '__execute__', 'set_public_key',
  'setPublicKey', 'execute_from_outside_v2', 'set_spending_policy', 'remove_spending_policy',
  'add_or_update_scoped_session_key', 'revoke_all_sessions', 'add_owner', 'remove_owner',
  '__validate__', '__validate_declare__', '__validate_deploy__', 'recover', 'prove_jwt',
  'finalize_override_recovery', 'cancel_override_recovery',
].map(name => BigInt(hash.getSelectorFromName(name)).toString()));
const bad = (): never => { throw new HttpError(400, 'WALLET_CALL_NOT_ALLOWED'); };
const uint = (value: bigint, bits: number, positive = false) => value >= (positive ? 1n : 0n) && value < (1n << BigInt(bits));

function validateManagementCall(account: bigint, selector: string, calldata: string[], now: number): void {
  const name = selectors['0x' + BigInt(selector).toString(16)];
  if (!name) bad();
  const data = calldata.map(BigInt);
  if (name === 'revoke_all_sessions') { if (data.length) bad(); return; }
  if (name === 'revoke_session_key' || name === 'remove_owner') { if (data.length !== 1 || !data[0]) bad(); return; }
  if (name === 'add_owner') { if (data.length !== 4 || !data[0] || data[1] !== 2n || !data[2] || !data[3]) bad(); return; }
  if (name === 'remove_spending_policy') {
    if (data.length !== 2 || !data[0] || !data[1] || data[1]! >= CONTRACT_BOUND) bad();
    return;
  }
  if (name === 'set_spending_policy') {
    if (data.length !== 7 || !data[0] || !data[1] || data[1]! >= CONTRACT_BOUND
      || !data.slice(2,6).every(v => uint(v,128)) || !(data[4]! || data[5]!) || !uint(data[6]!,64)) bad();
    return;
  }
  if (data.length < 5 || !data[0] || !uint(data[1]!,64) || data[1]! <= BigInt(now)
    || !uint(data[2]!,32,true) || !uint(data[3]!,128) || data[4]! > 64n) bad();
  const count = Number(data[4]);
  const scoped = name === 'add_or_update_scoped_session_key';
  if (scoped && count === 0 || data.length !== 5 + count * (scoped ? 2 : 1)) bad();
  for (let i=0; i<count; i++) {
    const entry = data[5+i*(scoped?2:1)+(scoped?1:0)]!;
    if (!entry || blockedScope.has(entry.toString())) bad();
    if (scoped) {
      const target=data[5+i*2]!;
      if (!target || target >= CONTRACT_BOUND || target === account) bad();
    }
  }
}

function assertWindow(execution: ReturnType<typeof decodeOutsideExecution>, now: number): void {
  const message=execution.typedData.message as Record<string,unknown>;
  const after=BigInt(message['Execute After'] as string), before=BigInt(message['Execute Before'] as string);
  if (!Number.isSafeInteger(now) || after >= BigInt(now) || before <= BigInt(now) || before > BigInt(now+MAX_WALLET_OUTSIDE_SECONDS)) throw new HttpError(400,'WALLET_OUTSIDE_WINDOW');
}

/** Pure shape/allow-list checks happen before any RPC, signing or budget debit. */
export function parseWalletManagement(body: SponsorRequest, chainId: string, now: number) {
  const request=parseSponsorRequest(body);
  if (BigInt(request.account) === 0n || BigInt(request.account) >= CONTRACT_BOUND) throw new HttpError(400,'BAD_ACCOUNT');
  const execution=decodeOutsideExecution(request.calldata,chainId);
  if (execution.signature.length !== 2) throw new HttpError(400,'WALLET_OWNER_SIGNATURE_REQUIRED');
  assertWindow(execution,now);
  const message=execution.typedData.message as Record<string,any>;
  const calls=message.Calls as {To:string;Selector:string;Calldata:string[]}[];
  if (!calls.length || calls.length>MAX_WALLET_CALLS) bad();
  for (const call of calls) {
    if (BigInt(call.To) !== BigInt(request.account)) bad();
    validateManagementCall(BigInt(request.account),call.Selector,call.Calldata,now);
  }
  const messageHash=typedData.getMessageHash(execution.typedData,request.account);
  // One paid attempt for an account/nonce, even if a signer changes calls or signature.
  const debitId=hash.computePoseidonHashOnElements([shortString.encodeShortString('kamui.wallet.v1'),chainId,request.account,message.Nonce]);
  return {request,execution,messageHash,debitId,nonce:message.Nonce as string};
}


async function fundWalletManagement(body: SponsorRequest, ctx: WalletSponsorContext): Promise<SponsorResult> {
  const now=ctx.now ?? (()=>Math.floor(Date.now()/1000));
  const parsed=parseWalletManagement(body,ctx.chainId,now());
  if (!ctx.funding) throw new HttpError(503,'DURABLE_FUNDING_REQUIRED');
  await ctx.assertPaidAvailable?.();
  return withRelayerLock(ctx.relayer as Account,async()=>{
    assertWindow(parsed.execution,now());
    await ctx.assertPaidAvailable?.();
    if (BigInt(await ctx.provider.getChainId()) !== BigInt(ctx.chainId)) throw new HttpError(503,'WALLET_CHAIN_MISMATCH');
    let classHash:string;
    try {classHash=await ctx.provider.getClassHashAt(parsed.request.account);}
    catch(error) {if(error instanceof RpcError && error.isType('CONTRACT_NOT_FOUND')) throw new HttpError(400,'ACCOUNT_NOT_DEPLOYED'); throw error;}
    if (BigInt(classHash)!==BigInt(ctx.classHash)) throw new HttpError(400,'WRONG_CLASS');
    let signature:string[];
    try {signature=await ctx.provider.callContract({contractAddress:parsed.request.account,entrypoint:'is_valid_signature',calldata:[parsed.messageHash,'0x2',...parsed.execution.signature]});}
    catch(error) {if(error instanceof RpcError && error.isType('CONTRACT_ERROR')) throw new HttpError(401,'WALLET_BAD_OWNER_SIGNATURE'); throw error;}
    if (signature.length!==1 || !/^0x[0-9a-fA-F]+$/.test(signature[0]!) || BigInt(signature[0]!)!==VALID) throw new HttpError(401,'WALLET_BAD_OWNER_SIGNATURE');
    const nonce=await ctx.provider.callContract({contractAddress:parsed.request.account,entrypoint:'is_valid_outside_execution_nonce',calldata:[parsed.nonce]});
    if(nonce.length!==1 || !/^0x[0-9a-fA-F]+$/.test(nonce[0]!) || BigInt(nonce[0]!)!==1n) throw new HttpError(409,'WALLET_NONCE_USED');
    const call={contractAddress:parsed.request.account,entrypoint:'execute_from_outside_v2',calldata:parsed.request.calldata};
    const estimate=await ctx.relayer.estimateInvokeFee(call,{skipValidate:false,tip:0n});
    requireSignedFeeBounds(estimate);
    assertWindow(parsed.execution,now());
    await ctx.assertPaidAvailable?.();
    await ctx.funding!.debit({kind:'wallet',account:parsed.request.account,maxFee:maxFee(estimate),id:parsed.debitId,external:Boolean(ctx.paymaster)});
    await ctx.assertPaidAvailable?.();
    assertWindow(parsed.execution,now());
    // No refund after this boundary: an error can conceal a paid submission.
    return ctx.paymaster
      ? ctx.paymaster.execute(parsed.request.account,parsed.execution)
      : ctx.relayer.execute(call,{resourceBounds:estimate.resourceBounds,tip:0n});
  });
}

/** Fixed-label telemetry only; no owner signature, calldata, nonce or account is logged. */
export async function sponsorWalletManagement(body: SponsorRequest, ctx: WalletSponsorContext): Promise<SponsorResult> {
  try {
    const result=await fundWalletManagement(body,ctx);
    if (typeof result?.transaction_hash !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(result.transaction_hash) || BigInt(result.transaction_hash) === 0n || BigInt(result.transaction_hash) >= FELT_BOUND) throw new HttpError(502,'WALLET_SUBMISSION_UNCERTAIN');
    metrics.sponsor.inc({budget:'wallet',decision:'sponsored'});
    if (!ctx.paymaster) metrics.relayerTransactions.inc({kind:'wallet'});
    log('info','wallet_sponsored',{tx:result.transaction_hash});
    return result;
  } catch(error) {
    metrics.sponsor.inc({budget:'wallet',decision:error instanceof HttpError && error.status<500?'refused':'failed'});
    throw error;
  }
}
