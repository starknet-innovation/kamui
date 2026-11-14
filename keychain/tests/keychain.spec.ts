// The keychain's pages and key storage, in a real browser, against fakes of everything outside
// the keychain (tests/fakes.ts).
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { outsideExecution, OutsideExecutionVersion, type TypedData } from 'starknet';
import {
  beginConnect,
  beginExecute,
  beginExtend,
  beginSignMessage,
  finishSignMessage,
  typedDataHash,
  exportPepper,
  finishConnect,
  finishExecute,
  isReferrerMissing,
  parsePepperFile,
  pepperFileMatchesLogin,
  serializePepperFile,
  type ConnectOptions,
  type KeyValueStore,
} from '../../sdk/src';
import { ACCOUNT, APPLE_ACCOUNT, APPLE_CLAIMS, CHAIN_ID, CLAIMS, CLASS_HASH, KEYCHAIN, PEPPER, installApp, installFakes, newWorld, selectorOf, signedBy, type World } from './fakes';

const APP = 'http://localhost:5199';
const OTHER_SITE = 'http://localhost:5198';
const GAME = '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc';
const TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'; // STRK
/** A token contract other than STRK. */
const OTHER_TOKEN = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
/** 1.5 tokens of 18 decimals, as the low half of a u256. */
const ONE_AND_A_HALF = '0x14d1120d7b160000';

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

