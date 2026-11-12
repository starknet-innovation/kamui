import { expect, test, describe } from 'bun:test';
import { hash, shortString, type Call } from 'starknet';
import { randomUUID } from 'node:crypto';
import { SQL } from 'bun';
import { outsideExecutionCall, outsideExecutionHash } from '../../../../../sdk/src/outside';
import { addSessionCall, setSpendingPolicyCall, revokeSessionCall, revokeAllSessionsCall } from '../../../../../sdk/src/sessions';
import { addOwnerCall, removeOwnerCall } from '../../../../../sdk/src/owners';
import { parseWalletManagement, sponsorWalletManagement, type WalletSponsorContext } from './wallet-sponsor';
import { FUNDING_SCHEMA_SQL, FUNDING_V3_MIGRATION_SQL, PostgresFunding, disabledFundingPolicy, parseFundingPolicy, type FundingLimit } from '../sponsor/funding';

const now=1_800_000_000,chainId='0x534e5f5345504f4c4941' as const,account='0x123',classHash='0x456';
const window={executeBefore:now+600};
const bound:FundingLimit={periodSeconds:3600,txPerPeriod:10,perAccountPerPeriod:10,maxFeePerTx:1000n,maxFeePerPeriod:10000n,perAccountMaxFeePerPeriod:10000n};
const signed=(calls:Call[]= [revokeAllSessionsCall(account)],nonce='0x1',signature=['0x2','0x3'])=>({account,calldata:outsideExecutionCall(account,calls,nonce,window,signature).calldata as string[]});
const bounds={l1_gas:{max_amount:1n,max_price_per_unit:1n},l2_gas:{max_amount:1n,max_price_per_unit:1n},l1_data_gas:{max_amount:1n,max_price_per_unit:1n}};
function context() {
  const seen={rpc:0,estimated:0,sent:0,debits:0,appAuth:0,signatureHash:'',nonce:'',details:{} as any};
  const ctx:WalletSponsorContext={classHash,chainId,now:()=>now,provider:{getChainId:async()=>{seen.rpc++;return chainId;},getClassHashAt:async()=>{seen.rpc++;return classHash;},callContract:async(call)=>{
    seen.rpc++;if(call.entrypoint==='is_valid_signature'){seen.signatureHash=(call.calldata as string[])[0]!;return[shortString.encodeShortString('VALID')];} seen.nonce=(call.calldata as string[])[0]!;return['0x1'];
  }},relayer:{estimateInvokeFee:async(_call,details)=>{seen.estimated++;seen.details=details;return{overall_fee:3n,resourceBounds:bounds} as any;},execute:async()=>{seen.sent++;return{transaction_hash:'0xabc'};}},funding:{authorizeApp(){seen.appAuth++;throw Error('APP_AUTH_NOT_A_WALLET_ROUTE');},debit:async(request)=>{expect(request.kind).toBe('wallet');seen.debits++;}}};
  return {ctx,seen};
}

test('wallet signed hash matches SDK and explicit self-management calls use owner validation',async()=>{
  const calls=[addSessionCall(account,{sessionPublicKey:'0x5',validUntil:now+3600,maxCalls:2,maxFeePerTx:0,scope:{kind:'contracts',calls:[{to:'0x789',entrypoint:'ping'}]}}),setSpendingPolicyCall(account,'0x5',{token:'0x987',maxPerCall:1,maxPerWindow:2,windowSeconds:3600})];
  const body=signed(calls), parsed=parseWalletManagement(body,chainId,now);
  expect(parsed.messageHash).toBe(outsideExecutionHash(chainId,account,calls,'0x1',window));
  const {ctx,seen}=context();
  expect(await sponsorWalletManagement(body,ctx)).toEqual({transaction_hash:'0xabc'});
  expect(seen.signatureHash).toBe(parsed.messageHash);expect(seen.debits).toBe(1);expect(seen.sent).toBe(1);expect(seen.appAuth).toBe(0);
  expect(seen.details.skipValidate).toBe(false);expect(seen.details.tip).toBe(0n);
  for(const call of [revokeSessionCall(account,'0x5'),removeOwnerCall(account,'0x5'),addOwnerCall(account,'0x6',['0x7','0x8']),{contractAddress:account,entrypoint:'remove_spending_policy',calldata:['0x5','0x987']}]) expect(parseWalletManagement(signed([call]),chainId,now).request.account).toBe(account);
});

