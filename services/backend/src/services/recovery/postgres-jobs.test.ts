import { describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { randomUUID } from 'node:crypto';
import { PostgresRecoveryJobs, RECOVERY_POSTGRES_SCHEMA } from './postgres-store';
import { digest, type JobRequest, type RecoveryJournal, type RecoveryStatus } from './jobs';
import { journaledTransaction } from './transaction';
import { setLogSink } from '../../log';
import fixture from './fixtures/invoke-v3.json';

const url = process.env.KAMUI_TEST_POSTGRES_URL;
const id = (n: number) => '0x' + n.toString(16).padStart(62, '0');
const request: JobRequest = { account:'0x1', operation:'relay', payload:{ proof:'PROOF_NOT_FOR_DATABASE', signature:['SIGNATURE_NOT_FOR_DATABASE'] } };
const result = { address:'0x1', identity:'0x7', transaction_hash:'0x8' };
const failure = () => ({ status:502, error:'UPSTREAM_UNAVAILABLE' });
const never = () => new Promise<typeof result>(() => {});
const receipt = (status = 'SUCCEEDED', finality = 'ACCEPTED_ON_L2') => ({ getTransactionReceipt:async () => ({ finality_status:finality, execution_status:status }) }) as any;
async function until(jobs:PostgresRecoveryJobs, key:string, status:RecoveryStatus['status']) {
  for(let i=0;i<100;i++) {
    const value = await jobs.status(key);
    if(value.status === status) return value;
    await Bun.sleep(5);
  }
  throw Error('TEST_JOB_TIMEOUT');
}
async function withDatabase(work:(sql:SQL, second:SQL) => Promise<void>) {
  const schema = 'kamui_recovery_' + randomUUID().replaceAll('-','');
  const admin = new SQL(url!, {max:1});
  let first:SQL|undefined, second:SQL|undefined;
  try {
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    first = new SQL(url!,{max:5,connection:{search_path:schema}});
    second = new SQL(url!,{max:5,connection:{search_path:schema}});
    await first.unsafe(RECOVERY_POSTGRES_SCHEMA);
    await work(first,second);
  } finally {
    await first?.close(); await second?.close();
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.close();
  }
}

test('an asynchronous intent commit finishes before broadcast and rejection prevents sending', async () => {
  let sends=0, commit!:()=>void;
  const gate = new Promise<void>(resolve=>{commit=resolve;});
  const ctx:any = { relayer:{getSignedTransaction:async()=>fixture.transaction}, provider:{getChainId:async()=>fixture.chainId,invokeSignedTx:async()=>{sends++;return {transaction_hash:fixture.transaction_hash};}} };
  const work = journaledTransaction(ctx,{contractAddress:'0x1',entrypoint:'recover'}, {}, {beforeSend:async()=>{await gate;},deploymentConfirmed(){}},'recover',result);
  await Bun.sleep(5); expect(sends).toBe(0);
  commit(); await work; expect(sends).toBe(1);
  await expect(journaledTransaction(ctx,{contractAddress:'0x1',entrypoint:'recover'},{},{beforeSend:async()=>{throw Error('COMMIT_FAILED');},deploymentConfirmed(){}},'recover',result)).rejects.toThrow('COMMIT_FAILED');
  expect(sends).toBe(1);
});

describe.skipIf(!url)('PostgreSQL recovery jobs (explicit disposable database)',()=>{
  test('retries execute once, concurrent account/quota admission is atomic, and payloads/capabilities are absent',async()=>{
    await withDatabase(async(sql,second)=>{
      const jobs=await PostgresRecoveryJobs.create(sql,{binding:'test-chain:class',maxActive:1});
      let runs=0;
      await Promise.all(Array.from({length:12},()=>jobs.submit(id(1),request,async()=>{runs++;return never();},failure)));
      await Bun.sleep(10); expect(runs).toBe(1);
      await expect(jobs.submit(id(1),{...request,payload:{}},never,failure)).rejects.toThrow('JOB_CONFLICT');
      await expect(jobs.submit(id(2),{...request,account:'0x2'},never,failure)).rejects.toThrow('RECOVERY_JOBS_FULL');
      const alternate=await PostgresRecoveryJobs.create(second,{binding:'test-chain:class'});
      await expect(alternate.submit(id(2),request,never,failure)).rejects.toThrow('IN_PROGRESS');
      const rows=await sql`SELECT * FROM recovery_jobs`;
      const bytes=JSON.stringify(rows);
      expect(rows[0].id).toBe(digest(id(1)));
      for(const privateValue of [id(1),'PROOF_NOT_FOR_DATABASE','SIGNATURE_NOT_FOR_DATABASE']) expect(bytes).not.toContain(privateValue);
      expect(await jobs.hasSubmission(id(1),request)).toBe(true);
      await expect(jobs.status(id(99))).rejects.toThrow('RECOVERY_JOB_NOT_FOUND');
    });
  });

  test('independent connection admissions cannot exceed global limits or duplicate an account',async()=>{
    await withDatabase(async(sql,second)=>{
      const a=await PostgresRecoveryJobs.create(sql,{binding:'chain:class',maxActive:1});
      const b=await PostgresRecoveryJobs.create(second,{binding:'chain:class',maxActive:1});
      const attempts=await Promise.allSettled(Array.from({length:12},(_,n)=>(n%2?a:b).submit(id(n+1),{...request,account:'0x'+(n+1).toString(16)},never,failure)));
      expect(attempts.filter(x=>x.status==='fulfilled')).toHaveLength(1);
      expect(Number((await sql`SELECT COUNT(*) AS n FROM recovery_jobs WHERE finished_at IS NULL`)[0].n)).toBe(1);
    });
  });

  test('terminal results survive a new store and retention never expires uncertain intents',async()=>{
    await withDatabase(async(sql,second)=>{
      let now=100;
      const jobs=await PostgresRecoveryJobs.create(sql,{binding:'chain:class',now:()=>now,retentionMs:10});
      await jobs.submit(id(1),request,async()=>result,failure);
      await until(jobs,id(1),'succeeded');
      const reopened=await PostgresRecoveryJobs.create(second,{binding:'chain:class',now:()=>now,retentionMs:10});
      expect(await reopened.status(id(1))).toEqual({status:'succeeded',result});
      now=110; await expect(reopened.status(id(1))).rejects.toThrow('RECOVERY_JOB_NOT_FOUND');
      let committed!:()=>void;
      const intentCommitted=new Promise<void>(resolve=>{committed=resolve;});
      await jobs.submit(id(2),request,async journal=>{await journal!.beforeSend({...result,kind:'recover',sender_address:'0xa',nonce:'0x4'});committed();return never();},failure);
      await intentCommitted; now=999999999;
      await reopened.reconcile({getTransactionReceipt:async()=>{throw Error('unavailable');}} as any);
      expect(await reopened.status(id(2))).toEqual({status:'running',phase:'reconciling',transaction_hash:result.transaction_hash});
      await expect(reopened.assertAccountAvailable(request.account)).rejects.toThrow('IN_PROGRESS');
      await reopened.reconcile(receipt());
      expect(await reopened.status(id(2))).toEqual({status:'succeeded',result});
    });
  });

  test('orphaned pre-intent work fails safely; only accepted receipts settle journaled recovery',async()=>{
    await withDatabase(async(sql,second)=>{
      const jobs=await PostgresRecoveryJobs.create(sql,{binding:'chain:class'});
      await jobs.submit(id(1),request,never,failure);
      const restart=await PostgresRecoveryJobs.create(second,{binding:'chain:class'});
      await restart.reconcile(receipt());
      expect(await restart.status(id(1))).toEqual({status:'failed',error:'RECOVERY_INTERRUPTED',httpStatus:409});
      for(const kind of ['recover','prepare','deploy'] as const) {
        const n={recover:2,prepare:3,deploy:4}[kind];
        let ready!:()=>void; const persisted=new Promise<void>(resolve=>{ready=resolve;});
        await jobs.submit(id(n),request,async journal=>{await journal!.beforeSend({...result,kind});ready();return never();},failure);
        await persisted;
        await restart.reconcile(receipt('SUCCEEDED','PRE_CONFIRMED'),id(n));
        expect((await restart.status(id(n))).status).toBe('running');
        await restart.reconcile(receipt(),id(n));
        expect((await restart.status(id(n))).status).toBe(kind==='deploy'?'failed':'succeeded');
      }
      let ready!:()=>void;const persisted=new Promise<void>(resolve=>{ready=resolve;});
      await jobs.submit(id(5),request,async journal=>{await journal!.beforeSend({...result,kind:'recover'});ready();return never();},failure);await persisted;
      await restart.reconcile(receipt('REVERTED'),id(5));
      expect(await restart.status(id(5))).toEqual({status:'failed',error:'RECOVERY_REVERTED',httpStatus:400,transaction_hash:result.transaction_hash});
    });
  });

  test('a stale receipt callback cannot settle an intent changed while its RPC was pending',async()=>{
    await withDatabase(async(sql,second)=>{
      const jobs=await PostgresRecoveryJobs.create(sql,{binding:'chain:class'});
      let ready!:()=>void;const persisted=new Promise<void>(resolve=>{ready=resolve;});
      await jobs.submit(id(1),request,async journal=>{await journal!.beforeSend({...result,kind:'recover'});ready();return never();},failure);await persisted;
      const restart=await PostgresRecoveryJobs.create(second,{binding:'chain:class'});
      let answer!:(r:any)=>void,queried!:()=>void;
      const requested=new Promise<void>(resolve=>{queried=resolve;});
      const pending=restart.reconcile({getTransactionReceipt:async()=>{queried();return new Promise(resolve=>{answer=resolve;});}} as any);
      await requested;
      await sql`UPDATE recovery_jobs SET intent = ${JSON.stringify({...result,transaction_hash:'0x9',kind:'recover'})} WHERE id = ${digest(id(1))}`;
      answer({finality_status:'ACCEPTED_ON_L2',execution_status:'SUCCEEDED'});await pending;
      expect((await restart.status(id(1))).status).toBe('running');
      await restart.reconcile(receipt());
      expect(await restart.status(id(1))).toEqual({status:'succeeded',result:{...result,transaction_hash:'0x9'}});
    });
  });

  test('operator supersession requires the exact sender/nonce and L1 finality',async()=>{
    await withDatabase(async(sql,second)=>{
      const jobs=await PostgresRecoveryJobs.create(sql,{binding:'chain:class'});
      let ready!:()=>void;const persisted=new Promise<void>(resolve=>{ready=resolve;});
      await jobs.submit(id(1),request,async journal=>{await journal!.beforeSend({...result,kind:'recover',sender_address:'0xa',nonce:'0x4'});ready();return never();},failure);await persisted;
      const operator=await PostgresRecoveryJobs.create(second,{binding:'chain:class'});
      const provider=(sender:string,nonce:string,finality='ACCEPTED_ON_L1')=>({getTransactionReceipt:async()=>({finality_status:finality}),getTransactionByHash:async()=>({sender_address:sender,nonce})}) as any;
      await expect(operator.resolveSuperseded('0x8','0x9',provider('0xa','0x4','ACCEPTED_ON_L2'))).rejects.toThrow('REPLACEMENT_NOT_FINAL');
      await expect(operator.resolveSuperseded('0x8','0x9',provider('0xb','0x4'))).rejects.toThrow('REPLACEMENT_NONCE_MISMATCH');
      await expect(operator.assertAccountAvailable('0x1')).rejects.toThrow('IN_PROGRESS');
      await operator.resolveSuperseded('0x8','0x9',provider('0xa','0x4'));
      expect(await operator.status(id(1))).toEqual({status:'failed',error:'RECOVERY_SUPERSEDED',httpStatus:409,transaction_hash:'0x8'});
    });
  });

  test('binding is immutable and concurrent compare-and-swap intent writes admit exactly one',async()=>{
    await withDatabase(async(sql)=>{
      const jobs=await PostgresRecoveryJobs.create(sql,{binding:'chain:class'});
      await expect(PostgresRecoveryJobs.create(sql,{binding:'other-chain:class'})).rejects.toThrow('RECOVERY_DB_NETWORK_MISMATCH');
      let journal!:RecoveryJournal,ready!:()=>void; const available=new Promise<void>(resolve=>{ready=resolve;});
      await jobs.submit(id(1),request,async j=>{journal=j!;ready();return never();},failure);await available;
      const changes=await Promise.allSettled([journal.beforeSend({...result,kind:'recover'}),journal.beforeSend({...result,kind:'recover',transaction_hash:'0x9'})]);
      expect(changes.filter(x=>x.status==='fulfilled')).toHaveLength(1);
      await sql`UPDATE recovery_jobs SET finished_at = 100 WHERE id = ${digest(id(1))}`;
      await expect(Promise.resolve().then(()=>journal.deploymentConfirmed())).rejects.toThrow('RECOVERY_INTENT_CHANGED');
      await expect(Promise.resolve().then(()=>journal.beforeSend({...result,kind:'recover'}))).rejects.toThrow('RECOVERY_INTENT_CHANGED');
    });
  });

  test('a completion persistence error is logged without an unhandled rejection and leaves the journal locked',async()=>{
    await withDatabase(async(sql)=>{
      const jobs=await PostgresRecoveryJobs.create(sql,{binding:'chain:class'});
      let journal!:RecoveryJournal,finish!:(r:typeof result)=>void,ready!:()=>void;
      const available=new Promise<void>(resolve=>{ready=resolve;});
      await jobs.submit(id(1),request,async j=>{journal=j!;ready();return new Promise(resolve=>{finish=resolve;});},failure);await available;
      await journal.beforeSend({...result,kind:'recover'});
      // Deny only terminal updates, retaining queries/reconciliation and the committed intent.
      await sql.unsafe(`CREATE FUNCTION deny_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.finished_at IS NOT NULL THEN RAISE EXCEPTION 'PRIVATE_DRIVER_PAYLOAD'; END IF; RETURN NEW; END $$`);
      await sql.unsafe(`CREATE TRIGGER deny_finish BEFORE UPDATE ON recovery_jobs FOR EACH ROW EXECUTE FUNCTION deny_finish()`);
      const logs:string[]=[];const previous=setLogSink(line=>logs.push(line));
      try {finish(result);await Bun.sleep(40);}finally{setLogSink(previous);}
      expect(logs.some(line=>line.includes('recovery_journal_write_failed'))).toBe(true);
      expect(logs.join('')).not.toContain('PRIVATE_DRIVER_PAYLOAD');
      await expect(jobs.assertAccountAvailable(request.account)).rejects.toThrow('IN_PROGRESS');
      expect((await jobs.status(id(1))).status).toBe('running');
    });
  });
});
