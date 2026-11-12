// Run-12 offline controls and read-only accounting. No signing keys are read.
import { SQL } from 'bun';
import { readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquirePostgresWriterLock, initializePostgres } from '../../../../services/backend/src/storage/postgres';
import { PostgresFunding, disabledFundingPolicy } from '../../../../services/backend/src/services/sponsor/funding';
import { initializeRestoreGate, acknowledgeRestoreGate } from '../../../../services/backend/src/storage/restore-fence';
const action=process.argv[2];
try{
  const directory=process.env.KAMUI_RUN12_DIRECTORY;
  if(!directory||!isAbsolute(directory)||(statSync(directory).mode&0o077)!==0)throw Error('RUN12_PRIVATE_DIRECTORY_REQUIRED');
  const runtime=JSON.parse(readFileSync(join(directory,'runtime.json'),'utf8'));
  if(runtime.approvedMaxAttempts!==4||runtime.approvedTotalFri!=='12000000000000000000')throw Error('RUN12_APPROVED_BOUNDS_REQUIRED');
  if(action==='summary'){
    const sql=new SQL(runtime.postgresUrl,{max:1,connection:{default_transaction_read_only:'on'}});
    try{
      const [schema]=await sql`SELECT value FROM kamui_storage_meta WHERE key='schema_version'`;
      const totals=await sql`SELECT kind,COUNT(*)::text AS attempts,COALESCE(SUM(fee),0)::text AS maximum_debited_fri FROM funding_debits GROUP BY kind ORDER BY kind`;
      const [paused]=await sql`SELECT paused FROM funding_control WHERE key='global'`;
      const jobs=await sql`SELECT state::jsonb->>'status' AS state,COUNT(*)::text AS jobs FROM recovery_jobs GROUP BY state::jsonb->>'status' ORDER BY state`;
      const [sessions]=await sql`SELECT COUNT(*)::text AS count FROM registry_sessions`;
      console.log(JSON.stringify({schemaVersion:schema?.value,paused:paused?.paused,totals,jobs,registryRows:sessions?.count},null,2));
    }finally{await sql.close();}
  }else{
    if(!['initialize','pause','resume','cap-one','cap-four'].includes(action??''))throw Error('RUN12_CONTROL_USAGE');
    const listeners=spawnSync('lsof',['-t','-nP','-iTCP:3000','-sTCP:LISTEN'],{encoding:'utf8'});
    if(listeners.stdout.trim())throw Error('RUN12_STOP_API_REQUIRED');
    const lease=await acquirePostgresWriterLock(runtime.postgresUrl,()=>process.exit(1));
    try{
      if(action==='initialize'){
        const tables=await lease.sql`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'`;
        if(tables.length)throw Error('RUN12_FRESH_DATABASE_REQUIRED');
        const path=join(directory,'restore-gate/state.json');
        const gate=initializeRestoreGate(path);
        acknowledgeRestoreGate(path,{version:1,generation:gate.generation,mode:'fresh',reviewRef:'run-12-local-sepolia',apiAndRotatorStopped:true,originalWriterCannotRestart:true});
        await initializePostgres(lease.sql);
      }else if(action==='pause'||action==='resume'){
        await new PostgresFunding(lease.sql,disabledFundingPolicy()).setPaused(action==='pause');
      }else{
        const policyPath=join(directory,'policy.json');
        const policy=JSON.parse(readFileSync(policyPath,'utf8'));
        policy.global.txPerPeriod=action==='cap-one'?1:4;
        policy.global.perAccountPerPeriod=action==='cap-one'?1:4;
        const temporary=join(directory,'policy.tmp');writeFileSync(temporary,JSON.stringify(policy,null,2),{mode:0o600});renameSync(temporary,policyPath);
      }
      console.log(JSON.stringify({status:'ok',action}));
    }finally{await lease.close();}
  }
}catch(error){const code=error instanceof Error&&/^(RUN12|POSTGRES)_[A-Z_]+$/.test(error.message)?error.message:'RUN12_CONTROL_FAILED';console.error(JSON.stringify({status:'refused',error:code}));process.exitCode=1;}
