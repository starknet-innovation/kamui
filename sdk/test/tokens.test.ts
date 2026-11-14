// Token names and amounts for approval screens.
import { describe, expect, test } from 'bun:test';
import { shortString } from 'starknet';
import { STRK_ADDRESS, describeAmount, formatTokenAmount, isUnlimitedAmount, readTokenInfo, type TokenInfo } from '../src';

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

  test('read in whole units for a token with a symbol, in raw units for one without', () => {
    const strk: TokenInfo = { status: 'named', address: STRK, symbol: 'STRK', decimals: 18 };
    const gold: TokenInfo = { status: 'named', address: OTHER, symbol: 'GOLD', decimals: 6 };
    const unknown: TokenInfo = { status: 'unknown', address: OTHER };
    expect(describeAmount(1_500_000_000_000_000_000n, strk)).toBe('1.5 STRK');
    expect(describeAmount(2_500_000n, gold)).toBe('2.5 GOLD');
    expect(describeAmount(2_500_000n, unknown)).toBe('2500000 units');
    expect(describeAmount((1n << 256n) - 1n, strk)).toBe('an unlimited amount of STRK');
    expect(describeAmount((1n << 256n) - 1n, unknown)).toBe('an unlimited amount');
  });
});

describe('token lookup', () => {
  test('STRK is built in and answered without asking the chain', async () => {
    const { provider, calls } = chain('not a contract');
    expect(await readTokenInfo(provider, STRK)).toEqual({ status: 'named', address: STRK, symbol: 'STRK', decimals: 18 });
    // The same address written differently is the same token.
    expect(await readTokenInfo(provider, '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d')).toMatchObject({ symbol: 'STRK', decimals: 18 });
    expect(calls).toEqual([]);
    expect(STRK_ADDRESS).toBe(STRK);
  });

  test('any other token is named by what its contract answers', async () => {
    const { provider, calls } = chain({ symbol: [felt('GOLD')], decimals: ['0x6'] });
    expect(await readTokenInfo(provider, OTHER)).toEqual({ status: 'named', address: OTHER, symbol: 'GOLD', decimals: 6 });
    expect(calls.sort()).toEqual([`decimals@${OTHER}`, `symbol@${OTHER}`]);
    // No list is consulted: ETH is read from the chain like any other token.
    const eth = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
    const asked = chain({ symbol: [felt('ETH')], decimals: ['0x12'] });
    expect(await readTokenInfo(asked.provider, eth)).toEqual({ status: 'named', address: eth, symbol: 'ETH', decimals: 18 });
    expect(asked.calls).toHaveLength(2);
  });

  test('a symbol returned as a byte array is read too', async () => {
    // ByteArray "USDC": no full word, pending word 'USDC', pending length 4.
    const info = await readTokenInfo(chain({ symbol: ['0x0', felt('USDC'), '0x4'], decimals: ['0x6'] }).provider, OTHER);
    expect(info).toMatchObject({ status: 'named', symbol: 'USDC', decimals: 6 });
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
