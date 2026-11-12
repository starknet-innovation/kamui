// The keychain's pages and key storage, in a real browser, against fakes of everything outside
// the keychain (tests/fakes.ts).
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { beginConnect, beginExecute, finishConnect, finishExecute, parsePepperFile, pepperFileMatchesLogin, type ConnectOptions, type KeyValueStore } from '../../sdk/src';
import { ACCOUNT, CHAIN_ID, CLAIMS, CLASS_HASH, KEYCHAIN, PEPPER, installApp, installFakes, newWorld, selectorOf, type World } from './fakes';

const APP = 'http://localhost:5199';
const OTHER_SITE = 'http://localhost:5198';
const GAME = '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc';
const TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

async function setup(context: BrowserContext): Promise<World> {
  const world = newWorld();
  await installFakes(context, world);
  await installApp(context, APP);
  await installApp(context, OTHER_SITE);
  return world;
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
}

/** An app on `from` sends the user to the keychain with a connect request. */
async function requestFrom(page: Page, from: string, options: Partial<ConnectOptions> = {}) {
  const store = memoryStore();
  const url = beginConnect(
    {
      keychainUrl: KEYCHAIN,
      redirectUri: `${APP}/`,
      appName: 'Example Game',
      validUntil: Math.floor(Date.now() / 1000) + 3600,
      maxCalls: 20,
      calls: [{ to: GAME, entrypoint: 'move' }],
      ...options,
    },
    store,
  );
  await page.goto(`${from}/`);
  await page.evaluate((target) => location.assign(target), url);
  // The keychain removes the request from the address bar as soon as it has read it.
  await page.waitForURL(`${KEYCHAIN}/connect`);
  return store;
}

/** The app's reading of the answer the keychain sent it back with. */
async function answerAt(page: Page, store: KeyValueStore) {
  await page.waitForURL(`${APP}/**`);
  const fragment = new URL(page.url()).hash;
  try {
    return { ok: true as const, connection: finishConnect(fragment, store)! };
  } catch (error) {
    return { ok: false as const, error: (error as Error).message };
  }
}

test.describe('signing in', () => {
  test('a new device signs in and lands on its account', async ({ page, context }) => {
    const world = await setup(context);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText('it ends every session your apps have')).toBeVisible();

    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    await expect(page.getByText(ACCOUNT)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Devices (1 of 5)' })).toBeVisible();
    await expect(page.getByText('this device', { exact: true })).toBeVisible();

    // What the keychain sent out: a key proof to the pepper service, and one recover request
    // carrying the pepper it got and the same key proof.
    expect(world.pepperRequests).toHaveLength(1);
    expect(world.recoverRequests).toHaveLength(1);
    const [pepperRequest] = world.pepperRequests;
    const [recover] = world.recoverRequests;
    expect(recover).toMatchObject({ account: ACCOUNT, pepper: PEPPER, override: false });
    expect(recover.newPubkey).toBe(pepperRequest.public_key);
    expect(recover.keyProof).toEqual(pepperRequest.signature);
    expect(world.owners).toEqual([recover.newPubkey]);
    // The token and the fragment are gone from the address bar.
    expect(page.url()).toBe(`${KEYCHAIN}/`);
  });

  test('the device is remembered: a later visit needs no sign-in', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    expect(world.issuerVisits).toBe(1);
    expect(world.recoverRequests).toHaveLength(1);
  });

  test('a stale sign-in page does not sign in twice', async ({ page, context }) => {
    const world = await setup(context);
    // A second tab drawn before the sign-in still offers "Continue with Google".
    const stale = await context.newPage();
    await stale.goto('/');
    await expect(stale.getByRole('button', { name: 'Continue with Google' })).toBeVisible();

    await signIn(page);
    await stale.getByRole('button', { name: 'Continue with Google' }).click();
    await expect(stale.getByRole('heading', { name: 'Your account' })).toBeVisible();
    expect(world.issuerVisits).toBe(1);
    expect(world.owners).toHaveLength(1);
  });

  test('a device whose key was removed elsewhere is asked to sign in again', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    world.owners = ['0x999'];
    await page.goto('/');
    await expect(page.getByText('This device no longer has access')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  });
});

