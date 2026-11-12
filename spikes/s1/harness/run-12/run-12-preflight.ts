// Public, read-only Sepolia preflight. No environment/config file or signing key is read.
import { hash } from '../../../../sdk/node_modules/starknet';
const RPC = 'https://api.zan.top/public/starknet-sepolia/rpc/v0_10';
const ACCOUNT = '0x133739e82cd76b5a6446848ae0cbbbb8cc4762fbb8e0eb5ebc417209423e0e9';
const RELAYER = '0x5bf22a824e3d20dfe018fab5de043a9cab41c45361f4ded0f2e2fc51776118e';
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
async function rpc(method:string,params:unknown):Promise<any>{
  const response = await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(30_000)});
  const answer = await response.json() as any;
  if(!response.ok || answer.error || answer.result===undefined) throw new Error('PUBLIC_RPC_PREFLIGHT_FAILED');
  return answer.result;
}
const call=(account:string,name:string,calldata:string[]=[])=>rpc('starknet_call',{request:{contract_address:account,entry_point_selector:hash.getSelectorFromName(name),calldata},block_id:'latest'});
try{
  const [owners,epoch,classHash,balance,block]=await Promise.all([
    call(ACCOUNT,'get_owners'),call(ACCOUNT,'get_session_epoch'),rpc('starknet_getClassHashAt',{block_id:'latest',contract_address:ACCOUNT}),call(STRK,'balance_of',[RELAYER]),rpc('starknet_blockNumber',[]),
  ]);
  const fri=BigInt(balance[0])+(BigInt(balance[1])<<128n);
  console.log(JSON.stringify({network:'SN_SEPOLIA',checkedAt:new Date().toISOString(),block,account:ACCOUNT,classHash,ownerCount:Number(BigInt(owners[0])),sessionEpoch:Number(BigInt(epoch[0])),relayer:RELAYER,relayerBalanceFri:fri.toString(),readOnly:true},null,2));
}catch{console.error('PUBLIC_RPC_PREFLIGHT_FAILED');process.exitCode=1;}
