// Kamui: the limiter, the client address, logs, metrics and the proof queue.
import { describe, expect, test } from 'bun:test';
import { resolveChain } from './env';
import { HttpError } from './http';
import { MemoryLimiter } from './limiter';
import { errorCode, log, setLogSink } from './log';
import { metrics, renderMetrics, resetMetrics } from './metrics';
import { clientAddress, fetchWithTimeout } from './net';
import { EnvSecretSource, secretSource } from './secrets';
import { ProofQueue } from './services/prover/queue';

describe('limiter', () => {
  test('allows up to the limit in a window, then again once the window has passed', async () => {
    let now = 0;
    const limiter = new MemoryLimiter(() => now);
    expect(await limiter.take('a', 2, 1000)).toBe(true);
    expect(await limiter.take('a', 2, 1000)).toBe(true);
    expect(await limiter.take('a', 2, 1000)).toBe(false);
    expect(await limiter.take('b', 2, 1000)).toBe(true);
    now = 1000;
    expect(await limiter.take('a', 2, 1000)).toBe(true);
  });

  test('a refused hit is not recorded, and memory is bounded', async () => {
    let now = 0;
    const limiter = new MemoryLimiter(() => now, 10);
    for (let i = 0; i < 50; i++) await limiter.take('a', 1, 1000);
    now = 1000;
    expect(await limiter.take('a', 1, 1000)).toBe(true);
    for (let i = 0; i < 100; i++) await limiter.take(`key-${i}`, 1, 1000);
    expect(limiter.size).toBeLessThanOrEqual(10);
  });
});

describe('client address', () => {
  test('is the socket peer unless proxies are trusted', () => {
    expect(clientAddress('10.0.0.1', '6.6.6.6', 0)).toBe('10.0.0.1');
    expect(clientAddress(undefined, null, 0)).toBe('unknown');
  });

  test('behind N trusted proxies it is the Nth entry from the right, never one the client wrote', () => {
    // The client sent "1.1.1.1"; our proxy appended the address it saw.
    expect(clientAddress('10.0.0.1', '1.1.1.1, 203.0.113.9', 1)).toBe('203.0.113.9');
    expect(clientAddress('10.0.0.1', '1.1.1.1, 203.0.113.9, 10.0.0.2', 2)).toBe('203.0.113.9');
    expect(clientAddress('10.0.0.1', '203.0.113.9', 2)).toBe('10.0.0.1');
    expect(clientAddress('10.0.0.1', null, 1)).toBe('10.0.0.1');
  });
});

