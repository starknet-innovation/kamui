import { describe, expect, test } from 'bun:test';
import { HttpError } from '../../http';
import { MAX_SPONSORED_CALLDATA, parseSponsorRequest, sponsorOutsideExecution, sponsoredPerHour } from './sponsor';

const ACCOUNT = '0x3ec3b3ead6762ecf0172e0d5e3f9df472e66608e3f483f300a784dc9652d193';
const CLASS = '0x13c5e8166199db99e894da9e55ce642267e5258c42eae8851357747b6201fdc';
const code = (work: () => unknown) => {
  try {
    work();
    return 'ok';
  } catch (e) {
    return `${(e as HttpError).status} ${(e as Error).message}`;
  }
};

/** A context whose relayer records what it was asked to send. */
function context(over: { classHash?: string; perHour?: number } = {}) {
  const sent: any[] = [];
  const ctx: any = {
    classHash: CLASS,
    sponsoredPerHour: over.perHour ?? 1000,
    provider: { getClassHashAt: async () => over.classHash ?? CLASS },
    relayer: { execute: async (call: unknown) => (sent.push(call), { transaction_hash: '0xabc' }) },
  };
  return { ctx, sent };
}

describe('sponsor request', () => {
  test('accepts an account and hex calldata', () => {
    expect(parseSponsorRequest({ account: ACCOUNT, calldata: ['0x1', '0x2'] })).toEqual({ account: ACCOUNT, calldata: ['0x1', '0x2'] });
  });

  test('refuses malformed requests', () => {
    expect(code(() => parseSponsorRequest({ account: 'x', calldata: ['0x1'] }))).toBe('400 BAD_ACCOUNT');
    expect(code(() => parseSponsorRequest({ account: ACCOUNT, calldata: [] }))).toBe('400 BAD_CALLDATA');
    expect(code(() => parseSponsorRequest({ account: ACCOUNT, calldata: ['1'] }))).toBe('400 BAD_CALLDATA');
    expect(code(() => parseSponsorRequest({ account: ACCOUNT, calldata: 'nope' as any }))).toBe('400 BAD_CALLDATA');
    const tooLong = Array.from({ length: MAX_SPONSORED_CALLDATA + 1 }, () => '0x1');
    expect(code(() => parseSponsorRequest({ account: ACCOUNT, calldata: tooLong }))).toBe('400 BAD_CALLDATA');
  });
});

describe('sponsoring', () => {
  test('sends exactly one entry point, to the account, with the calldata given', async () => {
    const { ctx, sent } = context();
    const result = await sponsorOutsideExecution({ account: ACCOUNT, calldata: ['0x1', '0x2'] }, '203.0.113.1', ctx);
    expect(result).toEqual({ transaction_hash: '0xabc' });
    expect(sent).toEqual([{ contractAddress: ACCOUNT, entrypoint: 'execute_from_outside_v2', calldata: ['0x1', '0x2'] }]);
  });

  test('refuses a contract that is not a Kamui account', async () => {
    const { ctx, sent } = context({ classHash: '0x1' });
    await expect(sponsorOutsideExecution({ account: ACCOUNT, calldata: ['0x1'] }, '203.0.113.2', ctx)).rejects.toThrow('WRONG_CLASS');
    expect(sent).toHaveLength(0);
  });

  test('is off when the cap is 0', async () => {
    const { ctx, sent } = context({ perHour: 0 });
    await expect(sponsorOutsideExecution({ account: ACCOUNT, calldata: ['0x1'] }, '203.0.113.3', ctx)).rejects.toThrow('SPONSOR_DISABLED');
    expect(sent).toHaveLength(0);
  });

  test('stops at the per-address cap', async () => {
    const { ctx } = context();
    const ip = '203.0.113.4';
    for (let i = 0; i < 60; i++) await sponsorOutsideExecution({ account: ACCOUNT, calldata: ['0x1'] }, ip, ctx);
    await expect(sponsorOutsideExecution({ account: ACCOUNT, calldata: ['0x1'] }, ip, ctx)).rejects.toThrow('RATE_LIMITED');
  });
});

describe('sponsor settings', () => {
  test('off by default on mainnet, on elsewhere, and settable', () => {
    expect(sponsoredPerHour('SN_MAIN', undefined)).toBe(0);
    expect(sponsoredPerHour('SN_SEPOLIA', undefined)).toBe(120);
    expect(sponsoredPerHour('SN_MAIN', '50')).toBe(50);
    expect(sponsoredPerHour('SN_SEPOLIA', '0')).toBe(0);
    expect(() => sponsoredPerHour('SN_SEPOLIA', 'lots')).toThrow();
  });
});
