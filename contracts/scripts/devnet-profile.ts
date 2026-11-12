// Deploys a Kamui dev account on a local devnet and counts the account's storage writes per
// transaction, for the owner path, the self-paid session path and the sponsored session path.
//
//   docker run --rm -p 127.0.0.1:5050:5050 shardlabs/starknet-devnet-rs:latest --seed 0
//   (a devnet new enough for Sierra 1.9; starknet-devnet 0.8.1 is too old)
//   scarb build                               (in contracts/)
//   bun run devnet-profile.ts [RPC_URL]
//
// Uses devnet's predeployed accounts and fixed test keys. Never point it at a real network.
import {
  Account,
  OutsideExecutionVersion,
  RpcProvider,
  Signer,
  ec,
  hash,
  json,
  num,
  outsideExecution,
  typedData,
  type Call,
  type Signature,
} from 'starknet';

const RPC = process.argv[2] ?? 'http://127.0.0.1:5050';
const ARTIFACTS = `${import.meta.dir}/../target/dev`;
const OWNER_KEY = '0x1111';
const SESSION_KEY = '0x2222';
const ANY_CALLER = '0x414e595f43414c4c4552';
const STRK = 10n ** 18n;

const provider = new RpcProvider({ nodeUrl: RPC });

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.result === undefined) throw new Error(`${method}: ${body.error?.message}`);
  return body.result;
}

const chainId = await provider.getChainId();
if (!RPC.includes('127.0.0.1') && !RPC.includes('localhost')) throw new Error('devnet only');

const predeployed = await rpc<{ address: string; private_key: string }[]>('devnet_getPredeployedAccounts', {});
const deployer = new Account({ provider, address: predeployed[0].address, signer: predeployed[0].private_key });
const relayer = new Account({ provider, address: predeployed[1].address, signer: predeployed[1].private_key });

async function declare(name: string): Promise<string> {
  const contract = json.parse(await Bun.file(`${ARTIFACTS}/kamui_${name}.contract_class.json`).text());
  const casm = json.parse(await Bun.file(`${ARTIFACTS}/kamui_${name}.compiled_contract_class.json`).text());
  const { class_hash, transaction_hash } = await deployer.declareIfNot({ contract, casm });
  if (transaction_hash) await provider.waitForTransaction(transaction_hash);
  return class_hash;
}

async function deploy(classHash: string, constructorCalldata: string[]): Promise<string> {
  const { contract_address, transaction_hash } = await deployer.deployContract({
    classHash,
    constructorCalldata,
    salt: num.toHex(BigInt(Date.now())),
  });
  await provider.waitForTransaction(transaction_hash);
  return contract_address;
}

/// Signs with the session key and returns SNIP-41's `[session_pubkey, r, s, valid_until]`.
class SessionSigner extends Signer {
  constructor(key: string, private validUntil: number) {
    super(key);
  }
  protected async signRaw(msgHash: string): Promise<Signature> {
    return sessionSignature(msgHash, this.validUntil);
  }
}

function sessionSignature(msgHash: string, validUntil: number): string[] {
  const { r, s } = ec.starkCurve.sign(msgHash, SESSION_KEY);
  return [ec.starkCurve.getStarkKey(SESSION_KEY), num.toHex(r), num.toHex(s), num.toHex(validUntil)];
}

type Row = { label: string; writes: number; l2Gas: string; fee: string };
const rows: Row[] = [];

/// Storage slots of `account` written by a transaction, from its trace.
async function record(label: string, account: string, txHash: string) {
  const receipt = (await provider.waitForTransaction(txHash)) as any;
  if (receipt.execution_status !== 'SUCCEEDED') throw new Error(`${label}: ${receipt.revert_reason}`);
  const trace = (await provider.getTransactionTrace(txHash)) as any;
  const diffs: { address: string; storage_entries: unknown[] }[] = trace.state_diff?.storage_diffs ?? [];
  const mine = diffs.filter((d) => BigInt(d.address) === BigInt(account));
  const writes = mine.reduce((n, d) => n + d.storage_entries.length, 0);
  rows.push({
    label,
    writes,
    l2Gas: String(receipt.execution_resources?.l2_gas ?? '?'),
    fee: (Number(BigInt(receipt.actual_fee.amount)) / 1e18).toFixed(6),
  });
}

