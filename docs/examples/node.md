# Node.js

A script, bot or game server can act for a user with a Kamui session, like a browser app does. The user approves the session once in their browser; the session key stays on your machine; your process then signs and sends calls on its own until the session ends.

The code is type-checked against the SDK in CI. Full files: [`docs/snippets/node`](https://github.com/starknet-innovation/kamui/tree/main/docs/snippets/node).

## Installation

Install `@kamui/sdk` and `starknet@10.8.0` as in the [Quickstart](/guide/quickstart#_1-add-the-sdk).

The SDK is plain ESM, so Node.js 22 or later imports it with no loader or flag. The files below are TypeScript: run them with **Bun** (`bun run main.ts`) or **tsx** (`npx tsx main.ts`), or compile them first.

## How the approval works

The keychain only answers pages on the origin it redirects to, and allows `http:` only for `localhost`. So the script starts a small local server for the round trip:

1. It prints `http://localhost:8765/start`. The user opens it.
2. `/start` is a page that sends the browser on to the keychain. A page is needed, not a `302`: the keychain checks the referrer, and a URL pasted into the address bar has none.
3. The user signs in and approves the session.
4. The keychain sends the browser back to `/callback`. The answer is in the URL fragment, which browsers never send to servers, so the page posts it to `/answer`.
5. The script reads the answer, stores the connection and closes the server.

Next time the script runs, it reuses the stored session if it is still alive on chain.

## Basic setup

### A file store

The SDK keeps its state in a `KeyValueStore`. On a server, use a file with owner-only permissions. It holds the session's private key.

<<< @/snippets/node/file-store.ts

### The localhost round trip

<<< @/snippets/node/connect.ts

### Using the session

A server can hold the sponsorship credential itself, so it calls Kamui's sponsor endpoint directly.

<<< @/snippets/node/main.ts

```sh
STARKNET_RPC_URL=https://YOUR-SEPOLIA-RPC \
KAMUI_APP_KEY=my_app_key KAMUI_SPONSOR_TOKEN=... \
bun run main.ts
# Approve the session in your browser: http://localhost:8765/start
# connected as 0x0123…
# sent 0x0456…
# confirmed
```

## Important notes

1. **Storage.** The store defaults to `.kamui/session.json` in the working directory; set `KAMUI_STORAGE_PATH` to move it. Add `.kamui/` to `.gitignore`. Anyone with the file can act within the session until it ends.
2. **First run.** The approval must happen in a browser on the same machine (it talks to `localhost`). For a remote server, forward the port (`ssh -L 8765:localhost:8765 host`) and open the link locally.
3. **Persistence.** Sessions end at `validUntil`, on revocation, and whenever the user adds or removes a device. `connect()` checks that on start; long-running processes should check `isConnectionAlive` periodically and on failures.
4. **Errors.** `sponsor()` throws `sponsor: CODE` with the codes in [Errors](/reference/errors). A timeout may still have spent the nonce: check the chain before you retry.
5. **Nonces.** Keep the `offset` that `sessionCall` returns and pass it back for the next call, so each send does not re-scan used nonces. See [Sessions](/guide/sessions#how-many-calls).
6. **Secrets.** Keep `KAMUI_SPONSOR_TOKEN` in your secret manager, not in the repository.

## No headless mode

There is no way to get a session without a user approving it in the keychain, and no app-managed owner keys. Every Kamui account belongs to a person who signed in with Google.