/** The keys of what the keychain has stored on this device. */
async function vaultKeys(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
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

/** Answers the page's own confirmation. The keychain does not use native dialogs. */
async function answer(page: Page, yes: boolean) {
  const box = page.getByRole('alertdialog');
  await box.getByRole('button', { name: yes ? /^Yes/ : 'Cancel' }).click();
  await expect(box).toHaveCount(0);
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

    // What the keychain sent out: a key proof to the pepper service, and one relay request
    // carrying only the completed proof and ownership authorization.
    expect(world.pepperRequests).toHaveLength(1);
    expect(world.recoverRequests).toHaveLength(1);
    const [pepperRequest] = world.pepperRequests;
    const [recover] = world.recoverRequests;
    expect(recover).toMatchObject({ account: ACCOUNT, override: false });
    expect(recover.newPubkey).toBe(pepperRequest.public_key);
    expect(recover).not.toHaveProperty('jwt');
    expect(recover).not.toHaveProperty('pepper');
    expect(recover).not.toHaveProperty('keyProof');
    expect(world.owners).toEqual([recover.newPubkey]);
    // The token and the fragment are gone from the address bar.
    expect(page.url()).toBe(`${KEYCHAIN}/`);
  });

  test('sign-in polls a slow recovery and survives a dropped status connection', async ({ page, context }) => {
    const world = await setup(context);
    const polls: { jobId: string }[] = [];
    await context.route(`${KEYCHAIN}/api/recover/status`, async (route) => {
      polls.push(route.request().postDataJSON());
      if (polls.length === 1) return route.fulfill({ json: { status: 'running' } });
      if (polls.length === 2) return route.abort('connectionfailed');
      return route.fulfill({ json: { status: 'succeeded', result: { transaction_hash: '0xaaa' } } });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible({ timeout: 10_000 });
    expect(world.recoverRequests).toHaveLength(1);
    expect(polls.length).toBeGreaterThanOrEqual(3);
    expect(polls.at(-1)).toEqual({ jobId: world.recoverRequests[0].jobId });
    expect(page.url()).not.toContain(world.recoverRequests[0].jobId);
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
    // Embedded browsers answer native dialogs with "cancel" unseen; the keychain must not use them.
    const nativeDialogs: string[] = [];
    page.on('dialog', (dialog) => {
      nativeDialogs.push(dialog.type());
      void dialog.dismiss();
    });
    await page.getByRole('button', { name: 'Forget this device' }).click();
    await answer(page, true);
    expect(nativeDialogs).toEqual([]);
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
    expect(sent!.endpoint).toBe('/api/wallet/sponsor');
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
      limits: [{ token: TOKEN, maxPerCall: 10n ** 18n, maxPerWindow: 15n * 10n ** 17n, windowSeconds: 3600 }],
    });
    await expect(page.getByRole('heading', { name: 'Spending limits' })).toBeVisible();
    // Amounts read in whole units, with the token's name.
    await expect(page.getByRole('cell', { name: '1 STRK', exact: true })).toBeVisible();
    await expect(page.getByText('1.5 STRK every 60 min')).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).click();
    expect((await answerAt(page, store)).ok).toBe(true);
    expect(world.sponsorRequests[0]!.calls.map((call) => call.selector)).toEqual([
      selectorOf('add_or_update_scoped_session_key'),
      selectorOf('set_spending_policy'),
    ]);
  });

  test('a spending limit on a token Kamui cannot identify says so', async ({ page, context }) => {
    await setup(context);
    await signIn(page);
    await requestFrom(page, APP, {
      calls: [{ to: OTHER_TOKEN, entrypoint: 'transfer' }],
      limits: [{ token: OTHER_TOKEN, maxPerCall: 100n, maxPerWindow: 150n, windowSeconds: 3600 }],
    });
    await expect(page.getByRole('cell', { name: '100 units', exact: true })).toBeVisible();
    await expect(page.getByText('150 units every 60 min')).toBeVisible();
    await expect(page.getByText('Kamui could not identify this token')).toBeVisible();
    // It can still be approved: the limit is enforced on chain in raw units either way.
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
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
    // The page says which site was named and which one sent the request, and how to fix it.
    await expect(page.locator('#view .origin')).toHaveText([APP, OTHER_SITE]);
    await expect(page.getByText('must be on the same origin')).toBeVisible();
    // Nothing the request asked for is shown, and there is no way on to the site it names.
    await expect(page.getByText('Example Game')).toHaveCount(0);
    await expect(page.locator('#view a')).toHaveCount(0);
    await expect(page.getByText('What usually causes this')).toHaveCount(0);
  });

  test('a request opened with no referring site is refused, and says why', async ({ page, context }) => {
    await setup(context);
    await signIn(page);
    const url = beginConnect(
      { keychainUrl: KEYCHAIN, redirectUri: `${APP}/`, appName: 'Example Game', validUntil: Math.floor(Date.now() / 1000) + 3600, maxCalls: 5, calls: [{ to: GAME, entrypoint: 'move' }] },
      memoryStore(),
    );
    // Typed or pasted into the address bar: there is no referrer.
    await page.goto(url);
    await expect(page.getByText('cannot tell which site sent this request')).toBeVisible();
    expect(page.url()).toBe(`${KEYCHAIN}/connect`);
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    // The likely causes, each with what to do about it.
    await expect(page.getByText('privacy or ad-blocking extension')).toBeVisible();
    await expect(page.getByText('browser privacy setting')).toBeVisible();
    await expect(page.getByText('address bar, a bookmark, an email')).toBeVisible();
    await expect(page.getByText('its referrer policy')).toBeVisible();
    await expect(page.getByText('Referrer-Policy: strict-origin-when-cross-origin')).toBeVisible();
    // The request is unverified: its app name is not shown, only where it wants its answer.
    await expect(page.getByText('Example Game')).toHaveCount(0);
    await expect(page.locator('#view .origin')).toHaveText(APP);
  });

  test('with no referrer the user is not sent anywhere, and can choose to go back with only the error', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    const store = memoryStore();
    const url = beginConnect(
      { keychainUrl: KEYCHAIN, redirectUri: `${APP}/play?room=7`, validUntil: Math.floor(Date.now() / 1000) + 3600, maxCalls: 5, calls: [{ to: GAME, entrypoint: 'move' }] },
      store,
    );
    // The app's page tells the browser to send no referrer, as `Referrer-Policy: no-referrer` does.
    await page.goto(`${APP}/`);
    await page.evaluate((target) => {
      const link = document.createElement('a');
      link.href = target;
      link.referrerPolicy = 'no-referrer';
      link.textContent = 'connect';
      document.body.append(link);
      link.click();
    }, url);
    await page.waitForURL(`${KEYCHAIN}/connect`);
    await expect(page.getByText('cannot tell which site sent this request')).toBeVisible();

    // Nothing happens by itself: the keychain stays where it is.
    await page.waitForTimeout(500);
    expect(page.url()).toBe(`${KEYCHAIN}/connect`);

    // The one way back is a link that names where it goes.
    const back = page.locator('#view a');
    await expect(back).toHaveCount(1);
    await expect(back).toHaveText(`Go back to ${APP}`);
    const href = new URL((await back.getAttribute('href'))!);
    expect(href.origin + href.pathname + href.search).toBe(`${APP}/play?room=7`);
    const payload = JSON.parse(Buffer.from(new URLSearchParams(href.hash.slice(1)).get('kamui')!, 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['error', 'id', 'ok', 'v']);
    expect(payload).toMatchObject({ v: 1, ok: false, error: 'referrer_missing' });
    // Nothing about the signed-in account travels with it.
    expect(href.toString()).not.toContain(ACCOUNT.slice(2));
    expect(JSON.stringify(payload)).not.toContain(ACCOUNT.slice(2));

    await back.click();
    await page.waitForURL(`${APP}/play**`);
    let thrown: unknown;
    try {
      finishConnect(new URL(page.url()).hash, store);
    } catch (error) {
      thrown = error;
    }
    expect(isReferrerMissing(thrown)).toBe(true);
    expect(world.sponsorRequests).toHaveLength(0);
  });

  test('a transaction request with no referrer gets the same explanation and way back', async ({ page, context }) => {
    await setup(context);
    await signIn(page);
    const store = memoryStore();
    const url = beginExecute(
      { keychainUrl: KEYCHAIN, redirectUri: `${APP}/`, calls: [{ contractAddress: GAME, entrypoint: 'move', calldata: ['0x1'] }] },
      store,
    );
    await page.goto(url);
    await expect(page.getByText('cannot tell which site sent this request')).toBeVisible();
    expect(page.url()).toBe(`${KEYCHAIN}/execute`);
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await page.getByRole('link', { name: `Go back to ${APP}` }).click();
    await page.waitForURL(`${APP}/**`);
    let thrown: unknown;
    try {
      finishExecute(new URL(page.url()).hash, store);
    } catch (error) {
      thrown = error;
    }
    expect(isReferrerMissing(thrown)).toBe(true);
  });

  test('a request with no referrer and an address the keychain would never answer gets no way back', async ({ page, context }) => {
    await setup(context);
    await signIn(page);
    const request = { v: 1, id: '0x1', redirectUri: 'javascript:alert(1)', session: {} };
    await page.goto(`${KEYCHAIN}/connect#kamui=${Buffer.from(JSON.stringify(request)).toString('base64url')}`);
    await expect(page.getByText('the redirect address must be https')).toBeVisible();
    await expect(page.locator('#view a')).toHaveCount(0);
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
  async function transactionFrom(page: Page, from: string, calls = [{ contractAddress: TOKEN, entrypoint: 'transfer', calldata: [GAME, ONE_AND_A_HALF, '0x0'] }]) {
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
    await expect(page.getByText('Sends 1.5 STRK out of your account.')).toBeVisible();
    await expect(page.getByText('1.5 STRK (1500000000000000000 in the smallest unit)')).toBeVisible();
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
    expect(call!.data.map(BigInt)).toEqual([BigInt(GAME), 1_500_000_000_000_000_000n, 0n]);
  });

  test('an allowance is described as letting someone else spend', async ({ page, context }) => {
    await setup(context);
    await signIn(page);
    await transactionFrom(page, APP, [{ contractAddress: TOKEN, entrypoint: 'approve', calldata: [GAME, ONE_AND_A_HALF, '0x0'] }]);
    await expect(page.getByText('Lets another address spend up to 1.5 STRK from your account.')).toBeVisible();
  });

  test('an unlimited allowance is called unlimited', async ({ page, context }) => {
    await setup(context);
    await signIn(page);
    const max = '0xffffffffffffffffffffffffffffffff';
    await transactionFrom(page, APP, [{ contractAddress: TOKEN, entrypoint: 'approve', calldata: [GAME, max, max] }]);
    await expect(page.getByText('Lets another address spend up to an unlimited amount of STRK from your account.')).toBeVisible();
  });

  test('a token is shown by the name and decimals its contract gives, with its address', async ({ page, context }) => {
    const world = await setup(context);
    world.tokens.set(BigInt(OTHER_TOKEN), { symbol: 'GOLD', decimals: 6 });
    await signIn(page);
    await transactionFrom(page, APP, [{ contractAddress: OTHER_TOKEN, entrypoint: 'transfer', calldata: [GAME, '0x2625a0', '0x0'] }]);
    await expect(page.getByText('Sends 2.5 GOLD out of your account.')).toBeVisible();
    await expect(page.getByRole('cell', { name: OTHER_TOKEN })).toBeVisible();
    // Kamui keeps no token list, so there is nothing to warn about for a contract that answers like a token.
    await expect(page.getByText('could not identify')).toHaveCount(0);
  });

  test('a contract that is not a token gets raw amounts and a caution', async ({ page, context }) => {
    await setup(context);
    await signIn(page);
    await transactionFrom(page, APP, [{ contractAddress: OTHER_TOKEN, entrypoint: 'transfer', calldata: [GAME, '0x64', '0x0'] }]);
    await expect(page.getByText('Sends 100 units of an unidentified token out of your account.')).toBeVisible();
    await expect(page.getByText('Kamui could not identify this token')).toBeVisible();
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
    expect(world.sponsorRequests[0]!.endpoint).toBe('/api/sponsor');
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

    await page.getByRole('button', { name: 'Remove' }).click();
    await answer(page, true);
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
    await page.getByRole('button', { name: 'Remove' }).click();
    await answer(page, false);
    await expect(page.getByRole('heading', { name: 'Devices (2 of 5)' })).toBeVisible();
    expect(world.sponsorRequests).toHaveLength(0);
    // The page is still usable.
    await expect(page.getByRole('button', { name: 'Remove' })).toBeEnabled();
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
    // The page is still usable after the download.
    await expect(page.getByRole('button', { name: 'Forget this device' })).toBeEnabled();
  });
});

