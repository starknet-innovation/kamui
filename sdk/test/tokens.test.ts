// Token names and amounts for approval screens.
import { describe, expect, test } from 'bun:test';
import { shortString } from 'starknet';
import {
  KNOWN_TOKENS,
  TOKEN_NETWORKS,
  describeAmount,
  formatTokenAmount,
  isUnlimitedAmount,
  knownTokensFor,
  readTokenInfo,
  type TokenInfo,
  type TokenNetwork,
} from '../src';

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const SEPOLIA_USDC = '0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343';
const OTHER = '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc';
const felt = (text: string) => shortString.encodeShortString(text);

/** A chain where `OTHER` answers `symbol()` and `decimals()` as given. Sepolia unless told otherwise. */
function chain(answers: { symbol?: string[]; decimals?: string[] } | 'not a contract', chainId: string | null = TOKEN_NETWORKS.sepolia) {
  const calls: string[] = [];
  const provider = {
    async getChainId() {
      if (chainId === null) throw new Error('node unreachable');
      return chainId;
    },
    async callContract({ contractAddress, entrypoint }: { contractAddress: string; entrypoint: string }) {
      calls.push(`${entrypoint}@${contractAddress}`);
      if (answers === 'not a contract') throw new Error('Contract not found');
      const result = entrypoint === 'symbol' ? answers.symbol : answers.decimals;
      if (!result) throw new Error('Entry point not found');
      return result;
    },
  };
  return { provider: provider as any, calls };
}

describe('amounts', () => {
  test('are written exactly, in whole units', () => {
    expect(formatTokenAmount(1_500_000_000_000_000_000n, 18)).toBe('1.5');
    expect(formatTokenAmount(1_000_000_000_000_000_000n, 18)).toBe('1');
    expect(formatTokenAmount(1n, 18)).toBe('0.000000000000000001');
    expect(formatTokenAmount(0n, 18)).toBe('0');
    expect(formatTokenAmount(123_456_789n, 6)).toBe('123.456789');
    expect(formatTokenAmount(1_234_567_000_000n, 6)).toBe('1,234,567');
    expect(formatTokenAmount(42n, 0)).toBe('42');
    // No rounding, however large: every digit is kept.
    expect(formatTokenAmount(123_456_789_012_345_678_901_234_567_890n, 18)).toBe('123,456,789,012.34567890123456789');
  });

  test('refuse negative amounts and nonsense decimals', () => {
    expect(() => formatTokenAmount(-1n, 18)).toThrow();
    expect(() => formatTokenAmount(1n, -1)).toThrow();
    expect(() => formatTokenAmount(1n, 1.5)).toThrow();
  });

  test('the conventional "no limit" values are recognised', () => {
    expect(isUnlimitedAmount((1n << 256n) - 1n)).toBe(true);
    expect(isUnlimitedAmount((1n << 128n) - 1n)).toBe(true);
    expect(isUnlimitedAmount((1n << 128n) - 2n)).toBe(false);
    expect(isUnlimitedAmount(0n)).toBe(false);
  });

  test('read differently for known, unverified and unknown tokens', () => {
    const known: TokenInfo = { status: 'known', address: STRK, symbol: 'STRK', decimals: 18 };
    const unverified: TokenInfo = { status: 'unverified', address: OTHER, symbol: 'GOLD', decimals: 6 };
    const unknown: TokenInfo = { status: 'unknown', address: OTHER };
    expect(describeAmount(1_500_000_000_000_000_000n, known)).toBe('1.5 STRK');
    expect(describeAmount(2_500_000n, unverified)).toBe('2.5 GOLD');
    expect(describeAmount(2_500_000n, unknown)).toBe('2500000 units');
    expect(describeAmount((1n << 256n) - 1n, known)).toBe('an unlimited amount of STRK');
    expect(describeAmount((1n << 256n) - 1n, unknown)).toBe('an unlimited amount');
  });
});