// Setup
// DevAccount: the production session and outside-execution code with a plain owner key.
// The social account cannot be used here because a devnet has no SNIP-36 proofs.
const accountClass = await declare('DevAccount');
const targetClass = await declare('Target');
const accountAddress = await deploy(accountClass, [ec.starkCurve.getStarkKey(OWNER_KEY)]);
const target = await deploy(targetClass, []);
await rpc('devnet_mint', { address: accountAddress, amount: Number(100n * STRK), unit: 'FRI' });

const owner = new Account({ provider, address: accountAddress, signer: OWNER_KEY });
const ping: Call = { contractAddress: target, entrypoint: 'ping', calldata: [] };
const pingSelector = hash.getSelectorFromName('ping');
const sessionPub = ec.starkCurve.getStarkKey(SESSION_KEY);
const validUntil = Math.floor(Date.now() / 1000) + 3600;

// Owner path
await record('owner: ping', accountAddress, (await owner.execute(ping)).transaction_hash);

// Session setup: contract-scoped, 5 transactions, fee cap 10 STRK
const addSession = await owner.execute({
  contractAddress: accountAddress,
  entrypoint: 'add_or_update_scoped_session_key',
  calldata: [sessionPub, num.toHex(validUntil), '5', num.toHex(10n * STRK), '1', target, pingSelector],
});
await record('owner: add scoped session (1 entry)', accountAddress, addSession.transaction_hash);

// Self-paid session path
const session = new Account({ provider, address: accountAddress, signer: new SessionSigner(SESSION_KEY, validUntil) });
await record('session self-paid: first tx', accountAddress, (await session.execute(ping)).transaction_hash);
await record('session self-paid: second tx', accountAddress, (await session.execute(ping)).transaction_hash);
await record('session self-paid: third tx', accountAddress, (await session.execute(ping)).transaction_hash);

// Sponsored session path
const [nonceBase] = await provider.callContract({
  contractAddress: accountAddress,
  entrypoint: 'get_session_nonce_base',
  calldata: [sessionPub],
});

async function sponsored(label: string, offset: bigint) {
  const nonce = num.toHex(BigInt(nonceBase) + offset);
  const options = { caller: ANY_CALLER, execute_after: 0, execute_before: validUntil };
  const data = outsideExecution.getTypedData(chainId, options, nonce, [ping], OutsideExecutionVersion.V2);
  const signature = sessionSignature(typedData.getMessageHash(data, accountAddress), validUntil);
  const tx = await relayer.execute({
    contractAddress: accountAddress,
    entrypoint: 'execute_from_outside_v2',
    calldata: [
      ANY_CALLER, nonce, '0', num.toHex(validUntil), // caller, nonce, execute_after, execute_before
      '1', target, pingSelector, '0', // calls
      num.toHex(signature.length), ...signature,
    ],
  });
  await record(label, accountAddress, tx.transaction_hash);
}

await sponsored('session sponsored: first tx', 0n);
await sponsored('session sponsored: second tx', 1n);

// The target must have counted every ping.
const [count] = await provider.callContract({ contractAddress: target, entrypoint: 'count', calldata: [] });
const expected = 6;
console.log(`account ${accountAddress}`);
console.log(`target counted ${Number(BigInt(count))} pings (expected ${expected})`);
console.log('');
console.log('| Transaction | Account storage writes | L2 gas | Fee (STRK) |');
console.log('|---|---:|---:|---:|');
for (const r of rows) console.log(`| ${r.label} | ${r.writes} | ${r.l2Gas} | ${r.fee} |`);
if (Number(BigInt(count)) !== expected) process.exit(1);
