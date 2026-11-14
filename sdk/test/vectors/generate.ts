// Test vectors for session signing, for SDKs in other languages (docs/reference/session-signing.md).
//
//   bun run test/vectors/generate.ts     rewrites session-signing.json
//
// The final values (message hash, signature, calldata) come from the TypeScript SDK. The
// intermediate hashes come from `specHashes` below, which follows the written spec step by step
// and uses nothing from starknet.js but Poseidon and starknet_keccak. The two must agree, here
// and in test/vectors.test.ts, so the spec cannot drift from what the SDK signs.
//
// The keys below are test keys. Never use them for anything.
import { hash, type Call } from 'starknet';
import { ANY_CALLER, keyPairFromPrivateKey, outsideExecutionHash, sessionOutsideExecution, sessionSignature, type OutsideWindow } from '../../src';

const felt = (value: string | number | bigint) => '0x' + BigInt(value).toString(16);
const poseidon = (values: (string | number | bigint)[]) => felt(hash.computePoseidonHashOnElements(values.map(felt)));
const keccak = (text: string) => felt(hash.starknetKeccak(text));
/** A Cairo short string: the ASCII bytes as one big-endian number. */
const shortString = (text: string) => felt('0x' + Array.from(text, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));

export const DOMAIN_TYPE = '"StarknetDomain"("name":"shortstring","version":"shortstring","chainId":"shortstring","revision":"shortstring")';
export const CALL_TYPE = '"Call"("To":"ContractAddress","Selector":"selector","Calldata":"felt*")';
export const OUTSIDE_EXECUTION_TYPE =
  '"OutsideExecution"("Caller":"ContractAddress","Nonce":"felt","Execute After":"u128","Execute Before":"u128","Calls":"Call*")' + CALL_TYPE;

export type VectorCall = { to: string; entrypoint: string; calldata: string[] };
export type OutsideInput = {
  chainId: string;
  account: string;
  caller: string;
  nonce: string;
  executeAfter: number;
  executeBefore: number;
  calls: VectorCall[];
};

/** The SNIP-12 revision 1 hash of an outside execution, as the spec page writes it. */
export function specHashes(input: OutsideInput) {
  const domainHash = poseidon([keccak(DOMAIN_TYPE), shortString('Account.execute_from_outside'), 2, input.chainId, 1]);
  const callHashes = input.calls.map((call) => poseidon([keccak(CALL_TYPE), call.to, keccak(call.entrypoint), poseidon(call.calldata)]));
  const structHash = poseidon([keccak(OUTSIDE_EXECUTION_TYPE), input.caller, input.nonce, input.executeAfter, input.executeBefore, poseidon(callHashes)]);
  const messageHash = poseidon([shortString('StarkNet Message'), domainHash, input.account, structHash]);
  return { domainHash, callHashes, structHash, messageHash };
}

const SESSION = { ...keyPairFromPrivateKey('0x1f2e3d4c5b6a79880123456789abcdef0fedcba9876543210a1b2c3d4e5f607'), validUntil: 1_900_000_000 };
const SEPOLIA = '0x534e5f5345504f4c4941';
const MAINNET = '0x534e5f4d41494e';
const ACCOUNT = '0x3ec3b3ead6762ecf0172e0d5e3f9df472e66608e3f483f300a784dc9652d193';
const GAME = '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc';
const STRK = '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const RELAYER = '0x64b48806902a367c8598f4f95c305e8c1a1acba5f082d294a43793113115691';

const CASES: { name: string; input: OutsideInput }[] = [
  {
    name: 'one call, no arguments, SDK defaults (any caller, execute_before = valid_until)',
    input: { chainId: SEPOLIA, account: ACCOUNT, caller: ANY_CALLER, nonce: '0x5a17', executeAfter: 0, executeBefore: SESSION.validUntil, calls: [{ to: GAME, entrypoint: 'ping', calldata: [] }] },
  },
  {
    name: 'two calls with arguments (a u256 is two felts: low, high)',
    input: {
      chainId: SEPOLIA,
      account: ACCOUNT,
      caller: ANY_CALLER,
      nonce: '0x2c6b4a0f6b1f9f3d6a2e8f1b7c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7',
      executeAfter: 0,
      executeBefore: SESSION.validUntil,
      calls: [
        { to: GAME, entrypoint: 'move', calldata: ['0x3', '0x7'] },
        { to: STRK, entrypoint: 'transfer', calldata: [GAME, '0xde0b6b3a7640000', '0x0'] },
      ],
    },
  },
  {
    name: 'mainnet chain id, a named caller, a window that opens later and closes before valid_until',
    input: { chainId: MAINNET, account: ACCOUNT, caller: RELAYER, nonce: '0x1', executeAfter: 1_800_000_000, executeBefore: 1_800_000_600, calls: [{ to: GAME, entrypoint: 'ping', calldata: [] }] },
  },
];

