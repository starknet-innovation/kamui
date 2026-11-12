// Sepolia end-to-end check of owners and sessions on a recovered Kamui account. Testnet only.
//
//   bun --env-file=<RPC_URL, RELAYER_ADDRESS, RELAYER_PRIVATE_KEY> run sepolia-session.ts \
//       <account> <file holding the device (owner) private key>
//
// The relayer pays for everything on the sponsored path. The self-paid session steps run only if
// the account holds at least 1 STRK.
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

const [accountAddress, keyFile] = process.argv.slice(2);
if (!accountAddress || !keyFile) throw new Error('usage: sepolia-session.ts <account> <device key file>');
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const ANY_CALLER = '0x414e595f43414c4c4552';
const STRK_TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const STRK = 10n ** 18n;
const ARTIFACTS = `${import.meta.dir}/../target/dev`;

const provider = new RpcProvider({ nodeUrl: env('RPC_URL') });
const chainId = await provider.getChainId();
if (chainId !== '0x534e5f5345504f4c4941') throw new Error('Sepolia only');

const relayer = new Account({ provider, address: env('RELAYER_ADDRESS'), signer: env('RELAYER_PRIVATE_KEY') });
const deviceKey = (await Bun.file(keyFile).text()).trim();
const devicePub = ec.starkCurve.getStarkKey(deviceKey);
// A throwaway session key, never stored.
const sessionKey = '0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(31))).toString('hex');
const sessionPub = ec.starkCurve.getStarkKey(sessionKey);
const validUntil = Math.floor(Date.now() / 1000) + 3 * 3600;

const read = async (entrypoint: string, calldata: string[] = [], contractAddress = accountAddress) =>
  provider.callContract({ contractAddress, entrypoint, calldata });

const results: [string, string][] = [];
const note = (label: string, outcome: string) => {
  results.push([label, outcome]);
  console.log(`${label}: ${outcome}`);
};

/// Storage slots of the account written by a transaction.
async function writes(txHash: string): Promise<string> {
  const receipt = (await provider.waitForTransaction(txHash)) as any;
  if (receipt.execution_status !== 'SUCCEEDED') throw new Error(`reverted: ${receipt.revert_reason}`);
  try {
    const trace = (await provider.getTransactionTrace(txHash)) as any;
    if (!trace.state_diff) return `ok, tx ${txHash} (this RPC's trace has no state diff)`;
    const diffs: { address: string; storage_entries: unknown[] }[] = trace.state_diff.storage_diffs ?? [];
    const n = diffs
      .filter((d) => BigInt(d.address) === BigInt(accountAddress))
      .reduce((sum, d) => sum + d.storage_entries.length, 0);
    return `ok, ${n} account storage write(s), tx ${txHash}`;
  } catch {
    return `ok, trace unavailable, tx ${txHash}`;
  }
}

/// The revert reason of a call that must fail, found by fee estimation (costs nothing).
/// `skipValidate: false` matters: starknet.js skips `__validate__` when estimating by default,
/// and on the self-paid path `__validate__` is where a session is checked.
async function mustFail(account: Account, call: Call, expected: string): Promise<string> {
  try {
    await account.estimateInvokeFee(call, { skipValidate: false });
    return 'NOT REFUSED';
  } catch (e) {
    const message = (e as Error).message;
    return message.includes(expected) ? `refused (${expected})` : `refused, other reason: ${message.slice(0, 160)}`;
  }
}

function outsideCall(calls: Call[], nonce: string, signature: string[]): Call {
  const flat = calls.flatMap((c) => {
    const data = (c.calldata ?? []) as string[];
    return [c.contractAddress, hash.getSelectorFromName(c.entrypoint), num.toHex(data.length), ...data];
  });
  return {
    contractAddress: accountAddress,
    entrypoint: 'execute_from_outside_v2',
    calldata: [
      ANY_CALLER, nonce, '0', num.toHex(validUntil),
      num.toHex(calls.length), ...flat,
      num.toHex(signature.length), ...signature,
    ],
  };
}

function outsideHash(calls: Call[], nonce: string): string {
  const options = { caller: ANY_CALLER, execute_after: 0, execute_before: validUntil };
  const data = outsideExecution.getTypedData(chainId, options, nonce, calls, OutsideExecutionVersion.V2);
  return typedData.getMessageHash(data, accountAddress);
}

const sign = (msgHash: string, key: string) => {
  const { r, s } = ec.starkCurve.sign(msgHash, key);
  return [num.toHex(r), num.toHex(s)];
};
const sessionSignature = (msgHash: string) => [sessionPub, ...sign(msgHash, sessionKey), num.toHex(validUntil)];

