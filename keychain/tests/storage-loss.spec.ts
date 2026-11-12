// Explicit deletion models the consequence of storage loss. It does NOT exercise Safari ITP
// or its seven-Safari-use-day clock. The contract, issuers and services below are fakes.
import { expect, test, type Page } from '@playwright/test';
import { ACCOUNT, installFakes, newWorld } from './fakes';

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
}

async function deleteFixtureStorage(page: Page) {
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('kamui-keychain');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Fixture database still open'));
    });
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

test('full browser storage loss keeps on-chain owners and sessions until a new sign-in adds a key', async ({ page, context }) => {
  const world = newWorld();
  await installFakes(context, world);
  await signIn(page);
  const oldOwner = world.owners[0]!;
  const epochBefore = world.epoch;
  // Seed a live session on the fake chain. Deleting browser storage must not revoke it.
  world.sessions.set('0x111', { validUntil: BigInt(Math.floor(Date.now() / 1000) + 3600), maxCalls: 10n, maxFee: 0n, scope: [], policies: new Map() });
  await expect(page.getByText('Keep this file outside the browser.', { exact: false })).toBeVisible();
  await deleteFixtureStorage(page);
  await expect(page.getByText('Browser storage can disappear.', { exact: false })).toBeVisible();
  expect(world.owners).toEqual([oldOwner]);
  expect(world.epoch).toBe(epochBefore);
  expect(world.sessions.size).toBe(1);
  expect(world.recoverRequests).toHaveLength(1);
  expect(world.sponsorRequests).toHaveLength(0);

  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  await expect(page.getByText(ACCOUNT, { exact: true })).toBeVisible();
  expect(world.recoverRequests).toHaveLength(2);
  expect(world.owners).toHaveLength(2);
  expect(world.owners[0]).toBe(oldOwner);
  expect(world.owners[1]).not.toBe(oldOwner);
  expect(world.epoch).toBe(epochBefore + 1);
  expect(world.sessions.size).toBe(0);
});

test('an exported recovery file survives the modeled purge and avoids a failed pepper service', async ({ page, context }) => {
  const world = newWorld();
  await installFakes(context, world);
  await signIn(page);
  const oldOwner = world.owners[0]!;
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download recovery file' }).click();
  const file = await (await downloaded).path();
  expect(file).toBeTruthy();
  const lookupsBefore = world.pepperRequests.length;
  await deleteFixtureStorage(page);
  world.pepperDown = true;
  await page.getByLabel('Recovery file (optional)').setInputFiles(file!);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  await expect(page.getByText(ACCOUNT, { exact: true })).toBeVisible();
  expect(world.pepperRequests).toHaveLength(lookupsBefore);
  expect(world.owners).toHaveLength(2);
  expect(world.owners[0]).toBe(oldOwner);
  expect(world.owners[1]).not.toBe(oldOwner);
});
