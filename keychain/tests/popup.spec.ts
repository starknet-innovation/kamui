// Popup mode (sdk/src/popup.ts) in a real browser: an app page that runs the SDK opens the
// keychain in a popup, and gets its answer without being reloaded. The app page is
// tests/popup-app.ts, bundled here; everything outside the keychain is faked as in the other
// tests (tests/fakes.ts).
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNT, KEYCHAIN, installFakes, newWorld, type World } from './fakes';

const APP = 'http://localhost:5199';
const GAME = '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc';

let bundle = '';
test.beforeAll(() => {
  const out = mkdtempSync(join(tmpdir(), 'kamui-popup-app-'));
  try {
    execFileSync(process.env.BUN ?? 'bun', ['build', fileURLToPath(new URL('./popup-app.ts', import.meta.url)), '--target=browser', '--outfile', join(out, 'app.js')], { stdio: 'pipe' });
    bundle = readFileSync(join(out, 'app.js'), 'utf8');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

/**
 * The fakes, and an app whose every page runs the SDK. Signs in at the keychain first unless told
 * not to. `page` ends on the app, marked so that a reload would show.
 */
async function setup(context: BrowserContext, page: Page, { signedIn = true } = {}): Promise<World> {
  const world = newWorld();
  await installFakes(context, world);
  if (signedIn) {
    await page.goto(`${KEYCHAIN}/`);
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  }
  await context.route(`${APP}/**`, (route) =>
    new URL(route.request().url()).pathname === '/app.js'
      ? route.fulfill({ status: 200, contentType: 'text/javascript', body: bundle })
      : route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>app</title><p>app</p><script type="module" src="/app.js"></script>' }),
  );
  await page.goto(`${APP}/`);
  await page.waitForFunction(() => 'kamui' in window);
  await page.evaluate(() => {
    (window as any).neverReloaded = true;
    // Keeps the handle the SDK gets, to see what the app's page can tell about the popup.
    const open = window.open.bind(window);
    window.open = (...args) => ((window as any).handle = open(...args));
  });
  return world;
}

/** The app starts a popup request and keeps the outcome in `window.outcome`. Returns the popup. */
async function start(page: Page, call: 'connect' | 'execute', popupOptions: Record<string, unknown> = {}): Promise<Page> {
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.evaluate(
      ({ call, keychainUrl, redirectUri, game, popupOptions }) => {
        const kamui = (window as any).kamui;
        const request =
          call === 'connect'
            ? kamui.connectWithPopup(
                { keychainUrl, redirectUri, appName: 'Example Game', validUntil: Math.floor(Date.now() / 1000) + 3600, maxCalls: 20, calls: [{ to: game, entrypoint: 'move' }] },
                sessionStorage,
                popupOptions,
              )
            : kamui.executeWithPopup({ keychainUrl, redirectUri, appName: 'Example Game', calls: [{ contractAddress: game, entrypoint: 'move', calldata: ['0x1'] }] }, sessionStorage, popupOptions);
        request.then(
          (value: unknown) => ((window as any).outcome = { ok: true, value }),
          (error: Error & { code?: string }) => ((window as any).outcome = { ok: false, message: error.message, code: error.code }),
        );
      },
      { call, keychainUrl: KEYCHAIN, redirectUri: `${APP}/`, game: GAME, popupOptions },
    ),
  ]);
  return popup;
}

async function outcome(page: Page) {
  // Polled on a timer: the app's page is behind the popup, where animation frames may not run.
  await page.waitForFunction(() => 'outcome' in window, null, { polling: 50 });
  return page.evaluate(() => (window as any).outcome);
}

test.describe('popup mode', () => {
  test('a signed-in user connects in a popup and the app page is never reloaded', async ({ page, context }) => {
    const world = await setup(context, page);
    const popup = await start(page, 'connect');

    await expect(popup.getByRole('heading', { name: 'Connection request' })).toBeVisible();
    // The keychain names the app by the origin of the page that opened the popup.
    await expect(popup.locator('.origin')).toHaveText(APP);
    const closed = popup.waitForEvent('close');
    await popup.getByRole('button', { name: 'Approve' }).click();

    const result = await outcome(page);
    expect(result.ok).toBe(true);
    expect(result.value.account).toBe(ACCOUNT);
    await closed;
    expect(world.sponsorRequests).toHaveLength(1);
    // Same document as before, and the connection is saved where a redirect would have saved it.
    expect(await page.evaluate(() => (window as any).neverReloaded)).toBe(true);
    expect(page.url()).toBe(`${APP}/`);
    const stored = await page.evaluate(() => ({ connection: sessionStorage.getItem('kamui.connection'), pending: sessionStorage.getItem('kamui.pending') }));
    expect(JSON.parse(stored.connection!).account).toBe(ACCOUNT);
    expect(stored.pending).toBeNull();
  });

  test('the answer still arrives after a sign-in at an issuer that cuts the popup off from its opener', async ({ page, context }) => {
    const world = await setup(context, page, { signedIn: false });
    // The issuer's page has Cross-Origin-Opener-Policy, which severs `window.opener` for good.
    world.issuerIsolatesOpener = true;
    const popup = await start(page, 'connect', { pollMs: 50, closedGraceMs: 200 });

    await expect(popup.getByText(`${APP} wants to connect. Sign in first.`)).toBeVisible();
    await popup.getByRole('button', { name: 'Continue with Google' }).click();
    await expect(popup.getByRole('heading', { name: 'Connection request' })).toBeVisible();
    expect(world.issuerVisits).toBe(1);

    // The link is gone on both sides: the popup has no opener, and the app's handle on it says
    // "closed" although the window is right there. The app is still waiting all the same.
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    expect(await page.evaluate(() => (window as any).handle.closed)).toBe(true);
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => 'outcome' in window)).toBe(false);

    await popup.getByRole('button', { name: 'Approve' }).click();
    const result = await outcome(page);
    expect(result.ok).toBe(true);
    expect(result.value.account).toBe(ACCOUNT);
    expect(await page.evaluate(() => (window as any).neverReloaded)).toBe(true);
    // The app can no longer close the popup; the relay page closes itself.
    await expect.poll(() => popup.isClosed()).toBe(true);
  });

  test('a refusal in the popup rejects with the keychain\'s reason', async ({ page, context }) => {
    await setup(context, page);
    const popup = await start(page, 'connect');
    await expect(popup.getByRole('button', { name: 'Deny' })).toBeVisible();
    // The answer is immediate and the popup closes itself: the click may not get to report back.
    await popup.getByRole('button', { name: 'Deny' }).click().catch(() => {});
    const result = await outcome(page);
    expect(result.ok).toBe(false);
    expect(result.message).toBe('keychain: denied by the user');
    expect(result.code).toBeUndefined();
    expect(await page.evaluate(() => sessionStorage.getItem('kamui.connection'))).toBeNull();
  });

  test('closing the popup rejects with `closed`', async ({ page, context }) => {
    await setup(context, page);
    const popup = await start(page, 'connect', { pollMs: 50, closedGraceMs: 200 });
    await expect(popup.getByRole('heading', { name: 'Connection request' })).toBeVisible();
    await popup.close();
    expect(await outcome(page)).toMatchObject({ ok: false, code: 'closed' });
    expect(await page.evaluate(() => (window as any).neverReloaded)).toBe(true);
  });

  test('one transaction is approved in a popup', async ({ page, context }) => {
    const world = await setup(context, page);
    const popup = await start(page, 'execute');
    await expect(popup.locator('.origin')).toHaveText(APP);
    await popup.getByRole('button', { name: 'Approve' }).click();
    const result = await outcome(page);
    expect(result.ok).toBe(true);
    // The signed transaction, for the app to send through its own sponsor route. The keychain sent nothing.
    expect(BigInt(result.value.account)).toBe(BigInt(ACCOUNT));
    expect(result.value.call.contractAddress).toBe(result.value.account);
    expect(result.value.call.entrypoint).toBe('execute_from_outside_v2');
    expect(result.value.call.calldata.length).toBeGreaterThan(5);
    expect(world.sponsorRequests).toHaveLength(0);
    expect(await page.evaluate(() => (window as any).neverReloaded)).toBe(true);
  });

  test('a blocked popup falls back to the redirect', async ({ page, context }) => {
    await setup(context, page);
    await page.evaluate(
      ({ keychainUrl, redirectUri, game }) => {
        window.open = () => null;
        void (window as any).kamui.connectWithPopup(
          { keychainUrl, redirectUri, validUntil: Math.floor(Date.now() / 1000) + 3600, maxCalls: 20, calls: [{ to: game, entrypoint: 'move' }] },
          sessionStorage,
        );
      },
      { keychainUrl: KEYCHAIN, redirectUri: `${APP}/`, game: GAME },
    );
    await page.waitForURL(`${KEYCHAIN}/connect`);
    await page.getByRole('button', { name: 'Approve' }).click();
    // Back on the app's plain address with the answer, for `finishConnect`: an ordinary redirect.
    await page.waitForURL(`${APP}/#kamui=*`);
    expect(await page.evaluate(() => sessionStorage.getItem('kamui.pending'))).not.toBeNull();
  });

  test('another site cannot have an answer relayed into the app', async ({ page, context }) => {
    await setup(context, page);
    const popup = await start(page, 'connect', { timeoutMs: 1500 });
    await expect(popup.getByRole('heading', { name: 'Connection request' })).toBeVisible();
    // A page anyone can link to: the app's relay address with a made-up answer. The app's page
    // relays it, and the page that is waiting ignores it, because it names no pending request.
    const forged = btoa(JSON.stringify({ v: 1, id: '0xbad', ok: true, account: '0x1', chainId: '0x1', classHash: '0x1' })).replace(/=+$/, '');
    const other = await context.newPage();
    await other.goto(`${APP}/?kamui_popup=1#kamui=${forged}`);
    expect(await outcome(page)).toMatchObject({ ok: false, code: 'timeout' });
  });
});
