// Kamui: the registry key watcher, with fake chain events and a fake issuer.
import { describe, expect, test } from 'bun:test';
import { CallData, byteArray, hash } from 'starknet';
import { byteArraysFromFelts, modulusHash, modulusLimbs, parseRegistryEvent } from '../../jwk/modulus';
import { setLogSink } from '../../log';
import { TEST_JWK, cairoFixture } from '../../test-fixtures';
import { alertIdentity, checkEvents, watchOnce, type WatcherDeps } from './key-watcher';

const GOOGLE = 'https://accounts.google.com';
const APPLE = 'https://appleid.apple.com';
const KEY_SET = hash.getSelectorFromName('KeySet');
const KEY_REMOVED = hash.getSelectorFromName('KeyRemoved');
const OTHER_N = Buffer.concat([Buffer.from(TEST_JWK.n, 'base64url').subarray(0, 250), Buffer.from([1, 2, 3, 4, 5, 7])]).toString('base64url');
const jwk = (kid: string, n = TEST_JWK.n) => ({ kid, kty: 'RSA', alg: 'RS256', use: 'sig', e: 'AQAB', n });
const hashOf = (n: string) => '0x' + modulusHash(modulusLimbs(n)).toString(16);
const names = (iss: string, kid: string) => CallData.compile([byteArray.byteArrayFromString(iss), byteArray.byteArrayFromString(kid)]) as string[];

let block = 100;
const keySet = (kid: string, n: string, iss = GOOGLE) => ({ keys: [KEY_SET, hashOf(n)], data: names(iss, kid), block_number: ++block, transaction_hash: `0x${block.toString(16)}` });
const keyRemoved = (kid: string, iss = GOOGLE) => ({ keys: [KEY_REMOVED], data: names(iss, kid), block_number: ++block, transaction_hash: `0x${block.toString(16)}` });

function watcher(events: any[], published: Record<string, ReturnType<typeof jwk>[] | Error>, webhookUrl?: string, stored: () => string[] = () => { throw new Error("'UNKNOWN_KID'"); }) {
  const posts: { url: string; body: any }[] = [];
  const deps: WatcherDeps = {
    provider: { getEvents: async () => ({ events }), getBlockNumber: async () => block, callContract: async () => stored() },
    registryAddress: '0x1',
    fromBlock: 0,
    fetchKeys: async (iss) => {
      const keys = published[iss] ?? [];
      if (keys instanceof Error) throw keys;
      return keys;
    },
    webhookUrl,
    send: async (url, init) => (posts.push({ url, body: JSON.parse(init!.body as string) }), new Response('ok')),
  };
  return { deps, posts };
}

async function once(deps: WatcherDeps) {
  const lines: any[] = [];
  const previous = setLogSink((line) => lines.push(JSON.parse(line)));
  try {
    return { ...(await watchOnce(deps)), lines };
  } finally {
    setLogSink(previous);
  }
}

describe('hashing', () => {
  test('the hash is poseidon over the 24 limbs the Cairo fixture holds, and an event decodes to it', async () => {
    const { limbs } = await cairoFixture();
    expect(modulusLimbs(TEST_JWK.n)).toEqual(limbs);
    expect('0x' + modulusHash(limbs).toString(16)).toBe(hash.computePoseidonHashOnElements(limbs));
    const event = parseRegistryEvent(keySet('kid-1', TEST_JWK.n));
    expect(event).toMatchObject({ kind: 'set', iss: GOOGLE, kid: 'kid-1', modulusHash: modulusHash(limbs) });
    expect(parseRegistryEvent({ keys: ['0x1234'], data: [] })).toBeNull();
  });
});