test('invalid targets/selectors/batches/Cairo types/windows refuse before RPC or debit',async()=>{
  const badCalls:Call[][]=[[],[{contractAddress:'0x987',entrypoint:'transfer',calldata:['0x5','0x1','0x0']}],[{contractAddress:account,entrypoint:'execute_from_outside_v2',calldata:[]}],[revokeAllSessionsCall(account),{contractAddress:'0x987',entrypoint:'ping',calldata:[]}],[{contractAddress:account,entrypoint:'recover',calldata:[]}],[{contractAddress:account,entrypoint:'revoke_all_sessions',calldata:['0x1']}],[{contractAddress:account,entrypoint:'add_owner',calldata:['0x4','0x4','0x1','0x2','0x3','0x4']}],[{contractAddress:account,entrypoint:'set_spending_policy',calldata:['0x5','0x987','0x1','0x0','0x0','0x0','0x1']}],[{contractAddress:account,entrypoint:'add_or_update_session_key',calldata:['0x5','0x'+(2n**64n).toString(16),'0x1','0x0','0x0']}],[{contractAddress:account,entrypoint:'add_or_update_scoped_session_key',calldata:['0x5','0x'+BigInt(now+3600).toString(16),'0x1','0x0','0x1',account,hash.getSelectorFromName('ping')]}]];
  const {ctx,seen}=context();
  for(const calls of badCalls) await expect(sponsorWalletManagement(signed(calls),ctx)).rejects.toThrow();
  await expect(sponsorWalletManagement(signed(undefined,'0x1',['0x5','0x2','0x3','0x4']),ctx)).rejects.toThrow('WALLET_OWNER_SIGNATURE_REQUIRED');
  const expired=signed();expired.calldata[3]='0x'+BigInt(now).toString(16);
  await expect(sponsorWalletManagement(expired,ctx)).rejects.toThrow('WALLET_OUTSIDE_WINDOW');
  const future=signed();future.calldata[3]='0x'+BigInt(now+901).toString(16);
  await expect(sponsorWalletManagement(future,ctx)).rejects.toThrow('WALLET_OUTSIDE_WINDOW');
  expect(seen.rpc).toBe(0);expect(seen.debits).toBe(0);expect(seen.sent).toBe(0);
});

test('wrong chain/class, non-owner signature and used nonce never reach fee estimation',async()=>{
  for(const kind of ['chain','class','signature','nonce'] as const){
    const {ctx,seen}=context();
    if(kind==='chain')ctx.provider.getChainId=async()=> '0x534e5f4d41494e';
    if(kind==='class')ctx.provider.getClassHashAt=async()=> '0x999';
    if(kind==='signature')ctx.provider.callContract=async()=>['0x0'];
    if(kind==='nonce')ctx.provider.callContract=async(call)=>call.entrypoint==='is_valid_signature'?[shortString.encodeShortString('VALID')]:['0x0'];
    await expect(sponsorWalletManagement(signed(),ctx)).rejects.toThrow();expect(seen.estimated).toBe(0);expect(seen.debits).toBe(0);expect(seen.sent).toBe(0);
  }
});

test('durable funding/restore guards and complete fee bounds are mandatory',async()=>{
  const {ctx,seen}=context();ctx.funding=undefined;
  await expect(sponsorWalletManagement(signed(),ctx)).rejects.toThrow('DURABLE_FUNDING_REQUIRED');expect(seen.rpc).toBe(0);
  const guarded=context();guarded.ctx.assertPaidAvailable=()=>{throw Error('RESTORE_RECONCILIATION_REQUIRED');};
  await expect(sponsorWalletManagement(signed(),guarded.ctx)).rejects.toThrow('RESTORE_RECONCILIATION_REQUIRED');expect(guarded.seen.rpc).toBe(0);
  const partial=context();partial.ctx.relayer.estimateInvokeFee=async()=>({overall_fee:3n,resourceBounds:{l2_gas:bounds.l2_gas}} as any);
  await expect(sponsorWalletManagement(signed(),partial.ctx)).rejects.toThrow('SIGNED_FEE_BOUNDS_REQUIRED');expect(partial.seen.debits).toBe(0);expect(partial.seen.sent).toBe(0);
});

