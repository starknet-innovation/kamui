// Proof that the caller holds the device key the token was requested for.
//
// The keychain sets the OAuth nonce to poseidon(new_pubkey, blinding); the account contract
// checks the same in `prove_jwt` (contracts/src/social/component.cairo). Here the caller
// reveals (public_key, blinding) and signs a message derived from the nonce with that key,
// so a token captured on its own (from a log, a proxy, a referrer) does not yield a pepper.
import { poseidonHashMany, verify } from '@scure/starknet';
import { ApiError } from './errors';
import { FELT_PRIME } from './derive';

/** The contract's nonce format (`parse_hex_felt`): lowercase `0x` hex. */
const NONCE = /^0x[0-9a-f]{1,64}$/;
const HEX = /^0x[0-9a-fA-F]{1,64}$/;

/** 'kamui.pepper.v1' as a Cairo short string. Separates this signature from any other use of the key. */
export const KEY_PROOF_DOMAIN = BigInt(`0x${Buffer.from('kamui.pepper.v1').toString('hex')}`);

export type KeyProof = { public_key: string; blinding: string; signature: [string, string] };

export function parseNonce(nonce: string): bigint {
  if (!NONCE.test(nonce)) throw new ApiError(400, 'BAD_NONCE');
  const v = BigInt(nonce);
  if (v >= FELT_PRIME) throw new ApiError(400, 'BAD_NONCE');
  return v;
}

/** The hash the device key signs: poseidon(domain, nonce). */
export function keyProofHash(nonce: bigint): bigint {
  return poseidonHashMany([KEY_PROOF_DOMAIN, nonce]);
}

export function parseKeyProof(body: Record<string, unknown>): KeyProof {
  const { public_key, blinding, signature } = body;
  const hex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v) && BigInt(v) < FELT_PRIME;
  if (!hex(public_key) || !hex(blinding)) throw new ApiError(400, 'BAD_KEY_PROOF');
  if (!Array.isArray(signature) || signature.length !== 2 || !signature.every(hex)) throw new ApiError(400, 'BAD_KEY_PROOF');
  return { public_key, blinding, signature: [signature[0], signature[1]] };
}

export function verifyKeyProof(nonce: bigint, proof: KeyProof): void {
  const pub = BigInt(proof.public_key);
  if (poseidonHashMany([pub, BigInt(proof.blinding)]) !== nonce) throw new ApiError(401, 'NONCE_MISMATCH');

  const word = (v: bigint) => v.toString(16).padStart(64, '0');
  const sig = word(BigInt(proof.signature[0])) + word(BigInt(proof.signature[1]));
  const hash = word(keyProofHash(nonce));
  // A Starknet public key is the x coordinate only; either y may be the signer's.
  const ok = ['02', '03'].some((prefix) => {
    try {
      return verify(sig, hash, prefix + word(pub));
    } catch {
      return false;
    }
  });
  if (!ok) throw new ApiError(401, 'BAD_KEY_PROOF_SIGNATURE');
}
