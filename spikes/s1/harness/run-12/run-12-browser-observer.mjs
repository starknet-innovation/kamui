// Observe route/status/public transaction hashes only. Never inspect request bodies,
// browser storage, credentials, fragments, JWTs, proofs or private keys.
import { chromium } from '../../../../keychain/node_modules/playwright-core/index.mjs';
import { writeFileSync } from 'node:fs';
const port=Number(process.env.KAMUI_RUN12_CDP_PORT??9222);
const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const records=[];
const path=new URL(`../../results/run-12-browser-events-${port}.json`,import.meta.url);
const persist=()=>writeFileSync(path,JSON.stringify({checkedAt:new Date().toISOString(),events:records},null,2)+'\n');
const wanted=new Set(['/api/wallet/sponsor','/api/sponsor','/api/relay','/api/recover/status','/api/deploy/authenticated','/api/registry/sessions','/api/registry/sessions/list','/api/registry/sessions/remove']);
const terminal=new Set(['/api/wallet/sponsor','/api/sponsor','/api/relay','/api/recover/status','/api/deploy/authenticated']);
const attached=new WeakSet();
function attach(page){
 if(attached.has(page))return;attached.add(page);
 page.on('response',async response=>{
  const url=new URL(response.url());if(!['localhost','127.0.0.1'].includes(url.hostname)||!wanted.has(url.pathname))return;
  const record={at:new Date().toISOString(),path:url.pathname,httpStatus:response.status(),method:response.request().method()};
  if(terminal.has(url.pathname)){
   try{const body=await response.json();
    if(typeof body.status==='string'&&['running','succeeded','failed'].includes(body.status))record.jobStatus=body.status;
    if(typeof body.error==='string'){const code=/^[A-Z_]{3,80}/.exec(body.error)?.[0];if(code)record.error=code;}
    const hash=body.transaction_hash??body.result?.transaction_hash;
    if(typeof hash==='string'&&/^0x[0-9a-fA-F]{1,64}$/.test(hash))record.transaction_hash=hash;
   }catch{}
  }
  records.push(record);persist();
 });
}
for(const context of browser.contexts()){
 for(const page of context.pages())attach(page);
 context.on('page',attach);
}
persist();console.log(JSON.stringify({observer:'ready',cdpPort:port,requestBodiesCaptured:false,storageInspected:false}));
await new Promise(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
await browser.close();
