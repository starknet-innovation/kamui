// A page, a keychain and a node, all in memory, for the wallet and wallet-standard adapter tests.
import type { ProviderInterface, TypedData } from 'starknet';
import {
  callsFromWire,
  ownerOutsideExecution,
  parseConnectRequest,
  parseExecuteRequest,
  toFragment,
  type KamuiPage,
  type KamuiSessionRequest,
  type KamuiWalletOptions,
  type KeyValueStore,
} from '../src';

export const APP = 'https://game.example';
export const KEYCHAIN = 'https://keychain.example';
export const ACCOUNT = '0x3ec3b3ead6762ecf0172e0d5e3f9df472e66608e3f483f300a784dc9652d193';
export const GAME = '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc';
export const TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
export const SEPOLIA = '0x534e5f5345504f4c4941';
export const CLASS_HASH = '0x1234';
export const TX = '0xabc';
/** The outside-execution nonce of a transaction the fake keychain approves. */
export const APPROVAL_NONCE = 0x777n;
export const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const NONCE_BASE = 1000n;

export function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

/** One browser tab: a URL fragment that survives "reloads", and the last place it was sent to. */
export function fakePage() {
  const state = { fragment: '', navigatedTo: [] as string[], cleared: 0 };
  const page: KamuiPage = {
    fragment: () => state.fragment,
    clearFragment: () => {
      state.fragment = '';
      state.cleared++;
    },
    redirectUri: () => `${APP}/play`,
    navigate: (url) => void state.navigatedTo.push(url),
  };
  return { page, state };
}

/** The account as a node reports it: is the session there, and which sponsored nonces are used. */
export function fakeNode(over: { maxCalls?: number } = {}) {
  const state = {
    alive: true,
    down: false,
    used: new Set<bigint>(),
    reads: [] as string[],
    base: NONCE_BASE,
    validUntil: FUTURE,
    maxCalls: over.maxCalls ?? 3,
    /** The chain's height, and the account's events by block, for a session watcher. */
    block: 100,
    events: [] as { keys: string[]; data: string[]; block_number: number }[],
  };
  const provider = {
    async getBlockNumber() {
      if (state.down) throw new Error('node unreachable');
      return state.block;
    },
    async getEvents(filter: { from_block: { block_number: number }; to_block: { block_number: number } }) {
      if (state.down) throw new Error('node unreachable');
      return { events: state.events.filter((event) => event.block_number >= filter.from_block.block_number && event.block_number <= filter.to_block.block_number) };
    },
    async callContract({ entrypoint, calldata = [] }: { entrypoint: string; calldata?: string[] }) {
      state.reads.push(entrypoint);
      if (state.down) throw new Error('node unreachable');
      switch (entrypoint) {
        case 'get_session_data':
          return state.alive ? [`0x${state.validUntil.toString(16)}`, `0x${state.maxCalls.toString(16)}`, '0x0', '0x1'] : ['0x0', '0x0', '0x0', '0x0'];
        case 'get_session_nonce_base':
          return [`0x${state.base.toString(16)}`];
        case 'is_valid_outside_execution_nonce':
          return [state.used.has(BigInt(calldata[0]!)) ? '0x0' : '0x1'];
        default:
          throw new Error(`unexpected read ${entrypoint}`);
      }
    },
  } as unknown as ProviderInterface;
  return { provider, state, nonce: (offset: number) => state.base + BigInt(offset) };
}

export const sessionRequest = (over: Partial<KamuiSessionRequest> = {}): KamuiSessionRequest => ({
  appName: 'Example Game',
  validUntil: FUTURE,
  maxCalls: 3,
  calls: [{ to: GAME, entrypoint: 'move' }],
  ...over,
});

/** What the keychain does with the address the page was sent to: approves it, or refuses. */
export function keychainAnswers(url: string, answer: 'approve' | { error: string } = 'approve'): string {
  const target = new URL(url);
  if (target.origin !== KEYCHAIN) throw new Error(`not the keychain: ${url}`);
  if (target.pathname === '/execute') {
    const request = parseExecuteRequest(target.hash, `${APP}/play`)!;
    if (answer !== 'approve') return toFragment({ v: 1, id: request.id, ok: false, error: answer.error });
    // Signed by an owner key and not sent: the wallet's sponsor sends it.
    const signed = ownerOutsideExecution({ chainId: SEPOLIA, account: ACCOUNT, calls: callsFromWire(request.calls), ownerPrivateKey: '0x1', window: { executeBefore: FUTURE }, nonce: APPROVAL_NONCE });
    return toFragment({ v: 1, id: request.id, ok: true, account: ACCOUNT, calldata: signed.calldata as string[] });
  }
  const request = parseConnectRequest(target.hash, `${APP}/play`)!;
  return toFragment(
    answer === 'approve'
      ? { v: 1, id: request.id, ok: true, account: ACCOUNT, chainId: SEPOLIA, classHash: CLASS_HASH }
      : { v: 1, id: request.id, ok: false, error: answer.error },
  );
}

/** A tab, its storage, a node and a relayer that records what it was handed. */
export function world(over: Partial<KamuiWalletOptions> = {}, node = fakeNode()) {
  const store = memoryStore();
  const { page, state: tab } = fakePage();
  const relayed: { contractAddress: string; entrypoint: string; nonce: bigint }[] = [];
  const relayer = { fail: false };
  const options: KamuiWalletOptions = {
    keychainUrl: KEYCHAIN,
    provider: node.provider,
    session: sessionRequest(),
    store,
    page,
    sponsor: async (call) => {
      if (relayer.fail) throw new Error('relayer down');
      const nonce = BigInt((call.calldata as string[])[1]!);
      relayed.push({ contractAddress: call.contractAddress, entrypoint: call.entrypoint, nonce });
      node.state.used.add(nonce);
      return TX;
    },
    ...over,
  };
  return { options, store, tab, node, relayed, relayer };
}

/** A sign-in message, as an app would ask a wallet to sign. */
export const signInMessage = (chainId: string = 'SN_SEPOLIA'): TypedData => ({
  types: {
    StarknetDomain: [
      { name: 'name', type: 'shortstring' },
      { name: 'version', type: 'shortstring' },
      { name: 'chainId', type: 'shortstring' },
      { name: 'revision', type: 'shortstring' },
    ],
    SignIn: [
      { name: 'statement', type: 'shortstring' },
      { name: 'nonce', type: 'felt' },
    ],
  },
  primaryType: 'SignIn',
  domain: { name: 'Example Game', version: '1', chainId, revision: '1' },
  message: { statement: 'Sign in', nonce: '0x1234' },
});
