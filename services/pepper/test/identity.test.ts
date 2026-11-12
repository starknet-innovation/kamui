// The pepper this service returns must reproduce the on-chain identity:
// poseidon(iss, aud, sub, pepper) with the strings serialized as Cairo ByteArrays
// (contracts/src/jwt/types.cairo, `identity` and `identity_from_other_aud`).
import { beforeAll, expect, test } from 'bun:test';
import { poseidonHashMany } from '@scure/starknet';
import { CallData, byteArray, hash } from 'starknet';
import { FELT_PRIME } from '../src/derive';
import { AUD, GOOGLE, NOW, RECOVERY_AUD, SUB, claims, makeDevice, makeIssuer, makeService, type Issuer } from './helpers';

/**
 * Upstream's `extractIdentity`, copied from keep-starknet-strange/social-account (MIT),
 * backend/src/social-account.ts at commit e1681348afbf5fc55ea410ea7ef93e1df575e969.
 */
function extractIdentity(token: { iss: string; aud: string; sub: string }, pepper: string): string {
  return hash.computePoseidonHashOnElements(
    CallData.compile([...[token.iss, token.aud, token.sub].map(byteArray.byteArrayFromString), pepper]),
  );
}

/** The Cairo formula written out by hand, with no starknet.js: ByteArray = [word count, ...31-byte words, pending word, pending length]. */
function cairoByteArray(s: string): bigint[] {
  const bytes = Buffer.from(s, 'utf8');
  const full = Math.floor(bytes.length / 31);
  const words = Array.from({ length: full }, (_, i) => BigInt(`0x${bytes.subarray(i * 31, i * 31 + 31).toString('hex')}`));
  const rest = bytes.subarray(full * 31);
  return [BigInt(full), ...words, rest.length ? BigInt(`0x${rest.toString('hex')}`) : 0n, BigInt(rest.length)];
}
function cairoIdentity(iss: string, aud: string, sub: string, pepper: bigint): bigint {
  return poseidonHashMany([...cairoByteArray(iss), ...cairoByteArray(aud), ...cairoByteArray(sub), pepper]);
}

let issuer: Issuer;
beforeAll(async () => {
  issuer = await makeIssuer('kid-1');
});

test('both identity implementations reproduce the value printed by the Cairo test', () => {
  // contracts/src/jwt/types.cairo::tests::identity_reference, as pinned in upstream's
  // backend/src/social-account.test.ts: identity(pepper = 0) for these exact strings.
  const t = { iss: GOOGLE, aud: '123-abc.apps.googleusercontent.com', sub: SUB };
  const reference = 3390181075934669139936153450168116728521076354543506169098880721240937364581n;
  expect(BigInt(extractIdentity(t, '0x0'))).toBe(reference);
  expect(cairoIdentity(t.iss, t.aud, t.sub, 0n)).toBe(reference);
});

test('the returned pepper gives the same identity under extractIdentity and the Cairo formula', async () => {
  const svc = makeService([issuer]);
  const device = makeDevice();
  const res = await svc.post({ jwt: await issuer.sign(claims({ nonce: device.nonce })), ...device.proof });
  expect(res.status).toBe(200);
  const pepper = res.body.pepper!;

  // The pepper is accepted as one felt by starknet.js calldata and by the Cairo formula.
  expect(BigInt(pepper) < FELT_PRIME).toBe(true);
  const identity = BigInt(extractIdentity({ iss: GOOGLE, aud: AUD, sub: SUB }, pepper));
  expect(identity).toBe(cairoIdentity(GOOGLE, AUD, SUB, BigInt(pepper)));
  expect(identity).not.toBe(BigInt(extractIdentity({ iss: GOOGLE, aud: AUD, sub: SUB }, '0x0')));
});

test('override recovery: a token under the recovery aud yields the pepper that rebuilds the original identity', async () => {
  const svc = makeService([issuer]);
  const first = makeDevice();
  const login = await svc.post({ jwt: await issuer.sign(claims({ nonce: first.nonce })), ...first.proof });
  const stored = extractIdentity({ iss: GOOGLE, aud: AUD, sub: SUB }, login.body.pepper!);

  // Later, on a new device, the user signs in through the recovery client.
  const second = makeDevice();
  const recovery = await svc.post({
    jwt: await issuer.sign(claims({ aud: RECOVERY_AUD, nonce: second.nonce, iat: NOW / 1000 - 1 })),
    ...second.proof,
  });
  expect(recovery.status).toBe(200);
  // `identity_from_other_aud(original_aud, pepper)` in prove_jwt's override branch.
  expect(extractIdentity({ iss: GOOGLE, aud: AUD, sub: SUB }, recovery.body.pepper!)).toBe(stored);
  // And the identity under the token's own aud does not match, which is what sends prove_jwt down that branch.
  expect(extractIdentity({ iss: GOOGLE, aud: RECOVERY_AUD, sub: SUB }, recovery.body.pepper!)).not.toBe(stored);
});
