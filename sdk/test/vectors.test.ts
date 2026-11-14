// The published test vectors (test/vectors/*.json) are what SDKs in other languages check
// themselves against, so they must stay exactly what this SDK produces, and the written spec
// (docs/reference/session-signing.md, mirrored by `specHashes`) must give the same hashes.
import { describe, expect, test } from 'bun:test';
import { ec, type Call } from 'starknet';
import { ANY_CALLER, openNativeHandoff, outsideExecutionHash, sessionOutsideExecution, type NativeHandoffSecret } from '../src';
import { buildVectors, specHashes } from './vectors/generate';
import published from './vectors/session-signing.json';
import handoff from './vectors/native-handoff.json';

const same = (a: string, b: string) => BigInt(a) === BigInt(b);

describe('session signing vectors', () => {
  test('the published file is what the SDK generates today', () => {
    expect(published).toEqual(JSON.parse(JSON.stringify(buildVectors())));
  });

  test('the public key is the x coordinate of the private key on the Stark curve', () => {
    expect(same(ec.starkCurve.getStarkKey(published.session.privateKey), published.session.publicKey)).toBe(true);
  });

  for (const vector of published.outsideExecutions) {
    describe(vector.name, () => {
      const calls: Call[] = vector.input.calls.map((call) => ({ contractAddress: call.to, entrypoint: call.entrypoint, calldata: call.calldata }));
      const window = { caller: vector.input.caller, executeAfter: vector.input.executeAfter, executeBefore: vector.input.executeBefore };

      test('the hash written in the spec is the hash the SDK signs', () => {
        const sdk = outsideExecutionHash(vector.input.chainId, vector.input.account, calls, vector.input.nonce, window);
        expect(same(sdk, vector.messageHash)).toBe(true);
        expect(specHashes(vector.input)).toEqual({
          domainHash: vector.domainHash,
          callHashes: vector.callHashes,
          structHash: vector.structHash,
          messageHash: vector.messageHash,
        });
      });

      test('the signature is [session_pubkey, r, s, valid_until] and verifies under the session key', () => {
        const [publicKey, r, s, validUntil] = vector.signature as [string, string, string, string];
        expect(same(publicKey, published.session.publicKey)).toBe(true);
        expect(BigInt(validUntil)).toBe(BigInt(published.session.validUntil));
        const signature = new ec.starkCurve.Signature(BigInt(r), BigInt(s));
        expect(ec.starkCurve.verify(signature, vector.messageHash, ec.starkCurve.getPublicKey(published.session.privateKey, false))).toBe(true);
        // A different hash does not verify: the check above is not vacuous.
        expect(ec.starkCurve.verify(signature, vector.structHash, ec.starkCurve.getPublicKey(published.session.privateKey, false))).toBe(false);
      });

      test('the calldata is the outside execution, then the signature with its length', () => {
        const sdk = sessionOutsideExecution({ chainId: vector.input.chainId, account: vector.input.account, calls, session: published.session, nonce: vector.input.nonce, window });
        expect(sdk.entrypoint).toBe('execute_from_outside_v2');
        expect(sdk.calldata).toEqual(vector.calldata);

        // Rebuilt by hand from the layout in the spec.
        const felt = (value: string | number) => '0x' + BigInt(value).toString(16);
        const flat = vector.input.calls.flatMap((call, i) => [call.to, vector.selectors[i]!, felt(call.calldata.length), ...call.calldata]);
        expect(vector.calldata.map(felt)).toEqual(
          [vector.input.caller, vector.input.nonce, felt(vector.input.executeAfter), felt(vector.input.executeBefore), felt(vector.input.calls.length), ...flat, '0x4', ...vector.signature].map(felt),
        );
        expect(vector.sponsorBody).toEqual({ account: vector.input.account, calldata: vector.calldata });
      });
    });
  }

  test('the vectors cover the default caller and a named one', () => {
    const callers = published.outsideExecutions.map((v) => v.input.caller);
    expect(callers).toContain(ANY_CALLER);
    expect(callers.some((caller) => caller !== ANY_CALLER)).toBe(true);
  });

  test('a self-paid signature has the same layout over the transaction hash', () => {
    const [publicKey, r, s, validUntil] = published.selfPaid.signature as [string, string, string, string];
    expect(same(publicKey, published.session.publicKey)).toBe(true);
    expect(BigInt(validUntil)).toBe(BigInt(published.session.validUntil));
    const signature = new ec.starkCurve.Signature(BigInt(r), BigInt(s));
    expect(ec.starkCurve.verify(signature, published.selfPaid.transactionHash, ec.starkCurve.getPublicKey(published.session.privateKey, false))).toBe(true);
  });
});

describe('native handoff vector', () => {
  test('the published handoff opens with the app key to the published connection', async () => {
    const connection = await openNativeHandoff(handoff.appLink, handoff.app as NativeHandoffSecret);
    expect(connection).toEqual(handoff.plaintext.connection);
  });
});