class SessionSigner extends Signer {
  protected async signRaw(msgHash: string): Promise<Signature> {
    return sessionSignature(msgHash);
  }
}

// 0. The device key must be an owner.
const [isOwner] = await read('is_owner', [devicePub]);
if (BigInt(isOwner) !== 1n) throw new Error('the device key is not an owner of this account');
const [ownerCount] = await read('get_owners');
note('device key is an owner', `yes, ${Number(BigInt(ownerCount))} owner(s) in the set`);

// 1. A target contract to call.
const targetContract = json.parse(await Bun.file(`${ARTIFACTS}/kamui_Target.contract_class.json`).text());
const targetCasm = json.parse(await Bun.file(`${ARTIFACTS}/kamui_Target.compiled_contract_class.json`).text());
const declared = await relayer.declareIfNot({ contract: targetContract, casm: targetCasm });
if (declared.transaction_hash) await provider.waitForTransaction(declared.transaction_hash);
const deployed = await relayer.deployContract({ classHash: declared.class_hash, salt: num.toHex(BigInt(Date.now())) });
await provider.waitForTransaction(deployed.transaction_hash);
const target = deployed.contract_address;
note('target contract deployed', target);
const ping: Call = { contractAddress: target, entrypoint: 'ping', calldata: [] };
const pingSelector = hash.getSelectorFromName('ping');

// 2. The owner approves a session, sponsored: an OutsideExecution signed by the device key.
const addSession: Call = {
  contractAddress: accountAddress,
  entrypoint: 'add_or_update_scoped_session_key',
  calldata: [sessionPub, num.toHex(validUntil), '3', num.toHex(5n * STRK), '1', target, pingSelector],
};
const ownerNonce = num.toHex(BigInt(Date.now()));
const approve = await relayer.execute(outsideCall([addSession], ownerNonce, sign(outsideHash([addSession], ownerNonce), deviceKey)));
note('owner approves a session (sponsored)', await writes(approve.transaction_hash));

// 3. Sponsored session transactions.
const [nonceBase] = await read('get_session_nonce_base', [sessionPub]);
const sessionNonce = (offset: bigint) => num.toHex(BigInt(nonceBase) + offset);
const sponsored = (calls: Call[], offset: bigint) =>
  outsideCall(calls, sessionNonce(offset), sessionSignature(outsideHash(calls, sessionNonce(offset))));

const transfer: Call = { contractAddress: STRK_TOKEN, entrypoint: 'transfer', calldata: [relayer.address, '1', '0'] };
note('session, sponsored: call outside its scope', await mustFail(relayer, sponsored([transfer], 0n), 'Kamui: invalid session'));
note('session, sponsored: nonce outside its range', await mustFail(relayer, sponsored([ping], 3n), 'Kamui: invalid session'));
note('session, sponsored: manage owners', await mustFail(
  relayer,
  sponsored([{ contractAddress: accountAddress, entrypoint: 'remove_owner', calldata: [devicePub] }], 0n),
  'Kamui: invalid session',
));
const first = await relayer.execute(sponsored([ping], 0n));
note('session, sponsored: allowed call', await writes(first.transaction_hash));
note('session, sponsored: replay of the same nonce', await mustFail(relayer, sponsored([ping], 0n), 'Kamui: duplicated nonce'));

// 4. Self-paid session transactions, if the account can pay.
const [low] = await read('balance_of', [accountAddress], STRK_TOKEN);
const balance = BigInt(low);
if (balance >= STRK) {
  const session = new Account({ provider, address: accountAddress, signer: new SessionSigner(sessionKey) });
  note('session, self-paid: call outside its scope', await mustFail(session, transfer, 'alidat'));
  note('session, self-paid: manage owners', await mustFail(
    session,
    { contractAddress: accountAddress, entrypoint: 'remove_owner', calldata: [devicePub] },
    'alidat',
  ));
  const one = await session.execute(ping);
  note('session, self-paid: first transaction', await writes(one.transaction_hash));
  const two = await session.execute(ping);
  note('session, self-paid: second transaction', await writes(two.transaction_hash));
  note('session, self-paid nonce limit', String(Number(BigInt((await read('get_session_nonce_limit', [sessionPub]))[0]))));
} else {
  note('session, self-paid', `skipped: the account holds ${Number(balance) / 1e18} STRK, needs 1`);
}

const [count] = await read('count', [], target);
note('target counted', `${Number(BigInt(count))} call(s)`);

console.log('\n| Step | Outcome |\n|---|---|');
for (const [label, outcome] of results) console.log(`| ${label} | ${outcome} |`);
