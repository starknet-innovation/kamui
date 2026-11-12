// Opt-in real Worker/Wasm proof. Uses a PUBLIC upstream balance capture, never a JWT/key.
// SNIP36_SOURCE=/path/to/pinned/upstream BUN=... playwright test --project=chrome prover-runtime.spec.ts
import { test, expect } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { V2_HEADER, V2_SEPOLIA_CONFIG } from '../../sdk/src/client-proving';

test('pinned runtime executes and proves a public capture in real Workers under keychain CSP', async ({ page }, info) => {
  test.skip(info.project.name !== 'chrome' || !process.env.SNIP36_SOURCE, 'Requires desktop Chrome and the public upstream capture.');
  test.setTimeout(240_000);
  const fixture = await readFile(`${process.env.SNIP36_SOURCE}/web/demo-data/sample.json`, 'utf8');
  await page.route('**/public-runtime-fixture.json', route => route.fulfill({ contentType: 'application/json', body: fixture }));
  page.on('console', m => { if (m.type() === 'error') console.log('Runtime console:', m.text().slice(0,160)); });
  page.on('crash', () => console.log('Runtime renderer crashed'));
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const fixture = await (await fetch('/public-runtime-fixture.json')).json();
    const base = new URL('/prover/v1.0.1/', location.origin);
    const { PublicRunController } = await import(new URL('public-run-controller.mjs', base).href);
    return await new Promise<any>((resolve, reject) => {
      const controller = new PublicRunController({
        workerFactory: (url: string) => new Worker(new URL(url, base), { type: 'module' }),
        save: async () => {},
        onStatus: (s: any) => {
          if (s.kind === 'phase') console.log('Runtime phase:', s.phase);
          if (s.kind === 'error' || s.kind === 'panic') reject(new Error('Public fixture Worker failed: ' + String(s.error ?? s.message).slice(0,300)));
        },
        onComplete: (r: any) => resolve({ proofHeader: r.proof.slice(0,35).map((v: number) => v.toString(16).padStart(2,'0')).join(''), proofBytes: r.proof.length, outputPreimage: r.output_preimage, report: r.report, execution: r.execution_report }),
      });
      controller.start(fixture.request, fixture.source, {build:'standard', expectedWasm: {bytes:76749727, sha256:'febb42b85947772b129eec17ba58aec50dae1988a7af5ef0fd6b61812358bde7'}});
    });
  });
  const measurements = info.outputPath('public-proof-measurements.json');
  await mkdir(dirname(measurements), {recursive:true});
  await writeFile(measurements, JSON.stringify(result, null, 2));
  await info.attach('public-proof-measurements', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  expect(result.proofHeader).toBe(V2_HEADER);
  expect(result.outputPreimage[6]).toBe(V2_SEPOLIA_CONFIG);
  expect(result.proofBytes).toBeGreaterThan(35);
  expect(result.proofBytes).toBeLessThanOrEqual(480_000);
  expect(result.report.wasm_sha256).toBe('febb42b85947772b129eec17ba58aec50dae1988a7af5ef0fd6b61812358bde7');
});