export function buildVectors() {
  const outsideExecutions = CASES.map(({ name, input }) => {
    const calls: Call[] = input.calls.map((call) => ({ contractAddress: call.to, entrypoint: call.entrypoint, calldata: call.calldata }));
    const window: OutsideWindow = { caller: input.caller, executeAfter: input.executeAfter, executeBefore: input.executeBefore };
    const hashes = specHashes(input);
    const sdkHash = felt(outsideExecutionHash(input.chainId, input.account, calls, input.nonce, window));
    if (sdkHash !== hashes.messageHash) throw new Error(`vectors: the spec and the SDK disagree on '${name}'`);
    const call = sessionOutsideExecution({ chainId: input.chainId, account: input.account, calls, session: SESSION, nonce: input.nonce, window });
    return {
      name,
      input,
      selectors: input.calls.map((c) => keccak(c.entrypoint)),
      ...hashes,
      signature: sessionSignature(hashes.messageHash, SESSION),
      calldata: call.calldata as string[],
      sponsorBody: { account: call.contractAddress, calldata: call.calldata as string[] },
    };
  });

  const transactionHash = '0x6d1c2b3a49586776859403f2e1d0cfbeadbc9a8b7c6d5e4f30211203f4e5d6c';
  return {
    about: 'Kamui session signing test vectors. Generated by sdk/test/vectors/generate.ts from the TypeScript SDK. See docs/reference/session-signing.md. The private key is a test key.',
    session: { privateKey: SESSION.privateKey, publicKey: SESSION.publicKey, validUntil: SESSION.validUntil },
    typeHashes: {
      StarknetDomain: { encoded: DOMAIN_TYPE, hash: keccak(DOMAIN_TYPE) },
      Call: { encoded: CALL_TYPE, hash: keccak(CALL_TYPE) },
      OutsideExecution: { encoded: OUTSIDE_EXECUTION_TYPE, hash: keccak(OUTSIDE_EXECUTION_TYPE) },
    },
    shortStrings: {
      'Account.execute_from_outside': shortString('Account.execute_from_outside'),
      'StarkNet Message': shortString('StarkNet Message'),
      ANY_CALLER: shortString('ANY_CALLER'),
      SN_SEPOLIA: shortString('SN_SEPOLIA'),
      SN_MAIN: shortString('SN_MAIN'),
    },
    outsideExecutions,
    selfPaid: {
      note: 'The same four-felt signature over a transaction hash. Computing an invoke v3 transaction hash is standard Starknet and not covered here.',
      transactionHash,
      signature: sessionSignature(transactionHash, SESSION),
    },
  };
}

if (import.meta.main) {
  await Bun.write(new URL('./session-signing.json', import.meta.url), JSON.stringify(buildVectors(), null, 2) + '\n');
  console.log('wrote session-signing.json');
}

// `--handoff` also rewrites native-handoff.json: one sealed handoff (docs/native/bounce-page.md)
// with the app's key, for checking a native app's decryption. Sealing is randomised, so this
// file changes on every run and is only regenerated on purpose.
if (import.meta.main && process.argv.includes('--handoff')) {
  const { beginNativeConnect, finishNativeConnect, nativeStartUrl, newNativeHandoff, openNativeHandoff, toFragment } = await import('../../src');
  const data = new Map<string, string>();
  const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
  const secret = await newNativeHandoff();
  const startUrl = nativeStartUrl('https://game.example/kamui/start', secret);
  beginNativeConnect(
    new URL(startUrl).hash,
    { keychainUrl: 'https://keychain.example', redirectUri: 'https://game.example/kamui/return', validUntil: SESSION.validUntil, maxCalls: 50, calls: [{ to: GAME, entrypoint: 'ping' }] },
    store,
  );
  const id = (JSON.parse(data.get('kamui.pending')!) as { id: string }).id;
  const answer = toFragment({ v: 1, id, ok: true, account: ACCOUNT, chainId: SEPOLIA, classHash: '0x1e12' });
  const appLink = (await finishNativeConnect(answer, 'https://game.example/kamui/app', store))!;
  const vector = {
    about: 'One sealed Kamui native handoff. Generated by sdk/test/vectors/generate.ts --handoff. See docs/native/bounce-page.md. The keys are test keys.',
    app: secret,
    startUrl,
    appLink,
    handoff: JSON.parse(Buffer.from(appLink.split('#kamui-native=')[1]!, 'base64url').toString()) as unknown,
    plaintext: { ok: true, connection: await openNativeHandoff(appLink, secret) },
  };
  await Bun.write(new URL('./native-handoff.json', import.meta.url), JSON.stringify(vector, null, 2) + '\n');
  console.log('wrote native-handoff.json');
}
