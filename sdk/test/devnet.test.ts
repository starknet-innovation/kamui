// End to end against a local devnet, with the production owner, session and spending code
// (`DevAccount`) and the real `KamuiAccount` class for the address derivation.
//
//   docker run --rm -p 127.0.0.1:5050:5050 shardlabs/starknet-devnet-rs:latest --seed 0
//   (cd ../contracts && scarb build)
//   bun test test/devnet.test.ts
//
// Skipped when no devnet answers on DEVNET_URL (default http://127.0.0.1:5050).
import { beforeAll, describe, expect, test } from 'bun:test';
import { Account, RpcProvider, json, num, type Call } from 'starknet';
import {
  KamuiReader,
  SESSION_KEY_INTERFACE_ID,
  SRC6_ID,
  SRC9_V2_ID,
  accountAddress,
  addOwnerCall,
  createSessionAccount,
  createSessionCalls,
  deployAccountCall,
  newKeyPair,
  nextSessionNonce,
  ownerOutsideExecution,
  removeOwnerCall,
  revokeSessionCall,
  sessionOutsideExecution,
  signNewOwner,
  type KeyPair,
  type SessionParams,
} from '../src';

const RPC = process.env.DEVNET_URL ?? 'http://127.0.0.1:5050';
const ARTIFACTS = `${import.meta.dir}/../../contracts/target/dev`;
const STRK = 10n ** 18n;
const TIMEOUT = 180_000;

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

const devnetUp = await rpc('starknet_chainId', []).then(() => true, () => false);
if (!devnetUp) console.log(`no devnet at ${RPC}: skipping the devnet tests`);

