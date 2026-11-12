// Independently retain only public transaction receipt/bounds metadata, never calldata.
import { existsSync,readFileSync,writeFileSync } from 'node:fs';
const [kind,transactionHash]=process.argv.slice(2);
const RPC='https://api.zan.top/public/starknet-sepolia/rpc/v0_10';
const path=new URL('../../results/run-12-receipts.json',import.meta.url);
async function rpc(method:string){const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{transaction_hash:transactionHash}}),signal:AbortSignal.timeout(30_000)});const d=await r.json() as any;if(!r.ok||!d.result)throw Error('PUBLIC_RECEIPT_UNAVAILABLE');return d.result;}
try{
 if(!/^[a-z_]{3,50}$/.test(kind??'')||!/^0x[0-9a-fA-F]{1,64}$/.test(transactionHash??''))throw Error('PUBLIC_RECEIPT_ARGUMENTS');
 const [receipt,transaction]=await Promise.all([rpc('starknet_getTransactionReceipt'),rpc('starknet_getTransactionByHash')]);
 const bounds=transaction.resource_bounds;
 const max=bounds?Object.values(bounds).reduce((s:bigint,b:any)=>s+BigInt(b.max_amount)*BigInt(b.max_price_per_unit),0n)+BigInt(transaction.tip??0)*BigInt(bounds.l2_gas?.max_amount??0):null;
 const record={kind,transaction_hash:transactionHash,execution_status:receipt.execution_status,finality_status:receipt.finality_status,block_number:receipt.block_number,actual_fee:{amount:receipt.actual_fee?.amount,unit:receipt.actual_fee?.unit},maximum_signed_fri:max===null?undefined:String(max),sender_address:transaction.sender_address};
 const previous=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):[];
 const rows=previous.filter((r:any)=>r.transaction_hash!==transactionHash);rows.push(record);
 writeFileSync(path,JSON.stringify(rows,null,2)+'\n');console.log(JSON.stringify(record,null,2));
}catch{console.error('PUBLIC_RECEIPT_CHECK_FAILED');process.exitCode=1;}
