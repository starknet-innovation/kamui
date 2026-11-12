import copy
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
import registry_handoff as handoff

PUBLIC_KEY='0x0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8'
X,Y=handoff.k1_coordinates(PUBLIC_KEY)
LIMBS=[hex(X%(2**128)),hex(X//(2**128)),hex(Y%(2**128)),hex(Y//(2**128))]
CONFIG={'registry':'0x1','oldAdministratorAccount':'0x2','newAdministratorAccount':'0x3',
        'expectedRegistryClassHash':'0x4','expectedNewAdministratorClassHash':'0x5',
        'expectedNewAdministratorPublicKey':PUBLIC_KEY,'controllerProofTransactionHash':'0x6'}
class Rpc:
    def __init__(self,new=False,old=True):self.new=new;self.old=old;self.calls=[]
    def request(self,method,params):
        self.calls.append((method,params))
        if method=='starknet_chainId':return handoff.CHAIN_ID
        if method=='starknet_blockHashAndNumber':return {'block_number':123,'block_hash':'0xabc'}
        if method=='starknet_getClassHashAt':return '0x4' if params['contract_address']=='0x1' else '0x5'
        if method=='starknet_getClass':return {'abi':[{'type':'interface','items':[{'type':'function','name':name} for name in ['has_role','get_role_admin','grant_role','renounce_role','set_key','remove_key','upgrade']]}]}
        if method=='starknet_getTransactionReceipt':return {'transaction_hash':'0x6','block_number':120,'block_hash':'0xdef','execution_status':'SUCCEEDED','finality_status':'ACCEPTED_ON_L2'}
        if method=='starknet_getTransactionByHash':return {'transaction_hash':'0x6','type':'INVOKE','sender_address':'0x3','version':'0x3','signature':['0x1','0x0','0x1','0x0']}
        if method=='starknet_getBlockWithTxHashes':return {'block_number':120,'block_hash':'0xdef','transactions':['0x6']}
        if method=='starknet_call':
            request=params['request']
            if request['entry_point_selector']==handoff.SELECTORS['get_public_key']:return LIMBS
            if request['entry_point_selector']==handoff.SELECTORS['get_role_admin']:return ['0x0']
            return ['0x1' if (self.old if request['calldata'][1]=='0x2' else self.new) else '0x0']
        raise AssertionError('unexpected RPC')

class HandoffTest(unittest.TestCase):
    def test_grants_two_roles_without_signing_or_broadcast(self):
        rpc=Rpc();plan=handoff.prepare(rpc,CONFIG,'prepare-grant')
        self.assertEqual([call['entrypoint'] for call in plan['calls']],['grant_role','grant_role'])
        self.assertEqual([call['calldata'][1] for call in plan['calls']],['0x3','0x3'])
        self.assertFalse(plan['signingOrBroadcastPerformed'])
        self.assertTrue(all(method in handoff.RPC_READS for method,_ in rpc.calls))
        self.assertTrue(all(params.get('block_id',{'block_hash':'0xabc'})=={'block_hash':'0xabc'} for method,params in rpc.calls if method not in {'starknet_chainId','starknet_blockHashAndNumber'}))

    def test_renounce_requires_both_new_roles_and_control_confirmation(self):
        with self.assertRaisesRegex(ValueError,'NEW_CONTROLLER_CONFIRMATION_REQUIRED'):handoff.prepare(Rpc(new=True),CONFIG,'prepare-renounce')
        with self.assertRaisesRegex(ValueError,'NEW_REGISTRY_ROLES_REQUIRED'):handoff.prepare(Rpc(),CONFIG,'prepare-renounce',True)
        plan=handoff.prepare(Rpc(new=True),CONFIG,'prepare-renounce',True)
        self.assertEqual(plan['calls'][0]['calldata'],[handoff.REVOKER,'0x2'])
        self.assertEqual(plan['calls'][1]['calldata'],[handoff.ADMIN,'0x2'])

    def test_wrong_class_and_equal_signers_refuse(self):
        data={**CONFIG,'expectedRegistryClassHash':'0x5'}
        with self.assertRaisesRegex(ValueError,'REGISTRY_CLASS_CHANGED'):handoff.prepare(Rpc(),data,'prepare-grant')
        with self.assertRaisesRegex(ValueError,'REGISTRY_SIGNERS_MUST_DIFFER'):handoff.prepare(Rpc(),{**CONFIG,'newAdministratorAccount':'0x2'},'prepare-grant')

    def test_final_verification_requires_old_roles_absent(self):
        with self.assertRaisesRegex(ValueError,'REGISTRY_HANDOFF_INCOMPLETE'):handoff.prepare(Rpc(new=True),CONFIG,'verify')
        self.assertEqual(handoff.prepare(Rpc(new=True,old=False),CONFIG,'verify')['status'],'verified')


    def test_new_controller_class_and_full_public_key_are_pinned(self):
        with self.assertRaisesRegex(ValueError,'NEW_ADMINISTRATOR_CLASS_CHANGED'):
            handoff.prepare(Rpc(),{**CONFIG,'expectedNewAdministratorClassHash':'0x8'},'prepare-grant')
        with self.assertRaisesRegex(ValueError,'K1_PUBLIC_KEY_INVALID'):
            handoff.prepare(Rpc(),{**CONFIG,'expectedNewAdministratorPublicKey':'0x04'+'0'*128},'prepare-grant')
        rpc=Rpc();original=rpc.request
        rpc.request=lambda method,params: ['0x1','0x0','0x1','0x0'] if method=='starknet_call' and params['request']['entry_point_selector']==handoff.SELECTORS['get_public_key'] else original(method,params)
        with self.assertRaisesRegex(ValueError,'NEW_ADMINISTRATOR_PUBLIC_KEY_CHANGED'):
            handoff.prepare(rpc,CONFIG,'prepare-grant')

    def test_renounce_requires_accepted_canonical_controller_receipt(self):
        for status in ['REVERTED','REJECTED','RECEIVED']:
            rpc=Rpc(new=True);original=rpc.request
            rpc.request=lambda method,params: {'execution_status':status,'finality_status':'ACCEPTED_ON_L2'} if method=='starknet_getTransactionReceipt' else original(method,params)
            with self.assertRaisesRegex(ValueError,'NEW_CONTROLLER_ACCEPTED_RECEIPT_REQUIRED'):
                handoff.prepare(rpc,CONFIG,'prepare-renounce',True)
        rpc=Rpc(new=True);original=rpc.request
        rpc.request=lambda method,params: {'block_number':120,'block_hash':'0xddd','transactions':['0x6']} if method=='starknet_getBlockWithTxHashes' else original(method,params)
        with self.assertRaisesRegex(ValueError,'NEW_CONTROLLER_RECEIPT_NOT_CANONICAL'):
            handoff.prepare(rpc,CONFIG,'prepare-renounce',True)
        with self.assertRaises(ValueError):
            handoff.prepare(Rpc(new=True),{**CONFIG,'controllerProofTransactionHash':''},'prepare-renounce',True)

    def test_proof_from_another_account_or_query_transaction_refused(self):
        for changed in [{'sender_address':'0x2'},{'version':'0x100000000000000000000000000000003'}]:
            rpc=Rpc(new=True);original=rpc.request
            def request(method,params):
                result=original(method,params)
                return {**result,**changed} if method=='starknet_getTransactionByHash' else result
            rpc.request=request
            with self.assertRaisesRegex(ValueError,'NEW_CONTROLLER_TRANSACTION_REQUIRED'):
                handoff.prepare(rpc,CONFIG,'prepare-renounce',True)

    def test_proof_class_at_accepted_block_must_match(self):
        rpc=Rpc(new=True);original=rpc.request
        rpc.request=lambda method,params: '0x7' if method=='starknet_getClassHashAt' and params.get('block_id')=={'block_hash':'0xdef'} else original(method,params)
        with self.assertRaisesRegex(ValueError,'NEW_ADMINISTRATOR_CLASS_CHANGED'):
            handoff.prepare(rpc,CONFIG,'prepare-renounce',True)

    def test_outputs_are_private_and_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            output=Path(temporary)/'plans'
            handoff.write_private(str(output),'grant.json',{'calls':[]})
            self.assertEqual((output/'grant.json').stat().st_mode&0o777,0o600)
            with self.assertRaises(FileExistsError):handoff.write_private(str(output),'grant.json',{'calls':['changed']})

if __name__=='__main__':unittest.main()
