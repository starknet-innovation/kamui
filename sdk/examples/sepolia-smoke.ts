// A short live check of the SDK on Sepolia against an existing Kamui account. Testnet only.
//
//   bun --env-file=<RPC_URL, RELAYER_ADDRESS, RELAYER_PRIVATE_KEY> run examples/sepolia-smoke.ts \
//       <account> <file holding an owner private key> <target contract with ping()>
//
// The owner approves a scoped session (sponsored), the session makes one sponsored and one
// self-paid call, a call outside its scope is refused, and the owner revokes the session.
import { Account, RpcProvider, type Call } from 'starknet';
import {
  KamuiReader,
  createSessionAccount,
  createSessionCalls,
  keyPairFromPrivateKey,
  newKeyPair,
  nextSessionNonce,
  ownerOutsideExecution,
  revokeSessionCall,
  sessionOutsideExecution,
} from '../src';

const [account, keyFile, target] = process.argv.slice(2);
if (!account || !keyFile || !target) throw new Error('usage: sepolia-smoke.ts <account> <owner key file> <target>');
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const provider = new RpcProvider({ nodeUrl: env('RPC_URL') });
const chainId = await provider.getChainId();
if (chainId !== '0x534e5f5345504f4c4941') throw new Error('Sepolia only');
const relayer = new Account({ provider, address: env('RELAYER_ADDRESS'), signer: env('RELAYER_PRIVATE_KEY') });
const owner = keyPairFromPrivateKey((await Bun.file(keyFile).text()).trim());
const reader = new KamuiReader(provider, account);
if (!(await reader.isOwner(owner.publicKey))) throw new Error('that key is not an owner of the account');

const session = { ...newKeyPair(), validUntil: Math.floor(Date.now() / 1000) + 3600 };
const window = { executeBefore: session.validUntil };
const ping: Call = { contractAddress: target, entrypoint: 'ping', calldata: [] };
const count = async () => Number(BigInt((await provider.callContract({ contractAddress: target, entrypoint: 'count', calldata: [] }))[0]!));
const relay = async (call: Call) => {
  const { transaction_hash } = await relayer.execute(call);
  const receipt = (await provider.waitForTransaction(transaction_hash)) as any;
  if (receipt.execution_status !== 'SUCCEEDED') throw new Error(receipt.revert_reason);
  return transaction_hash;
};
const asOwner = (calls: Call[]) => relay(ownerOutsideExecution({ chainId, account, calls, ownerPrivateKey: owner.privateKey, window }));

const before = await count();
console.log(`owners: ${(await reader.owners()).length}, session epoch ${await reader.sessionEpoch()}`);

const approve = createSessionCalls(account, {
  sessionPublicKey: session.publicKey,
  validUntil: session.validUntil,
  maxCalls: 3,
  maxFeePerTx: 5n * 10n ** 18n,
  scope: { kind: 'contracts', calls: [{ to: target, entrypoint: 'ping' }] },
});
console.log(`session approved: ${await asOwner(approve)}`);

const next = await nextSessionNonce(reader, session.publicKey, 3);
console.log(`sponsored ping: ${await relay(sessionOutsideExecution({ chainId, account, calls: [ping], session, nonce: next!.nonce }))}`);

const sessionAccount = createSessionAccount({ provider, address: account, sessionPrivateKey: session.privateKey, validUntil: session.validUntil });
const selfPaid = await sessionAccount.execute(ping);
await provider.waitForTransaction(selfPaid.transaction_hash);
console.log(`self-paid ping: ${selfPaid.transaction_hash}`);

const outOfScope: Call = { contractAddress: target, entrypoint: 'transfer', calldata: ['0x1', '0x1', '0x0'] };
const refused = await sessionAccount.estimateInvokeFee(outOfScope).then(() => false, () => true);
console.log(`call outside the scope refused: ${refused}`);

console.log(`session revoked: ${await asOwner([revokeSessionCall(account, session.publicKey)])}`);
const dead = !(await reader.session(session.publicKey)).exists;
const pings = (await count()) - before;
console.log(`session gone: ${dead}, target counted ${pings} new call(s)`);
if (!refused || !dead || pings !== 2) process.exit(1);
