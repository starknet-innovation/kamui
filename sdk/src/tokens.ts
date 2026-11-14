// What a token is called and how its amounts read, for approval screens.
//
// A token's name comes from the token contract itself, so any contract can claim any name. That
// is why there are three outcomes and the screen must treat them differently:
//
//   known        the address is one this SDK lists for the network; its symbol and decimals are
//                built in
//   unverified   the contract answered `symbol()` and `decimals()`, but anyone could deploy a
//                contract that answers the same; show what it claims, and say it is a claim
//   unknown      the contract did not answer like a token; only raw amounts can be shown
import type { ProviderInterface } from 'starknet';
import { sameFelt } from './utils';

export type TokenInfo =
  | { status: 'known'; address: string; symbol: string; decimals: number }
  | { status: 'unverified'; address: string; symbol: string; decimals: number }
  | { status: 'unknown'; address: string };

/** A token the SDK vouches for. `source` is where its issuer, or Starknet, publishes the address. */
export type KnownToken = { address: string; symbol: string; decimals: number; source: string };

/** Chain ids of the networks the list covers, as `starknet_chainId` answers them. */
export const TOKEN_NETWORKS = {
  mainnet: '0x534e5f4d41494e', // SN_MAIN
  sepolia: '0x534e5f5345504f4c4941', // SN_SEPOLIA
} as const;
export type TokenNetwork = keyof typeof TOKEN_NETWORKS;

const STARKNET_CHAIN_INFO = 'https://docs.starknet.io/learn/cheatsheets/chain-info';
const STARKGATE_SEPOLIA = 'https://github.com/starknet-io/starknet-addresses/blob/master/bridged_tokens/sepolia.json';
const CIRCLE_USDC = 'https://developers.circle.com/stablecoins/usdc-contract-addresses';

/**
 * Tokens recognised by address, per network. An address listed for one network says nothing about
 * another: a token listed for Sepolia is not known on mainnet unless it is listed there too.
 *
 * This list is a security control. An entry makes a contract read as trusted on every approval
 * screen, so a wrong address makes a fake token look real. Do not add, change or remove an entry
 * without following `../KNOWN_TOKENS.md`: an address published by the issuer, two
 * independent sources, an on-chain check (`bun run check:tokens`) and a second reviewer.
 *
 * Format, checked by `test/tokens.test.ts`: an address is lowercase, `0x` and 64 hex digits; the
 * symbol is the one the contract answers on chain; every entry names its source.
 */