describe('outbound calls', () => {
  test('a call that never answers fails at the deadline, even if it ignores the abort signal', async () => {
    const started = Date.now();
    await expect(fetchWithTimeout('http://x.test', {}, 30, () => new Promise(() => {}))).rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('logs', () => {
  test('one JSON object per line; fields that look secret are replaced', () => {
    const lines: string[] = [];
    const previous = setLogSink((line) => lines.push(line));
    log('info', 'something', { account: '0x1', jwt: 'aaa.bbb.ccc', pepper: '0x2', signature: '0x3', origin: 'https://a.example', tx: '0xabc' });
    setLogSink(previous);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ level: 'info', event: 'something', account: '0x1', tx: '0xabc', jwt: '[redacted]', pepper: '[redacted]', signature: '[redacted]', origin: '[redacted]' });
    expect(lines[0]).not.toContain('aaa.bbb.ccc');
  });

  test('an error contributes its code or its class, never its text', () => {
    expect(errorCode(new HttpError(400, 'WRONG_CLASS'))).toBe('WRONG_CLASS');
    expect(errorCode(new HttpError(400, 'REVERTED: Kamui: something about 0x1234'))).toBe('REVERTED');
    expect(errorCode(new SyntaxError('JSON Parse error: Unexpected identifier "eyJhbGci"'))).toBe('SyntaxError');
  });
});

describe('metrics', () => {
  test('render as Prometheus text', () => {
    resetMetrics();
    metrics.requests.inc({ route: '/recover', outcome: 'ok' });
    metrics.requests.inc({ route: '/recover', outcome: 'ok' });
    metrics.proofSeconds.observe(42);
    const text = renderMetrics();
    expect(text).toContain('# TYPE kamui_http_requests_total counter');
    expect(text).toContain('kamui_http_requests_total{route="/recover",outcome="ok"} 2');
    expect(text).toContain('kamui_proof_duration_seconds_bucket{le="60"} 1');
    expect(text).toContain('kamui_proof_duration_seconds_bucket{le="30"} 0');
    expect(text).toContain('kamui_proof_duration_seconds_count 1');
    resetMetrics();
  });
});

describe('chain', () => {
  test('with CHAIN_ID the service starts without the node, and a node on another chain is caught', async () => {
    let calls = 0;
    const down = { getChainId: async () => { calls++; if (calls < 3) throw new Error('down'); return '0x534e5f5345504f4c4941'; } };
    const sepolia = await resolveChain(down as any, 'SN_SEPOLIA', 1);
    expect(sepolia.chain).toBe('SN_SEPOLIA');
    expect(BigInt(sepolia.chainId)).toBe(0x534e5f5345504f4c4941n);
    await sepolia.confirmed;
    expect(calls).toBe(3);
    const wrong = await resolveChain({ getChainId: async () => '0x534e5f4d41494e' } as any, 'SN_SEPOLIA', 1);
    await expect(wrong.confirmed).rejects.toThrow('SN_MAIN');
    expect((await resolveChain({ getChainId: async () => '0x534e5f4d41494e' } as any, '')).chain).toBe('SN_MAIN');
  });
});

describe('secret source', () => {
  test('reads from the environment and refuses a missing secret or an unknown source', async () => {
    const source = new EnvSecretSource({ A: 'value' });
    expect(await source.get('A')).toBe('value');
    await expect(source.get('B')).rejects.toThrow('B is not set');
    expect(() => secretSource('vault')).toThrow('not implemented');
  });
});

describe('proof queue', () => {
  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => (open = resolve));
    return { promise, open };
  };
  const status = (p: Promise<unknown>) => p.then(() => 'done', (e: HttpError) => `${e.status} ${e.message}`);

  test('runs one proof at a time, in order, and refuses when the queue is full', async () => {
    const queue = new ProofQueue({ concurrency: 1, maxQueued: 1 });
    const first = gate();
    const order: string[] = [];
    let running = 0;
    let peak = 0;
    const work = (name: string, wait?: Promise<void>) => async () => {
      peak = Math.max(peak, ++running);
      await wait;
      order.push(name);
      running--;
    };
    const a = queue.run(work('a', first.promise));
    const b = queue.run(work('b'));
    expect(queue.full).toBe(true);
    expect(await status(queue.run(work('c')))).toBe('503 PROVER_BUSY');
    first.open();
    await Promise.all([a, b]);
    expect(order).toEqual(['a', 'b']);
    expect(peak).toBe(1);
    expect(queue.full).toBe(false);
    expect(queue.depth).toEqual({ running: 0, waiting: 0 });
  });

  test('a request that waits too long is refused and leaves the queue', async () => {
    const queue = new ProofQueue({ concurrency: 1, maxQueued: 2, maxWaitMs: 20 });
    const first = gate();
    const a = queue.run(() => first.promise);
    expect(await status(queue.run(async () => {}))).toBe('503 PROVER_BUSY');
    expect(queue.depth).toEqual({ running: 1, waiting: 0 });
    first.open();
    await a;
    expect(await status(queue.run(async () => {}))).toBe('done');
  });

  test('a failed proof frees its slot', async () => {
    const queue = new ProofQueue({ concurrency: 1, maxQueued: 0 });
    await expect(queue.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await status(queue.run(async () => {}))).toBe('done');
  });
});