test.describe('sessions', () => {
  const SESSION_KEY = '0x5f513650a95ebc650404cfb1da39de4eba808aab4273f0c9a0d6d3bb09d3966';
  const felt = (value: string) => `0x${BigInt(value).toString(16)}`;
  const later = () => Math.floor(Date.now() / 1000) + 3600;

  /** Puts a session on the fake account, as if it had been approved earlier. */
  function sessionOnChain(world: World, publicKey: string, scope = [{ to: GAME, entrypoint: 'move' }], validUntil = later()) {
    world.sessions.set(felt(publicKey), {
      validUntil: BigInt(validUntil),
      maxCalls: 20n,
      maxFee: 0n,
      scope: scope.map((call) => ({ to: BigInt(call.to), selector: selectorOf(call.entrypoint) })),
      policies: new Map(),
    });
  }

  /** Puts a record in the fake registry, whatever it says. */
  function recorded(world: World, publicKey: string, over: Record<string, unknown> = {}) {
    world.registry.set(felt(publicKey), {
      publicKey,
      origin: APP,
      appName: 'Example Game',
      validUntil: later(),
      maxCalls: 20,
      maxFeePerTx: '0x0',
      calls: [{ to: GAME, entrypoint: 'move' }],
      limits: [],
      createdAt: Math.floor(Date.now() / 1000) - 60,
      ...over,
    });
  }

  const requestsOf = (world: World, action: string) => world.registryRequests.filter((request) => request.action === action);

  /** Connects from APP and comes back to the keychain's account page. */
  async function connectAndReturn(page: Page, options: Partial<ConnectOptions> = {}) {
    const store = await requestFrom(page, APP, options);
    await page.getByRole('button', { name: 'Approve' }).click();
    const answer = await answerAt(page, store);
    if (!answer.ok) throw new Error(answer.error);
    await page.goto(`${KEYCHAIN}/`);
    return answer.connection.session.publicKey;
  }

  test('an approved session is recorded, and listed with what the account says it may do', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    await expect(page.getByRole('heading', { name: 'Sessions (0)' })).toBeVisible();
    await expect(page.getByText('No site has a session on your account.')).toBeVisible();

    const publicKey = await connectAndReturn(page, {
      calls: [{ to: GAME, entrypoint: 'move' }, { to: TOKEN, entrypoint: 'transfer' }],
      limits: [{ token: TOKEN, maxPerCall: 10n ** 18n, maxPerWindow: 15n * 10n ** 17n, windowSeconds: 3600 }],
    });

    // The registry got one record, signed by the device key (the fake checks the signature),
    // naming the site the session was approved for.
    const puts = requestsOf(world, 'put');
    expect(puts).toHaveLength(1);
    expect(BigInt(puts[0]!.body.account)).toBe(BigInt(ACCOUNT));
    expect(puts[0]!.body.signature).toHaveLength(2);
    expect(puts[0]!.body.session).toMatchObject({
      publicKey,
      origin: APP,
      appName: 'Example Game',
      maxCalls: 20,
      maxFeePerTx: '0x0',
      calls: [{ to: GAME, entrypoint: 'move' }, { to: TOKEN, entrypoint: 'transfer' }],
      limits: [{ token: TOKEN, maxPerCall: '0xde0b6b3a7640000', maxPerWindow: '0x14d1120d7b160000', windowSeconds: 3600 }],
    });
    expect(world.registry.size).toBe(1);

    await expect(page.getByRole('heading', { name: 'Sessions (1)' })).toBeVisible();
    const session = page.locator('.session');
    await expect(session).toHaveCount(1);
    await expect(session.locator('.origin')).toHaveText(APP);
    await expect(session.getByText('It called itself "Example Game".')).toBeVisible();
    await expect(session.getByRole('cell', { name: 'move', exact: true })).toBeVisible();
    await expect(session.getByRole('cell', { name: 'transfer', exact: true })).toBeVisible();
    await expect(session.getByText('at most 20 sponsored')).toBeVisible();
    await expect(session.getByText('none: every transaction must be sponsored')).toBeVisible();
    await expect(session.getByRole('cell', { name: '1 STRK', exact: true })).toBeVisible();
    await expect(session.getByText('1.5 STRK every 60 min')).toBeVisible();
    await expect(session.getByRole('button', { name: 'Revoke' })).toBeVisible();
    // Nothing waits on this device once the registry has the record.
    expect(await vaultKeys(page)).not.toContain('unrecorded-sessions');
  });

  test('revoking a session sends exactly that revocation and removes its record', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    const first = await connectAndReturn(page);
    const second = await connectAndReturn(page, { appName: 'Second' });
    await expect(page.getByRole('heading', { name: 'Sessions (2)' })).toBeVisible();
    world.sponsorRequests.length = 0;

    await page.locator('.session').filter({ hasText: 'It called itself "Second".' }).getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByRole('heading', { name: 'Sessions (1)' })).toBeVisible();
    await expect(page.getByText('It called itself "Example Game".')).toBeVisible();

    // One sponsored transaction, with one call: the account revoking that session key.
    expect(world.sponsorRequests).toHaveLength(1);
    expect(BigInt(world.sponsorRequests[0]!.account)).toBe(BigInt(ACCOUNT));
    expect(world.sponsorRequests[0]!.calls).toHaveLength(1);
    const [call] = world.sponsorRequests[0]!.calls;
    expect(BigInt(call!.to)).toBe(BigInt(ACCOUNT));
    expect(call!.selector).toBe(selectorOf('revoke_session_key'));
    expect(call!.data.map(BigInt)).toEqual([BigInt(second)]);

    // The other session is untouched, on chain and in the registry.
    expect([...world.sessions.keys()]).toEqual([felt(first)]);
    expect([...world.registry.keys()]).toEqual([felt(first)]);
    const removes = requestsOf(world, 'remove');
    expect(removes).toHaveLength(1);
    expect(BigInt(removes[0]!.body.publicKey)).toBe(BigInt(second));
  });

  test('if the relayer refuses a revocation, the session stays listed and recorded', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    await connectAndReturn(page);
    world.sponsorError = 'SPONSOR_CAP';
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(page.getByText('sponsor: SPONSOR_CAP')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revoke', exact: true })).toBeEnabled();
    expect(world.sessions.size).toBe(1);
    expect(world.registry.size).toBe(1);
  });

  test('a registry that is down does not keep the user from the app, and the session is not lost', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    world.registryDown = true;
    // The approval still succeeds and the user is back at the app.
    await connectAndReturn(page);
    expect(world.sessions.size).toBe(1);
    expect(world.registry.size).toBe(0);

    // The account page says the list could not be loaded, and shows the session from this
    // device's own storage.
    await expect(page.getByText('Kamui could not load its list of your sessions')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sessions (1)' })).toBeVisible();
    await expect(page.locator('.session .origin')).toHaveText(APP);
    expect(await vaultKeys(page)).toContain('unrecorded-sessions');

    // Once the registry answers again, the next visit records the session.
    world.registryDown = false;
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sessions (1)' })).toBeVisible();
    await expect(page.getByText('Kamui could not load its list of your sessions')).toHaveCount(0);
    await expect.poll(() => world.registry.size).toBe(1);
    await expect.poll(() => vaultKeys(page)).not.toContain('unrecorded-sessions');
    expect([...world.registry.values()][0]).toMatchObject({ origin: APP, appName: 'Example Game' });
  });

  test('a full registry does not keep the user from the app, and the page says the list is full', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    world.registryFull = true;
    await connectAndReturn(page);
    expect(world.registry.size).toBe(0);
    await expect(page.getByRole('heading', { name: 'Sessions (1)' })).toBeVisible();
    await expect(page.locator('.session .origin')).toHaveText(APP);
    await expect(page.getByText("Kamui's list of your sessions is full.")).toBeVisible();
    await expect(page.getByText('Kamui could not load its list of your sessions')).toHaveCount(0);

    // With room again, the next visit records it and the notice is gone.
    world.registryFull = false;
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sessions (1)' })).toBeVisible();
    await expect.poll(() => world.registry.size).toBe(1);
    await expect(page.getByText("Kamui's list of your sessions is full.")).toHaveCount(0);
  });

  test('records are matched to the account by value, whatever the formatting of their keys', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    sessionOnChain(world, SESSION_KEY);
    // Upper case and leading zeros where the account answers lower case and none.
    recorded(world, SESSION_KEY, { publicKey: `0x0${SESSION_KEY.slice(2).toUpperCase()}`, calls: [{ to: `0x0${GAME.slice(2).toUpperCase()}`, entrypoint: 'move' }] });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sessions (1)' })).toBeVisible();
    await expect(page.locator('.session').getByRole('cell', { name: 'move', exact: true })).toBeVisible();
    world.sponsorRequests.length = 0;
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sessions (0)' })).toBeVisible();
    expect(world.sponsorRequests[0]!.calls[0]!.data.map(BigInt)).toEqual([BigInt(SESSION_KEY)]);
    expect(world.registry.size).toBe(0);
  });

  test('a session approved while the registry was down can be revoked while it is still down', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    world.registryDown = true;
    await connectAndReturn(page);
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sessions (0)' })).toBeVisible();
    expect(world.sessions.size).toBe(0);
    expect(await vaultKeys(page)).not.toContain('unrecorded-sessions');
  });

  test('"Revoke all sessions" works when the registry is down', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    sessionOnChain(world, SESSION_KEY);
    recorded(world, SESSION_KEY);
    world.registryDown = true;
    await page.goto('/');
    // The registry cannot say which sessions exist, so none is listed.
    await expect(page.getByRole('heading', { name: 'Sessions (0)' })).toBeVisible();
    await expect(page.getByText('Kamui could not load its list of your sessions')).toBeVisible();

    await page.getByRole('button', { name: 'Revoke all sessions' }).click();
    await expect(page.getByRole('alertdialog')).toHaveText(/^Revoke every session on your account\? Each site will have to ask you again\./);
    await answer(page, true);
    await expect.poll(() => world.sponsorRequests.length).toBe(1);
    await expect(page.getByRole('button', { name: 'Revoke all sessions' })).toBeEnabled();

    // One call to the account, with no arguments.
    expect(world.sponsorRequests[0]!.calls).toHaveLength(1);
    const [call] = world.sponsorRequests[0]!.calls;
    expect(BigInt(call!.to)).toBe(BigInt(ACCOUNT));
    expect(call!.selector).toBe(selectorOf('revoke_all_sessions'));
    expect(call!.data).toEqual([]);
    expect(world.sessions.size).toBe(0);
  });

  test('"Revoke all sessions" works with an empty registry, and removes the records of what it ended', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    // A session the registry never heard of.
    sessionOnChain(world, SESSION_KEY);
    await connectAndReturn(page);
    await expect(page.getByRole('heading', { name: 'Sessions (1)' })).toBeVisible();
    world.sponsorRequests.length = 0;

    await page.getByRole('button', { name: 'Revoke all sessions' }).click();
    await answer(page, true);
    await expect(page.getByRole('heading', { name: 'Sessions (0)' })).toBeVisible();
    expect(world.sponsorRequests).toHaveLength(1);
    expect(world.sponsorRequests[0]!.endpoint).toBe('/api/wallet/sponsor');
    expect(world.sponsorRequests[0]!.calls.map((call) => call.selector)).toEqual([selectorOf('revoke_all_sessions')]);
    expect(world.sessions.size).toBe(0);
    await expect.poll(() => world.registry.size).toBe(0);
  });

  test('declining the confirmation revokes nothing and leaves the page usable', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    await connectAndReturn(page);
    world.sponsorRequests.length = 0;
    await page.getByRole('button', { name: 'Revoke all sessions' }).click();
    await answer(page, false);
    await expect(page.getByRole('button', { name: 'Revoke all sessions' })).toBeEnabled();
    await expect(page.getByRole('heading', { name: 'Sessions (1)' })).toBeVisible();
    expect(world.sponsorRequests).toHaveLength(0);
    expect(world.sessions.size).toBe(1);
  });

  test('a recorded session that does not exist on the account is not shown, and its record is removed', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    const expired = '0x777';
    sessionOnChain(world, SESSION_KEY);
    sessionOnChain(world, expired, undefined, Math.floor(Date.now() / 1000) - 10);
    recorded(world, SESSION_KEY);
    recorded(world, '0x666', { origin: 'https://never-approved.example', appName: 'Ghost' });
    recorded(world, expired, { origin: 'https://expired.example', appName: 'Expired' });
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Sessions (1)' })).toBeVisible();
    await expect(page.locator('.session .origin')).toHaveText(APP);
    await expect(page.getByText('never-approved.example')).toHaveCount(0);
    await expect(page.getByText('expired.example')).toHaveCount(0);

    await expect.poll(() => [...world.registry.keys()]).toEqual([felt(SESSION_KEY)]);
    expect(requestsOf(world, 'remove').map((request) => BigInt(request.body.publicKey)).sort()).toEqual([0x666n, 0x777n]);
    // Looking at the list sends nothing to the chain.
    expect(world.sponsorRequests).toHaveLength(0);
  });

  test('markup in a recorded origin or app name is shown as text', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    sessionOnChain(world, SESSION_KEY);
    recorded(world, SESSION_KEY, {
      origin: '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>',
      appName: '<img src=x onerror="window.pwned=3"><b>Game</b>',
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sessions (1)' })).toBeVisible();
    await expect(page.locator('.session .origin')).toHaveText('<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>');
    await expect(page.getByText('It called itself "<img src=x onerror="window.pwned=3"><b>Game</b>".')).toBeVisible();
    expect(await page.locator('#view img, #view b, #view script').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();
  });

  test('records the registry cannot have been given honestly are dropped', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    sessionOnChain(world, SESSION_KEY);
    sessionOnChain(world, '0x888');
    recorded(world, SESSION_KEY);
    recorded(world, '0x888', { calls: [{ to: GAME, entrypoint: '<img src=x onerror="window.pwned=1">' }] });
    world.registry.set('junk', 'not a session');
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sessions (1)' })).toBeVisible();
    expect(await page.locator('#view img').count()).toBe(0);
  });

  test('what a session may do is read from the account, not from its record', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    // On chain: two permissions, a limit of 5 STRK per call, valid for an hour.
    sessionOnChain(world, SESSION_KEY, [{ to: GAME, entrypoint: 'move' }, { to: TOKEN, entrypoint: 'transfer' }]);
    world.sessions.get(felt(SESSION_KEY))!.policies.set(BigInt(TOKEN), { maxPerCall: 5n * 10n ** 18n, maxPerWindow: 50n * 10n ** 18n, windowSeconds: 7200n });
    // The record claims one harmless call, another call the account does not allow, a smaller
    // limit and other counts.
    recorded(world, SESSION_KEY, {
      maxCalls: 1,
      calls: [{ to: GAME, entrypoint: 'move' }, { to: GAME, entrypoint: 'end_turn' }],
      limits: [{ token: TOKEN, maxPerCall: '0x1', maxPerWindow: '0x1', windowSeconds: 60 }],
    });
    await page.goto('/');
    const session = page.locator('.session');
    await expect(session.getByRole('cell', { name: 'move', exact: true })).toBeVisible();
    await expect(session.getByRole('cell', { name: 'end_turn', exact: true })).toHaveCount(0);
    await expect(session.getByText('Your account holds 2 permissions for this session, and Kamui knows 1 of them.')).toBeVisible();
    await expect(session.getByText('at most 20 sponsored')).toBeVisible();
    await expect(session.getByRole('cell', { name: '5 STRK', exact: true })).toBeVisible();
    await expect(session.getByText('50 STRK every 120 min')).toBeVisible();
  });

  test('a session that may spend a token with no limit is flagged', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    sessionOnChain(world, SESSION_KEY, [{ to: TOKEN, entrypoint: 'transfer' }]);
    recorded(world, SESSION_KEY, { calls: [{ to: TOKEN, entrypoint: 'transfer' }], limits: [{ token: TOKEN, maxPerCall: '0x1', maxPerWindow: '0x1', windowSeconds: 60 }] });
    await page.goto('/');
    await expect(page.locator('.session').getByText('This session can spend any amount of this token: STRK')).toBeVisible();
  });

  test('removing a device ends every session, and their records are removed', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    await connectAndReturn(page);
    world.owners.unshift('0x5f513650a95ebc650404cfb1da39de4eba808aab4273f0c9a0d6d3bb09d3966');
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sessions (1)' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove' }).click();
    await answer(page, true);
    await expect(page.getByRole('heading', { name: 'Sessions (0)' })).toBeVisible();
    await expect.poll(() => world.registry.size).toBe(0);
  });

  /** A site on `from` asks to renew the session of `publicKey`, as `beginExtend` does. */
  async function renewalFrom(page: Page, from: string, publicKey: string, store = memoryStore(), privateKey = '0x1') {
    const connection = { account: ACCOUNT, chainId: CHAIN_ID, classHash: CLASS_HASH, session: { privateKey, publicKey, validUntil: later(), maxCalls: 20 } };
    const url = beginExtend(
      connection,
      { keychainUrl: KEYCHAIN, redirectUri: `${from}/`, appName: 'Example Game', validUntil: later() + 3600, maxCalls: 500, calls: [{ to: GAME, entrypoint: 'move' }] },
      store,
    );
    await page.goto(`${from}/`);
    await page.evaluate((target) => location.assign(target), url);
    await page.waitForURL(`${KEYCHAIN}/connect`);
    return store;
  }

  test('a renewal keeps the session key, is shown as a renewal, and replaces the session and its record', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    const store = await requestFrom(page, APP);
    await expect(page.getByRole('heading', { name: 'Connection request' })).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).click();
    const first = await answerAt(page, store);
    if (!first.ok) throw new Error(first.error);
    const { publicKey, privateKey } = first.connection.session;

    await renewalFrom(page, APP, publicKey, store, privateKey);
    await expect(page.getByRole('heading', { name: 'Session renewal' })).toBeVisible();
    await expect(page.locator('.origin')).toHaveText(APP);
    await expect(page.getByText('Approving replaces that session with the limits below')).toBeVisible();
    await expect(page.getByText('at most 500 sponsored')).toBeVisible();
    await expect(page.getByText('Kamui could not check which site')).toHaveCount(0);

    await page.getByRole('button', { name: 'Approve' }).click();
    const renewed = await answerAt(page, store);
    if (!renewed.ok) throw new Error(renewed.error);
    expect(renewed.connection.session).toMatchObject({ publicKey, privateKey, maxCalls: 500 });

    // One more sponsored call, for the same key with the new limits; still one record.
    expect(world.sponsorRequests).toHaveLength(2);
    const call = world.sponsorRequests[1]!.calls[0]!;
    expect(call.selector).toBe(selectorOf('add_or_update_scoped_session_key'));
    expect(BigInt(call.data[0]!)).toBe(BigInt(publicKey));
    expect(BigInt(call.data[2]!)).toBe(500n);
    expect(world.registry.size).toBe(1);
    expect(world.registry.get(felt(publicKey))).toMatchObject({ origin: APP, maxCalls: 500 });
  });

  test('a site cannot renew a session that was approved for another site', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    sessionOnChain(world, SESSION_KEY);
    recorded(world, SESSION_KEY);

    const store = await renewalFrom(page, OTHER_SITE, SESSION_KEY);
    await expect(page.getByRole('heading', { name: 'Session renewal' })).toBeVisible();
    await expect(page.getByText(`this session key already belongs to a session approved for ${APP}`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Go back' }).click();
    await page.waitForURL(`${OTHER_SITE}/**`);
    expect(() => finishConnect(new URL(page.url()).hash, store)).toThrow(/refused by the keychain/);
    expect(world.sponsorRequests).toHaveLength(0);
  });

  test('a renewal of a session Kamui has no record of says so, and can still be approved', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    sessionOnChain(world, SESSION_KEY);

    await renewalFrom(page, APP, SESSION_KEY);
    await expect(page.getByRole('heading', { name: 'Session renewal' })).toBeVisible();
    await expect(page.getByText('Kamui could not check which site this session was first approved for')).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.waitForURL(`${APP}/**`);
    expect(world.sponsorRequests).toHaveLength(1);
  });
});

