// Adding a device from one that is already signed in (src/link.ts, DEVICE_LINK.md), in real
// browsers against the fakes of tests/fakes.ts. The second device is another browser context of
// the same engine with memory64 turned off, standing in for a browser that cannot prove. This
// shows the flow needs no proof and no sign-in on the new device; it is not a run on a phone.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ACCOUNT, CHAIN_ID, CLASS_HASH, KEYCHAIN, installFakes, newWorld, selectorOf, type World } from './fakes';

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
}

/** A second browser on the same chain, which cannot make a login proof. */
async function browserThatCannotProve(browser: Browser, world: World): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await installFakes(context, world);
  await context.addInitScript(() => { WebAssembly.validate = () => false; });
  return { context, page: await context.newPage() };
}

/** The signed-in device opens "Add another device" and reads the link it offers. */
async function makeLink(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Add another device' }).click();
  await expect(page.getByRole('heading', { name: '1. Open this link on the new device' })).toBeVisible();
  return page.locator('#link-url').inputValue();
}

/** The new device opens the link, makes its key and reads the code it shows. */
async function makeCode(page: Page, link: string): Promise<string> {
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Add this device to an account' })).toBeVisible();
  await page.getByRole('button', { name: 'Create a key for this device' }).click();
  await expect(page.getByRole('heading', { name: 'Finish on your other device' })).toBeVisible();
  return page.locator('#link-answer').inputValue();
}

const checkCodeOn = async (page: Page) => (await page.getByText(/^Check code: /).textContent())!.replace('Check code: ', '');

async function vaultKeys(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('kamui-keychain');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<string[]>((resolve, reject) => {
        const request = db.transaction('vault').objectStore('vault').getAllKeys();
        request.onsuccess = () => resolve(request.result.map(String));
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  });
}

test('a signed-in device adds a browser that cannot prove, with no sign-in or proof there', async ({ page, context, browser }) => {
  const world = newWorld();
  await installFakes(context, world);
  await signIn(page);
  const link = await makeLink(page);
  expect(new URL(link).origin).toBe(KEYCHAIN);
  expect(new URL(link).search).toBe('');

  const other = await browserThatCannotProve(browser, world);
  const api: string[] = [];
  other.page.on('request', (request) => { if (request.url().includes('/api/')) api.push(new URL(request.url()).pathname); });
  await other.page.goto(link);
  await expect(other.page.getByRole('heading', { name: 'Add this device to an account' })).toBeVisible();
  // The link is taken out of the address bar as soon as it is read.
  expect(other.page.url()).toBe(`${KEYCHAIN}/`);
  await expect(other.page.getByText(ACCOUNT)).toBeVisible();
  await other.page.getByRole('button', { name: 'Create a key for this device' }).click();
  const code = await other.page.locator('#link-answer').inputValue();
  const check = await checkCodeOn(other.page);
  expect(check).toMatch(/^[0-9A-F]{3}-[0-9A-F]{3}$/);
  // Nothing has changed yet: the new key is only a request.
  expect(world.owners).toHaveLength(1);

  await page.locator('#link-code').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
  const box = page.getByRole('alertdialog');
  await expect(box).toContainText(`check code ${check}`);
  await expect(box).toContainText('full control');
  await box.getByRole('button', { name: 'Yes, add this device' }).click();
  await expect(page.getByRole('heading', { name: 'Devices (2 of 5)' })).toBeVisible();

  // One add_owner from the signed-in device, through the wallet's own sponsorship.
  expect(world.sponsorRequests).toHaveLength(1);
  expect(world.sponsorRequests[0]!.endpoint).toBe('/api/wallet/sponsor');
  expect(world.sponsorRequests[0]!.calls).toHaveLength(1);
  const [call] = world.sponsorRequests[0]!.calls;
  expect(BigInt(call!.to)).toBe(BigInt(ACCOUNT));
  expect(call!.selector).toBe(selectorOf('add_owner'));
  expect(world.owners).toHaveLength(2);
  expect(BigInt(call!.data[0]!)).toBe(BigInt(world.owners[1]!));

  // The new device finds itself on the account by itself, and is signed in.
  await expect(other.page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  await expect(other.page.getByRole('heading', { name: 'Devices (2 of 5)' })).toBeVisible();
  // It never saw a sign-in, so it has no recovery file to offer.
  await expect(other.page.getByText(/holds no recovery file/)).toBeVisible();
  await expect(other.page.getByRole('button', { name: 'Download recovery file' })).toHaveCount(0);
  // No sign-in, no pepper lookup, no proof and no relay came from the new device.
  expect(world.issuerVisits).toBe(1);
  expect(world.pepperRequests).toHaveLength(1);
  expect(world.recoverRequests).toHaveLength(1);
  expect(api.filter((path) => !path.startsWith('/api/registry/'))).toEqual([]);

  // It is remembered like any other device, and can act as an owner.
  await other.page.reload();
  await expect(other.page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  expect((await vaultKeys(other.page)).sort()).toEqual(['account', 'device', 'wrapping-key']);
  await other.page.getByRole('button', { name: 'Revoke all sessions' }).click();
  await other.page.getByRole('alertdialog').getByRole('button', { name: /^Yes/ }).click();
  await expect.poll(() => world.sponsorRequests.length).toBe(2);
  expect(world.sponsorRequests[1]!.calls[0]!.selector).toBe(selectorOf('revoke_all_sessions'));
  await other.context.close();
});

test('declining the confirmation adds nothing and leaves the page usable', async ({ page, context, browser }) => {
  const world = newWorld();
  await installFakes(context, world);
  await signIn(page);
  const other = await browserThatCannotProve(browser, world);
  const code = await makeCode(other.page, await makeLink(page));

  await page.locator('#link-code').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
  expect(world.sponsorRequests).toHaveLength(0);
  expect(world.owners).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  await other.page.getByRole('button', { name: 'Check now' }).click();
  await expect(other.page.locator('#status')).toHaveText('Not added yet.');
  await other.context.close();
});

test('a code that does not answer this device\'s link is refused before anything is sent', async ({ page, context, browser }) => {
  const world = newWorld();
  await installFakes(context, world);
  await signIn(page);
  const link = await makeLink(page);
  // Someone who knows the account address, but was never given the link, makes a code.
  const forged = new URL(link);
  const fields = new URLSearchParams(forged.hash.slice(1));
  fields.set('id', '0x1234');
  forged.hash = fields.toString();
  const other = await browserThatCannotProve(browser, world);
  const code = await makeCode(other.page, forged.href);

  await page.locator('#link-code').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/does not answer the link above/)).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);

  // Not a code at all, and a code whose signature was changed.
  await page.locator('#link-code').fill('hello');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/This is not a code from a new device/)).toBeVisible();
  const real = await makeCode(other.page, link);
  await page.locator('#link-code').fill(real.replace(/\.[0-9a-f]+$/, '.1'));
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/damaged or was not made for your account/)).toBeVisible();

  expect(world.sponsorRequests).toHaveLength(0);
  expect(world.owners).toHaveLength(1);
  await other.context.close();
});

