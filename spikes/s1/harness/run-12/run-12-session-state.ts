// Derive only the PUBLIC session key from the accepted registration event, not storage.
import {RpcProvider,hash} from '../../../../sdk/node_modules/starknet';
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
const stage=process.argv[2];
const account='0x133739e82cd76b5a6446848ae0cbbbb8cc4762fbb8e0eb5ebc417209423e0e9';
const provider=new RpcProvider({nodeUrl:'https://api.zan.top/public/starknet-sepolia/rpc/v0_10'});
const output=new URL('../../results/run-12-session-states.json',import.meta.url);
try{
 if(!['before_recovery','after_recovery','after_revoke'].includes(stage??''))throw Error();
 const receipts=JSON.parse(readFileSync(new URL('../../results/run-12-receipts.json',import.meta.url),'utf8'));
 const registration=receipts.find((r:any)=>r.kind==='wallet_session_approval');
 const receipt:any=await provider.getTransactionReceipt(registration.transaction_hash);
 const selector=hash.getSelectorFromName('SessionKeySet');
 const events=receipt.events.filter((e:any)=>BigInt(e.from_address)===BigInt(account)&&e.keys.some((key:string)=>BigInt(key)===BigInt(selector)));
 if(events.length!==1)throw Error();
 const publicKey=events[0].keys.at(-1);
 const block=stage==='before_recovery'?JSON.parse(readFileSync(new URL('../../results/run-12-public-checkpoints.json',import.meta.url),'utf8')).beforeRecoveryBlock:await provider.getBlockNumber();
 const [data,epoch]=await Promise.all([provider.callContract({contractAddress:account,entrypoint:'get_session_data',calldata:[publicKey]},block),provider.callContract({contractAddress:account,entrypoint:'get_session_epoch',calldata:[]},block)]);
 const record={stage,checkedAt:new Date().toISOString(),block,sessionPublicKey:publicKey,exists:BigInt(data[0])!==0n,validUntil:Number(BigInt(data[0])),maxCalls:Number(BigInt(data[1])),maxFeePerTxFri:BigInt(data[2]).toString(),scopeEntries:Number(BigInt(data[3])),sessionEpoch:Number(BigInt(epoch[0])),source:'public SessionKeySet event and account getters; no browser storage read'};
 const previous=existsSync(output)?JSON.parse(readFileSync(output,'utf8')):[];
 const rows=previous.filter((r:any)=>r.stage!==stage);rows.push(record);writeFileSync(output,JSON.stringify(rows,null,2)+'\n');console.log(JSON.stringify(record,null,2));
}catch{console.error('PUBLIC_SESSION_STATE_FAILED');process.exitCode=1;}