test.describe('key storage', () => {
  test('the device key is stored encrypted, under a key the browser will not export', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);

    const stored = await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const request = indexedDB.open('kamui-keychain');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const read = (key: string) =>
        new Promise<any>((resolve, reject) => {
          const request = db.transaction('vault').objectStore('vault').get(key);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const wrapping: CryptoKey = await read('wrapping-key');
      const device = await read('device');
      const account = await read('account');
      let exported = 'exported';
      try {
        await crypto.subtle.exportKey('raw', wrapping);
      } catch {
        exported = 'refused';
      }
      const text = (sealed: any) => new TextDecoder().decode(new Uint8Array(sealed.data));
      return {
        wrappingExtractable: wrapping.extractable,
        wrappingAlgorithm: (wrapping.algorithm as any).name,
        exported,
        deviceFields: Object.keys(device).sort(),
        deviceText: text(device),
        accountText: text(account),
        pending: await read('pending-device'),
        // Nothing sensitive in web storage either.
        localStorageKeys: Object.keys(localStorage),
        sessionStorageKeys: Object.keys(sessionStorage),
      };
    });

    expect(stored.wrappingExtractable).toBe(false);
    expect(stored.wrappingAlgorithm).toBe('AES-GCM');
    expect(stored.exported).toBe('refused');
    expect(stored.deviceFields).toEqual(['data', 'iv']);
    // The stored bytes are ciphertext: no key, address or pepper is readable in them.
    expect(stored.deviceText).not.toContain('privateKey');
    expect(stored.deviceText).not.toContain(world.owners[0]!.slice(2, 20));
    expect(stored.accountText).not.toContain(ACCOUNT.slice(2, 20));
    expect(stored.accountText).not.toContain('pepper');
    // The key waiting for a sign-in is cleared once the sign-in is done.
    expect(stored.pending).toBeUndefined();
    expect(stored.localStorageKeys).toEqual([]);
    expect(stored.sessionStorageKeys).toEqual([]);
  });

  test('forgetting the device clears its key and account', async ({ page, context }) => {
    await setup(context);
    await signIn(page);
    page.on('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Forget this device' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    const left = await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((resolve) => {
        const request = indexedDB.open('kamui-keychain');
        request.onsuccess = () => resolve(request.result);
      });
      return new Promise<string[]>((resolve) => {
        const request = db.transaction('vault').objectStore('vault').getAllKeys();
        request.onsuccess = () => resolve(request.result.map(String));
      });
    });
    expect(left).not.toContain('device');
    expect(left).not.toContain('account');
  });
});

