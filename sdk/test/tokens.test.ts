// Token names and amounts for approval screens.
import { describe, expect, test } from 'bun:test';
import { shortString } from 'starknet';
import { KNOWN_TOKENS, describeAmount, formatTokenAmount, isUnlimitedAmount, readTokenInfo, type TokenInfo } from '../src';

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const OTHER = '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc';
const felt = (text: string) => shortString.encodeShortString(text);

/** A chain where `OTHER` answers `symbol()` and `decimals()` as given. */
function chain(answers: { symbol?: string[]; decimals?: string[] } | 'not a contract') {
  const calls: string[] = [];
  const provider = {
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
    expect(KNOWN_TOKENS.map((token) => token.symbol)).toEqual(['STRK', 'ETH']);
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
