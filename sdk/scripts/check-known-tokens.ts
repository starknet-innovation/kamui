// Checks every listed token against a live node: the contract is on that network and answers the
// listed symbol and decimals. Opt-in, because it needs the network; the format checks that need
// none are in test/tokens.test.ts.
//
//   bun run check:tokens                          Sepolia, public node
//   bun run check:tokens sepolia <rpc url>
//   bun run check:tokens mainnet <rpc url>        mainnet has no default node: name one
//
// This is one of the checks ../KNOWN_TOKENS.md asks for, not a substitute for the
// others. A fake token answers any symbol it likes, so a pass here says nothing about who issued
// the token.
import { RpcProvider } from 'starknet';
import { KNOWN_TOKENS, TOKEN_NETWORKS, decodeSymbol, type TokenNetwork } from '../src';
import { sameFelt } from '../src/utils';

const DEFAULT_RPC: Partial<Record<TokenNetwork, string>> = { sepolia: 'https://sepolia.nodes.starknet.org/rpc/v0_10' };

const network = (process.argv[2] ?? 'sepolia') as TokenNetwork;
if (!Object.hasOwn(TOKEN_NETWORKS, network)) {
  console.error(`unknown network "${network}": use ${Object.keys(TOKEN_NETWORKS).join(' or ')}`);
  process.exit(2);
}
const rpc = process.argv[3] ?? DEFAULT_RPC[network];
if (!rpc) {
  console.error(`no default node for ${network}: bun run check:tokens ${network} <rpc url>`);
  process.exit(2);
}

const provider = new RpcProvider({ nodeUrl: rpc });
const chainId = await provider.getChainId();
if (!sameFelt(chainId, TOKEN_NETWORKS[network])) {
  console.error(`the node is on chain ${chainId}, not ${network} (${TOKEN_NETWORKS[network]})`);
  process.exit(2);
}

let failed = 0;
for (const token of KNOWN_TOKENS[network]) {
  const listed = `${network} ${token.address} listed ${token.symbol}/${token.decimals}`;
  try {
    const [symbolResult, decimalsResult] = await Promise.all([
      provider.callContract({ contractAddress: token.address, entrypoint: 'symbol', calldata: [] }),
      provider.callContract({ contractAddress: token.address, entrypoint: 'decimals', calldata: [] }),
    ]);
    const symbol = decodeSymbol(symbolResult);
    const decimals = decimalsResult.length === 1 ? Number(BigInt(decimalsResult[0]!)) : NaN;
    const ok = symbol === token.symbol && decimals === token.decimals;
    if (!ok) failed++;
    console.log(`${ok ? 'ok      ' : 'MISMATCH'} ${listed}, chain says ${symbol}/${decimals}`);
  } catch (error) {
    failed++;
    console.log(`FAILED   ${listed}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const total = KNOWN_TOKENS[network].length;
console.log(failed ? `${failed} of ${total} ${network} entries do not match the chain` : `all ${total} ${network} entries match the chain`);
process.exit(failed ? 1 : 0);