test.describe('connection requests', () => {
  test('an approved request registers the session and returns the account to the app', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    const store = await requestFrom(page, APP);

    await expect(page.getByRole('heading', { name: 'Connection request' })).toBeVisible();
    await expect(page.locator('.origin')).toHaveText(APP);
    await expect(page.getByText('It calls itself "Example Game"')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'move', exact: true })).toBeVisible();
    await expect(page.getByText('at most 20 sponsored')).toBeVisible();
    await expect(page.getByText('none: every transaction must be sponsored')).toBeVisible();
    await expect(page.getByText('can also sign messages as your account')).toBeVisible();
    // The request left the address bar as soon as it was read.
    expect(page.url()).toBe(`${KEYCHAIN}/connect`);

    await page.getByRole('button', { name: 'Approve' }).click();
    const answer = await answerAt(page, store);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.connection).toMatchObject({ account: ACCOUNT, chainId: CHAIN_ID, classHash: CLASS_HASH });

    // One sponsored call, to the account, registering exactly the session the app asked for.
    expect(world.sponsorRequests).toHaveLength(1);
    const [sent] = world.sponsorRequests;
    expect(BigInt(sent!.account)).toBe(BigInt(ACCOUNT));
    expect(sent!.calls).toHaveLength(1);
    expect(sent!.calls[0]!.selector).toBe(selectorOf('add_or_update_scoped_session_key'));
    expect(BigInt(sent!.calls[0]!.data[0]!)).toBe(BigInt(answer.connection.session.publicKey));
    expect(BigInt(sent!.calls[0]!.data[3]!)).toBe(0n); // sponsored only
    expect(BigInt(sent!.calls[0]!.data[5]!)).toBe(BigInt(GAME));
    // The device key did not sign in again for this.
    expect(world.issuerVisits).toBe(1);
  });

  test('a session with a spending limit sends the session and its policy together', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    const store = await requestFrom(page, APP, {
      calls: [{ to: GAME, entrypoint: 'move' }, { to: TOKEN, entrypoint: 'transfer' }],
      limits: [{ token: TOKEN, maxPerCall: 100n, maxPerWindow: 150n, windowSeconds: 3600 }],
    });
    await expect(page.getByRole('heading', { name: 'Spending limits' })).toBeVisible();
    await expect(page.getByText('150 every 60 min')).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).click();
    expect((await answerAt(page, store)).ok).toBe(true);
    expect(world.sponsorRequests[0]!.calls.map((call) => call.selector)).toEqual([
      selectorOf('add_or_update_scoped_session_key'),
      selectorOf('set_spending_policy'),
    ]);
  });

  test('a denied request tells the app and sends nothing', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    const store = await requestFrom(page, APP);
    await page.getByRole('button', { name: 'Deny' }).click();
    const answer = await answerAt(page, store);
    expect(answer).toEqual({ ok: false, error: 'keychain: denied by the user' });
    expect(world.sponsorRequests).toHaveLength(0);
  });

  test('token calls without a spending limit cannot be approved', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    const store = await requestFrom(page, APP, { calls: [{ to: TOKEN, entrypoint: 'transfer' }] });
    await expect(page.getByText('Kamui will not approve this request')).toBeVisible();
    await expect(page.getByText('no spending limit for transfer')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Go back' }).click();
    const answer = await answerAt(page, store);
    expect(answer.ok).toBe(false);
    expect(world.sponsorRequests).toHaveLength(0);
  });

  test('a request sent by another site in the app\'s name is refused', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    // The request names APP as the place to answer, but comes from OTHER_SITE.
    await requestFrom(page, OTHER_SITE);
    await expect(page.getByText('this request was not sent by the site it names')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    // Refused or not, the request does not linger in the address bar.
    expect(page.url()).toBe(`${KEYCHAIN}/connect`);
    expect(world.sponsorRequests).toHaveLength(0);
  });

  test('a request opened with no referring site is refused', async ({ page, context }) => {
    await setup(context);
    await signIn(page);
    const url = beginConnect(
      { keychainUrl: KEYCHAIN, redirectUri: `${APP}/`, validUntil: Math.floor(Date.now() / 1000) + 3600, maxCalls: 5, calls: [{ to: GAME, entrypoint: 'move' }] },
      memoryStore(),
    );
    // Typed or pasted into the address bar: there is no referrer.
    await page.goto(url);
    await expect(page.getByText('cannot tell which site sent this request')).toBeVisible();
    expect(page.url()).toBe(`${KEYCHAIN}/connect`);
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  });

  test('an app name is shown as text, never run as markup', async ({ page, context }) => {
    await setup(context);
    await signIn(page);
    await requestFrom(page, APP, { appName: '<img src=x onerror="window.pwned=1">' });
    await expect(page.getByText('<img src=x onerror=')).toBeVisible();
    expect(await page.locator('#view img').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();
  });

  test('a request before any sign-in goes through sign-in, then to approval', async ({ page, context }) => {
    const world = await setup(context);
    const store = await requestFrom(page, APP);
    await expect(page.getByText(`${APP} wants to connect. Sign in first.`)).toBeVisible();
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    // The request survived the trip to the issuer.
    await expect(page.getByRole('heading', { name: 'Connection request' })).toBeVisible();
    await expect(page.locator('.origin')).toHaveText(APP);
    await page.getByRole('button', { name: 'Approve' }).click();
    expect((await answerAt(page, store)).ok).toBe(true);
    expect(world.recoverRequests).toHaveLength(1);
    expect(world.sponsorRequests).toHaveLength(1);
  });

  test('if the relayer refuses, the user sees why and stays on the request', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    await requestFrom(page, APP);
    world.sponsorError = 'SPONSOR_CAP';
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('sponsor: SPONSOR_CAP')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(page.url()).toBe(`${KEYCHAIN}/connect`);
  });
});