test('a code made before the account\'s devices changed is refused, and the new device says so', async ({ page, context, browser }) => {
  const world = newWorld();
  await installFakes(context, world);
  await signIn(page);
  const other = await browserThatCannotProve(browser, world);
  const code = await makeCode(other.page, await makeLink(page));
  // Another change of the owner set lands first.
  world.owners.unshift('0x123');
  world.anchor += 1n;

  await page.locator('#link-code').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/devices changed after this code was made/)).toBeVisible();
  expect(world.sponsorRequests).toHaveLength(0);
  await expect(other.page.getByRole('heading', { name: 'This device was not added' })).toBeVisible();
  expect(await vaultKeys(other.page)).not.toContain('pending-link');
  await other.context.close();
});

test('the new device keeps its code across a reload, and cancelling discards the key', async ({ page, context, browser }) => {
  const world = newWorld();
  await installFakes(context, world);
  await signIn(page);
  const other = await browserThatCannotProve(browser, world);
  const code = await makeCode(other.page, await makeLink(page));
  // The waiting key is sealed in the vault, and nothing about it is in web storage.
  expect(await vaultKeys(other.page)).toContain('pending-link');
  expect(await other.page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]))).toBe('[{},{}]');

  await other.page.reload();
  await expect(other.page.getByRole('heading', { name: 'Finish on your other device' })).toBeVisible();
  expect(await other.page.locator('#link-answer').inputValue()).toBe(code);

  await other.page.getByRole('button', { name: 'Cancel' }).click();
  await expect(other.page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(await vaultKeys(other.page)).not.toContain('pending-link');
  expect(world.owners).toHaveLength(1);
  await other.context.close();
});

test('a link for another network, class or account, or one that has run out, is refused', async ({ page, context }) => {
  const world = newWorld();
  await installFakes(context, world);
  world.deployed = true;
  const link = (change: Record<string, string>) => {
    const fields = new URLSearchParams({ v: '1', account: ACCOUNT, chain: CHAIN_ID, class: CLASS_HASH, id: '0xabc', exp: String(Math.floor(Date.now() / 1000) + 600), ...change });
    return `${KEYCHAIN}/link#${fields}`;
  };
  for (const [change, message] of [
    [{ chain: '0x534e5f4d41494e' }, /for another network/],
    [{ class: '0x1' }, /another version of the Kamui account/],
    [{ account: '0x999' }, /does not exist on this network/],
    [{ exp: '1000' }, /has run out/],
    [{ v: '9' }, /not a Kamui device link/],
    [{ account: '<img src=x onerror=alert(1)>' }, /not a Kamui device link/],
  ] as const) {
    // A fragment-only change does not load the page again, so leave it first.
    await page.goto('about:blank');
    await page.goto(link(change));
    await expect(page.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
    await expect(page.getByText(message)).toBeVisible();
    expect(page.url()).toBe(`${KEYCHAIN}/`);
    await expect(page.getByRole('button', { name: 'Create a key for this device' })).toHaveCount(0);
  }
});

test('an account that is full says so instead of offering a link', async ({ page, context }) => {
  const world = newWorld();
  await installFakes(context, world);
  await signIn(page);
  world.owners.push('0x11', '0x12', '0x13', '0x14');
  await page.goto('/');
  await page.getByRole('button', { name: 'Add another device' }).click();
  await expect(page.getByText(/already has 5 devices/)).toBeVisible();
  await expect(page.locator('#link-url')).toHaveCount(0);
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Devices (5 of 5)' })).toBeVisible();
});

test('a browser signed in to the same account is sent home by a link, and makes no second key', async ({ page, context }) => {
  const world = newWorld();
  await installFakes(context, world);
  await signIn(page);
  const link = await makeLink(page);
  await page.goto('about:blank');
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  expect(await vaultKeys(page)).not.toContain('pending-link');
  expect(world.owners).toHaveLength(1);
});