describe('watcher', () => {
  test('keys that match the issuer raise nothing: exit code 0', async () => {
    const { deps, posts } = watcher([keySet('kid-1', TEST_JWK.n), keySet('kid-2', OTHER_N), keySet('a-1', TEST_JWK.n, APPLE)], { [GOOGLE]: [jwk('kid-1'), jwk('kid-2', OTHER_N)], [APPLE]: [jwk('a-1')] }, 'https://hooks.test/x');
    const { code, result, lines } = await once(deps);
    expect(code).toBe(0);
    expect(result.verified).toBe(3);
    expect(lines.filter((l) => l.level === 'error')).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  test('a key whose hash differs from the issuer\'s is an alert: error log, webhook, exit code 1', async () => {
    const bad = keySet('kid-1', OTHER_N);
    const { deps, posts } = watcher([bad], { [GOOGLE]: [jwk('kid-1')] }, 'https://hooks.test/x');
    const { code, lines } = await once(deps);
    expect(code).toBe(1);
    const alert = lines.find((l) => l.event === 'registry_key_alert');
    expect(alert).toMatchObject({ level: 'error', reason: 'MODULUS_MISMATCH', iss: GOOGLE, kid: 'kid-1', on_chain_hash: hashOf(OTHER_N), issuer_hash: hashOf(TEST_JWK.n), tx: bad.transaction_hash, in_effect: true });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('https://hooks.test/x');
    expect(posts[0]!.body.alerts[0]).toMatchObject({ reason: 'MODULUS_MISMATCH', kid: 'kid-1' });
  });

  test('a kid the issuer does not publish is an alert', async () => {
    const { deps } = watcher([keySet('kid-1', TEST_JWK.n), keySet('attacker-kid', OTHER_N)], { [GOOGLE]: [jwk('kid-1')] });
    const { code, result } = await once(deps);
    expect(code).toBe(1);
    expect(result.alerts.map((a) => [a.reason, a.kid])).toEqual([['KID_NOT_PUBLISHED', 'attacker-kid']]);
  });

  test('a published key that is not an RS256 signing key does not count as published', async () => {
    const { deps } = watcher([keySet('kid-1', TEST_JWK.n)], { [GOOGLE]: [{ ...jwk('kid-1'), use: 'enc' }] });
    expect((await once(deps)).result.alerts.map((a) => a.reason)).toEqual(['KID_NOT_PUBLISHED']);
  });

  test('an event for an issuer nobody knows is an alert', async () => {
    const { deps } = watcher([keySet('kid-1', TEST_JWK.n, 'https://evil.example')], {});
    expect((await once(deps)).result.alerts.map((a) => a.reason)).toEqual(['UNKNOWN_ISSUER']);
  });

  test('history: a retired key that was removed is a warning, not an alert', async () => {
    const { deps } = watcher([keySet('old', OTHER_N), keySet('kid-1', TEST_JWK.n), keyRemoved('old')], { [GOOGLE]: [jwk('kid-1')] });
    const { code, result, lines } = await once(deps);
    expect(code).toBe(0);
    expect(result.unverifiable.map((e) => e.kid)).toEqual(['old']);
    expect(lines.some((l) => l.event === 'registry_key_unverifiable' && l.level === 'warn')).toBe(true);
  });

  test('a wrong key that replaced a right one is an alert; a right key that replaced a wrong one is not', async () => {
    const wrongLast = watcher([keySet('kid-1', TEST_JWK.n), keySet('kid-1', OTHER_N)], { [GOOGLE]: [jwk('kid-1')] });
    expect((await once(wrongLast.deps)).result.alerts.map((a) => a.reason)).toEqual(['MODULUS_MISMATCH']);
    const fixed = watcher([keySet('kid-1', OTHER_N), keySet('kid-1', TEST_JWK.n)], { [GOOGLE]: [jwk('kid-1')] });
    expect((await once(fixed.deps)).code).toBe(0);
  });

  test('while watching, a bad write is an alert even if it was removed straight after', () => {
    const start = block;
    const events = [keySet('attacker-kid', OTHER_N), keyRemoved('attacker-kid')].map((e) => parseRegistryEvent(e)!);
    const keys = new Map([[GOOGLE, [jwk('kid-1')]]]);
    expect(checkEvents(events, keys, start).alerts.map((a) => [a.reason, a.inEffect])).toEqual([['KID_NOT_PUBLISHED', false]]);
    expect(checkEvents(events, keys).alerts).toHaveLength(0);
  });

  test('an issuer that cannot be fetched is a failure, never "ok": exit code 2', async () => {
    const { deps } = watcher([keySet('kid-1', TEST_JWK.n)], { [GOOGLE]: new Error('down') });
    const { code, result, lines } = await once(deps);
    expect(code).toBe(2);
    expect(result.verified).toBe(0);
    expect(lines.some((l) => l.event === 'watcher_issuer_unavailable' && l.level === 'error')).toBe(true);
  });

  test('a write without a hash (older registry class) is checked against the stored key', async () => {
    const event = keySet('kid-1', TEST_JWK.n);
    event.keys = [KEY_SET];
    const limbs = (n: string) => () => modulusLimbs(n).map((limb) => '0x' + limb.toString(16));
    const good = watcher([event], { [GOOGLE]: [jwk('kid-1')] }, undefined, limbs(TEST_JWK.n));
    expect(await once(good.deps)).toMatchObject({ code: 0, result: { verified: 1 } });
    const bad = watcher([event], { [GOOGLE]: [jwk('kid-1')] }, undefined, limbs(OTHER_N));
    expect((await once(bad.deps)).result.alerts.map((a) => a.reason)).toEqual(['MODULUS_MISMATCH']);
    // The events say a key is set and storage has none: nothing to compare, which is itself an alert.
    const missing = watcher([event], { [GOOGLE]: [jwk('kid-1')] });
    expect((await once(missing.deps)).result.alerts.map((a) => a.reason)).toEqual(['NO_MODULUS_HASH']);
  });

  test('a webhook that fails does not hide the alert', async () => {
    const { deps } = watcher([keySet('kid-1', OTHER_N)], { [GOOGLE]: [jwk('kid-1')] }, 'https://hooks.test/x');
    deps.send = async () => new Response('no', { status: 500 });
    const { code, lines } = await once(deps);
    expect(code).toBe(1);
    expect(lines.some((l) => l.event === 'watcher_webhook_failed')).toBe(true);
  });
});

describe('current issuer publication freshness', () => {
  test('new Google kid absent from empty registry alerts without fabricated chain evidence', async () => {
    const {deps,posts}=watcher([], {[GOOGLE]:[jwk('new-google-kid')]}, 'https://hooks.test/x');deps.publishedIssuers=[GOOGLE];
    const {code,result,lines}=await once(deps);
    expect(code).toBe(1);
    expect(result.alerts).toEqual([{source:'issuer',reason:'REGISTRY_KEY_MISSING',iss:GOOGLE,kid:'new-google-kid',issuerHash:hashOf(TEST_JWK.n),inEffect:true}]);
    const line=lines.find(line=>line.event==='registry_key_alert');expect(line.source).toBe('issuer');expect(line.tx).toBeUndefined();expect(line.block).toBeUndefined();
    expect(posts[0]!.body.text).not.toContain('undefined');expect(posts[0]!.body.alerts[0].transactionHash).toBeUndefined();
  });
  test('every eligible publication is checked directly even without any historical writes', async () => {
    const {deps}=watcher([], {[GOOGLE]:[jwk('one'),jwk('two',OTHER_N)]});deps.publishedIssuers=[GOOGLE,GOOGLE];
    const read:string[]=[];let fetches=0;
    deps.fetchKeys=async iss=>{fetches++;expect(iss).toBe(GOOGLE);return[jwk('one'),jwk('two',OTHER_N)];};
    deps.provider.callContract=async call=>{expect(call.entrypoint).toBe('get_key');const [iss,kid]=byteArraysFromFelts(call.calldata);expect(iss).toBe(GOOGLE);read.push(kid!);return modulusLimbs(kid==='one'?TEST_JWK.n:OTHER_N).map(limb=>'0x'+limb.toString(16));};
    const {code,result}=await once(deps);expect(code).toBe(0);expect(result.verified).toBe(2);expect(fetches).toBe(1);expect(read).toEqual(['one','two']);
  });
  test('storage mismatch is visible even when historical event hash matches issuer', async () => {
    const {deps}=watcher([keySet('one',TEST_JWK.n)], {[GOOGLE]:[jwk('one')]},undefined,()=>modulusLimbs(OTHER_N).map(limb=>'0x'+limb.toString(16)));deps.publishedIssuers=[GOOGLE];
    const {code,result}=await once(deps);expect(code).toBe(1);
    expect(result.alerts).toEqual([{source:'issuer',reason:'MODULUS_MISMATCH',iss:GOOGLE,kid:'one',onChainHash:hashOf(OTHER_N),issuerHash:hashOf(TEST_JWK.n),inEffect:true}]);
  });
  test('fresh fetch on each pass detects a later publication absent from event history', async () => {
    const {deps}=watcher([],{});deps.publishedIssuers=[GOOGLE];let fetches=0;
    deps.fetchKeys=async()=>++fetches===1?[jwk('existing')]:[jwk('existing'),jwk('later')];
    deps.provider.callContract=async call=>{if(byteArraysFromFelts(call.calldata)[1]==='later')throw Error("'UNKNOWN_KID'");return modulusLimbs(TEST_JWK.n).map(limb=>'0x'+limb.toString(16));};
    expect((await once(deps)).code).toBe(0);const next=await once(deps);expect(next.code).toBe(1);expect(fetches).toBe(2);expect(next.result.alerts[0]!.kid).toBe('later');
  });
  test('fetch failures, malformed JWKS and no eligible keys fail rather than report healthy', async () => {
    for(const keys of [new Error('issuer unavailable'),[],[{...jwk('kid'),use:'enc'}],[{...jwk('kid'),n:'not-a-modulus'}]]){
      const {deps}=watcher([],{[GOOGLE]:keys});deps.publishedIssuers=[GOOGLE];
      const {code,result}=await once(deps);expect(code).toBe(2);expect(result.issuersUnavailable).toEqual([GOOGLE]);expect(result.verified).toBe(0);
    }
  });
  test('RPC and malformed-storage failures never become missing-key or healthy results', async () => {
    for(const stored of [()=>{throw Error('RPC_SOCKET_UNAVAILABLE');},()=>['0x1']]){
      const {deps}=watcher([],{[GOOGLE]:[jwk('kid')]},undefined,stored);deps.publishedIssuers=[GOOGLE];await expect(once(deps)).rejects.toThrow();
    }
  });
  test('source and changed comparison hashes separate alert deduplication identities', () => {
    const issuer={source:'issuer' as const,reason:'MODULUS_MISMATCH' as const,iss:GOOGLE,kid:'kid',inEffect:true,onChainHash:'0x1',issuerHash:'0x2'};
    const event={...issuer,source:'event' as const,transactionHash:'0x3',blockNumber:1};
    expect(alertIdentity(issuer)).not.toBe(alertIdentity(event));expect(alertIdentity(issuer)).not.toBe(alertIdentity({...issuer,issuerHash:'0x4'}));expect(alertIdentity(issuer)).toBe(alertIdentity({...issuer}));
  });
});
