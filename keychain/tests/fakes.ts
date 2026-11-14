import { generateKeyPairSync, sign } from 'node:crypto';
import { installProverFake } from './prover-fake';
// Fakes for everything outside the keychain, installed on a browser context with network
// interception: a chain with one account, the backend's /recover and /sponsor, the session
// registry, the pepper service, and the Google and Apple sign-in pages. The keychain's own server, page, storage and content
// security policy are the real ones.
import type { BrowserContext, Route } from '@playwright/test';
import { ec, hash } from 'starknet';
import { accountAddressFromLogin, registryMessageHash, type RegistryAction } from '../../sdk/src';

export const KEYCHAIN = 'http://localhost:5183';
export const RPC = 'http://localhost:5184';
export const PEPPER_SERVICE = 'http://localhost:5185';
export const CLASS_HASH = '0x13c5e8166199db99e894da9e55ce642267e5258c42eae8851357747b6201fdc';
export const CHAIN_ID = '0x534e5f5345504f4c4941';
export const PEPPER = '0x1234';
export const CLAIMS = { iss: 'https://accounts.google.com', aud: 'test-client', sub: 'user-1' };
export const ACCOUNT = accountAddressFromLogin(CLASS_HASH, CLAIMS, PEPPER);
/** The same person signing in with Apple is another user, with another account. */
export const APPLE_CLAIMS = { iss: 'https://appleid.apple.com', aud: 'test-apple-client', sub: 'apple-user-1' };
export const APPLE_ACCOUNT = accountAddressFromLogin(CLASS_HASH, APPLE_CLAIMS, PEPPER);

const selector = (name: string) => BigInt(hash.getSelectorFromName(name));
const hex = (value: bigint | number) => `0x${BigInt(value).toString(16)}`;
const same = (a: string, b: string) => BigInt(a) === BigInt(b);

export type FakePolicy = { maxPerCall: bigint; maxPerWindow: bigint; windowSeconds: bigint };
export type FakeSession = {
  validUntil: bigint;
  maxCalls: bigint;
  maxFee: bigint;
  /** What the session may call: contract and selector. */
  scope: { to: bigint; selector: bigint }[];
  /** Spending policies by token address. */
  policies: Map<bigint, FakePolicy>;
};

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
  sponsorRequests: { endpoint: string; account: string; calls: { to: string; selector: bigint; data: string[] }[] }[];
  pepperRequests: any[];
  /** Every signature the account was asked about (`is_valid_signature`). */
  signatureChecks: { hash: string; signature: string[] }[];
  issuerVisits: number;
  /** The query of each visit to Apple's sign-in page. */
  appleVisits: Record<string, string>[];
  /** Make the next /sponsor fail with this error. */
  sponsorError?: string;
  /** Apple answers with this error instead of a token. */
  appleError?: string;
  /** Google's page sets Cross-Origin-Opener-Policy, which cuts a popup off from the page that opened it. */
  issuerIsolatesOpener?: boolean;
  /** The pepper service answers 503. */
  pepperDown?: boolean;
  /** The session registry's records, by session key (hex without leading zeros). */
  registry: Map<string, any>;
  /** Every request the registry got, accepted or not. */
  registryRequests: { action: RegistryAction; body: any }[];
  /** The registry has no room for another record: a new one is answered 409 REGISTRY_FULL. */
  registryFull?: boolean;
  /** The registry answers 503. */
  registryDown?: boolean;
};

export function newWorld(): World {
  return { deployed: false, owners: [], anchor: 0n, epoch: 0, sessions: new Map(), tokens: new Map(), recoverRequests: [], sponsorRequests: [], pepperRequests: [], signatureChecks: [], issuerVisits: 0, appleVisits: [], registry: new Map(), registryRequests: [] };
}

function ownersChanged(world: World) {
  world.anchor += 1n;
  world.epoch += 1;
  world.sessions.clear();
}

const fixtureRsa = generateKeyPairSync('rsa', {modulusLength:2048});
const fixtureModulus = BigInt('0x' + Buffer.from(fixtureRsa.publicKey.export({format:'jwk'}).n!, 'base64url').toString('hex'));

