// Stop only this run's API and only before live recovery work begins.
import {SQL} from 'bun';
import{readFileSync}from'node:fs';
import{join}from'node:path';
import{spawnSync}from'node:child_process';
let sql:SQL|undefined;
try{
 const dir=process.env.KAMUI_RUN12_DIRECTORY;if(!dir)throw Error('RUN12_DIRECTORY_REQUIRED');
 const runtime=JSON.parse(readFileSync(join(dir,'runtime.json'),'utf8'));
 sql=new SQL(runtime.postgresUrl,{max:1,connection:{default_transaction_read_only:'on'}});
 if(Number((await sql`SELECT COUNT(*) AS n FROM recovery_jobs WHERE finished_at IS NULL`)[0].n)!==0)throw Error('RUN12_ACTIVE_RECOVERY_USE_RECEIPT_MONITOR');
 const pid=Number(readFileSync(join(dir,'api.pid'),'utf8'));
 const listeners=spawnSync('lsof',['-t','-nP','-iTCP:3000','-sTCP:LISTEN'],{encoding:'utf8'}).stdout.trim().split(/\s+/).filter(Boolean);
 if(!Number.isSafeInteger(pid)||listeners.length!==1||listeners[0]!==String(pid))throw Error('RUN12_API_PID_MISMATCH');
 process.kill(pid,'SIGTERM');
 for(let i=0;i<100;i++){
  if(!spawnSync('lsof',['-t','-nP','-iTCP:3000','-sTCP:LISTEN'],{encoding:'utf8'}).stdout.trim())break;
  await Bun.sleep(100);
 }
 if(spawnSync('lsof',['-t','-nP','-iTCP:3000','-sTCP:LISTEN'],{encoding:'utf8'}).stdout.trim())throw Error('RUN12_API_DID_NOT_STOP');
 console.log(JSON.stringify({status:'stopped',unfinishedRecoveryJobs:0}));
}catch(e){console.error(JSON.stringify({status:'refused',error:e instanceof Error&&/^RUN12_[A-Z_]+$/.test(e.message)?e.message:'RUN12_STOP_FAILED'}));process.exitCode=1;}
finally{await sql?.close();}
