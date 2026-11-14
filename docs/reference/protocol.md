# Keychain protocol

The keychain protocol is version 1: full-page redirects with JSON in the URL fragment. Use it to integrate from a language without the TypeScript SDK. The reference implementation is [`sdk/src/keychain.ts`](https://github.com/starknet-innovation/kamui/blob/main/sdk/src/keychain.ts).

## Encoding

A request or answer travels as `#kamui=<payload>`, where `<payload>` is the JSON object, UTF-8 encoded, then **base64url without padding**.

All felts are `0x`-prefixed hex strings of 1 to 64 hex digits. Request ids are random felts in lowercase hex.

## Connect

Send the user to `GET {keychainUrl}/connect#kamui=<payload>`:

```json
{
  "v": 1,
  "id": "0x5c1e…",
  "redirectUri": "https://mygame.example/",
  "appName": "My game",
  "session": {
    "publicKey": "0x0123…",
    "validUntil": 1763200000,
    "maxCalls": 200,
    "maxFeePerTx": "0x0",
    "calls": [
      { "to": "0x2f8c…", "entrypoint": "ping" },
      { "to": "0x0471…", "entrypoint": "transfer" }
    ],
    "limits": [
      { "token": "0x0471…", "maxPerCall": "0xde0b6b3a7640000", "maxPerWindow": "0x4563918244f40000", "windowSeconds": 86400 }
    ]
  }
}
```

| Field | Rule |
|---|---|
| `redirectUri` | `https:`, or `http:` with host `localhost`. No fragment. Its origin must equal the origin of the page that navigated to the keychain (`document.referrer`). |
| `appName` | Optional, at most 60 characters. Shown as text next to the origin. |
| `session.publicKey` | The Stark public key (x coordinate) of the session key. You keep the private key. |
| `session.validUntil`, `session.maxCalls` | Positive integers. `validUntil` is unix seconds. |
| `session.calls` | At least one entry, at most 64. `entrypoint` matches `[A-Za-z_][A-Za-z0-9_]{0,63}`. |
| `session.limits` | Required for each token whose `transfer`, `approve`, `increase_allowance` or `increaseAllowance` is in `calls`. |

The keychain redirects to `redirectUri#kamui=<answer>`:

```json
{ "v": 1, "id": "0x5c1e…", "ok": true, "account": "0x07a1…", "chainId": "0x534e5f5345504f4c4941", "classHash": "0x1e12…" }
{ "v": 1, "id": "0x5c1e…", "ok": false, "error": "denied by the user" }
```

Check that `id` matches the request you sent before trusting the answer.

### Renewing

A connect request whose `session.publicKey` already has a session on the account is a renewal. There is no separate message: the keychain reads the account, shows the request as a renewal, and on approval the account replaces the session under the same key. The nonce base changes, the call count and the spending periods start again, and anything signed for the previous session is refused. The keychain refuses a renewal whose origin differs from the one it recorded for that key.

## Execute

Send the user to `GET {keychainUrl}/execute#kamui=<payload>`:

```json
{
  "v": 1,
  "kind": "execute",
  "id": "0x9a0b…",
  "redirectUri": "https://mygame.example/",
  "appName": "My game",
  "calls": [{ "to": "0x0471…", "entrypoint": "approve", "calldata": ["0x2f8c…", "0x14d1120d7b160000", "0x0"] }]
}
```

At most 10 calls and 100 calldata felts per call. No call may target the user's account. The answer is `{ v, id, ok: true, transactionHash }` or `{ v, id, ok: false, error }`. The transaction has been accepted by the network when the user comes back.

## Sign a message

Send the user to `GET {keychainUrl}/sign#kamui=<payload>`:

```json
{
  "v": 1,
  "kind": "signMessage",
  "id": "0x77d2…",
  "redirectUri": "https://mygame.example/",
  "appName": "My game",
  "typedData": {
    "types": {
      "StarknetDomain": [
        { "name": "name", "type": "shortstring" },
        { "name": "version", "type": "shortstring" },
        { "name": "chainId", "type": "shortstring" },
        { "name": "revision", "type": "shortstring" }
      ],
      "SignIn": [
        { "name": "statement", "type": "string" },
        { "name": "nonce", "type": "felt" }
      ]
    },
    "primaryType": "SignIn",
    "domain": { "name": "My game", "version": "1", "chainId": "SN_SEPOLIA", "revision": "1" },
    "message": { "statement": "Sign in to My game", "nonce": "0x1234" }
  }
}
```

| Rule | |
|---|---|
| Revision | SNIP-12 revision 1 only: a `StarknetDomain` type and `domain.revision` = 1. |
| Network | `domain.chainId` must be the chain of the user's account. |
| Size | The typed data is at most 16,384 characters of JSON and 200 values. |
| Message | Every value of `message` must be declared by its type, and every declared value present. |
| Never signed | A message whose domain name is `Account.execute_from_outside` (an outside execution): that is a transaction. Use [execute](#execute). |

The user is shown the requesting origin, the domain, and every value of the message with its type. The answer is `{ v, id, ok: true, account, chainId, signature }` or `{ v, id, ok: false, error }`. `signature` is `[r, s]` from one of the account's owner keys, over the SNIP-12 message hash for `account`.

The answer comes back through the browser, so verify it where it matters: call `is_valid_signature(hash, signature)` on `account` and expect `'VALID'` (`0x56414c4944`).

## Signing messages with a session

A live session can sign any SNIP-12 message as the account, without the keychain: Stark ECDSA over the message hash for the account, sent as `[session_pubkey, r, s, valid_until]`. `is_valid_signature` accepts it while the session exists and has not expired. The session's scope and limits do not apply to messages, and the signature stops verifying when the session ends.

## Popup mode

The requests and answers above are unchanged when the keychain runs in a popup; the keychain does not know the difference. Two conventions are added around them, both in [`sdk/src/popup.ts`](https://github.com/starknet-innovation/kamui/blob/main/sdk/src/popup.ts):

- The app adds the query parameter `kamui_popup=1` to `redirectUri`. Its page at that address, seeing the parameter and an answer in the fragment, posts `{ "kamui": "popup-result", "fragment": "#kamui=<answer>" }` on the `BroadcastChannel` named `kamui.popup` (and to `window.opener` with its own origin as the target, if there is one), then closes. The page that opened the popup takes the first such message whose answer carries its request's `id`.
- Before it navigates to the issuer, a keychain that has a pending request and a `window.opener` posts `{ "kamui": "leaving-for-issuer", "id": "<request id>" }` to the opener, with the origin of `redirectUri` as the target origin. It tells the app that the popup may from now on look closed without being closed.

## Signing session calls

A sponsored session call is an SNIP-9 v2 outside execution (`execute_from_outside_v2`) on the user's account.

1. **Nonce.** Call `get_session_nonce_base(session_pubkey)` on the account and pick a `base + i`, `0 ≤ i < maxCalls`, for which `is_valid_outside_execution_nonce` returns true. Any other nonce is refused. The account accepts the range in any order and keeps no count of it; if you use it in order, the used nonces are a prefix and a binary search finds the first free one. The base changes whenever the session is renewed, so read it each time.
2. **Hash.** The SNIP-12 (revision 1) message hash of the `OutsideExecution` struct for the account, with `caller` = `ANY_CALLER` (`0x414e595f43414c4c4552`), `execute_after` = 0, `execute_before` ≤ `validUntil`, your nonce and calls. starknet.js: `outsideExecution.getTypedData(..., OutsideExecutionVersion.V2)`.
3. **Signature.** Stark ECDSA over the hash with the session private key, sent as `[session_pubkey, r, s, valid_until]`.
4. **Call.** `execute_from_outside_v2(outside_execution, signature)` on the account. Post `{ account, calldata }` to the [sponsor endpoint](/guide/sponsorship).

Self-paid session transactions use the same four-felt signature over the transaction hash.

## Chain

| | Sepolia |
|---|---|
| Keychain | `https://sepolia.kamui.page` |
| Sponsor endpoint | `https://sepolia.kamui.page/api/sponsor` |
| Chain id | `SN_SEPOLIA` (`0x534e5f5345504f4c4941`) |
| Account class hash | Returned in each connect answer as `classHash` |
