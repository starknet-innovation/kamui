// Startup gate for the selected offline registry-administration model. This only
// checks the configured API relayer's roles on the pinned Sepolia registry; it
// does not prove custody of other keys, a timelock, or general host isolation.
import { hash, type RpcProvider } from 'starknet';

export const PINNED_SEPOLIA_REGISTRY = '0x4bc2b2afcce053e788511a851e6aeb004d18adb243df4fe852e1b727bd09808';
const SEPOLIA_CHAIN_ID = '0x534e5f5345504f4c4941';
const HEX = /^0x[0-9a-fA-F]{1,64}$/;
const ADDRESS_BOUND = 1n << 251n;
const REVOKER_ROLE = hash.getSelectorFromName('REVOKER_ROLE');

export type RegistryGovernanceContext = {
  provider: Pick<RpcProvider, 'getChainId' | 'callContract'>;
  chainId: string;
  registryAddress: string;
  relayerAddress: string;
};

/** No mutations or secrets. Any ambiguous/unavailable role view refuses startup. */
export async function assertRegistryAdminOffHost(ctx: RegistryGovernanceContext): Promise<void> {
  if (![ctx.chainId, ctx.registryAddress, ctx.relayerAddress].every(value => typeof value === 'string' && HEX.test(value))
    || BigInt(ctx.relayerAddress) === 0n || BigInt(ctx.relayerAddress) >= ADDRESS_BOUND) throw new Error('REGISTRY_GOVERNANCE_CONFIG_INVALID');
  if (BigInt(ctx.chainId) !== BigInt(SEPOLIA_CHAIN_ID)) throw new Error('REGISTRY_GOVERNANCE_CHAIN_MISMATCH');
  if (BigInt(ctx.registryAddress) !== BigInt(PINNED_SEPOLIA_REGISTRY)) throw new Error('REGISTRY_GOVERNANCE_PIN_MISMATCH');

  let chainId: string;
  try { chainId = await ctx.provider.getChainId(); }
  catch { throw new Error('REGISTRY_GOVERNANCE_UNAVAILABLE'); }
  if (typeof chainId !== 'string' || !HEX.test(chainId)) throw new Error('REGISTRY_GOVERNANCE_MALFORMED_RESPONSE');
  if (BigInt(chainId) !== BigInt(SEPOLIA_CHAIN_ID)) throw new Error('REGISTRY_GOVERNANCE_CHAIN_MISMATCH');

  let roles: string[][];
  try {
    roles = await Promise.all(['0x0', REVOKER_ROLE].map(role => ctx.provider.callContract({
      contractAddress: PINNED_SEPOLIA_REGISTRY,
      entrypoint: 'has_role',
      calldata: [role, '0x' + BigInt(ctx.relayerAddress).toString(16)],
    })));
  } catch { throw new Error('REGISTRY_GOVERNANCE_UNAVAILABLE'); }

  const held = roles.map(result => {
    if (!Array.isArray(result) || result.length !== 1 || typeof result[0] !== 'string'
      || !HEX.test(result[0]) || BigInt(result[0]) > 1n) throw new Error('REGISTRY_GOVERNANCE_MALFORMED_RESPONSE');
    return BigInt(result[0]) === 1n;
  });
  if (held.some(Boolean)) throw new Error('REGISTRY_ADMIN_STILL_ONLINE');
}