/** A test issuer token, signed only to exercise real browser RSA witness construction. */
function token(nonce: string, claims: { iss: string; aud: string; sub: string } = CLAIMS): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const message = `${b64({ alg: 'RS256', kid: 'test' })}.${b64({ ...claims, nonce, iat: now - 5, exp: now + 3600 })}`;
  return `${message}.${sign('RSA-SHA256', Buffer.from(message), fixtureRsa.privateKey).toString('base64url')}`;
}

/** The fake chain has one account's state, reachable at the Google and the Apple address. */
const isAccount = (contract: string) => same(contract, ACCOUNT) || same(contract, APPLE_ACCOUNT);
const u256 = (value: bigint) => [hex(value & ((1n << 128n) - 1n)), hex(value >> 128n)];

/** Whether `[r, s]` is the signature of `messageHash` by the key whose public x coordinate is `publicKey`. */
export function signedBy(messageHash: string, r: string, s: string, publicKey: string): boolean {
  for (const bit of [0, 1]) {
    try {
      const point = new ec.starkCurve.Signature(BigInt(r), BigInt(s)).addRecoveryBit(bit).recoverPublicKey(BigInt(messageHash).toString(16).padStart(64, '0'));
      if (BigInt(`0x${point.toHex(true).slice(2)}`) === BigInt(publicKey)) return true;
    } catch { /* no point for this recovery bit */ }
  }
  return false;
}

function contractCall(world: World, contract: string, entry: bigint, calldata: string[]): string[] {
  if (!isAccount(contract)) {
    const token = world.tokens.get(BigInt(contract));
    if (token && entry === selector('symbol')) return [`0x${Buffer.from(token.symbol).toString('hex')}`];
    if (token && entry === selector('decimals')) return [hex(token.decimals)];
    throw new Error(`contract ${contract} has no such entry point`);
  }
  switch (entry) {
    case selector('is_owner'):
      return [world.owners.some((o) => same(o, calldata[0]!)) ? '0x1' : '0x0'];
    case selector('is_valid_signature'): {
      // Owner signatures only, as the real account checks them: `[r, s]` by any owner key.
      const [messageHash, length, ...signature] = calldata as [string, string, ...string[]];
      world.signatureChecks.push({ hash: messageHash, signature });
      const valid = BigInt(length) === 2n && signature.length === 2 && world.owners.some((owner) => signedBy(messageHash, signature[0]!, signature[1]!, owner));
      return [valid ? '0x56414c4944' : '0x0']; // 'VALID'
    }
    case selector('get_owners'):
      return [hex(world.owners.length), ...world.owners];
    case selector('get_owners_anchor'):
      return [hex(world.anchor)];
    case selector('get_session_epoch'):
      return [hex(world.epoch)];
    case selector('get_session_data'): {
      const session = world.sessions.get(hex(BigInt(calldata[0]!)));
      return session ? [hex(session.validUntil), hex(session.maxCalls), hex(session.maxFee), hex(session.scope.length)] : ['0x0', '0x0', '0x0', '0x0'];
    }
    case selector('is_session_call_allowed'): {
      const session = world.sessions.get(hex(BigInt(calldata[0]!)));
      const allowed = session?.scope.some((entry) => entry.to === BigInt(calldata[1]!) && entry.selector === BigInt(calldata[2]!));
      return [allowed ? '0x1' : '0x0'];
    }
    case selector('get_spending_policy'): {
      const policy = world.sessions.get(hex(BigInt(calldata[0]!)))?.policies.get(BigInt(calldata[1]!));
      if (!policy) return ['0x0', '0x0', '0x0', '0x0', '0x0', '0x0', '0x0', '0x0'];
      return [...u256(policy.maxPerCall), ...u256(policy.maxPerWindow), hex(policy.windowSeconds), '0x0', '0x0', '0x0'];
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
    case 'starknet_getBlockWithTxHashes': return { block_hash: '0x1', block_number: 100, transactions: [], timestamp: Math.floor(Date.now()/1000), status: 'ACCEPTED_ON_L2' };
    case 'starknet_getNonce': return '0x0';
    case 'starknet_blockNumber':
      return 100;
    case 'starknet_getClassHashAt':
      if (!world.deployed) throw { code: 20, message: 'Contract not found' };
      return CLASS_HASH;
    case 'starknet_call': {
      const request = params.request ?? params[0];
      if (BigInt(request.entry_point_selector) === selector('get_key')) return Array.from({length:24}, (_,i) => hex(fixtureModulus >> (96n*BigInt(i)) & ((1n<<96n)-1n)));
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
      const scope = [];
      for (let i = 0; i < Number(BigInt(call.data[4]!)); i++) scope.push({ to: BigInt(call.data[5 + 2 * i]!), selector: BigInt(call.data[6 + 2 * i]!) });
      world.sessions.set(hex(BigInt(call.data[0]!)), {
        validUntil: BigInt(call.data[1]!),
        maxCalls: BigInt(call.data[2]!),
        maxFee: BigInt(call.data[3]!),
        scope,
        policies: new Map(),
      });
    } else if (call.selector === selector('set_spending_policy')) {
      const [low, high, windowLow, windowHigh] = call.data.slice(2, 6).map((felt) => BigInt(felt));
      world.sessions.get(hex(BigInt(call.data[0]!)))?.policies.set(BigInt(call.data[1]!), {
        maxPerCall: (high! << 128n) + low!,
        maxPerWindow: (windowHigh! << 128n) + windowLow!,
        windowSeconds: BigInt(call.data[6]!),
      });
    } else if (call.selector === selector('revoke_session_key')) {
      world.sessions.delete(hex(BigInt(call.data[0]!)));
    } else if (call.selector === selector('revoke_all_sessions')) {
      world.epoch += 1;
      world.sessions.clear();
    } else if (call.selector === selector('remove_owner')) {
      world.owners = world.owners.filter((o) => !same(o, call.data[0]!));
      ownersChanged(world);
    }
  }
}

const cors = { 'access-control-allow-origin': KEYCHAIN, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, OPTIONS' };
const json = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });

