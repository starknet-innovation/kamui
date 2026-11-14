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

If the request arrives with no referrer, the keychain does not redirect. It explains the refusal to the user and offers a link they may click to `redirectUri#kamui=<answer>` with `"error": "referrer_missing"`. That answer carries the `id` the request named and nothing else. See [Troubleshooting: the referrer](/reference/errors#troubleshooting-the-referrer).

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

## Signing session calls

A sponsored session call is an SNIP-9 v2 outside execution (`execute_from_outside_v2`) on the user's account.

1. **Nonce.** Call `get_session_nonce_base(session_pubkey)` on the account and pick the first `base + i`, `0 ≤ i < maxCalls`, for which `is_valid_outside_execution_nonce` returns true. Any other nonce is refused.
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
