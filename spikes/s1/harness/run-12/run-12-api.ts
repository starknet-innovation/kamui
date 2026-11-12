// Run only after the user-approved run-12 budget and stopped-writer checks.
// Run from services/backend so Bun loads its existing runtime config normally.
// This wrapper never reads/exports/signs with a private key itself.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import '../../../../services/backend/src/env';

try {
  const directory=process.env.KAMUI_RUN12_DIRECTORY;
  if(!directory||!isAbsolute(directory)||(statSync(directory).mode&0o077)!==0)throw Error('RUN12_PRIVATE_DIRECTORY_REQUIRED');
  const settings=JSON.parse(readFileSync(join(directory,'runtime.json'),'utf8'));
  if(settings.approvedMaxAttempts!==4||settings.approvedTotalFri!=='12000000000000000000'||settings.approvedPerTxFri!=='5000000000000000000')throw Error('RUN12_APPROVED_BOUNDS_REQUIRED');
  const policy=JSON.parse(readFileSync(join(directory,'policy.json'),'utf8'));
  if(policy.global.txPerPeriod>4||BigInt(policy.global.maxFeePerTx)>5n*10n**18n||BigInt(policy.global.maxFeePerPeriod)>12n*10n**18n||policy.allowExternalPaymaster!==false)throw Error('RUN12_POLICY_OUTSIDE_BOUNDS');
  if(BigInt(process.env.RELAYER_ADDRESS??'0')!==BigInt('0x5bf22a824e3d20dfe018fab5de043a9cab41c45361f4ded0f2e2fc51776118e'))throw Error('RUN12_RELAYER_REVIEW_REQUIRED');
  if(process.env.SECRET_SOURCE && process.env.SECRET_SOURCE!=='env')throw Error('RUN12_SECRET_SOURCE_REVIEW_REQUIRED');
  Object.assign(process.env,{STORAGE_BACKEND:'postgres',DATABASE_URL:settings.postgresUrl,REGISTRY_DB:'',RECOVERY_DB:'',DATABASE_URL_FILE:'',FUNDING_POLICY_FILE:join(directory,'policy.json'),RESTORE_GATE_FILE:join(directory,'restore-gate/state.json'),CHAIN_ID:'SN_SEPOLIA',PAYMASTER_URL:'',PAYMASTER_API_KEY:'',PAYMASTER_API_KEY_FILE:'',DEPLOYS_PER_HOUR:'0',METRICS_PORT:'0',HOST:'127.0.0.1',PORT:'3000'});
  writeFileSync(join(directory,'api.pid'),String(process.pid),{mode:0o600});
  await import('../../../../services/backend/src/services/api/index');
} catch(error) {
  const code=error instanceof Error&&/^RUN12_[A-Z_]+$/.test(error.message)?error.message:'RUN12_STARTUP_REFUSED';
  console.error(JSON.stringify({status:'refused',error:code}));process.exit(1);
}