test.describe('transaction requests', () => {
  /** An app on `from` asks the keychain to approve one transaction. */
  async function transactionFrom(page: Page, from: string, calls = [{ contractAddress: TOKEN, entrypoint: 'transfer', calldata: [GAME, '0x64', '0x0'] }]) {
    const store = memoryStore();
    const url = beginExecute({ keychainUrl: KEYCHAIN, redirectUri: `${APP}/`, appName: 'Example Game', calls }, store);
    await page.goto(`${from}/`);
    await page.evaluate((target) => location.assign(target), url);
    await page.waitForURL(`${KEYCHAIN}/execute`);
    return store;
  }

  async function transactionAnswer(page: Page, store: KeyValueStore) {
    await page.waitForURL(`${APP}/**`);
    try {
      return { ok: true as const, ...finishExecute(new URL(page.url()).hash, store)! };
    } catch (error) {
      return { ok: false as const, error: (error as Error).message };
    }
  }

  test('an approved transaction is sent as asked and its hash returned', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    const store = await transactionFrom(page, APP);

    await expect(page.getByRole('heading', { name: 'Transaction request' })).toBeVisible();
    await expect(page.locator('.origin')).toHaveText(APP);
    await expect(page.getByText('This uses your full authority')).toBeVisible();
    await expect(page.getByText('Sends 100 units of a token out of your account.')).toBeVisible();
    await expect(page.getByRole('cell', { name: TOKEN })).toBeVisible();
    await expect(page.getByRole('cell', { name: GAME })).toBeVisible();

    await page.getByRole('button', { name: 'Approve' }).click();
    const answer = await transactionAnswer(page, store);
    expect(answer).toEqual({ ok: true, transactionHash: '0xbbb' });

    expect(world.sponsorRequests).toHaveLength(1);
    const [call] = world.sponsorRequests[0]!.calls;
    expect(world.sponsorRequests[0]!.calls).toHaveLength(1);
    expect(BigInt(call!.to)).toBe(BigInt(TOKEN));
    expect(call!.selector).toBe(selectorOf('transfer'));
    expect(call!.data.map(BigInt)).toEqual([BigInt(GAME), 100n, 0n]);
  });

  test('an allowance is described as letting someone else spend', async ({ page, context }) => {
    await setup(context);
    await signIn(page);
    await transactionFrom(page, APP, [{ contractAddress: TOKEN, entrypoint: 'approve', calldata: [GAME, '0x5', '0x0'] }]);
    await expect(page.getByText('Lets another address spend up to 5 units of a token from your account.')).toBeVisible();
  });

  test('an unrecognised call is shown with its raw arguments, and several calls are all shown', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    const store = await transactionFrom(page, APP, [
      { contractAddress: GAME, entrypoint: 'move', calldata: ['0x7', '0x9'] },
      { contractAddress: GAME, entrypoint: 'end_turn', calldata: [] },
    ]);
    await expect(page.getByRole('heading', { name: 'Call 1 of 2' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Call 2 of 2' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '0x7, 0x9' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'end_turn' })).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).click();
    expect((await transactionAnswer(page, store)).ok).toBe(true);
    expect(world.sponsorRequests[0]!.calls.map((call) => call.selector)).toEqual([selectorOf('move'), selectorOf('end_turn')]);
  });

  test('a denied transaction tells the app and sends nothing', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    const store = await transactionFrom(page, APP);
    await page.getByRole('button', { name: 'Deny' }).click();
    expect(await transactionAnswer(page, store)).toEqual({ ok: false, error: 'keychain: denied by the user' });
    expect(world.sponsorRequests).toHaveLength(0);
  });

  test('a site cannot ask for a new device key, or any call to the account itself', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    const store = await transactionFrom(page, APP, [{ contractAddress: ACCOUNT, entrypoint: 'add_owner', calldata: ['0x666', '0x2', '0x1', '0x2'] }]);
    await expect(page.getByText('Kamui will not approve this request')).toBeVisible();
    await expect(page.getByText("'add_owner' targets your account itself")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Go back' }).click();
    expect((await transactionAnswer(page, store)).ok).toBe(false);
    expect(world.sponsorRequests).toHaveLength(0);
    expect(world.owners).toHaveLength(1);
  });

  test('one bad call among good ones refuses the whole request', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    await transactionFrom(page, APP, [
      { contractAddress: GAME, entrypoint: 'move', calldata: [] },
      { contractAddress: ACCOUNT, entrypoint: 'remove_owner', calldata: ['0x1'] },
    ]);
    await expect(page.getByText('Kamui will not approve this request')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    expect(world.sponsorRequests).toHaveLength(0);
  });

  test('a transaction request from another site in the app\'s name is refused', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    await transactionFrom(page, OTHER_SITE);
    await expect(page.getByText('this request was not sent by the site it names')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    expect(page.url()).toBe(`${KEYCHAIN}/execute`);
    expect(world.sponsorRequests).toHaveLength(0);
  });

  test('a transaction request before any sign-in goes through sign-in, then to approval', async ({ page, context }) => {
    const world = await setup(context);
    const store = await transactionFrom(page, APP);
    await expect(page.getByText(`${APP} asks you to approve a transaction. Sign in first.`)).toBeVisible();
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await expect(page.getByRole('heading', { name: 'Transaction request' })).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).click();
    expect((await transactionAnswer(page, store)).ok).toBe(true);
    expect(world.sponsorRequests).toHaveLength(1);
  });
});

