// Read-only monitor. Stop only the run-12 API after an independently accepted
// recovery receipt; never interrupt the intent-before-broadcast uncertainty window.
import { SQL } from 'bun';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const RPC='https://api.zan.top/public/starknet-sepolia/rpc/v0_10';
let sql:SQL|undefined;
try{
 const directory=process.env.KAMUI_RUN12_DIRECTORY;if(!directory)throw Error('RUN12_DIRECTORY_REQUIRED');
 const runtime=JSON.parse(readFileSync(join(directory,'runtime.json'),'utf8'));
 sql=new SQL(runtime.postgresUrl,{max:1,connection:{default_transaction_read_only:'on'}});
 const deadline=Date.now()+20*60_000;
 let done=false;
 while(Date.now()<deadline&&!done){
  const rows=await sql`SELECT intent::jsonb->>'transaction_hash' AS hash FROM recovery_jobs WHERE finished_at IS NULL AND intent IS NOT NULL AND intent::jsonb->>'kind'='recover'`;
  for(const row of rows){
   if(!/^0x[0-9a-fA-F]{1,64}$/.test(row.hash))continue;
   let receipt:any;
   try{const response=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'starknet_getTransactionReceipt',params:{transaction_hash:row.hash}}),signal:AbortSignal.timeout(3000)});receipt=(await response.json() as any).result;}catch{continue;}
   if(!receipt||!['ACCEPTED_ON_L2','ACCEPTED_ON_L1'].includes(receipt.finality_status)||receipt.execution_status!=='SUCCEEDED')continue;
   if(!(await sql`SELECT 1 FROM recovery_jobs WHERE finished_at IS NULL AND intent::jsonb->>'transaction_hash'=${row.hash}`).length)continue;
   const pid=Number(readFileSync(join(directory,'api.pid'),'utf8'));
   const listeners=spawnSync('lsof',['-t','-nP','-iTCP:3000','-sTCP:LISTEN'],{encoding:'utf8'}).stdout.trim().split(/\s+/).filter(Boolean).map(Number);
   if(!Number.isSafeInteger(pid)||listeners.length!==1||listeners[0]!==pid)throw Error('RUN12_API_PID_MISMATCH');
   process.kill(pid,'SIGTERM');
   for(let n=0;n<100;n++){
    const check=spawnSync('lsof',['-t','-nP','-iTCP:3000','-sTCP:LISTEN'],{encoding:'utf8'});
    if(!check.stdout.trim())break;
    await Bun.sleep(100);
   }
   if(spawnSync('lsof',['-t','-nP','-iTCP:3000','-sTCP:LISTEN'],{encoding:'utf8'}).stdout.trim())throw Error('RUN12_API_DID_NOT_STOP');
   const [after]=await sql`SELECT finished_at IS NULL AS unfinished FROM recovery_jobs WHERE intent::jsonb->>'transaction_hash'=${row.hash} OR state::jsonb->'result'->>'transaction_hash'=${row.hash}`;
   const evidence={checkedAt:new Date().toISOString(),transaction_hash:row.hash,independentReceipt:{execution_status:receipt.execution_status,finality_status:receipt.finality_status,block_number:receipt.block_number,actual_fee:{amount:receipt.actual_fee?.amount,unit:receipt.actual_fee?.unit}},unfinishedObservedBeforeStop:true,unfinishedAfterStop:after?.unfinished===true,apiStopped:true,manualRestartRequired:true};
   writeFileSync(join(import.meta.dir,'../../results/run-12-restart-event.json'),JSON.stringify(evidence,null,2)+'\n');
   console.log(JSON.stringify(evidence));done=true;break;
  }
  if(!done)await Bun.sleep(200);
 }
 if(!done)console.log(JSON.stringify({status:'monitor_expired',apiStopped:false,orphanReconciliationNotEstablished:true}));
}catch(error){console.error(JSON.stringify({status:'refused',error:error instanceof Error&&/^RUN12_[A-Z_]+$/.test(error.message)?error.message:'RUN12_RECOVERY_MONITOR_FAILED'}));process.exitCode=1;}
finally{await sql?.close();}
