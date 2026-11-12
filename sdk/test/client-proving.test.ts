import { describe, expect, test } from 'bun:test';
import { RpcError, hash, shortString } from 'starknet';
import { accountAddressFromLogin, identity } from '../src/address';
import { browserRecoverBackend, clientProofFacts, recoveryMessage, V2_HEADER, V2_PROGRAM, V2_SEPOLIA_CONFIG, type ClientProof } from '../src/client-proving';
import { type RecoverRequest } from '../src/login';

const CLASS = '0x123';
const CLAIMS = { iss: 'https://accounts.google.com', aud: 'client', sub: 'subject', nonce: '0x1', iat: 1, exp: 9999999999 };
const PEPPER = '0x456';
const ACCOUNT = accountAddressFromLogin(CLASS, CLAIMS, PEPPER);
const ACCOUNT_ID = identity(CLAIMS, PEPPER);
const ANCHOR = '0x777';
const B64 = (data: object) => Buffer.from(JSON.stringify(data)).toString('base64url');
const request = (): RecoverRequest => ({ jwt: `${B64({ alg: 'RS256', kid: 'k' })}.${B64(CLAIMS)}.c2ln`, account: ACCOUNT, newPubkey: '0x2', blinding: '0x3', pepper: PEPPER, signature: ['0x4', '0x5'], keyProof: ['0x6', '0x7'], override: false });
const message = (anchor = ANCHOR) => recoveryMessage(ACCOUNT, ACCOUNT_ID, '0x2', anchor);
const preimage = (anchor = ANCHOR) => ['0x1', '0x8', V2_PROGRAM, shortString.encodeShortString('VIRTUAL_SNOS0'), '0x64', '0xabc', V2_SEPOLIA_CONFIG, '0x1', message(anchor)];
const proof = (anchor = ANCHOR): ClientProof => ({ proof: Buffer.from(V2_HEADER + '00', 'hex').toString('base64'), proofFacts: clientProofFacts(preimage(anchor), message(anchor)) });

function setup(deployed = true) {
  const state = { deployed, anchor: deployed ? ANCHOR : '0x0' };
  const waits: string[] = [];
  const requests: { path: string; body: any }[] = [];
  const provider = {
    getClassHashAt: async () => {
      if (!state.deployed) throw new RpcError({ code: 20, message: 'Contract not found' }, 'starknet_getClassHashAt', {});
      return CLASS;
    },
    callContract: async ({ entrypoint }: { entrypoint: string }) => {
      if (entrypoint !== 'get_owners_anchor') throw Error('unexpected read');
      return [state.anchor];
    },
    waitForTransaction: async (hash: string) => { waits.push(hash); },
  } as any;
  const send = async (url: string, init: { body: string }) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    requests.push({ path, body });
    if (path === '/deploy/authenticated') {
      state.deployed = true;
      return Response.json({ jobId: body.jobId }, { status: 202 });
    }
    if (path === '/relay') return Response.json({ jobId: body.jobId }, { status: 202 });
    if (path === '/recover/status') return Response.json({ status: 'succeeded', result: { transaction_hash: requests.some(r => r.path === '/relay') ? '0xb' : '0xa' } });
    throw Error('unexpected route');
  };
  return { state, provider, requests, waits, send };
}

describe('client proof validation', () => {
  test('the recovery statement matches the Cairo message shape, including the account in its payload', () => {
    expect(BigInt(message())).toBe(BigInt(hash.computePoseidonHashOnElements([ACCOUNT, '0x0', '0x5', ACCOUNT, ACCOUNT_ID, '0x2', ANCHOR, '0x0'])));
    const facts = clientProofFacts(preimage(), message());
    expect(facts).toEqual([shortString.encodeShortString('PROOF2'), shortString.encodeShortString('VIRTUAL_SNOS'), ...preimage().slice(2)]);
  });

  test('rejects incompatible output envelopes, program, output version, message count and bindings', () => {
    for (const [index, value] of [[0, '0x2'], [1, '0x7'], [2, '0x1'], [3, '0x2'], [4, '0x20000000000000'], [7, '0x0'], [8, '0x1'], [5, 'not a felt'], [6, '0x' + 'f'.repeat(64)], [6, '0x1']] as [number, string][]) {
      const changed = preimage(); changed[index] = value;
      expect(() => clientProofFacts(changed, message())).toThrow('recovery output mismatch');
    }
    expect(() => clientProofFacts(preimage().slice(1), message())).toThrow('recovery output mismatch');
    expect(() => clientProofFacts([...preimage(), '0x0'], message())).toThrow('recovery output mismatch');
  });
});