/**
 * The registry's check of a request, as the protocol describes it: a fresh timestamp, and
 * exactly two signature elements that are an owner key's signature over the request's hash.
 * The real server asks the account's `is_valid_signature`; here the owners are at hand.
 */
function registryRefusal(world: World, action: RegistryAction, body: any, subject: string | undefined): string | null {
  if (typeof body?.nonce !== 'string' || !/^0x[0-9a-f]+$/i.test(body.nonce)) return 'no nonce';
  if (!isAccount(String(body?.account))) return 'unknown account';
  if (!Number.isInteger(body.timestamp) || Math.abs(Date.now() / 1000 - body.timestamp) > 300) return 'stale timestamp';
  if (!Array.isArray(body.signature) || body.signature.length !== 2) return 'bad signature';
  if (action !== 'list' && typeof subject !== 'string') return 'no session key';
  const digest = BigInt(registryMessageHash({ chainId: CHAIN_ID, account: body.account, action, timestamp: body.timestamp, nonce: body.nonce, subject, session: action === 'put' ? body.session : undefined })).toString(16).padStart(64, '0');
  const signature = new ec.starkCurve.Signature(BigInt(body.signature[0]), BigInt(body.signature[1]));
  // An owner key is the x coordinate of a point; either of the two points with that x will do.
  const signed = world.owners.some((owner) =>
    ['02', '03'].some((prefix) => {
      try {
        return ec.starkCurve.verify(signature, digest, prefix + BigInt(owner).toString(16).padStart(64, '0'));
      } catch {
        return false;
      }
    }),
  );
  return signed ? null : 'bad signature';
}

/**
 * The issuer's page sending the user back. A page that navigates, not a 302: WebKit cannot be
 * given a redirect as a faked answer.
 */
const sendBack = (route: Route, to: string, headers: Record<string, string> = {}) =>
  route.fulfill({ status: 200, contentType: 'text/html', headers, body: `<!doctype html><title>issuer</title><script>location.replace(${JSON.stringify(to)})</script>` });