export const KNOWN_TOKENS: Readonly<Record<TokenNetwork, readonly KnownToken[]>> = {
  // Mainnet: STRK and ETH only, until other entries go through the review process.
  mainnet: [
    { address: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d', symbol: 'STRK', decimals: 18, source: STARKNET_CHAIN_INFO },
    { address: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7', symbol: 'ETH', decimals: 18, source: STARKNET_CHAIN_INFO },
  ],
  sepolia: [
    { address: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d', symbol: 'STRK', decimals: 18, source: STARKNET_CHAIN_INFO },
    { address: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7', symbol: 'ETH', decimals: 18, source: STARKNET_CHAIN_INFO },
    { address: '0x035c332b8de00874e702b4831c84b22281fb3246f714475496d74e644f35d492', symbol: 'vSTRK', decimals: 18, source: STARKNET_CHAIN_INFO },
    // Native USDC, issued by Circle. The StarkGate-bridged USDC also answers "USDC" on Sepolia and
    // is deliberately not listed: see "Pending" in ../KNOWN_TOKENS.md.
    { address: '0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343', symbol: 'USDC', decimals: 6, source: CIRCLE_USDC },
    // Test tokens bridged through StarkGate from Ethereum Sepolia.
    { address: '0x02ab8758891e84b968ff11361789070c6b1af2df618d6d2f4a78b0757573c6eb', symbol: 'USDT', decimals: 6, source: STARKGATE_SEPOLIA },
    { address: '0x00452bd5c0512a61df7c7be8cfea5e4f893cb40e126bdc40aee6054db955129e', symbol: 'WBTC', decimals: 8, source: STARKGATE_SEPOLIA },
  ],
};

/** The list for a chain id, or nothing for a chain the SDK does not cover. */
export function knownTokensFor(chainId: string): readonly KnownToken[] {
  try {
    const id = BigInt(chainId);
    for (const network of Object.keys(TOKEN_NETWORKS) as TokenNetwork[]) {
      if (BigInt(TOKEN_NETWORKS[network]) === id) return KNOWN_TOKENS[network];
    }
  } catch {
    // Not a chain id: nothing is known.
  }
  return [];
}

/** Largest values an "unlimited" allowance is usually written as. */
const MAX_U256 = (1n << 256n) - 1n;
const MAX_U128 = (1n << 128n) - 1n;

/** Whether an amount is one of the conventional "no limit" values. */
export function isUnlimitedAmount(amount: bigint): boolean {
  return amount === MAX_U256 || amount === MAX_U128;
}

/**
 * An amount in a token's smallest unit, written in whole units. Exact: no floating point, no
 * rounding. `formatTokenAmount(1500000000000000000n, 18)` is "1.5".
 */
export function formatTokenAmount(amount: bigint, decimals: number): string {
  if (amount < 0n) throw new Error('token amount: negative');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) throw new Error('token amount: bad decimals');
  const digits = amount.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** A symbol fit to show: 1 to 12 letters, digits, dots, dashes or underscores. Anything else is dropped. */
function cleanSymbol(text: string): string | null {
  return /^[A-Za-z0-9._-]{1,12}$/.test(text) ? text : null;
}

/**
 * The bytes of a felt as text, most significant byte first. Done here and not with
 * starknet.js's `decodeShortString`, which returns "0" for the felt 0.
 */
function feltToText(felt: string): string {
  let value = BigInt(felt);
  let text = '';
  while (value > 0n) {
    text = String.fromCharCode(Number(value & 0xffn)) + text;
    value >>= 8n;
  }
  return text;
}

/** `symbol()` answers either one short-string felt or a Cairo byte array. */
export function decodeSymbol(result: string[]): string | null {
  try {
    if (result.length === 1) return cleanSymbol(feltToText(result[0]!));
    // ByteArray: [number of 31-byte words, ...words, pending word, pending length]
    const words = Number(BigInt(result[0]!));
    if (words > 1 || result.length !== words + 3) return null;
    const pendingLength = Number(BigInt(result[words + 2]!));
    let text = '';
    for (let i = 1; i <= words; i++) text += feltToText(result[i]!);
    if (pendingLength > 0) text += feltToText(result[words + 1]!);
    return cleanSymbol(text);
  } catch {
    return null;
  }
}

/**
 * Looks a token up: by address in the list for the provider's network first, then by asking the
 * contract. Pass `chainId` if you already have it; otherwise the provider is asked, which
 * starknet.js does once per provider. If the network cannot be told, no token is known. Never
 * throws.
 */
export async function readTokenInfo(provider: ProviderInterface, address: string, chainId?: string): Promise<TokenInfo> {
  let known: KnownToken | undefined;
  try {
    known = knownTokensFor(chainId ?? (await provider.getChainId())).find((token) => sameFelt(token.address, address));
  } catch {
    // The network did not answer, or the address is not a felt: ask the contract instead.
  }
  if (known) return { status: 'known', address, symbol: known.symbol, decimals: known.decimals };
  try {
    const [symbolResult, decimalsResult] = await Promise.all([
      provider.callContract({ contractAddress: address, entrypoint: 'symbol', calldata: [] }),
      provider.callContract({ contractAddress: address, entrypoint: 'decimals', calldata: [] }),
    ]);
    const symbol = decodeSymbol(symbolResult);
    const decimals = decimalsResult.length === 1 ? Number(BigInt(decimalsResult[0]!)) : NaN;
    if (!symbol || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return { status: 'unknown', address };
    return { status: 'unverified', address, symbol, decimals };
  } catch {
    return { status: 'unknown', address };
  }
}

/**
 * An amount as an approval screen should say it. For a known token "1.5 STRK"; for an
 * unverified one the same with the claimed symbol; for an unknown one the raw number of units.
 */
export function describeAmount(amount: bigint, token: TokenInfo): string {
  if (isUnlimitedAmount(amount)) return token.status === 'unknown' ? 'an unlimited amount' : `an unlimited amount of ${token.symbol}`;
  if (token.status === 'unknown') return `${amount.toString()} units`;
  return `${formatTokenAmount(amount, token.decimals)} ${token.symbol}`;
}