describe.skipIf(!devnetUp)('devnet', () => {
  const provider = new RpcProvider({ nodeUrl: RPC });
  let chainId: string;
  let relayer: Account;
  let account: string; // a DevAccount
  let reader: KamuiReader;
  let target: string;
  const owner: KeyPair = newKeyPair();
  const session = { ...newKeyPair(), validUntil: Math.floor(Date.now() / 1000) + 3600 };

  const artifact = async (name: string) => ({
    contract: json.parse(await Bun.file(`${ARTIFACTS}/kamui_${name}.contract_class.json`).text()),
    casm: json.parse(await Bun.file(`${ARTIFACTS}/kamui_${name}.compiled_contract_class.json`).text()),
  });
  const declare = async (name: string) => {
    const { class_hash, transaction_hash } = await relayer.declareIfNot(await artifact(name));
    if (transaction_hash) await provider.waitForTransaction(transaction_hash);
    return class_hash;
  };
  const deploy = async (classHash: string, constructorCalldata: string[]) => {
    const { contract_address, transaction_hash } = await relayer.deployContract({
      classHash,
      constructorCalldata,
      salt: num.toHex(BigInt(Date.now())),
    });
    await provider.waitForTransaction(transaction_hash);
    return contract_address;
  };
  /** Sends a call from the relayer and waits; throws if it reverts. */
  const relay = async (call: Call) => {
    const { transaction_hash } = await relayer.execute(call);
    const receipt = (await provider.waitForTransaction(transaction_hash)) as any;
    if (receipt.execution_status !== 'SUCCEEDED') throw new Error(receipt.revert_reason);
  };
  /** The reason a relayed call would fail, or null if it would go through. */
  const refusal = async (call: Call): Promise<string | null> =>
    relayer.estimateInvokeFee(call).then(() => null, (e: Error) => e.message);
  const asOwner = (calls: Call[], key = owner) =>
    relay(ownerOutsideExecution({ chainId, account, calls, ownerPrivateKey: key.privateKey, window: { executeBefore: session.validUntil } }));
  const count = async () => Number(BigInt((await provider.callContract({ contractAddress: target, entrypoint: 'count', calldata: [] }))[0]!));
  const ping = (): Call => ({ contractAddress: target, entrypoint: 'ping', calldata: [] });
  const spend = (amount: number): Call => ({ contractAddress: target, entrypoint: 'transfer', calldata: ['0x1', num.toHex(amount), '0x0'] });
  const sessionParams = (): SessionParams => ({
    sessionPublicKey: session.publicKey,
    validUntil: session.validUntil,
    maxCalls: 6,
    maxFeePerTx: 10n * STRK,
    scope: { kind: 'contracts', calls: [{ to: target, entrypoint: 'ping' }, { to: target, entrypoint: 'transfer' }] },
  });
  const limit = () => ({ token: target, maxPerCall: 100n, maxPerWindow: 150n, windowSeconds: 3600 });
  const sponsored = async (calls: Call[], fromOffset = 0) => {
    const next = await nextSessionNonce(reader, session.publicKey, 6, fromOffset);
    if (!next) throw new Error('session exhausted');
    return sessionOutsideExecution({ chainId, account, calls, session, nonce: next.nonce });
  };

  beforeAll(async () => {
    chainId = await provider.getChainId();
    const [first] = await rpc<{ address: string; private_key: string }[]>('devnet_getPredeployedAccounts', {});
    relayer = new Account({ provider, address: first!.address, signer: first!.private_key });
    account = await deploy(await declare('DevAccount'), [owner.publicKey]);
    target = await deploy(await declare('Target'), []);
    await rpc('devnet_mint', { address: account, amount: Number(100n * STRK), unit: 'FRI' });
    reader = new KamuiReader(provider, account);
  }, TIMEOUT);

  test('the computed address is where the KamuiAccount class deploys', async () => {
    const classHash = await declare('KamuiAccount');
    const identity = num.toHex(BigInt(Date.now()));
    await relay(deployAccountCall(classHash, 'some-aud.apps.example', identity));
    const address = accountAddress(classHash, 'some-aud.apps.example', identity);
    const deployed = new KamuiReader(provider, address);
    expect(await deployed.isDeployed()).toBe(true);
    expect(BigInt(await deployed.identity())).toBe(BigInt(identity));
    expect(await deployed.owners()).toEqual([]);
    expect(BigInt(await deployed.ownersAnchor())).toBe(0n);
  }, TIMEOUT);

  test('reads the account', async () => {
    expect((await reader.owners()).map(BigInt)).toEqual([BigInt(owner.publicKey)]);
    expect(await reader.isOwner(owner.publicKey)).toBe(true);
    expect(await reader.supportsInterface(SRC6_ID)).toBe(true);
    expect(await reader.supportsInterface(SRC9_V2_ID)).toBe(true);
    expect(await reader.supportsInterface(SESSION_KEY_INTERFACE_ID)).toBe(true);
    expect((await reader.session(session.publicKey)).exists).toBe(false);
  }, TIMEOUT);

  test('an owner adds a second key, which can then act as owner', async () => {
    const second = newKeyPair();
    const epoch = await reader.sessionEpoch();
    const signature = signNewOwner(account, await reader.ownersAnchor(), second.privateKey);
    await asOwner([addOwnerCall(account, second.publicKey, signature)]);
    expect((await reader.owners()).map(BigInt)).toEqual([BigInt(owner.publicKey), BigInt(second.publicKey)]);
    expect(await reader.sessionEpoch()).toBe(epoch + 1);

    // The second key approves and then revokes a throwaway session.
    const throwaway = newKeyPair();
    const params = { ...sessionParams(), sessionPublicKey: throwaway.publicKey };
    await asOwner(createSessionCalls(account, params, [limit()]), second);
    expect((await reader.session(throwaway.publicKey)).exists).toBe(true);
    await asOwner([revokeSessionCall(account, throwaway.publicKey)], second);
    expect((await reader.session(throwaway.publicKey)).exists).toBe(false);

    // Removing it revokes sessions again and takes its signing power away.
    await asOwner([removeOwnerCall(account, second.publicKey)]);
    expect(await reader.isOwner(second.publicKey)).toBe(false);
    const call = ownerOutsideExecution({ chainId, account, calls: [ping()], ownerPrivateKey: second.privateKey, window: { executeBefore: session.validUntil } });
    expect(await refusal(call)).toContain('Kamui: invalid signature');
  }, TIMEOUT);

  test('an owner approves a scoped session with a spending limit', async () => {
    await asOwner(createSessionCalls(account, sessionParams(), [limit()]));
    const data = await reader.session(session.publicKey);
    expect(data).toMatchObject({ exists: true, maxCalls: 6, scopeEntries: 2, validUntil: session.validUntil });
    expect(await reader.isSessionCallAllowed(session.publicKey, target, 'ping')).toBe(true);
    expect(await reader.isSessionCallAllowed(session.publicKey, target, 'count')).toBe(false);
    expect(await reader.spendingPolicy(session.publicKey, target)).toMatchObject({ exists: true, maxPerCall: 100n, maxPerWindow: 150n, spentInWindow: 0n });
  }, TIMEOUT);

  test('sponsored session calls work within scope and limits, and are refused outside them', async () => {
    const before = await count();
    await relay(await sponsored([ping()]));
    await relay(await sponsored([spend(100)]));
    expect(await count()).toBe(before + 2);
    expect((await reader.spendingPolicy(session.publicKey, target)).spentInWindow).toBe(100n);

    expect(await refusal(await sponsored([spend(101)]))).toContain('Spending: over per-call limit');
    expect(await refusal(await sponsored([spend(51)]))).toContain('Spending: over window limit');
    const outOfScope: Call = { contractAddress: target, entrypoint: 'approve', calldata: ['0x1', '0x1', '0x0'] };
    expect(await refusal(await sponsored([outOfScope]))).toContain('Kamui: invalid session');
    expect(await refusal(await sponsored([removeOwnerCall(account, owner.publicKey)]))).toContain('Kamui: invalid session');

    // The next free nonce moved past the two that were used.
    expect((await nextSessionNonce(reader, session.publicKey, 6))!.offset).toBe(2);
    // A nonce outside the session's range is refused.
    const base = BigInt(await reader.sessionNonceBase(session.publicKey));
    const outside = sessionOutsideExecution({ chainId, account, calls: [ping()], session, nonce: num.toHex(base + 6n) });
    expect(await refusal(outside)).toContain('Kamui: invalid session');
  }, TIMEOUT);

  test('self-paid session transactions work, with fees estimated under validation', async () => {
    const sessionAccount = createSessionAccount({ provider, address: account, sessionPrivateKey: session.privateKey, validUntil: session.validUntil });
    const before = await count();
    const sent = await sessionAccount.execute(spend(50));
    const receipt = (await provider.waitForTransaction(sent.transaction_hash)) as any;
    expect(receipt.execution_status).toBe('SUCCEEDED');
    expect(await count()).toBe(before + 1);
    // Sponsored and self-paid spending share one window: 100 + 50.
    expect((await reader.spendingPolicy(session.publicKey, target)).spentInWindow).toBe(150n);
    expect(await reader.sessionNonceLimit(session.publicKey)).toBeGreaterThan(0);

    // Estimation runs validation, so refusals are visible before sending.
    await expect(sessionAccount.estimateInvokeFee(spend(1))).rejects.toThrow(/Spending: over window limit/);
    await expect(sessionAccount.estimateInvokeFee(removeOwnerCall(account, owner.publicKey))).rejects.toThrow();
  }, TIMEOUT);

  test('an owner change kills the session', async () => {
    const third = newKeyPair();
    await asOwner([addOwnerCall(account, third.publicKey, signNewOwner(account, await reader.ownersAnchor(), third.privateKey))]);
    expect((await reader.session(session.publicKey)).exists).toBe(false);
    expect(await refusal(await sponsored([ping()], 2))).toContain('Kamui: invalid session');
  }, TIMEOUT);
});