test.describe('signing in with a recovery file', () => {
  const fileFor = (over: Partial<Parameters<typeof exportPepper>[0]> = {}) =>
    serializePepperFile(exportPepper({ chainId: CHAIN_ID, classHash: CLASS_HASH, claims: CLAIMS, pepper: PEPPER, keyVersion: 1, ...over }));

  async function choose(page: Page, text: string | Buffer) {
    await page.locator('#recovery-file').setInputFiles({ name: 'kamui-recovery.json', mimeType: 'application/json', buffer: Buffer.isBuffer(text) ? text : Buffer.from(text) });
  }

  test('the file\'s pepper is used and the pepper service is never contacted', async ({ page, context }) => {
    const world = await setup(context);
    // The service the file stands in for is gone.
    world.pepperDown = true;
    await page.goto('/');
    await choose(page, fileFor());
    await expect(page.locator('#recovery-file-note')).toContainText("Kamui's lookup service will not be asked");
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    await expect(page.getByText(ACCOUNT)).toBeVisible();

    expect(world.pepperRequests).toHaveLength(0);
    expect(world.recoverRequests).toHaveLength(1);
    expect(world.recoverRequests[0]).toMatchObject({ account: ACCOUNT, override: false });
    // The file is not kept anywhere once the sign-in is over.
    expect(await vaultKeys(page)).not.toContain('pending-pepper-file');
    expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  });

  test('the file a signed-in device downloads signs a new device in', async ({ page, context, browser }) => {
    const world = await setup(context);
    await signIn(page);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download recovery file' }).click()]);
    const text = await readFile((await download.path())!, 'utf8');

    const other = await browser.newContext();
    await installFakes(other, world);
    const second = await other.newPage();
    world.pepperRequests.length = 0;
    await second.goto(`${KEYCHAIN}/`);
    await choose(second, text);
    await second.getByRole('button', { name: 'Continue with Google' }).click();
    await expect(second.getByRole('heading', { name: 'Devices (2 of 5)' })).toBeVisible();
    expect(world.pepperRequests).toHaveLength(0);
    await other.close();
  });

  test('while the user is at the issuer, the file is stored encrypted and not in web storage', async ({ page, context }) => {
    await setup(context);
    await page.goto('/');
    await choose(page, fileFor());
    await expect(page.locator('#recovery-file-note')).toContainText('Recovery file for the account');
    // Hold the user at the issuer.
    await context.route('https://accounts.google.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>issuer</title><p>issuer</p>' }));
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await page.waitForURL('https://accounts.google.com/**');
    await page.goto(`${KEYCHAIN}/nothing-here`);
    const stored = await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const request = indexedDB.open('kamui-keychain');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const sealed: any = await new Promise((resolve, reject) => {
        const request = db.transaction('vault').objectStore('vault').get('pending-pepper-file');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return { fields: Object.keys(sealed).sort(), text: new TextDecoder().decode(new Uint8Array(sealed.data)), session: JSON.stringify({ ...sessionStorage }), local: Object.keys(localStorage) };
    });
    expect(stored.fields).toEqual(['data', 'iv']);
    expect(stored.text).not.toContain('pepper');
    expect(stored.text).not.toContain(ACCOUNT.slice(2, 20));
    // The tab keeps the sign-in attempt, not the file.
    expect(stored.session).not.toContain('pepper');
    expect(stored.session).not.toContain(ACCOUNT.slice(2));
    expect(stored.local).toEqual([]);
  });

  test('a file for another user is refused after the sign-in, and nothing is sent', async ({ page, context }) => {
    const world = await setup(context);
    await page.goto('/');
    await choose(page, fileFor({ claims: { ...CLAIMS, sub: 'someone-else' } }));
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await expect(page.getByText('This recovery file does not belong to the account you signed in with. Nothing was changed.')).toBeVisible();
    // No fallback to the pepper service, and no device added.
    expect(world.pepperRequests).toHaveLength(0);
    expect(world.recoverRequests).toHaveLength(0);
    expect(world.owners).toEqual([]);
    expect(await vaultKeys(page)).not.toContain('pending-pepper-file');
    expect(await vaultKeys(page)).not.toContain('device');
    expect(page.url()).toBe(`${KEYCHAIN}/`);

    // Starting again without a file works as usual.
    await page.getByRole('button', { name: 'Start again' }).click();
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    expect(world.pepperRequests).toHaveLength(1);
  });

  test('a file for another network or another account class is refused when it is chosen', async ({ page, context }) => {
    const world = await setup(context);
    await page.goto('/');
    await choose(page, fileFor({ chainId: '0x534e5f4d41494e' }));
    await expect(page.locator('#recovery-file-note')).toHaveText('This recovery file is for another network and cannot be used here.');
    expect(await page.locator('#recovery-file').evaluate((input: HTMLInputElement) => input.files!.length)).toBe(0);

    await choose(page, fileFor({ classHash: '0x999' }));
    await expect(page.locator('#recovery-file-note')).toHaveText('This recovery file is for another version of the Kamui account and cannot be used here.');
    expect(await page.locator('#recovery-file').evaluate((input: HTMLInputElement) => input.files!.length)).toBe(0);

    // A refused file is not used: the sign-in that follows asks the pepper service.
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    expect(world.pepperRequests).toHaveLength(1);
  });

  test('a file for another application or another issuer is refused before leaving for the issuer', async ({ page, context }) => {
    const world = await setup(context);
    await page.goto('/');
    await choose(page, fileFor({ claims: { ...CLAIMS, aud: 'another-app' } }));
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await expect(page.getByText('This recovery file was made for another application and cannot be used here.')).toBeVisible();

    await choose(page, fileFor());
    await page.getByRole('button', { name: 'Continue with Apple' }).click();
    await expect(page.getByText('This recovery file is for a sign-in with Google, not with Apple.')).toBeVisible();

    expect(world.issuerVisits).toBe(0);
    expect(world.appleVisits).toHaveLength(0);
    expect(await vaultKeys(page)).not.toContain('pending-pepper-file');
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  });

  test('a file that is not a recovery file is refused when it is chosen', async ({ page, context }) => {
    const world = await setup(context);
    await page.goto('/');
    const note = page.locator('#recovery-file-note');

    await choose(page, 'not json at all <img src=x onerror="window.pwned=1">');
    await expect(note).toHaveText('This is not a Kamui recovery file (not valid JSON).');
    await choose(page, JSON.stringify({ kind: 'something-else', pepper: PEPPER }));
    await expect(note).toHaveText('This is not a Kamui recovery file (not a Kamui pepper file).');
    await choose(page, fileFor().replace(/"pepper": "0x[0-9a-f]+"/, '"pepper": "0x0"'));
    await expect(note).toHaveText('This is not a Kamui recovery file (pepper out of range).');
    await choose(page, fileFor().replace(/"account": "0x[0-9a-f]+"/, '"account": "<img src=x onerror=window.pwned=1>"'));
    await expect(note).toHaveText('This is not a Kamui recovery file (bad account).');
    await choose(page, Buffer.alloc(20_000, 0x20));
    await expect(note).toHaveText('This is not a Kamui recovery file: it is too large.');
    expect(await page.locator('#recovery-file').evaluate((input: HTMLInputElement) => input.files!.length)).toBe(0);
    expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();

    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    expect(world.pepperRequests).toHaveLength(1);
  });

  test('a file whose account does not match its own pepper is refused after the sign-in', async ({ page, context }) => {
    const world = await setup(context);
    await page.goto('/');
    // Edited by hand: someone else's pepper under this user's account address.
    await choose(page, fileFor().replace(/"pepper": "0x[0-9a-f]+"/, '"pepper": "0x9999"'));
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await expect(page.getByText('This recovery file does not belong to the account you signed in with.')).toBeVisible();
    expect(world.recoverRequests).toHaveLength(0);
  });
});