test.describe('the account page', () => {
  test('removing another device key sends remove_owner and updates the list', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    const other = '0x5f513650a95ebc650404cfb1da39de4eba808aab4273f0c9a0d6d3bb09d3966';
    world.owners.unshift(other);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Devices (2 of 5)' })).toBeVisible();
    // Only the other key can be removed from here.
    await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(1);

    page.on('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('heading', { name: 'Devices (1 of 5)' })).toBeVisible();

    expect(world.sponsorRequests).toHaveLength(1);
    const [call] = world.sponsorRequests[0]!.calls;
    expect(call!.selector).toBe(selectorOf('remove_owner'));
    expect(BigInt(call!.data[0]!)).toBe(BigInt(other));
    expect(world.owners).toHaveLength(1);
  });

  test('declining the confirmation removes nothing', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    world.owners.unshift('0x123');
    await page.goto('/');
    page.on('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('heading', { name: 'Devices (2 of 5)' })).toBeVisible();
    expect(world.sponsorRequests).toHaveLength(0);
  });

  test('the recovery file downloads, belongs to this login, and holds no user id', async ({ page, context }) => {
    await setup(context);
    await signIn(page);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download recovery file' }).click()]);
    expect(download.suggestedFilename()).toBe('kamui-recovery.json');
    const text = await readFile((await download.path())!, 'utf8');
    const file = parsePepperFile(text);
    expect(file.account).toBe(ACCOUNT);
    expect(BigInt(file.pepper)).toBe(BigInt(PEPPER));
    expect(pepperFileMatchesLogin(file, CLAIMS, CHAIN_ID)).toBe(true);
    expect(text).not.toContain(CLAIMS.sub);
  });
});

test.describe('page security', () => {
  test('pages are served with a strict content security policy and cannot be framed', async ({ request }) => {
    for (const path of ['/', '/connect', '/execute', '/callback', '/main.js']) {
      const response = await request.get(path);
      const policy = response.headers()['content-security-policy']!;
      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain("script-src 'self'");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).not.toContain('unsafe-inline');
      expect(policy).not.toContain('unsafe-eval');
      expect(response.headers()['referrer-policy']).toBe('no-referrer');
    }
  });

  test('the policy blocks an injected inline script', async ({ page, context }) => {
    await setup(context);
    await page.goto('/');
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'window.injected = 1';
      document.body.append(script);
    });
    expect(await page.evaluate(() => (window as any).injected)).toBeUndefined();
  });

  test('the page loads nothing from outside its own origin', async ({ page, context }) => {
    await setup(context);
    const origins = new Set<string>();
    page.on('request', (request) => origins.add(new URL(request.url()).origin));
    await signIn(page);
    // Its own origin, the chain, the pepper service and the issuer's sign-in page. No CDN.
    expect([...origins].sort()).toEqual(['http://localhost:5183', 'http://localhost:5184', 'http://localhost:5185', 'https://accounts.google.com'].sort());
  });
});
