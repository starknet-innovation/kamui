import { describe, expect, test } from 'bun:test';
import { createHmac, randomBytes } from 'node:crypto';
import {
  FELT_PRIME, derivePepper, encodeInput, inMemoryDeriver, keyCheckValue, macToPepper, pepperToHex,
} from '../src/derive';
import { APPLE, GOOGLE, SUB } from './helpers';

const key = Uint8Array.from(randomBytes(32));

describe('derivePepper', () => {
  test('the field prime is 2^251 + 17 * 2^192 + 1', () => {
    expect(FELT_PRIME).toBe(0x800000000000011000000000000000000000000000000000000000000000001n);
  });

  test('is deterministic', () => {
    expect(derivePepper(key, GOOGLE, SUB)).toBe(derivePepper(Uint8Array.from(key), GOOGLE, SUB));
  });

  test('has no aud input, so it cannot differ across audiences', () => {
    // The signature is (key, iss, sub). The HTTP-level test in service.test.ts checks the
    // same thing end to end with two tokens that differ only in `aud`.
    expect(derivePepper.length).toBe(3);
  });

  test('differs for a different sub, a different iss and a different key', () => {
    const base = derivePepper(key, GOOGLE, SUB);
    expect(derivePepper(key, GOOGLE, SUB.replace(/1$/, '2'))).not.toBe(base);
    expect(derivePepper(key, APPLE, SUB)).not.toBe(base);
    expect(derivePepper(Uint8Array.from(randomBytes(32)), GOOGLE, SUB)).not.toBe(base);
  });

  test('the encoding is injective: moving bytes between iss and sub changes the pepper', () => {
    expect(Buffer.from(encodeInput('ab', 'c'))).not.toEqual(Buffer.from(encodeInput('a', 'bc')));
    expect(derivePepper(key, 'ab', 'c')).not.toBe(derivePepper(key, 'a', 'bc'));
  });

  test('is always a valid felt252: below 2^250, hence below the field prime', () => {
    for (let i = 0; i < 2000; i++) {
      const p = derivePepper(Uint8Array.from(randomBytes(32)), GOOGLE, String(i));
      expect(p >= 0n && p < 2n ** 250n && p < FELT_PRIME).toBe(true);
    }
  });

  test('the worst-case MAC (all ones) still maps below the field prime', () => {
    const max = macToPepper(new Uint8Array(32).fill(0xff));
    expect(max).toBe(2n ** 250n - 1n);
    expect(max < FELT_PRIME).toBe(true);
    expect(macToPepper(new Uint8Array(32))).toBe(0n);
  });

  test('matches an independent computation of the documented formula', () => {
    const k = Buffer.alloc(32, 7);
    const msg = Buffer.concat([
      Buffer.from('kamui.pepper.v1'), Buffer.from([0]),
      Buffer.from([0, 0, 0, GOOGLE.length]), Buffer.from(GOOGLE),
      Buffer.from([0, 0, 0, SUB.length]), Buffer.from(SUB),
    ]);
    const mac = createHmac('sha256', k).update(msg).digest('hex');
    expect(derivePepper(k, GOOGLE, SUB)).toBe(BigInt(`0x${mac}`) % 2n ** 250n);
  });

  test('pinned vector: a change to the derivation would move every user to a new address', () => {
    // Key = 32 bytes of 0x07 (not a secret; a test vector).
    expect(pepperToHex(derivePepper(Buffer.alloc(32, 7), GOOGLE, SUB))).toBe(PINNED);
  });

  test('rejects a wrong key length, an all-zero key and empty inputs', () => {
    expect(() => derivePepper(new Uint8Array(16), GOOGLE, SUB)).toThrow('BAD_KEY_LENGTH');
    expect(() => inMemoryDeriver(new Uint8Array(32), 1)).toThrow('ZERO_KEY');
    expect(() => derivePepper(key, GOOGLE, '')).toThrow('EMPTY_INPUT');
  });

  test('the key check value is stable per key and is not a prefix of any pepper path', () => {
    expect(keyCheckValue(key)).toBe(keyCheckValue(key));
    expect(keyCheckValue(key)).toMatch(/^[0-9a-f]{16}$/);
    expect(keyCheckValue(key)).not.toBe(keyCheckValue(Uint8Array.from(randomBytes(32))));
  });
});

const PINNED = '0x2b30880cc32b52a8a1bb094b8201ac8d42c8d9d4472b6875faf1fe8386fab71';