test.describe('signing in with Apple', () => {
  test('a new device signs in with Apple and lands on its account', async ({ page, context }) => {
    const world = await setup(context);
    await page.goto('/');
    await page.getByRole('button', { name: 'Continue with Apple' }).click();
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    await expect(page.getByText(APPLE_ACCOUNT)).toBeVisible();

    // What Apple was asked: the token in the fragment, no scope, and the nonce that binds the
    // device key.
    expect(world.appleVisits).toHaveLength(1);
    expect(world.issuerVisits).toBe(0);
    const [asked] = world.appleVisits;
    expect(asked).toMatchObject({ client_id: 'test-apple-client', redirect_uri: `${KEYCHAIN}/callback`, response_type: 'code id_token', response_mode: 'fragment' });
    expect(asked!.scope).toBeUndefined();
    expect(asked!.nonce).toMatch(/^0x[0-9a-f]+$/);
    expect(asked!.state).toMatch(/^0x[0-9a-f]+$/);

    expect(world.pepperRequests).toHaveLength(1);
    expect(world.recoverRequests).toHaveLength(1);
    expect(world.recoverRequests[0]).toMatchObject({ account: APPLE_ACCOUNT });
    expect(world.recoverRequests[0].newPubkey).toBe(world.pepperRequests[0].public_key);
    // The token and the code are gone from the address bar.
    expect(page.url()).toBe(`${KEYCHAIN}/`);
  });

  test('the recovery file of an Apple account holds Apple as its issuer, and signs in with Apple', async ({ page, context }) => {
    const world = await setup(context);
    await page.goto('/');
    await page.getByRole('button', { name: 'Continue with Apple' }).click();
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download recovery file' }).click()]);
    const text = await readFile((await download.path())!, 'utf8');
    const file = parsePepperFile(text);
    expect(file.account).toBe(APPLE_ACCOUNT);
    expect(pepperFileMatchesLogin(file, APPLE_CLAIMS, CHAIN_ID)).toBe(true);
    expect(text).not.toContain(APPLE_CLAIMS.sub);

    await page.getByRole('button', { name: 'Forget this device' }).click();
    await answer(page, true);
    world.pepperRequests.length = 0;
    await page.locator('#recovery-file').setInputFiles({ name: 'kamui-recovery.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await expect(page.locator('#recovery-file-note')).toContainText('Recovery file for the account');
    await page.getByRole('button', { name: 'Continue with Apple' }).click();
    await expect(page.getByRole('heading', { name: 'Devices (2 of 5)' })).toBeVisible();
    expect(world.pepperRequests).toHaveLength(0);
  });

  test('a connection request survives a sign-in with Apple', async ({ page, context }) => {
    const world = await setup(context);
    const store = await requestFrom(page, APP);
    await page.getByRole('button', { name: 'Continue with Apple' }).click();
    await expect(page.getByRole('heading', { name: 'Connection request' })).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).click();
    const answer = await answerAt(page, store);
    expect(answer.ok && answer.connection.account).toBe(APPLE_ACCOUNT);
    expect(world.sponsorRequests).toHaveLength(1);
  });

  test('an error from Apple is shown and adds no device', async ({ page, context }) => {
    const world = await setup(context);
    world.appleError = 'user_cancelled_authorize';
    await page.goto('/');
    await page.getByRole('button', { name: 'Continue with Apple' }).click();
    await expect(page.getByText('login: apple answered user_cancelled_authorize')).toBeVisible();
    expect(world.recoverRequests).toHaveLength(0);
    expect(page.url()).toBe(`${KEYCHAIN}/`);
  });

  test('the Apple button is not offered when the server has no Apple client id', async ({ page, context }) => {
    await setup(context);
    await context.route(`${KEYCHAIN}/config.json`, async (route) => {
      const response = await route.fetch();
      const config = await response.json();
      await route.fulfill({ response, json: { ...config, appleClientId: '' } });
    });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with Apple' })).toHaveCount(0);
  });
});

test.describe('message requests', () => {
  const signInMessage = (change: (data: any) => void = () => {}): TypedData => {
    const data = {
      types: {
        StarknetDomain: [
          { name: 'name', type: 'shortstring' },
          { name: 'version', type: 'shortstring' },
          { name: 'chainId', type: 'shortstring' },
          { name: 'revision', type: 'shortstring' },
        ],
        SignIn: [
          { name: 'statement', type: 'string' },
          { name: 'nonce', type: 'felt' },
          { name: 'scopes', type: 'shortstring*' },
        ],
      },
      primaryType: 'SignIn',
      domain: { name: 'Example Game', version: '1', chainId: CHAIN_ID, revision: '1' },
      message: { statement: 'Sign in to Example Game', nonce: '0x1234', scopes: ['profile', 'scores'] },
    };
    change(data);
    return data;
  };

  /** An app on `from` asks the keychain to sign one message. */
  async function messageFrom(page: Page, from: string, typedData = signInMessage()) {
    const store = memoryStore();
    const url = beginSignMessage({ keychainUrl: KEYCHAIN, redirectUri: `${APP}/`, appName: 'Example Game', typedData }, store);
    await page.goto(`${from}/`);
    await page.evaluate((target) => location.assign(target), url);
    await page.waitForURL(`${KEYCHAIN}/sign`);
    return store;
  }

  async function messageAnswer(page: Page, store: KeyValueStore) {
    await page.waitForURL(`${APP}/**`);
    try {
      return { ok: true as const, ...finishSignMessage(new URL(page.url()).hash, store)! };
    } catch (error) {
      return { ok: false as const, error: (error as Error).message };
    }
  }

  test('a signed message shows who asks and all of the message, and returns an owner signature the account accepts', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    const store = await messageFrom(page, APP);

    await expect(page.getByRole('heading', { name: 'Signature request' })).toBeVisible();
    await expect(page.locator('.origin')).toHaveText(APP);
    await expect(page.getByText('Nothing is sent to the network')).toBeVisible();
    // The domain, with the network spelled out, and every value of the message with its type.
    await expect(page.getByRole('row', { name: 'name Example Game' })).toBeVisible();
    await expect(page.getByRole('row', { name: `chainId SN_SEPOLIA (${CHAIN_ID})` })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Message (SignIn)' })).toBeVisible();
    await expect(page.getByRole('row', { name: 'statement string Sign in to Example Game' })).toBeVisible();
    await expect(page.getByRole('row', { name: 'nonce felt 0x1234' })).toBeVisible();
    await expect(page.getByRole('row', { name: 'scopes[1] shortstring scores' })).toBeVisible();
    const messageHash = typedDataHash(signInMessage(), ACCOUNT);
    await expect(page.getByRole('cell', { name: messageHash })).toBeVisible();
    await page.getByText('Full typed data').click();
    await expect(page.locator('pre')).toContainText('"primaryType": "SignIn"');

    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    const answer = await messageAnswer(page, store);
    expect(answer).toMatchObject({ ok: true, account: ACCOUNT, chainId: CHAIN_ID });
    if (!answer.ok) throw new Error(answer.error);
    // The device key, an owner, signed the hash of this message for this account.
    expect(answer.signature).toHaveLength(2);
    expect(world.owners).toHaveLength(1);
    expect(signedBy(messageHash, answer.signature[0]!, answer.signature[1]!, world.owners[0]!)).toBe(true);
    // The keychain asked the account before answering, and nothing was sent to the network.
    expect(world.signatureChecks.map((check) => BigInt(check.hash))).toEqual([BigInt(messageHash)]);
    expect(world.sponsorRequests).toHaveLength(0);
  });

  test('a denied message returns a refusal and signs nothing', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    const store = await messageFrom(page, APP);
    await page.getByRole('button', { name: 'Deny' }).click();
    expect(await messageAnswer(page, store)).toEqual({ ok: false, error: 'keychain: denied by the user' });
    expect(world.signatureChecks).toHaveLength(0);
  });

  test('what the site wrote is shown as text, never as markup', async ({ page, context }) => {
    await setup(context);
    await signIn(page);
    const markup = '<img src=x onerror="document.title=\'pwned\'"><b>bold</b>';
    await messageFrom(page, APP, signInMessage((data) => {
      data.message.statement = markup;
      data.domain.name = '<i>Game</i>';
    }));
    await expect(page.getByRole('row', { name: `statement string ${markup}` })).toBeVisible();
    await expect(page.getByRole('row', { name: 'name <i>Game</i>' })).toBeVisible();
    expect(await page.locator('#view img, #view b, #view i').count()).toBe(0);
    expect(await page.title()).not.toBe('pwned');
  });

  test('a transaction written as a message is refused', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    const calls = [{ contractAddress: TOKEN, entrypoint: 'transfer', calldata: [GAME, ONE_AND_A_HALF, '0x0'] }];
    const execution = outsideExecution.getTypedData(CHAIN_ID as any, { caller: '0x414e595f43414c4c4552', execute_after: 0, execute_before: Math.floor(Date.now() / 1000) + 600 }, '0x1', calls, OutsideExecutionVersion.V2);
    const store = await messageFrom(page, APP, execution);
    await expect(page.getByText('Kamui will not sign this message')).toBeVisible();
    await expect(page.getByText('it is a transaction written as a message')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Go back' }).click();
    expect(await messageAnswer(page, store)).toMatchObject({ ok: false, error: expect.stringContaining('refused by the keychain') });
    expect(world.signatureChecks).toHaveLength(0);
  });

  test('a message for another network is refused', async ({ page, context }) => {
    await setup(context);
    await signIn(page);
    await messageFrom(page, APP, signInMessage((data) => (data.domain.chainId = 'SN_MAIN')));
    await expect(page.getByText("it is for another network than your account's")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign', exact: true })).toHaveCount(0);
  });

  test('a message request from another site in the app\'s name is refused', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    await messageFrom(page, OTHER_SITE);
    await expect(page.getByText('this request was not sent by the site it names')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign', exact: true })).toHaveCount(0);
    expect(page.url()).toBe(`${KEYCHAIN}/sign`);
    expect(world.signatureChecks).toHaveLength(0);
    // The refusal names both sites, shows nothing of the message, and offers no way on.
    await expect(page.locator('#view .origin')).toHaveText([APP, OTHER_SITE]);
    await expect(page.getByText('Sign in to Example Game')).toHaveCount(0);
    await expect(page.locator('#view a')).toHaveCount(0);
  });

  test('a message request with no referrer says why, shows nothing of the message, and offers a way back with only the error', async ({ page, context }) => {
    const world = await setup(context);
    await signIn(page);
    const store = memoryStore();
    const url = beginSignMessage({ keychainUrl: KEYCHAIN, redirectUri: `${APP}/`, appName: 'Example Game', typedData: signInMessage() }, store);
    // Typed or pasted into the address bar: there is no referrer.
    await page.goto(url);
    await expect(page.getByText('cannot tell which site sent this request')).toBeVisible();
    expect(page.url()).toBe(`${KEYCHAIN}/sign`);
    await expect(page.getByText('privacy or ad-blocking extension')).toBeVisible();
    await expect(page.getByText('its referrer policy')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign', exact: true })).toHaveCount(0);
    await expect(page.getByText('Sign in to Example Game')).toHaveCount(0);
    await expect(page.getByText('Example Game')).toHaveCount(0);

    const back = page.getByRole('link', { name: `Go back to ${APP}` });
    const href = new URL((await back.getAttribute('href'))!);
    const payload = JSON.parse(Buffer.from(new URLSearchParams(href.hash.slice(1)).get('kamui')!, 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['error', 'id', 'ok', 'v']);
    expect(payload).toMatchObject({ v: 1, ok: false, error: 'referrer_missing' });

    await back.click();
    await page.waitForURL(`${APP}/**`);
    let thrown: unknown;
    try {
      finishSignMessage(new URL(page.url()).hash, store);
    } catch (error) {
      thrown = error;
    }
    expect(isReferrerMissing(thrown)).toBe(true);
    expect(world.signatureChecks).toHaveLength(0);
  });

  test('a message request before any sign-in goes through sign-in, then to approval', async ({ page, context }) => {
    await setup(context);
    const store = await messageFrom(page, APP);
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await expect(page.getByRole('heading', { name: 'Signature request' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    expect(await messageAnswer(page, store)).toMatchObject({ ok: true, account: ACCOUNT });
  });
});

test.describe('page security', () => {
  test('pages are served with a strict content security policy and cannot be framed', async ({ request }) => {
    for (const path of ['/', '/connect', '/execute', '/sign', '/callback', '/main.js']) {
      const response = await request.get(path);
      const policy = response.headers()['content-security-policy']!;
      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain("script-src 'self'");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).not.toContain('unsafe-inline');
      expect(policy).toContain("'wasm-unsafe-eval'");
      expect(policy).toContain("worker-src 'self'");
      expect(policy).not.toContain("'unsafe-eval'");
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
    // Its own origin (which includes the session registry, behind /api), the chain, the pepper
    // service and the issuer's sign-in page. No CDN.
    expect([...origins].sort()).toEqual(['http://localhost:5183', 'http://localhost:5184', 'http://localhost:5185', 'https://accounts.google.com', 'https://sepolia.nodes.starknet.org'].sort());
  });
});
