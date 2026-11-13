import { afterEach, expect, test } from 'bun:test';
import { makeProvider } from './env';

const PRIMARY = 'https://primary.invalid/rpc';
const FALLBACK = 'https://fallback.invalid/rpc';
const original = { fetch: globalThis.fetch, rpc: process.env.RPC_URL, fallback: process.env.RPC_FALLBACK_URL };

afterEach(() => {
  globalThis.fetch = original.fetch;
  process.env.RPC_URL = original.rpc;
  if (original.fallback === undefined) delete process.env.RPC_FALLBACK_URL;
  else process.env.RPC_FALLBACK_URL = original.fallback;
});

function node(responses: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    return responses[url]!();
  }) as typeof fetch;
  return calls;
}

const chain = () => Response.json({ jsonrpc: '2.0', id: 1, result: '0x534e5f5345504f4c4941' });

test('uses only the primary node when it answers', async () => {
  process.env.RPC_URL = PRIMARY; process.env.RPC_FALLBACK_URL = FALLBACK;
  const calls = node({ [PRIMARY]: chain });
  expect(await makeProvider().getChainId()).toBe('0x534e5f5345504f4c4941');
  expect(calls).toEqual([PRIMARY]);
});

test('falls back once on rate limiting, server errors and unreachable nodes', async () => {
  process.env.RPC_URL = PRIMARY; process.env.RPC_FALLBACK_URL = FALLBACK;
  for (const failure of [
    () => new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"limit"}}', { status: 429 }),
    () => new Response('bad gateway', { status: 502 }),
    () => Promise.reject(new TypeError('unreachable')),
  ]) {
    const calls = node({ [PRIMARY]: failure, [FALLBACK]: chain });
    expect(await makeProvider().getChainId()).toBe('0x534e5f5345504f4c4941');
    expect(calls).toEqual([PRIMARY, FALLBACK]);
  }
});

test('does not retry JSON-RPC errors or fall back without a configured fallback', async () => {
  process.env.RPC_URL = PRIMARY; process.env.RPC_FALLBACK_URL = FALLBACK;
  let calls = node({ [PRIMARY]: () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: 20, message: 'Contract not found' } }) });
  await expect(makeProvider().getClassHashAt('0x1')).rejects.toThrow();
  expect(calls).toEqual([PRIMARY]);

  delete process.env.RPC_FALLBACK_URL;
  calls = node({ [PRIMARY]: () => new Response('limit', { status: 429 }) });
  await expect(makeProvider().getChainId()).rejects.toThrow();
  expect(calls).toEqual([PRIMARY]);
});