test('paid nonce identity binds chain/account/nonce despite changed calls/signature',()=>{
  const first=parseWalletManagement(signed(),chainId,now);
  expect(parseWalletManagement(signed([revokeSessionCall(account,'0x5')],'0x1',['0x7','0x8']),chainId,now).debitId).toBe(first.debitId);
  expect(parseWalletManagement(signed(undefined,'0x2'),chainId,now).debitId).not.toBe(first.debitId);
  expect(parseWalletManagement(signed(),shortString.encodeShortString('SN_MAIN'),now).debitId).not.toBe(first.debitId);
});

const url=process.env.KAMUI_TEST_POSTGRES_URL;
describe.skipIf(!url)('PostgreSQL wallet accounting',()=>{
  async function withDatabase(work:(sql:SQL,second:SQL)=>Promise<void>){
    const schema='kamui_wallet_'+randomUUID().replaceAll('-','');const admin=new SQL(url!);let sql:SQL|undefined,second:SQL|undefined;
    try{await admin.unsafe(`CREATE SCHEMA ${schema}`);sql=new SQL(url!,{max:3,connection:{search_path:schema}});second=new SQL(url!,{max:3,connection:{search_path:schema}});await sql.unsafe(FUNDING_SCHEMA_SQL);await sql`UPDATE funding_control SET paused=false WHERE key='global'`;await work(sql,second);}
    finally{await sql?.close();await second?.close();await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);await admin.close();}
  }
  test('old policies disable wallet; lost submission remains spent across a new store',async()=>{
    await withDatabase(async(sql,second)=>{
      const p=disabledFundingPolicy();p.global={...bound};p.operations.sponsor={...bound};p.operations.deployment={...bound};p.operations.recovery={...bound};
      const old=JSON.parse(JSON.stringify(p,(_,v)=>typeof v==='bigint'?v.toString():v));delete old.operations.wallet;
      expect(parseFundingPolicy(old).operations.wallet!.txPerPeriod).toBe(0);
      const a=context();a.ctx.funding=new PostgresFunding(sql,parseFundingPolicy(old));
      await expect(sponsorWalletManagement(signed(),a.ctx)).rejects.toThrow('FUNDING_DISABLED');expect(a.seen.sent).toBe(0);
      p.operations.wallet={...bound};a.ctx.funding=new PostgresFunding(sql,p);a.ctx.relayer.execute=async()=>{a.seen.sent++;throw Error('LOST_RESPONSE');};
      await expect(sponsorWalletManagement(signed(),a.ctx)).rejects.toThrow('LOST_RESPONSE');
      const b=context();b.ctx.funding=new PostgresFunding(second,p);
      await expect(sponsorWalletManagement(signed([revokeSessionCall(account,'0x5')]),b.ctx)).rejects.toThrow('FUNDING_ALREADY_DEBITED');
      expect(a.seen.sent).toBe(1);expect(b.seen.sent).toBe(0);
      const rows:{kind:string;app:null}[]=await sql`SELECT kind,app FROM funding_debits`;
      expect(rows).toEqual([{kind:'wallet',app:null}]);
    });
  });
  test('concurrent changed payloads with one nonce can cause only one paid attempt',async()=>{
    await withDatabase(async(sql,second)=>{
      const p=disabledFundingPolicy();p.global={...bound};p.operations.wallet={...bound};
      const a=context(),b=context();a.ctx.funding=new PostgresFunding(sql,p);b.ctx.funding=new PostgresFunding(second,p);
      const attempts=await Promise.allSettled(Array.from({length:12},(_,i)=>sponsorWalletManagement(signed([revokeSessionCall(account,'0x'+(i+1).toString(16))]),i%2?a.ctx:b.ctx)));
      expect(attempts.filter(r=>r.status==='fulfilled')).toHaveLength(1);
      expect(a.seen.sent+b.seen.sent).toBe(1);
      expect(Number((await sql`SELECT COUNT(*) AS n FROM funding_debits`)[0].n)).toBe(1);
    });
  });
  test('external wallet spending requires opt-in and never falls back after uncertainty',async()=>{
    await withDatabase(async(sql,second)=>{
      const p=disabledFundingPolicy();p.global={...bound};p.operations.wallet={...bound};
      const a=context();a.ctx.funding=new PostgresFunding(sql,p);let externalSends=0;
      a.ctx.relayer.execute=async()=>{throw Error('LOCAL_FALLBACK_FORBIDDEN');};
      a.ctx.paymaster={prepare(){throw Error('SIGNED_PAYLOAD_ALREADY_DECODED');},execute:async()=>{externalSends++;throw Error('EXTERNAL_RESPONSE_LOST');}};
      await expect(sponsorWalletManagement(signed(),a.ctx)).rejects.toThrow('EXTERNAL_SPENDING_CONTROLS_REQUIRED');
      expect(externalSends).toBe(0);
      p.allowExternalPaymaster=true;
      await expect(sponsorWalletManagement(signed(),a.ctx)).rejects.toThrow('EXTERNAL_RESPONSE_LOST');
      a.ctx.funding=new PostgresFunding(second,p);
      await expect(sponsorWalletManagement(signed(),a.ctx)).rejects.toThrow('FUNDING_ALREADY_DEBITED');
      expect(externalSends).toBe(1);
      expect((await sql`SELECT external FROM funding_debits`)[0].external).toBe(true);
    });
  });
  test('a restore block after debit prevents sending and retains conservative accounting',async()=>{
    await withDatabase(async sql=>{
      const p=disabledFundingPolicy();p.global={...bound};p.operations.wallet={...bound};
      const a=context();let blocked=false;const funding=new PostgresFunding(sql,p);
      a.ctx.assertPaidAvailable=()=>{if(blocked)throw Error('RESTORE_RECONCILIATION_REQUIRED');};
      a.ctx.funding={authorizeApp(){throw Error('NOT_APP');},debit:async request=>{await funding.debit(request);blocked=true;}};
      await expect(sponsorWalletManagement(signed(),a.ctx)).rejects.toThrow('RESTORE_RECONCILIATION_REQUIRED');
      expect(a.seen.sent).toBe(0);
      expect(Number((await sql`SELECT COUNT(*) AS n FROM funding_debits`)[0].n)).toBe(1);
    });
  });
  test('a malformed submission answer is uncertain and keeps its paid nonce reservation',async()=>{
    await withDatabase(async sql=>{
      const p=disabledFundingPolicy();p.global={...bound};p.operations.wallet={...bound};
      const a=context();a.ctx.funding=new PostgresFunding(sql,p);
      a.ctx.relayer.execute=async()=>({transaction_hash:'NOT_A_HASH_PRIVATE_FIXTURE'});
      await expect(sponsorWalletManagement(signed(),a.ctx)).rejects.toThrow('WALLET_SUBMISSION_UNCERTAIN');
      await expect(sponsorWalletManagement(signed(),a.ctx)).rejects.toThrow('FUNDING_ALREADY_DEBITED');
      expect(Number((await sql`SELECT COUNT(*) AS n FROM funding_debits`)[0].n)).toBe(1);
    });
  });
  test('CHECK migration retains old rows and operator pause state',async()=>{
    await withDatabase(async(sql)=>{
      await sql.unsafe("ALTER TABLE funding_debits DROP CONSTRAINT funding_debits_kind_check;ALTER TABLE funding_debits ADD CONSTRAINT funding_debits_kind_check CHECK(kind IN ('sponsor','deployment','recovery'))");
      await sql`INSERT INTO funding_debits(id,kind,account,fee,created_at,external) VALUES ('old','recovery','0x1',1,1,false)`;
      await sql.unsafe(FUNDING_V3_MIGRATION_SQL);
      await sql`INSERT INTO funding_debits(id,kind,account,fee,created_at,external) VALUES ('wallet-fixture','wallet','0x1',1,1,false)`;
      expect((await sql`SELECT COUNT(*)::int AS n FROM funding_debits`)[0].n).toBe(2);
      expect((await sql`SELECT paused FROM funding_control WHERE key='global'`)[0].paused).toBe(false);
    });
  });
});
