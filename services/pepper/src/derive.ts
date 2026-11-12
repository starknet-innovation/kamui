// The pepper derivation. Pure: no I/O, no clock, no globals. See DESIGN.md, section 3.
//
//   pepper = low 250 bits of HMAC-SHA-256(key, encode(iss, sub))
//
// The pepper depends on (iss, sub) only. It must not depend on `aud`: override recovery
// rebuilds the identity under the account's original `aud` with the same pepper.
import { createHmac } from 'node:crypto';

/** The Starknet field prime, 2^251 + 17 * 2^192 + 1. Every felt252 is below it. */
export const FELT_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;
/** Peppers are 250-bit integers, so they are below FELT_PRIME with no reduction. */
export const PEPPER_BITS = 250;
export const KEY_BYTES = 32;

const DERIVE_TAG = 'kamui.pepper.v1';
const KEY_CHECK_TAG = 'kamui.pepper.key-check.v1';

/**
 * The HMAC message: tag, a zero byte, then each string as a 4-byte big-endian length
 * followed by its UTF-8 bytes. Length prefixes make the encoding injective, so no two
 * (iss, sub) pairs share a message.
 */
export function encodeInput(iss: string, sub: string): Uint8Array {
  const enc = new TextEncoder();
  const parts = [enc.encode(iss), enc.encode(sub)];
  const tag = enc.encode(DERIVE_TAG);
  const out = new Uint8Array(tag.length + 1 + parts.reduce((n, p) => n + 4 + p.length, 0));
  const view = new DataView(out.buffer);
  out.set(tag, 0);
  let at = tag.length + 1;
  for (const p of parts) {
    view.setUint32(at, p.length, false);
    out.set(p, at + 4);
    at += 4 + p.length;
  }
  return out;
}

/** Reads a 32-byte MAC as a big-endian integer and keeps the low 250 bits. */
export function macToPepper(mac: Uint8Array): bigint {
  if (mac.length !== 32) throw new Error('BAD_MAC_LENGTH');
  let v = 0n;
  for (const b of mac) v = (v << 8n) | BigInt(b);
  return v & ((1n << BigInt(PEPPER_BITS)) - 1n);
}

/** The pepper for one user of one issuer. Same key and inputs always give the same value. */
export function derivePepper(key: Uint8Array, iss: string, sub: string): bigint {
  assertKey(key);
  if (!iss || !sub) throw new Error('EMPTY_INPUT');
  return macToPepper(createHmac('sha256', key).update(encodeInput(iss, sub)).digest());
}

/** Lowercase `0x` hex without leading zeros, the form the recover API and SDK pass around. */
export function pepperToHex(pepper: bigint): string {
  return `0x${pepper.toString(16)}`;
}

/**
 * A short public fingerprint of the key (16 hex characters), under its own tag so it says
 * nothing about any pepper. Recorded at the key ceremony; the service compares it at startup
 * so that a wrong or mistyped key is refused instead of silently giving every user a new,
 * empty account.
 */
export function keyCheckValue(key: Uint8Array): string {
  assertKey(key);
  return createHmac('sha256', key).update(KEY_CHECK_TAG).digest('hex').slice(0, 16);
}

/** The message whose MAC is the key check value. Shared by every kind of key holder. */
export function keyCheckMessage(): Uint8Array {
  return new TextEncoder().encode(KEY_CHECK_TAG);
}

/** The key check value from the MAC of `keyCheckMessage()`: its first 16 hex characters. */
export function keyCheckFromMac(mac: Uint8Array): string {
  if (mac.length !== 32) throw new Error('BAD_MAC_LENGTH');
  return Buffer.from(mac).toString('hex').slice(0, 16);
}

function assertKey(key: Uint8Array) {
  if (key.length !== KEY_BYTES) throw new Error('BAD_KEY_LENGTH');
}

/**
 * What the HTTP layer needs from a key holder. The reference holds the key in memory;
 * a production deriver calls an HSM or KMS MAC operation and applies `macToPepper`.
 */
export interface PepperDeriver {
  readonly version: number;
  derive(iss: string, sub: string): Promise<bigint>;
}

/** Development deriver: key in process memory. Not for production. */
export function inMemoryDeriver(key: Uint8Array, version: number): PepperDeriver {
  assertKey(key);
  if (key.every((b) => b === 0)) throw new Error('ZERO_KEY');
  const copy = Uint8Array.from(key);
  return { version, derive: async (iss, sub) => derivePepper(copy, iss, sub) };
}
