// Fakes for everything outside the keychain, installed on a browser context with network
// interception: a chain with one account, the backend's /recover and /sponsor, the pepper
// service, and the issuer's sign-in page. The keychain's own server, page, storage and content
// security policy are the real ones.
import type { BrowserContext, Route } from '@playwright/test';
import { hash } from 'starknet';
import { accountAddressFromLogin } from '../../sdk/src';

export const KEYCHAIN = 'http://localhost:5183';
export const RPC = 'http://localhost:5184';
export const PEPPER_SERVICE = 'http://localhost:5185';
export const CLASS_HASH = '0x13c5e8166199db99e894da9e55ce642267e5258c42eae8851357747b6201fdc';
export const CHAIN_ID = '0x534e5f5345504f4c4941';
export const PEPPER = '0x1234';
export const CLAIMS = { iss: 'https://accounts.google.com', aud: 'test-client', sub: 'user-1' };
export const ACCOUNT = accountAddressFromLogin(CLASS_HASH, CLAIMS, PEPPER);

const selector = (name: string) => BigInt(hash.getSelectorFromName(name));
const hex = (value: bigint | number) => `0x${BigInt(value).toString(16)}`;
const same = (a: string, b: string) => BigInt(a) === BigInt(b);

export type FakeSession = { validUntil: bigint; maxCalls: bigint; maxFee: bigint; entries: bigint };

export type World = {
  deployed: boolean;
  owners: string[];
  anchor: bigint;
  epoch: number;
  sessions: Map<string, FakeSession>;
  /** Contracts that answer `symbol()` and `decimals()`, by address. Anything else is not a token. */
  tokens: Map<bigint, { symbol: string; decimals: number }>;
  /** What the keychain asked the outside world to do. */
  recoverRequests: any[];
  sponsorRequests: { account: string; calls: { to: string; selector: bigint; data: string[] }[] }[];
  pepperRequests: any[];
  issuerVisits: number;
  /** Make the next /sponsor fail with this error. */
  sponsorError?: string;
};

export function newWorld(): World {
  return { deployed: false, owners: [], anchor: 0n, epoch: 0, sessions: new Map(), tokens: new Map(), recoverRequests: [], sponsorRequests: [], pepperRequests: [], issuerVisits: 0 };
}

function ownersChanged(world: World) {
  world.anchor += 1n;
  world.epoch += 1;
  world.sessions.clear();
}

