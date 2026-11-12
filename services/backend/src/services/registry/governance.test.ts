import { expect, test } from 'bun:test';
import { hash } from 'starknet';
import { assertRegistryAdminOffHost, PINNED_SEPOLIA_REGISTRY, type RegistryGovernanceContext } from './governance';

const chainId = '0x534e5f5345504f4c4941' as const;
function fixture() {
  const seen: { contractAddress: string; entrypoint: string; calldata: string[] }[] = [];
  let chainReads = 0;
  const ctx: RegistryGovernanceContext = {
    chainId, registryAddress: PINNED_SEPOLIA_REGISTRY, relayerAddress: '0x0123',
    provider: {
      getChainId: async () => { chainReads++; return chainId; },
      callContract: async (call) => { seen.push(call as typeof seen[number]); return ['0x0']; },
    },
  };
  return { ctx, seen, chainReads: () => chainReads };
}

test('only the pinned Sepolia registry and the configured relayer are queried, read-only', async () => {
  const {ctx,seen,chainReads} = fixture();
  await assertRegistryAdminOffHost(ctx);
  expect(chainReads()).toBe(1);
  expect(seen).toEqual([
    {contractAddress:PINNED_SEPOLIA_REGISTRY,entrypoint:'has_role',calldata:['0x0','0x123']},
    {contractAddress:PINNED_SEPOLIA_REGISTRY,entrypoint:'has_role',calldata:[hash.getSelectorFromName('REVOKER_ROLE'),'0x123']},
  ]);
});

test('invalid config, wrong registry and wrong configured chain refuse before any RPC', async () => {
  for (const override of [{chainId:'0x534e5f4d41494e'}, {registryAddress:'0x123'}, {relayerAddress:'0x0'}, {relayerAddress:'invalid-fixture'}, {relayerAddress:'0x'+(1n<<251n).toString(16)}]) {
    const {ctx,seen,chainReads} = fixture();
    await expect(assertRegistryAdminOffHost({...ctx,...override})).rejects.toThrow();
    expect(chainReads()).toBe(0);expect(seen).toHaveLength(0);
  }
});

test('RPC chain mismatch or malformed chain output refuses before role reads', async () => {
  const {ctx,seen} = fixture();
  ctx.provider.getChainId = async () => '0x534e5f4d41494e';
  await expect(assertRegistryAdminOffHost(ctx)).rejects.toThrow('REGISTRY_GOVERNANCE_CHAIN_MISMATCH');
  ctx.provider.getChainId = async () => 'malformed' as any;
  await expect(assertRegistryAdminOffHost(ctx)).rejects.toThrow('REGISTRY_GOVERNANCE_MALFORMED_RESPONSE');
  expect(seen).toHaveLength(0);
});

test('either admin or revoker authority on the online relayer refuses startup', async () => {
  for(const role of ['0x0',hash.getSelectorFromName('REVOKER_ROLE')]) {
    const {ctx} = fixture();
    ctx.provider.callContract = async call => BigInt((call.calldata as string[])[0]!) === BigInt(role) ? ['0x1'] : ['0x0'];
    await expect(assertRegistryAdminOffHost(ctx)).rejects.toThrow('REGISTRY_ADMIN_STILL_ONLINE');
  }
});

test('malformed booleans, extra values and empty role responses fail closed', async () => {
  for(const response of [[], ['0x2'], ['0x0','0x1'], ['0'], ['private-response-fixture'], [false], null]) {
    const {ctx} = fixture();ctx.provider.callContract = async () => response as any;
    await expect(assertRegistryAdminOffHost(ctx)).rejects.toThrow('REGISTRY_GOVERNANCE_MALFORMED_RESPONSE');
  }
});

test('provider errors expose only a fixed refusal rather than private RPC error text', async () => {
  const sensitive = 'PRIVATE_RPC_CONFIGURATION_FIXTURE_DO_NOT_LOG';
  const chain = fixture();chain.ctx.provider.getChainId = async () => {throw Error(sensitive);};
  await expect(assertRegistryAdminOffHost(chain.ctx)).rejects.toThrow('REGISTRY_GOVERNANCE_UNAVAILABLE');
  const roles = fixture();roles.ctx.provider.callContract = async () => {throw Error(sensitive);};
  try {await assertRegistryAdminOffHost(roles.ctx);throw Error('UNEXPECTED_SUCCESS');}
  catch(error) {expect((error as Error).message).toBe('REGISTRY_GOVERNANCE_UNAVAILABLE');expect((error as Error).message).not.toContain(sensitive);}
});