describe('token lookup', () => {
  test('a listed address is known without asking the chain', async () => {
    const { provider, calls } = chain('not a contract');
    expect(await readTokenInfo(provider, STRK)).toEqual({ status: 'known', address: STRK, symbol: 'STRK', decimals: 18 });
    // The same address written differently is the same token.
    expect((await readTokenInfo(provider, '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d')).status).toBe('known');
    expect(calls).toEqual([]);
  });

  test('a token is known only on the network it is listed for', async () => {
    const usdc = { symbol: [felt('USDC')], decimals: ['0x6'] };
    expect(await readTokenInfo(chain(usdc).provider, SEPOLIA_USDC)).toEqual({ status: 'known', address: SEPOLIA_USDC, symbol: 'USDC', decimals: 6 });
    // The same address on mainnet, or on a chain the SDK does not cover, is only what it claims.
    expect((await readTokenInfo(chain(usdc, TOKEN_NETWORKS.mainnet).provider, SEPOLIA_USDC)).status).toBe('unverified');
    expect((await readTokenInfo(chain(usdc, '0x4b4154414e41').provider, SEPOLIA_USDC)).status).toBe('unverified');
    expect((await readTokenInfo(chain(usdc, '0x4b4154414e41').provider, STRK)).status).toBe('unverified');
    // A chain id passed in is used instead of asking the provider.
    expect((await readTokenInfo(chain(usdc, null).provider, SEPOLIA_USDC, TOKEN_NETWORKS.sepolia)).status).toBe('known');
    expect((await readTokenInfo(chain(usdc).provider, SEPOLIA_USDC, TOKEN_NETWORKS.mainnet)).status).toBe('unverified');
  });

  test('if the network cannot be told, nothing is known', async () => {
    const strk = { symbol: [felt('STRK')], decimals: ['0x12'] };
    expect((await readTokenInfo(chain(strk, null).provider, STRK)).status).toBe('unverified');
    expect((await readTokenInfo(chain(strk, 'not a chain id').provider, STRK)).status).toBe('unverified');
    expect(knownTokensFor('not a chain id')).toEqual([]);
    expect(knownTokensFor('0x1')).toEqual([]);
    expect(knownTokensFor(TOKEN_NETWORKS.sepolia)).toBe(KNOWN_TOKENS.sepolia);
    // The same chain id written with leading zeros is the same network.
    expect(knownTokensFor('0x00534e5f4d41494e')).toBe(KNOWN_TOKENS.mainnet);
  });

  test('a contract that answers like a token is unverified, whatever it claims', async () => {
    const info = await readTokenInfo(chain({ symbol: [felt('GOLD')], decimals: ['0x6'] }).provider, OTHER);
    expect(info).toEqual({ status: 'unverified', address: OTHER, symbol: 'GOLD', decimals: 6 });
    // A contract claiming to be STRK at another address is still only unverified.
    const fake = await readTokenInfo(chain({ symbol: [felt('STRK')], decimals: ['0x12'] }).provider, OTHER);
    expect(fake.status).toBe('unverified');
  });

  test('a symbol returned as a byte array is read too', async () => {
    // ByteArray "USDC": no full word, pending word 'USDC', pending length 4.
    const info = await readTokenInfo(chain({ symbol: ['0x0', felt('USDC'), '0x4'], decimals: ['0x6'] }).provider, OTHER);
    expect(info).toMatchObject({ status: 'unverified', symbol: 'USDC', decimals: 6 });
  });

  test('anything that does not answer like a token is unknown', async () => {
    const unknown: TokenInfo = { status: 'unknown', address: OTHER };
    expect(await readTokenInfo(chain('not a contract').provider, OTHER)).toEqual(unknown);
    expect(await readTokenInfo(chain({ symbol: [felt('GOLD')] }).provider, OTHER)).toEqual(unknown);
    expect(await readTokenInfo(chain({ symbol: [felt('GOLD')], decimals: ['0x64'] }).provider, OTHER)).toEqual(unknown); // 100 decimals
    expect(await readTokenInfo(chain({ symbol: [felt('GOLD')], decimals: ['0x1', '0x2'] }).provider, OTHER)).toEqual(unknown);
  });

  test('a symbol that is not plain text is not shown', async () => {
    const lookup = (symbol: string[]) => readTokenInfo(chain({ symbol, decimals: ['0x6'] }).provider, OTHER);
    expect((await lookup([felt('<b>X</b>')])).status).toBe('unknown');
    expect((await lookup([felt('STRK (real)')])).status).toBe('unknown');
    expect((await lookup([felt('ABCDEFGHIJKLM')])).status).toBe('unknown'); // 13 characters
    expect((await lookup(['0x0'])).status).toBe('unknown'); // empty
    expect((await lookup(['0x5', '0x1', '0x2'])).status).toBe('unknown'); // a long byte array
  });
});

// The list is a security control (see ../KNOWN_TOKENS.md). These checks need no network; the
// check against a live node is `bun run check:tokens`.
describe('the known-token list', () => {
  const networks = Object.keys(KNOWN_TOKENS) as TokenNetwork[];

  test('covers exactly the networks that have a chain id', () => {
    expect(Object.keys(KNOWN_TOKENS).sort()).toEqual(Object.keys(TOKEN_NETWORKS).sort());
    expect(TOKEN_NETWORKS.mainnet as string).toBe(felt('SN_MAIN'));
    expect(TOKEN_NETWORKS.sepolia as string).toBe(felt('SN_SEPOLIA'));
  });

  test('every entry is well formed', () => {
    for (const network of networks) {
      expect(KNOWN_TOKENS[network].length).toBeGreaterThan(0);
      for (const token of KNOWN_TOKENS[network]) {
        const where = `${network} ${token.symbol} ${token.address}`;
        // One spelling per address: lowercase, 0x and 64 hex digits, below 2^251.
        expect(token.address, where).toMatch(/^0x0[0-7][0-9a-f]{62}$/);
        expect(BigInt(token.address), where).not.toBe(0n);
        // The same rule an unverified symbol must pass before it is shown.
        expect(token.symbol, where).toMatch(/^[A-Za-z0-9._-]{1,12}$/);
        expect(Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 36, where).toBe(true);
        expect(token.source, where).toMatch(/^https:\/\/\S+$/);
        expect(Object.keys(token).sort(), where).toEqual(['address', 'decimals', 'source', 'symbol']);
      }
    }
  });

  test('no address and no symbol is listed twice on a network', () => {
    for (const network of networks) {
      const addresses = KNOWN_TOKENS[network].map((token) => BigInt(token.address));
      expect(new Set(addresses).size, `${network} addresses`).toBe(addresses.length);
      // Two trusted tokens with the same name could not be told apart on an approval screen.
      const symbols = KNOWN_TOKENS[network].map((token) => token.symbol.toLowerCase());
      expect(new Set(symbols).size, `${network} symbols`).toBe(symbols.length);
    }
  });

  test('is the list that was reviewed: a change here is a deliberate change', () => {
    const listed = (network: TokenNetwork) => KNOWN_TOKENS[network].map((token) => `${token.symbol}/${token.decimals}`);
    expect(listed('mainnet')).toEqual(['STRK/18', 'ETH/18']);
    expect(listed('sepolia')).toEqual(['STRK/18', 'ETH/18', 'vSTRK/18', 'USDC/6', 'USDT/6', 'WBTC/8']);
  });
});
