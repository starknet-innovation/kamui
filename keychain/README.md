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
- **What an amount means.** Amounts are shown in whole units with the token's name ("1.5 STRK"), exactly, next to the raw value. Kamui recognises STRK and ETH by address. For any other contract that answers like a token it shows the name as a claim ("says it is GOLD") with a caution, because anyone can deploy a token with any name. For a contract it cannot identify it shows raw units and says the amount may not be what it looks like. An allowance with no limit is called unlimited.

## Where the device key lives

In IndexedDB, in the keychain's origin, encrypted with an AES-GCM key that the browser will not export (`src/vault.ts`). A Stark-curve key cannot itself be a non-exportable browser key, so this is the closest available: the stored bytes are useless elsewhere, and no script can read the wrapping key. Code running in the keychain's origin can still use the key, which is why the page is served with a strict content security policy (only its own script and style, no framing) and loads nothing from third parties.

The account address, the pepper and the recovery file are stored the same way. So are two things that wait there for a short time: a recovery file chosen for a sign-in, and sessions the registry has not recorded yet (both below).

## Signing in

With Google, or with Apple when the server has an Apple client id (`APPLE_CLIENT_ID`, or `AUTHORIZED_APPLE_RECOVERY_CLIENT_ID` in the backend's local file). Without one the Apple button is not shown. An Apple sign-in and a Google sign-in are two different users with two different accounts.

**Apple has not been tried against Apple.** The browser tests use a fake issuer that answers the way Apple documents for `response_mode=fragment` (a token and a code in the fragment, no scope). Apple does not accept `http://localhost` as a redirect address, so it cannot be tried with this dev server at all; it needs an https domain registered with Apple. Whether the backend and the contracts accept an Apple token is theirs to show.

**With a recovery file.** The sign-in page takes a recovery file. When one is chosen, the account's pepper comes from the file and the pepper service is not contacted, including when the file turns out to be wrong: there is no fallback. The file is checked in three steps:

1. When it is chosen: that it is a recovery file, for this network and this account class. A refused file is dropped on the spot.
2. When a sign-in button is clicked: that it was made for that issuer and this application.
3. When the issuer has answered: that the file's pepper and the signed-in user give the file's account (`pepperFromFile`). Only then is anything sent. A file for someone else stops the sign-in with nothing changed.

During the trip to the issuer the file is kept in the vault, encrypted like the device key, not in web storage. The tab only remembers that this sign-in uses a file. The file is taken out of the vault as soon as the user is back, before anything is checked, and is also removed by the next sign-in that starts and by "forget this device". If it is gone when the user comes back (another tab started a sign-in meanwhile), the sign-in stops and asks to start again.

## Sessions

The account page lists the sessions that are live on the account, each with a "Revoke" button, and has "Revoke all sessions".

The account contract cannot list its sessions, so the keychain keeps a record of each one in the session registry (`../sdk/src/registry.ts`; the server is the backend's). The registry only helps to find sessions. What the page shows is read from the account:

- A record is shown only if its session exists on the account and has not expired. Records of dead sessions are removed from the registry in the background.
- The expiry, the transaction count and the fee cap are the account's. Each call in the record is shown only if the account confirms the session may make it. Spending limits are the account's, for every token the record names or the session may spend.
- If the account holds more permissions for the session than the record accounts for, the page says so. If the session may spend a token with no limit, the page says so.
- The site's origin and the name it gave are not on chain. They are what was recorded at approval, and are written as text.

**When the registry cannot be reached at approval.** The session is real once the account has it, so the user goes back to the app regardless; the keychain waits at most five seconds for the registry. The record is written to this device's storage before the registry is asked and removed once the registry has it. If the registry failed, the account page on this device still lists the session from that copy, says that Kamui's list could not be loaded when that is the case, and sends the record again on each visit until it is accepted. A session approved this way does not show on the user's other devices until then.

The same holds when the registry answers but refuses the record. A full registry (`REGISTRY_FULL`, 50 live records for an account) leaves the session on this device, and the page says the list is full. A session that expired before its record got through (`SESSION_EXPIRED`) is dropped: there is nothing left to list.

**The registry is untrusted display data.** Its requests are signed by this device's key over the whole record, and the server accepts each signed request once, so a record cannot be altered or re-sent by someone who sees it in transit. The server itself can still answer anything. Nothing the keychain does with a session depends on a record being right: a record only tells it which session keys to look up on the account, and supplies the site's origin and name, which are shown as text and may be wrong. Session keys are compared by value, never as strings.

**"Revoke"** sends one sponsored call from the account, `revoke_session_key`, signed by this device's key, and then removes the record. **"Revoke all sessions"** sends `revoke_all_sessions` after a confirmation. It needs nothing from the registry, so it works when the registry is empty, wrong or down, and it is the way to end a session that is not listed.

## Pages

| Page | What it does |
|---|---|
| `/connect` | Receives an app's request for a session, then sign-in if needed, then the approval screen. |
| `/execute` | Receives an app's request for one transaction, then sign-in if needed, then the approval screen. |
| `/callback` | Where the issuer returns after a sign-in. |
| `/` | Sign-in, with Google or Apple and optionally a recovery file. Then the account: device keys with removal, sessions with revocation, the recovery file, and "forget this device". |

## Run

With the prover, the backend api and the pepper service running locally (see `../services/backend/README.md` and `../services/pepper/README.md`):

```sh
bun install
bun run server.ts      # http://localhost:5173
```

`../apps/demo-dapp` is a small app that connects through it. Settings come from the backend's local files. The Google OAuth client must allow `http://localhost:5173/callback`, and the pepper service must allow `http://localhost:5173` as an origin. The session registry is reached through `/api/registry/sessions`, so the backend must serve it.

## Tested

- **The protocol,** its refusals and the app-side helpers: 23 tests in `../sdk/test/keychain.test.ts`.
- **The pages and key storage, in three browsers:** 63 tests in `tests/`, each run in Chrome (the installed one), Firefox and WebKit (Playwright's builds), 189 runs in all. They run the real keychain server, page, storage and content security policy, and replace everything outside the keychain (the chain, the backend, the session registry, the pepper service and the issuers) with fakes at the network level. They cover:
  - sign-in with Google and with Apple, a remembered device, a stale sign-in page, a key removed elsewhere, an error from the issuer, and no Apple button without an Apple client id;
  - sign-in with a recovery file: the pepper service never contacted, the file a device downloads signing another device in, how the file is stored during the trip, and files refused for another user, network, class, application or issuer, or for not being a recovery file;
  - how the key is stored, and forgetting the device;
  - approving and denying a session or a single transaction, the requests the keychain refuses, how token calls and amounts are described for known, unverified and unidentified tokens, an app name containing markup;
  - the session list: a session recorded at approval with an owner signature the fake registry verifies, revocation sending exactly `revoke_session_key` for that key, "Revoke all sessions" with a registry that is down or empty, a registry that is down or full at approval, keys formatted differently from the account's, a record whose session does not exist or has expired, markup in a recorded origin or name, malformed records, and a record that disagrees with the account;
  - removing a device, the recovery file download, and the content security policy.
- **Live on Sepolia** on 2026-11-12, through the demo app: sign-in on a new device, the approval screen, a sponsored session call, a call outside the session refused by the account, and the device list (`../spikes/s1/results/RESULTS.md`, run 6); and one transaction approved in the keychain (run 7).

```sh
bun install
./node_modules/.bin/playwright install firefox webkit   # once; Chrome is the installed one
bun run test                                            # set BUN to the bun binary if `bun` on PATH is older than 1.2
./node_modules/.bin/playwright test --project=firefox   # one browser
```

The browser tests found three things, all fixed: a refused request stayed in the address bar; the page waited five seconds before its first look for a transaction (now two, and configurable with `POLL_MS`); and after a declined confirmation or a recovery file download every button on the account page stayed disabled until a reload.

### Browsers

All 63 tests pass in Chrome, Firefox and WebKit with no change to the keychain. The points that could have differed did not: a `CryptoKey` that cannot be exported is stored in and read back from IndexedDB in all three, the app's origin arrives in `document.referrer` in all three with default settings, and the recovery file downloads in all three. The one change was in the fakes: WebKit cannot be handed a 302 as a faked answer, so the fake issuers answer with a page that navigates.

What this does not show:

- **WebKit is not Safari.** Playwright's WebKit is the engine without Safari's own policies. In particular, Safari deletes a site's script-written storage, IndexedDB included, after seven days in which the user did not interact with the site. For the keychain that means the device key is gone and the next visit is a sign-in on a "new" device, which ends every session. This has not been tried and nothing here addresses it.
- **Private windows** were not tried in any browser. Storage there is short-lived at best.
- **Referrer settings.** A browser or an extension set to send no referrer makes every request look like it came from nowhere, and the keychain refuses it. This is by design, but the user is told only that the keychain "cannot tell which site sent this request".
- **Mobile browsers** were not tried.

## Not done

- **Removing a device, the recovery file download, a sign-in from a recovery file, the session list, revocation and "forget this device"** are covered by the browser tests against fakes, and were not exercised on a live network.
- **The session registry was only ever a fake here.** The client follows the registry protocol (`kamui.registry.v2`) and the fake checks the signature the way the spec describes, but the keychain has not been run against the backend's registry.
- **A sign-in from a recovery file when the pepper service is really gone.** The keychain does not contact it, and the backend confirms a pepper with the pepper service only before it deploys a new account, so a sign-in to an existing account goes through (backend tests, `recover.test.ts`). The two were not run together.
- **Safari itself,** private windows and mobile browsers (see Browsers above).
- **Apple against Apple** (see Signing in), and override recovery.
- **Only STRK and ETH are recognised by address.** Every other token, including well-known ones, is shown as unverified. The list is in `../sdk/src/tokens.ts` and needs an owner and a process before it grows.
- **Token names and amounts were not checked in a live run,** only in the browser tests against a fake chain.
- **A single transaction is always sponsored.** There is no path for the account to pay its own fee from the keychain.
- **Sessions the registry does not know.** A session approved while the registry was down shows only on the device that approved it until the record gets through, and a session whose record is lost shows nowhere. "Revoke all sessions" still ends them.
- **The registry trusts the keychain's clock** to within five minutes. A device whose clock is further off cannot list or record sessions; the page then says the list could not be loaded.
- **Embedded modes** (iframe with the Storage Access API, or popup) for apps that cannot afford a page reload.
- **A production build and domain.** The domain can never change once accounts exist: the OAuth redirect and the stored keys are bound to it.
- **Sponsoring is the backend's development endpoint,** not a paymaster.