/** An unsigned id_token. The client side never checks the signature. */
function token(nonce: string): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'RS256', kid: 'test' })}.${b64({ ...CLAIMS, nonce, iat: now - 5, exp: now + 3600 })}.c2ln`;
}

function contractCall(world: World, contract: string, entry: bigint, calldata: string[]): string[] {
  if (!same(contract, ACCOUNT)) {
    const token = world.tokens.get(BigInt(contract));
    if (token && entry === selector('symbol')) return [`0x${Buffer.from(token.symbol).toString('hex')}`];
    if (token && entry === selector('decimals')) return [hex(token.decimals)];
    throw new Error(`contract ${contract} has no such entry point`);
  }
  switch (entry) {
    case selector('is_owner'):
      return [world.owners.some((o) => same(o, calldata[0]!)) ? '0x1' : '0x0'];
    case selector('get_owners'):
      return [hex(world.owners.length), ...world.owners];
    case selector('get_owners_anchor'):
      return [hex(world.anchor)];
    case selector('get_session_epoch'):
      return [hex(world.epoch)];
    case selector('get_session_data'): {
      const session = world.sessions.get(hex(BigInt(calldata[0]!)));
      return session ? [hex(session.validUntil), hex(session.maxCalls), hex(session.maxFee), hex(session.entries)] : ['0x0', '0x0', '0x0', '0x0'];
    }
    default:
      throw new Error(`unexpected entry point ${hex(entry)}`);
  }
}

function rpc(world: World, method: string, params: any): unknown {
  switch (method) {
    case 'starknet_chainId':
      return CHAIN_ID;
    case 'starknet_specVersion':
      return '0.10.0';
    case 'starknet_blockNumber':
      return 100;
    case 'starknet_getClassHashAt':
      if (!world.deployed) throw { code: 20, message: 'Contract not found' };
      return CLASS_HASH;
    case 'starknet_call': {
      const request = params.request ?? params[0];
      return contractCall(world, request.contract_address, BigInt(request.entry_point_selector), request.calldata ?? []);
    }
    case 'starknet_getTransactionStatus':
      return { finality_status: 'ACCEPTED_ON_L2', execution_status: 'SUCCEEDED' };
    case 'starknet_getTransactionReceipt':
      return {
        type: 'INVOKE',
        transaction_hash: params.transaction_hash ?? params[0],
        actual_fee: { amount: '0x0', unit: 'FRI' },
        finality_status: 'ACCEPTED_ON_L2',
        execution_status: 'SUCCEEDED',
        block_hash: '0x1',
        block_number: 100,
        messages_sent: [],
        events: [],
        execution_resources: { l1_gas: 0, l1_data_gas: 0, l2_gas: 0 },
      };
    default:
      throw { code: -32601, message: `fake chain: ${method} is not implemented` };
  }
}

/** Splits `execute_from_outside_v2` calldata into its calls. */
function outsideCalls(calldata: string[]) {
  const calls: { to: string; selector: bigint; data: string[] }[] = [];
  let at = 5;
  for (let i = 0; i < Number(BigInt(calldata[4]!)); i++) {
    const length = Number(BigInt(calldata[at + 2]!));
    calls.push({ to: calldata[at]!, selector: BigInt(calldata[at + 1]!), data: calldata.slice(at + 3, at + 3 + length) });
    at += 3 + length;
  }
  return calls;
}

function applySponsored(world: World, calls: ReturnType<typeof outsideCalls>) {
  for (const call of calls) {
    if (call.selector === selector('add_or_update_scoped_session_key')) {
      world.sessions.set(hex(BigInt(call.data[0]!)), {
        validUntil: BigInt(call.data[1]!),
        maxCalls: BigInt(call.data[2]!),
        maxFee: BigInt(call.data[3]!),
        entries: BigInt(call.data[4]!),
      });
    } else if (call.selector === selector('remove_owner')) {
      world.owners = world.owners.filter((o) => !same(o, call.data[0]!));
      ownersChanged(world);
    }
  }
}

const cors = { 'access-control-allow-origin': KEYCHAIN, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, OPTIONS' };
const json = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });

/** Replaces the outside world for every page of `context`. */
export async function installFakes(context: BrowserContext, world: World) {
  await context.route(`${RPC}/**`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = route.request().postDataJSON();
    const one = (call: any) => {
      try {
        return { jsonrpc: '2.0', id: call.id, result: rpc(world, call.method, call.params ?? {}) };
      } catch (error) {
        return { jsonrpc: '2.0', id: call.id, error: (error as any).code ? error : { code: -32000, message: String((error as Error).message) } };
      }
    };
    return json(route, Array.isArray(body) ? body.map(one) : one(body), 200, cors);
  });

  await context.route(`${PEPPER_SERVICE}/**`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    world.pepperRequests.push(route.request().postDataJSON());
    return json(route, { pepper: PEPPER, key_version: 1 }, 200, cors);
  });

  await context.route(`${KEYCHAIN}/api/recover`, async (route) => {
    const request = route.request().postDataJSON();
    world.recoverRequests.push(request);
    world.deployed = true;
    world.owners.push(request.newPubkey);
    ownersChanged(world);
    return json(route, { address: request.account, transaction_hash: '0xaaa' });
  });

  await context.route(`${KEYCHAIN}/api/sponsor`, async (route) => {
    const request = route.request().postDataJSON();
    if (world.sponsorError) {
      const error = world.sponsorError;
      world.sponsorError = undefined;
      return json(route, { error }, 400);
    }
    const calls = outsideCalls(request.calldata);
    world.sponsorRequests.push({ account: request.account, calls });
    applySponsored(world, calls);
    return json(route, { transaction_hash: '0xbbb' });
  });

  await context.route('https://accounts.google.com/**', async (route) => {
    world.issuerVisits += 1;
    const url = new URL(route.request().url());
    const back = `${url.searchParams.get('redirect_uri')}#id_token=${token(url.searchParams.get('nonce')!)}&state=${url.searchParams.get('state')}`;
    return route.fulfill({ status: 302, headers: { location: back } });
  });
}

/** Serves a blank page for an app origin, so tests can start requests from it. */
export async function installApp(context: BrowserContext, origin: string) {
  await context.route(`${origin}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>app</title><p>app</p>' }),
  );
}

export const selectorOf = selector;
