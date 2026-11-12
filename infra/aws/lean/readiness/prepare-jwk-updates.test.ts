import {expect,test} from 'bun:test';
import {collectGoogleJwkCalls,assertPinnedK1Admin} from './prepare-jwk-updates';
import {TEST_JWK} from '../../../../services/backend/src/test-fixtures';
import {setLogSink} from '../../../../services/backend/src/log';

const missing = () => {throw new Error("RPC: starknet_call: 40: Contract error: {\"revert_error\":\"0x554e4b4e4f574e5f4b4944 ('UNKNOWN_KID')\"}");};

test('manual planner captures a Google key addition without receipt waiting or claiming an update',async()=>{
  const lines:string[]=[];const previous=setLogSink(line=>lines.push(line));let waits=0;
  try {
    const calls=await collectGoogleJwkCalls({registryContractAddress:'0x1',fromBlock:1,
      provider:{getEvents:async()=>({events:[]}),callContract:async()=>missing(),waitForTransaction:async()=>{waits++;throw Error('RECEIPT_WAIT_FORBIDDEN');}},
      fetchJwks:async()=>({keys:[{...TEST_JWK,kid:'fixture-kid'}],headers:new Headers()}) as any});
    expect(calls).toHaveLength(1);expect(calls[0].entrypoint).toBe('set_key');expect(calls[0].contractAddress).toBe('0x1');
    expect(waits).toBe(0);expect(lines.join('')).not.toContain('registry_updated');
  } finally {setLogSink(previous);}
});

test('manual planner does not confuse an upstream error message with its unique capture sentinel',async()=>{
  await expect(collectGoogleJwkCalls({registryContractAddress:'0x1',fromBlock:1,
    provider:{getEvents:async()=>{throw Error('UNSIGNED_JWK_PLAN_CAPTURED');},callContract:async()=>[],waitForTransaction:async()=>{}},
    fetchJwks:async()=>({keys:[],headers:new Headers()}) as any})).rejects.toThrow('UNSIGNED_JWK_PLAN_CAPTURED');
});


test('manual planner pins full k1 administrator public key and class before planning',async()=>{
  const key='0x0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8';
  const x=BigInt('0x'+key.slice(4,68)),y=BigInt('0x'+key.slice(68)),mask=(1n<<128n)-1n;
  const limbs=[x&mask,x>>128n,y&mask,y>>128n].map(value=>'0x'+value.toString(16));
  const provider={getClassHashAt:async()=> '0x5',callContract:async()=>limbs};
  await expect(assertPinnedK1Admin(provider,'0x3','0x5',key)).resolves.toBeUndefined();
  await expect(assertPinnedK1Admin(provider,'0x3','0x6',key)).rejects.toThrow('NEW_ADMINISTRATOR_CLASS_CHANGED');
  await expect(assertPinnedK1Admin({...provider,callContract:async()=>['0x1','0x0','0x1','0x0']},'0x3','0x5',key)).rejects.toThrow('NEW_ADMINISTRATOR_PUBLIC_KEY_CHANGED');
  await expect(assertPinnedK1Admin(provider,'0x3','0x5','0x04'+'0'.repeat(128))).rejects.toThrow('K1_PUBLIC_KEY_INVALID');
});