describe('browser recovery orchestration', () => {
  test('existing-account proof submission contains no JWT, pepper, blinding, key proof or adapter extras', async () => {
    const f = setup();
    let proved = 0;
    const backend = browserRecoverBackend({ apiUrl: 'https://api.test', classHash: CLASS, provider: f.provider, polling: { pollIntervalMs: 0 }, send: f.send, prove: async (r, anchor) => {
      proved++;
      expect(r.jwt).toBe(request().jwt);
      expect(anchor).toBe(ANCHOR);
      return { ...proof(anchor), jwt: r.jwt, pepper: r.pepper, account: '0xdead' } as any;
    } });
    expect(await backend.recover(request())).toEqual({ transaction_hash: '0xb' });
    expect(proved).toBe(1);
    expect(f.requests.map(r => r.path)).toEqual(['/relay', '/recover/status']);
    const body = f.requests[0]!.body;
    expect(Object.keys(body).sort()).toEqual(['account', 'jobId', 'newPubkey', 'override', 'proof', 'proofFacts', 'signature']);
    expect(body.account).toBe(ACCOUNT);
    for (const r of f.requests) {
      expect(JSON.stringify(r.body)).not.toContain(request().jwt);
      expect(r.body).not.toHaveProperty('pepper');
      expect(r.body).not.toHaveProperty('blinding');
      expect(r.body).not.toHaveProperty('keyProof');
    }
  });

  test('first deployment authenticates before proving and uses distinct job capabilities', async () => {
    const f = setup(false);
    let proved = false;
    const backend = browserRecoverBackend({ apiUrl: 'https://api.test', classHash: CLASS, provider: f.provider, send: f.send, polling: { pollIntervalMs: 0 }, prove: async (_r, anchor) => {
      expect(f.state.deployed).toBe(true);
      expect(f.waits).toEqual(['0xa']);
      expect(anchor).toBe('0x0');
      proved = true;
      return proof(anchor);
    } });
    expect(await backend.recover(request())).toEqual({ transaction_hash: '0xb' });
    expect(proved).toBe(true);
    expect(f.requests.map(r => r.path)).toEqual(['/deploy/authenticated', '/recover/status', '/relay', '/recover/status']);
    expect(f.requests[0]!.body).toMatchObject(request());
    expect(f.requests[0]!.body.jobId).not.toBe(f.requests[2]!.body.jobId);
    expect(f.requests[2]!.body).not.toHaveProperty('jwt');
  });

  test('unsupported proving fails before first-deployment authentication or chain access', async () => {
    const f = setup(false);
    f.provider.getClassHashAt = async () => { throw Error('must not read'); };
    const backend = browserRecoverBackend({ apiUrl: 'https://api.test', classHash: CLASS, provider: f.provider, send: f.send, assertSupported: () => { throw Error('unsupported browser'); }, prove: async () => { throw Error('must not prove'); } });
    await expect(backend.recover(request())).rejects.toThrow('unsupported browser');
    expect(f.requests).toEqual([]);
  });

  test('a failed browser proof never falls back to an API prover or submits private input', async () => {
    const f = setup();
    const backend = browserRecoverBackend({ apiUrl: 'https://api.test', classHash: CLASS, provider: f.provider, send: f.send, prove: async () => { throw Error('browser memory exhausted'); } });
    await expect(backend.recover(request())).rejects.toThrow('browser memory exhausted');
    expect(f.requests).toEqual([]);
  });

  test('an expiring token is refused before first deployment, chain reads or proving', async () => {
    const f = setup(false);
    let proved = 0;
    f.provider.getClassHashAt = async () => { throw Error('must not read'); };
    const backend = browserRecoverBackend({ apiUrl: 'https://api.test', classHash: CLASS, provider: f.provider, send: f.send, prove: async () => { proved++; return proof(); } });
    const jwt = `${B64({ alg: 'RS256', kid: 'k' })}.${B64({ ...CLAIMS, exp: Math.floor(Date.now() / 1000) + 899 })}.c2ln`;
    await expect(backend.recover({ ...request(), jwt })).rejects.toThrow('expires too soon');
    expect(proved).toBe(0);
    expect(f.requests).toEqual([]);
  });

  test('a changed signature anchor stops before expensive proving or relay', async () => {
    const f = setup();
    let proved = 0;
    const backend = browserRecoverBackend({ apiUrl: 'https://api.test', classHash: CLASS, provider: f.provider, send: f.send, prove: async () => { proved++; return proof(); } });
    await expect(backend.recover({ ...request(), ownersAnchor: '0x778' })).rejects.toThrow('owners changed');
    expect(proved).toBe(0);
    expect(f.requests).toEqual([]);
    // The optional field is local metadata, and a matching anchor still works.
    expect(await backend.recover({ ...request(), ownersAnchor: '0x0777' })).toEqual({ transaction_hash: '0xb' });
    expect(proved).toBe(1);
    expect(f.requests[0]!.body).not.toHaveProperty('ownersAnchor');
  });

  test('submission hook runs once after proof validation and before any relay request', async () => {
    const f = setup();
    const events: string[] = [];
    const backend = browserRecoverBackend({ apiUrl: 'https://api.test', classHash: CLASS, provider: f.provider, polling: { pollIntervalMs: 0 }, prove: async () => { events.push('prove'); return proof(); }, onSubmitting: () => events.push('submitting'), onStatus: status => events.push(status), send: async (url, init) => { events.push(new URL(url).pathname); return f.send(url, init); } });
    await backend.recover(request());
    expect(events).toEqual(['prove', 'submitting', 'Submitting your proof…', '/relay', '/recover/status']);
    let submitted = 0;
    const failed = browserRecoverBackend({ apiUrl: 'https://api.test', classHash: CLASS, provider: f.provider, prove: async () => ({ ...proof(), proofFacts: [] }), onSubmitting: () => { submitted++; } });
    await expect(failed.recover(request())).rejects.toThrow('recovery output mismatch');
    expect(submitted).toBe(0);
  });

  test('RPC outages are not mistaken for a first deployment and do not send the token', async () => {
    const f = setup();
    f.provider.getClassHashAt = async () => { throw Error('RPC unavailable'); };
    const backend = browserRecoverBackend({ apiUrl: 'https://api.test', classHash: CLASS, provider: f.provider, send: f.send, prove: async () => proof() });
    await expect(backend.recover(request())).rejects.toThrow('RPC unavailable');
    expect(f.requests).toEqual([]);
  });

  test('contract-not-found is recognized across separately bundled starknet.js constructors', async () => {
    const f = setup(false);
    f.provider.getClassHashAt = async () => {
      if (!f.state.deployed) throw { isType: (name: string) => name === 'CONTRACT_NOT_FOUND', baseError: { code: 20 } };
      return CLASS;
    };
    const backend = browserRecoverBackend({ apiUrl: 'https://api.test', classHash: CLASS, provider: f.provider, send: f.send, polling: { pollIntervalMs: 0 }, prove: async (_r, anchor) => proof(anchor) });
    expect(await backend.recover(request())).toEqual({ transaction_hash: '0xb' });
    expect(f.requests[0]!.path).toBe('/deploy/authenticated');
  });

  test('a mismatched account, facts or proof circuit is refused before relay', async () => {
    for (const mode of ['account', 'message', 'program', 'version', 'header'] as const) {
      const f = setup();
      const p = proof();
      if (mode === 'message') p.proofFacts[8] = '0x1';
      if (mode === 'program') p.proofFacts[2] = '0x1';
      if (mode === 'version') p.proofFacts[0] = shortString.encodeShortString('PROOF1');
      if (mode === 'header') p.proof = 'AAAA';
      const backend = browserRecoverBackend({ apiUrl: 'https://api.test', classHash: CLASS, provider: f.provider, send: f.send, prove: async () => p });
      await expect(backend.recover({ ...request(), ...(mode === 'account' ? { account: '0x1' } : {}) })).rejects.toThrow('prover:');
      expect(f.requests).toEqual([]);
    }
  });

  test('a lost relay response retries identical proof and capability without re-proving', async () => {
    const f = setup();
    let attempts = 0, proved = 0;
    const backend = browserRecoverBackend({ apiUrl: 'https://api.test', classHash: CLASS, provider: f.provider, polling: { pollIntervalMs: 0 }, prove: async () => { proved++; return proof(); }, send: async (url, init) => {
      if (url.endsWith('/relay') && ++attempts === 1) {
        // The attempt was accepted, but its HTTP response was lost.
        f.requests.push({ path: '/relay', body: JSON.parse(init.body) });
        throw Error('lost response');
      }
      return f.send(url, init);
    } });
    expect(await backend.recover(request())).toEqual({ transaction_hash: '0xb' });
    expect(proved).toBe(1);
    expect(attempts).toBe(2);
    expect(f.requests[0]!.body).toEqual(f.requests[1]!.body);
    expect(f.requests.every(r => r.path !== '/recover' && r.path !== '/deploy/authenticated')).toBe(true);
  });
});
