import { test, expect } from '@playwright/test';
import { installFakes, newWorld, KEYCHAIN } from './fakes';

test('unsupported proving fails before deployment or relay without server fallback', async ({ page, context }) => {
  const world = newWorld();
  await installFakes(context, world);
  await context.addInitScript(() => { WebAssembly.validate = () => false; });
  const sends: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/')) sends.push(r.url()); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByText(/Recovery proving requires/)).toBeVisible();
  expect(world.deployed).toBe(false);
  expect(world.recoverRequests).toHaveLength(0);
  expect(sends).toEqual([]);
});

test('cancelling a running prover never submits a proof or starts server proving', async ({ page, context }) => {
  const world = newWorld();
  await installFakes(context, world);
  await context.route(`${KEYCHAIN}/prover/v1.0.1/public-run-controller.mjs`, route => route.fulfill({ contentType: 'text/javascript', body: `export class PublicRunController { constructor(h){this.h=h} start(){this.h.onStatus({kind:'phase',phase:'recursive proving'})} cancel(){} }` }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.locator('#status')).toHaveText(/Proving in this browser/);
  await page.getByRole('button', { name: 'Cancel proving' }).click();
  await expect(page.getByText(/proving cancelled/i)).toBeVisible();
  expect(world.recoverRequests).toHaveLength(0);
});

test('private worker errors are sanitized and cannot reach a relay', async ({ page, context }) => {
  const world = newWorld();
  await installFakes(context, world);
  await context.route(`${KEYCHAIN}/prover/v1.0.1/public-run-controller.mjs`, route => route.fulfill({ contentType: 'text/javascript', body: `export class PublicRunController { constructor(h){this.h=h} start(){this.h.onStatus({kind:'error',error:'private-witness-marker JWT pepper calldata'})} cancel(){} }` }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByText(/Browser proving failed/)).toBeVisible();
  await expect(page.locator('body')).not.toContainText('private-witness-marker');
  expect(world.recoverRequests).toHaveLength(0);
});

test('only pinned public prover files are served with Wasm MIME and immutable caching', async ({ request }) => {
  const profile = await request.get('/prover/v1.0.1/prover-profile.mjs');
  expect(profile.ok()).toBe(true);
  expect(profile.headers()['cache-control']).toContain('immutable');
  expect(await profile.text()).toContain('0x50524f4f4632');
  expect((await request.get('/prover/v1.0.1/manifest.json')).status()).toBe(404);
  expect((await request.get('/prover/v1.0.1/not-present.wasm')).status()).toBe(404);
  const wasm = await request.get('/prover/v1.0.1/auth/browser_virtual_os_bg.wasm');
  expect(wasm.headers()['content-type']).toBe('application/wasm');
  expect((await wasm.body()).length).toBe(36330443);
});

test('cancellation also interrupts preparation RPC before any Worker or relay', async ({ page, context }) => {
  const world = newWorld();
  await installFakes(context, world);
  await context.route('https://sepolia.nodes.starknet.org/rpc/v0_10', async route => {
    // Hold the acquisition request; AbortSignal must break the client's await independently.
    await new Promise<void>(resolve => page.once('close', () => resolve()));
    await route.abort().catch(() => {});
  });
  await page.goto('/');
  const preparing = page.waitForRequest('https://sepolia.nodes.starknet.org/rpc/v0_10');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await preparing;
  await page.getByRole('button', { name: 'Cancel proving' }).click();
  await expect(page.getByText(/Browser proving cancelled/)).toBeVisible();
  expect(world.recoverRequests).toHaveLength(0);
});

test('the deadline bounds hung preparation rather than only running Workers', async ({ page, context }) => {
  const world = newWorld();
  await installFakes(context, world);
  await page.clock.install();
  await context.route('https://sepolia.nodes.starknet.org/rpc/v0_10', async route => {
    await new Promise<void>(resolve => page.once('close', () => resolve()));
    await route.abort().catch(() => {});
  });
  await page.goto('/');
  const preparing = page.waitForRequest('https://sepolia.nodes.starknet.org/rpc/v0_10');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await preparing;
  await page.clock.fastForward(20 * 60_000 + 1);
  await expect(page.getByText(/Browser proving timed out/)).toBeVisible();
  expect(world.recoverRequests).toHaveLength(0);
});

test('missing verified assets fail before paying for a deployment', async ({ page, context }) => {
  const world = newWorld();
  await installFakes(context, world);
  await context.route(`${KEYCHAIN}/config.json`, async route => {
    const response = await route.fetch();
    return route.fulfill({ response, json: { ...await response.json(), proverReady: false } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByText(/Browser prover assets are unavailable/)).toBeVisible();
  expect(world.deployed).toBe(false);
  expect(world.recoverRequests).toHaveLength(0);
});
