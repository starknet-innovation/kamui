#!/usr/bin/env python3
"""Read-only registry checks and UNSIGNED call preparation. No signing/broadcast mode."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import urllib.request
from inspect_aws import load_private

RPC_URL = 'https://api.zan.top/public/starknet-sepolia/rpc/v0_10'
CHAIN_ID = '0x' + b'SN_SEPOLIA'.hex()
PRIME = 2**251 + 17*2**192 + 1
ADMIN = '0x0'
# Derived with starknet.js 10 hash.getSelectorFromName from these exact names.
REVOKER = '0x23f34913921da558f105cefb578d87278debbbd073a8d552b5de0d168deee30'
SELECTORS = {
    'has_role':'0x30559321b47d576b645ed7bd24089943dd5fd3a359ecdd6fa8f05c1bab67d6b',
    'get_role_admin':'0x302e0454f48778e0ca3a2e714a289c4e8d8e03d614b370130abb1a524a47f22',
    'get_public_key':'0x1a35984e05126dbecb7c3bb9929e7dd9106d460c59b1633739a5c733a5fb13b',
}
RPC_READS = {'starknet_chainId', 'starknet_blockHashAndNumber', 'starknet_getClassHashAt', 'starknet_getClass', 'starknet_call', 'starknet_getTransactionByHash', 'starknet_getTransactionReceipt', 'starknet_getBlockWithTxHashes'}


def felt(value, nonzero=False):
    if not isinstance(value,str) or not re.fullmatch('0x[0-9a-fA-F]{1,64}',value) or not (int(value,16) < PRIME) or (nonzero and int(value,16)==0):
        raise ValueError('PUBLIC_FELT_REQUIRED')
    return hex(int(value,16))


class Rpc:
    def request(self, method, params):
        if method not in RPC_READS:
            raise ValueError('RPC_READ_OPERATION_REQUIRED')
        request=urllib.request.Request(RPC_URL,data=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode(),headers={'content-type':'application/json'})
        with urllib.request.urlopen(request,timeout=30) as response:
            raw=response.read(16*1024*1024+1)
        if len(raw)>16*1024*1024:raise ValueError('RPC_RESPONSE_TOO_LARGE')
        data=json.loads(raw)
        if 'error' in data or 'result' not in data:raise ValueError('RPC_READ_UNAVAILABLE')
        return data['result']


def functions(abi):
    if isinstance(abi,str):abi=json.loads(abi)
    if not isinstance(abi,list):raise ValueError('REGISTRY_ABI_INVALID')
    result=set()
    for item in abi:
        if not isinstance(item,dict):raise ValueError('REGISTRY_ABI_INVALID')
        if item.get('type')=='function':result.add(item.get('name'))
        if item.get('type')=='interface':result.update(functions(item.get('items')))
    return result


def call(rpc, registry, block, name, data):
    result=rpc.request('starknet_call',{'request':{'contract_address':registry,'entry_point_selector':SELECTORS[name],'calldata':data},'block_id':block})
    if not isinstance(result,list) or len(result)!=1:raise ValueError('REGISTRY_REPLY_INVALID')
    return felt(result[0])


def observe(rpc, registry, expected_class=None):
    registry=felt(registry,True)
    if int(rpc.request('starknet_chainId',{}),16)!=int(CHAIN_ID,16):raise ValueError('WRONG_CHAIN')
    head=rpc.request('starknet_blockHashAndNumber',{})
    if type(head.get('block_number')) is not int or head['block_number']<0:raise ValueError('RPC_REPLY_INVALID')
    block_hash=felt(head.get('block_hash'),True)
    block={'block_hash':block_hash}
    class_hash=felt(rpc.request('starknet_getClassHashAt',{'block_id':block,'contract_address':registry}),True)
    if expected_class and class_hash!=felt(expected_class,True):raise ValueError('REGISTRY_CLASS_CHANGED')
    contract=rpc.request('starknet_getClass',{'block_id':block,'class_hash':class_hash})
    required={'has_role','get_role_admin','grant_role','renounce_role','set_key','remove_key','upgrade'}
    if not required.issubset(functions(contract.get('abi'))):raise ValueError('REGISTRY_ACCESS_CONTROL_ABI_REQUIRED')
    if call(rpc,registry,block,'get_role_admin',[ADMIN])!=ADMIN or call(rpc,registry,block,'get_role_admin',[REVOKER])!=ADMIN:
        raise ValueError('REGISTRY_ROLE_ADMIN_CHANGED')
    return {'chainId':CHAIN_ID,'registry':registry,'registryClassHash':class_hash,'blockNumber':head['block_number'],'blockHash':block_hash,'block':block}


def k1_coordinates(value):
    if not isinstance(value,str) or not re.fullmatch('0x04[0-9a-fA-F]{128}',value):
        raise ValueError('K1_PUBLIC_KEY_REQUIRED')
    x=int(value[4:68],16);y=int(value[68:],16)
    p=2**256-2**32-977
    if x>=p or y>=p or (x==0 and y==0) or (y*y-x*x*x-7)%p:
        raise ValueError('K1_PUBLIC_KEY_INVALID')
    return x,y


def observe_controller(rpc, config, block):
    account=felt(config['newAdministratorAccount'],True)
    expected=felt(config['expectedNewAdministratorClassHash'],True)
    actual=felt(rpc.request('starknet_getClassHashAt',{'block_id':block,'contract_address':account}),True)
    if actual!=expected:raise ValueError('NEW_ADMINISTRATOR_CLASS_CHANGED')
    expected_coordinates=k1_coordinates(config['expectedNewAdministratorPublicKey'])
    values=rpc.request('starknet_call',{'request':{'contract_address':account,
        'entry_point_selector':SELECTORS['get_public_key'],'calldata':[]},'block_id':block})
    if not isinstance(values,list) or len(values)!=4:raise ValueError('NEW_ADMINISTRATOR_PUBLIC_KEY_INVALID')
    limbs=[int(felt(value),16) for value in values]
    if any(value>=2**128 for value in limbs):raise ValueError('NEW_ADMINISTRATOR_PUBLIC_KEY_INVALID')
    actual_coordinates=(limbs[0]+2**128*limbs[1],limbs[2]+2**128*limbs[3])
    if actual_coordinates!=expected_coordinates:raise ValueError('NEW_ADMINISTRATOR_PUBLIC_KEY_CHANGED')
    return {'account':account,'classHash':actual,'publicKeyMatches':True}


def controller_receipt(rpc, config, snapshot):
    tx_hash=felt(config['controllerProofTransactionHash'],True)
    receipt=rpc.request('starknet_getTransactionReceipt',{'transaction_hash':tx_hash})
    if not isinstance(receipt,dict) or receipt.get('execution_status')!='SUCCEEDED' or receipt.get('finality_status') not in {'ACCEPTED_ON_L2','ACCEPTED_ON_L1'}:
        raise ValueError('NEW_CONTROLLER_ACCEPTED_RECEIPT_REQUIRED')
    number=receipt.get('block_number')
    if type(number) is not int or not 0<=number<=snapshot['blockNumber'] or felt(receipt.get('transaction_hash'),True)!=tx_hash:
        raise ValueError('NEW_CONTROLLER_RECEIPT_INVALID')
    block_hash=felt(receipt.get('block_hash'),True)
    canonical=rpc.request('starknet_getBlockWithTxHashes',{'block_id':{'block_number':number}})
    if not isinstance(canonical,dict) or felt(canonical.get('block_hash'),True)!=block_hash or canonical.get('block_number')!=number or not isinstance(canonical.get('transactions'),list) or tx_hash not in [felt(value,True) for value in canonical['transactions']]:
        raise ValueError('NEW_CONTROLLER_RECEIPT_NOT_CANONICAL')
    tx=rpc.request('starknet_getTransactionByHash',{'transaction_hash':tx_hash})
    if not isinstance(tx,dict) or tx.get('type')!='INVOKE' or felt(tx.get('version'))!='0x3' or felt(tx.get('transaction_hash'),True)!=tx_hash or felt(tx.get('sender_address'),True)!=felt(config['newAdministratorAccount'],True):
        raise ValueError('NEW_CONTROLLER_TRANSACTION_REQUIRED')
    signature=tx.get('signature')
    if not isinstance(signature,list) or len(signature)!=4 or any(int(felt(value),16)>=2**128 for value in signature):
        raise ValueError('NEW_CONTROLLER_SIGNATURE_SHAPE_INVALID')
    # The reviewed immutable class and public key must have been in use for the proof too.
    observe_controller(rpc,config,{'block_hash':block_hash})
    return {'transactionHash':tx_hash,'blockNumber':number,'blockHash':block_hash,
            'executionStatus':'SUCCEEDED','finalityStatus':receipt['finality_status']}


def prepare(rpc, config, action, new_controller_confirmed=False):
    if not isinstance(config,dict) or set(config)!={'registry','oldAdministratorAccount','newAdministratorAccount','expectedRegistryClassHash',
            'expectedNewAdministratorClassHash','expectedNewAdministratorPublicKey','controllerProofTransactionHash'}:
        raise ValueError('HANDOFF_INPUT_INVALID')
    old=felt(config['oldAdministratorAccount'],True);new=felt(config['newAdministratorAccount'],True)
    if old==new:raise ValueError('REGISTRY_SIGNERS_MUST_DIFFER')
    snapshot=observe(rpc,config['registry'],felt(config['expectedRegistryClassHash'],True))
    registry=snapshot['registry'];block=snapshot['block']
    controller=observe_controller(rpc,config,block)
    roles={}
    for label,address in [('old',old),('new',new)]:
        for name,role in [('admin',ADMIN),('revoker',REVOKER)]:
            value=call(rpc,registry,block,'has_role',[role,address])
            if value not in {'0x0','0x1'}:raise ValueError('REGISTRY_REPLY_INVALID')
            roles[label+'_'+name]=value=='0x1'
    if action=='verify':
        if not roles['new_admin'] or not roles['new_revoker'] or roles['old_admin'] or roles['old_revoker']:
            raise ValueError('REGISTRY_HANDOFF_INCOMPLETE')
        proof=controller_receipt(rpc,config,snapshot)
        return {**snapshot,'roles':roles,'controller':controller,'controllerProof':proof,'status':'verified','signingOrBroadcastPerformed':False}
    if not roles['old_admin'] or not roles['old_revoker']:raise ValueError('OLD_REGISTRY_ROLES_REQUIRED')
    if action=='prepare-grant':
        entrypoint='grant_role';who=new;role_order=[ADMIN,REVOKER]
    elif action=='prepare-renounce':
        if new_controller_confirmed is not True:raise ValueError('NEW_CONTROLLER_CONFIRMATION_REQUIRED')
        if not roles['new_admin'] or not roles['new_revoker']:raise ValueError('NEW_REGISTRY_ROLES_REQUIRED')
        proof=controller_receipt(rpc,config,snapshot)
        entrypoint='renounce_role';who=old;role_order=[REVOKER,ADMIN]
    else:raise ValueError('HANDOFF_ACTION_INVALID')
    return {**snapshot,'roles':roles,'controller':controller,
            'controllerProof':proof if action=='prepare-renounce' else None,'executorAccount':old,'calls':[{'contractAddress':registry,'entrypoint':entrypoint,'calldata':[role,who]} for role in role_order],
            'signingOrBroadcastPerformed':False,'warning':'DEFAULT_ADMIN_ROLE_ALSO_CONTROLS_UPGRADE',
            'instruction':'REVIEW_AND_SIGN_ONLY_IN_THE_EXECUTOR_ACCOUNTS_APPROVED_WALLET'}


def write_private(directory, filename, data):
    path=Path(directory)
    if not path.is_absolute() or path.is_symlink():raise ValueError('PRIVATE_OUTPUT_REQUIRED')
    path.mkdir(mode=0o700,parents=True,exist_ok=True)
    info=path.stat()
    if not path.is_dir() or info.st_mode&0o077 or info.st_uid!=os.geteuid():raise ValueError('PRIVATE_OUTPUT_REQUIRED')
    fd=os.open(path/filename,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        with os.fdopen(fd,'w') as output:
            json.dump(data,output,indent=2);output.write('\n');output.flush();os.fsync(output.fileno())
    except Exception:raise ValueError('PRIVATE_OUTPUT_WRITE_FAILED')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['observe','prepare-grant','prepare-renounce','verify'])
    parser.add_argument('--registry')
    parser.add_argument('--private-input')
    parser.add_argument('--private-output-directory',required=True)
    parser.add_argument('--new-controller-confirmed',action='store_true')
    options=parser.parse_args()
    try:
        if options.action=='observe':
            if not options.registry or options.private_input or options.new_controller_confirmed:raise ValueError('HANDOFF_USAGE')
            data=observe(Rpc(),options.registry)
        else:
            if not options.private_input or options.registry or (options.new_controller_confirmed and options.action!='prepare-renounce'):raise ValueError('HANDOFF_USAGE')
            data=prepare(Rpc(),load_private(options.private_input),options.action,options.new_controller_confirmed)
        write_private(options.private_output_directory,options.action+'.json',data)
        print(json.dumps({'status':'observed' if options.action=='observe' else 'verified' if options.action=='verify' else 'unsigned_calls_prepared','signingOrBroadcastPerformed':False}))
        return 0
    except Exception:
        print('{"status":"refused","error":"HANDOFF_PREPARATION_FAILED","signingOrBroadcastPerformed":false}')
        return 1


if __name__=='__main__':raise SystemExit(main())