/** Replaces the outside world for every page of `context`. */
export async function installFakes(context: BrowserContext, world: World) {
  await installProverFake(context, world);
  await context.route(url => url.href.startsWith(`${RPC}/`) || url.href === 'https://sepolia.nodes.starknet.org/rpc/v0_10', async (route) => {
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
    if (world.pepperDown) return json(route, { error: 'unavailable' }, 503, cors);
    return json(route, { pepper: PEPPER, key_version: 1 }, 200, cors);
  });

  await context.route(`${KEYCHAIN}/api/deploy/authenticated`, async route => {
    const r = route.request().postDataJSON();
    world.deployed = true;
    return json(route, {jobId:r.jobId}, 202);
  });

  await context.route(`${KEYCHAIN}/api/relay`, async (route) => {
    const request = route.request().postDataJSON();
    world.recoverRequests.push(request);
    world.deployed = true;
    world.owners.push(request.newPubkey);
    ownersChanged(world);
    return json(route, { jobId: request.jobId }, 202);
  });

  await context.route(`${KEYCHAIN}/api/recover/status`, async (route) => {
    return json(route, { status: 'succeeded', result: { transaction_hash: '0xaaa' } });
  });

  await context.route(new RegExp(`^${KEYCHAIN}/api/(wallet/)?sponsor$`), async (route) => {
    const request = route.request().postDataJSON();
    if (world.sponsorError) {
      const error = world.sponsorError;
      world.sponsorError = undefined;
      return json(route, { error }, 400);
    }
    const calls = outsideCalls(request.calldata);
    world.sponsorRequests.push({ endpoint: new URL(route.request().url()).pathname, account: request.account, calls });
    applySponsored(world, calls);
    return json(route, { transaction_hash: '0xbbb' });
  });

  const registry = (path: string, action: RegistryAction, handle: (body: any) => unknown, subjectOf: (body: any) => string | undefined) =>
    context.route(`${KEYCHAIN}/api/registry/sessions${path}`, async (route) => {
      const body = route.request().postDataJSON();
      world.registryRequests.push({ action, body });
      if (world.registryDown) return json(route, { error: 'unavailable' }, 503);
      const refusal = registryRefusal(world, action, body, subjectOf(body));
      if (refusal) return json(route, { error: refusal }, 401);
      return json(route, handle(body));
    });
  await context.route(`${KEYCHAIN}/api/registry/sessions`, async (route) => {
    const body = route.request().postDataJSON();
    world.registryRequests.push({ action: 'put', body });
    if (world.registryDown) return json(route, { error: 'unavailable' }, 503);
    const refusal = registryRefusal(world, 'put', body, body.session?.publicKey);
    if (refusal) return json(route, { error: refusal }, 401);
    // The backend's choices where the spec is silent: no expired sessions, at most 50 records
    // for an account, and keys answered as lower-case hex without leading zeros.
    if (body.session.validUntil <= Date.now() / 1000) return json(route, { error: 'SESSION_EXPIRED' }, 400);
    const key = hex(BigInt(body.session.publicKey));
    if (world.registryFull && !world.registry.has(key)) return json(route, { error: 'REGISTRY_FULL' }, 409);
    world.registry.set(key, { ...body.session, publicKey: key, createdAt: Math.floor(Date.now() / 1000) });
    return json(route, { ok: true });
  });
  await registry('/list', 'list', () => ({ sessions: [...world.registry.values()].reverse() }), () => undefined);
  await registry('/remove', 'remove', (body) => {
    world.registry.delete(hex(BigInt(body.publicKey)));
    return { ok: true };
  }, (body) => body.publicKey);

  // Apple answers in the fragment when asked with response_mode=fragment, and sends a code
  // along with the token.
  await context.route('https://appleid.apple.com/**', async (route) => {
    const url = new URL(route.request().url());
    world.appleVisits.push(Object.fromEntries(url.searchParams));
    if (world.appleError) return sendBack(route, `${url.searchParams.get('redirect_uri')}#error=${world.appleError}&state=${url.searchParams.get('state')}`);
    const back = `${url.searchParams.get('redirect_uri')}#code=fake-code&id_token=${token(url.searchParams.get('nonce')!, APPLE_CLAIMS)}&state=${url.searchParams.get('state')}`;
    return sendBack(route, back);
  });

  await context.route('https://accounts.google.com/**', async (route) => {
    world.issuerVisits += 1;
    const url = new URL(route.request().url());
    const back = `${url.searchParams.get('redirect_uri')}#id_token=${token(url.searchParams.get('nonce')!)}&state=${url.searchParams.get('state')}`;
    return sendBack(route, back, world.issuerIsolatesOpener ? { 'cross-origin-opener-policy': 'same-origin' } : {});
  });
}

/** Serves a blank page for an app origin, so tests can start requests from it. */
export async function installApp(context: BrowserContext, origin: string) {
  await context.route(`${origin}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>app</title><p>app</p>' }),
  );
}

export const selectorOf = selector;
