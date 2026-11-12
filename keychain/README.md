# Kamui keychain

The page a user signs in on, where their device key lives, and where they approve what an app may do. Version 1, development only: not audited, and served by a local dev server.

## How an app uses it

Full-page redirects, like an OAuth login (`../sdk/src/keychain.ts`):

1. The app creates a session key and sends the user to `/connect` with a request: where to come back to, and what the session should be allowed to do.
2. The keychain signs the user in if needed, shows the request, and on approval has the account register the session.
3. The keychain sends the user back with the account address. The app then signs calls with its session key and has them sponsored. The keychain is not involved again until the session ends.

For anything a session does not cover, the app sends the user to `/execute` with the calls it wants. The keychain shows them, and on approval the account sends them once, with its full authority. The user comes back with the transaction hash.

The session's private key never leaves the app, and the device key never leaves the keychain.

Why redirects and not an iframe or a popup: browsers isolate storage inside third-party iframes, so one keychain shared by every app does not work in an iframe without extra browser permissions; and a popup can lose its link to the app while it visits the issuer. Redirects have neither problem. The cost is that the app's page reloads when the user connects.

## What the keychain checks

- **Who is asking.** It shows the origin the answer will go to, and refuses a request that did not come from a page on that origin (the browser's referrer). A link on another site cannot ask in an app's name.
- **What is asked.** For a session it refuses, whatever the user clicks: token calls with no spending limit, functions a session can never call, the account itself as a target, and any scope that does not name its contracts. For a single transaction it refuses any call to the account itself: device keys, sessions and spending limits are only ever changed from the keychain's own pages, never at a site's request.
- **What it tells the user.** For a session: the contracts and functions, the expiry, the transaction and fee limits, the spending limits, that the app can sign messages as the account while the session lasts, and that signing in on a new device ends every session. For a single transaction: every call, that it uses the account's full authority, and in plain words when a call sends tokens out or lets another address spend them.

## Where the device key lives

In IndexedDB, in the keychain's origin, encrypted with an AES-GCM key that the browser will not export (`src/vault.ts`). A Stark-curve key cannot itself be a non-exportable browser key, so this is the closest available: the stored bytes are useless elsewhere, and no script can read the wrapping key. Code running in the keychain's origin can still use the key, which is why the page is served with a strict content security policy (only its own script and style, no framing) and loads nothing from third parties.

The account address, the pepper and the recovery file are stored the same way.

## Pages

| Page | What it does |
|---|---|
| `/connect` | Receives an app's request for a session, then sign-in if needed, then the approval screen. |
| `/execute` | Receives an app's request for one transaction, then sign-in if needed, then the approval screen. |
| `/callback` | Where the issuer returns after a sign-in. |
| `/` | The account: device keys with removal, the recovery file, and "forget this device". |

## Run

With the prover, the backend api and the pepper service running locally (see `../services/backend/README.md` and `../services/pepper/README.md`):

```sh
bun install
bun run server.ts      # http://localhost:5173
```

`../apps/demo-dapp` is a small app that connects through it. Settings come from the backend's local files. The Google OAuth client must allow `http://localhost:5173/callback`, and the pepper service must allow `http://localhost:5173` as an origin.

## Tested

- **The protocol,** its refusals and the app-side helpers: 23 tests in `../sdk/test/keychain.test.ts`.
- **The pages and key storage, in Chrome:** 29 tests in `tests/`. They run the real keychain server, page, storage and content security policy, and replace everything outside the keychain (the chain, the backend, the pepper service and the issuer) with fakes at the network level. They cover sign-in, a remembered device, a stale sign-in page, a key removed elsewhere, how the key is stored, forgetting the device, approving and denying a session or a single transaction, the requests the keychain refuses, how token calls are described, an app name containing markup, removing a device, the recovery file, and the content security policy.
- **Live on Sepolia** on 2026-11-12, through the demo app: sign-in on a new device, the approval screen, a sponsored session call, a call outside the session refused by the account, and the device list (`../spikes/s1/results/RESULTS.md`, run 6); and one transaction approved in the keychain (run 7).

```sh
bun install
bun run test        # needs Google Chrome; set BUN to the bun binary if `bun` on PATH is older than 1.2
```

The browser tests found two things, both fixed: a refused request stayed in the address bar, and the page waited five seconds before its first look for a transaction (now two, and configurable with `POLL_MS`).

## Not done

- **One browser.** The tests run in Chrome only. Safari and Firefox store keys and send referrers under their own rules and have not been tried.
- **Removing a device, the recovery file download and "forget this device"** are covered by the browser tests against fakes, and were not exercised on a live network.
- **A login from a recovery file,** Apple, and override recovery.
- **Token amounts are shown in the smallest unit.** The keychain does not look up a token's name or decimals, so the user has to know them.
- **A single transaction is always sponsored.** There is no path for the account to pay its own fee from the keychain.
- **A list of live sessions** with revocation. The account does not enumerate sessions; this needs the session and app registry (plan, Phase 2 step 4).
- **Embedded modes** (iframe with the Storage Access API, or popup) for apps that cannot afford a page reload.
- **A production build and domain.** The domain can never change once accounts exist: the OAuth redirect and the stored keys are bound to it.
- **Sponsoring is the backend's development endpoint,** not a paymaster.
