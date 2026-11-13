// The backend keeps its own copies of the account derivation (its image is built from
// services/backend alone and cannot import this package). These tests pin both copies to the
// same answers, so the client and the server can never derive different accounts.
//
// They live here rather than in the backend so that changing them never changes a backend image.
import { describe, expect, test } from 'bun:test';
import { accountAddress, constructorCalldata, deployAccountCall, identity } from '../src/address';
import { loginNonce } from '../src/login';
import {
  accountAddress as backendAccountAddress,
  constructorCalldata as backendConstructorCalldata,
  deployCall as backendDeployCall,
  expectedNonce as backendExpectedNonce,
  extractIdentity as backendIdentity,
} from '../../services/backend/src/social-account';
import type { Jwt } from '../../services/backend/src/jwk/verification';

const CLASS_HASH = '0x4c6d6f0f4c3d1b4a1e0f7c2b9d8e5a3f1c2b4d6e8f0a1b3c5d7e9f1a2b3c4d5';
const CLAIMS = [
  { iss: 'https://accounts.google.com', aud: '123-abc.apps.googleusercontent.com', sub: '123456789012345678901' },
  // A long aud spans more than one ByteArray word, which exercises the full word encoding.
  { iss: 'https://appleid.apple.com', aud: 'com.example.kamui.' + 'x'.repeat(40), sub: '001234.abcdef0123456789.0123' },
];
const PEPPERS = ['0x0', '0x1', '0x' + 'f'.repeat(62)];
const felt = (value: string) => BigInt(value);

describe('backend and SDK derive the same account', () => {
  for (const claims of CLAIMS) {
    for (const pepper of PEPPERS) {
      const label = `${claims.iss} / pepper ${pepper.slice(0, 6)}`;
      const id = identity(claims, pepper);

      test(`identity: ${label}`, () => {
        expect(felt(backendIdentity(claims as Jwt, pepper))).toBe(felt(id));
      });

      test(`constructor calldata: ${label}`, () => {
        expect(backendConstructorCalldata(claims.aud, id).map(felt)).toEqual(constructorCalldata(claims.aud, id).map(felt));
      });

      test(`address and deploy call: ${label}`, () => {
        // The two copies take their arguments in different orders; this pins which is which.
        const sdk = accountAddress(CLASS_HASH, claims.aud, id);
        expect(felt(backendAccountAddress(claims.aud, id, CLASS_HASH))).toBe(felt(sdk));
        const ours = deployAccountCall(CLASS_HASH, claims.aud, id);
        const theirs = backendDeployCall(claims.aud, id, CLASS_HASH);
        expect(theirs.contractAddress).toBe(ours.contractAddress);
        expect(theirs.entrypoint).toBe(ours.entrypoint);
        expect((theirs.calldata as string[]).map(felt)).toEqual((ours.calldata as string[]).map(felt));
      });
    }
  }

  test('the same identity with other padding or case is the same account', () => {
    const id = identity(CLAIMS[0]!, '0x1');
    const padded = '0x' + BigInt(id).toString(16).padStart(64, '0').toUpperCase();
    const sdk = felt(accountAddress(CLASS_HASH, CLAIMS[0]!.aud, id));
    expect(felt(backendAccountAddress(CLAIMS[0]!.aud, padded, CLASS_HASH))).toBe(sdk);
  });

  test('the login nonce is the one the backend expects', () => {
    for (const [key, blinding] of [['0x1', '0x2'], ['0x' + 'a'.repeat(63), '0x' + 'b'.repeat(63)]] as const) {
      expect(backendExpectedNonce(key, blinding)).toBe(felt(loginNonce(key, blinding)));
    }
  });
});
