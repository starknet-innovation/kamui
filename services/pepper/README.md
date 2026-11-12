# Kamui pepper service (reference implementation)

Returns the pepper that goes into a Kamui account's identity, `poseidon(iss, aud, sub, pepper)`, to a caller who shows a current Google or Apple login for that user. Plan decision D2. The design, its trade-offs and the open decisions are in [DESIGN.md](DESIGN.md).

**This is a reference, not a production service.** See "Limits" below. Do not create mainnet accounts with peppers from it.

## What it does

`POST /v1/pepper` with an ID token and a proof of the device key behind the token's nonce. The service:

1. verifies the token: RS256 against the issuer's JWKS, `iss`, `exp`, `iat`, maximum age, `aud` in the allow-list, nonce format;
2. verifies the key proof: the nonce opens to `(public_key, blinding)` and the signature over `poseidon("kamui.pepper.v1", nonce)` is by that key;
3. applies rate limits (per client address, per user);
4. returns `{ "pepper": "0x…", "key_version": 1 }`, where `pepper = low 250 bits of HMAC-SHA-256(key, iss, sub)`.

The pepper does not depend on `aud`, so override recovery gets the same value.

## Layout

| File | What it is |
|---|---|
| `src/derive.ts` | The derivation, as pure functions, and the `PepperDeriver` interface a KMS-backed deriver would implement. |
| `src/jwt.ts` | Token parsing and verification, JWKS fetch and cache. Ported from social-account (MIT), see `THIRD_PARTY.md`. |
| `src/keyproof.ts` | Nonce binding and the device-key signature check. |
| `src/ratelimit.ts` | In-memory token buckets. |
| `src/log.ts` | The closed log entry type. No field can hold a token, `sub`, pepper or key. |
| `src/app.ts` | The HTTP handler, with every dependency injected. |
| `src/config.ts`, `src/index.ts` | Environment and `Bun.serve`. |
| `test/` | Tests. They generate their own RSA and Stark keys and never reach the network. |

## Run

Developed and tested on Bun 1.4.4.

```sh
bun install
cp .env.example .env
# put a throwaway key in .env:  PEPPER_KEY_HEX=$(openssl rand -hex 32)
# set GOOGLE_AUDIENCES and/or APPLE_AUDIENCES to your OAuth client ids
bun run src/index.ts
```

Print the key check value of the configured key (to fill `PEPPER_KEY_CHECK`):

```sh
bun run src/index.ts --print-key-check
```

Example request:

```sh
curl -s localhost:8787/v1/pepper -H 'content-type: application/json' \
  -d '{"jwt":"<id token>","public_key":"0x…","blinding":"0x…","signature":["0x…","0x…"]}'
```

Set `REQUIRE_KEY_PROOF=false` to send only `jwt` while the SDK side is not written yet.

## Test

```sh
bun test
bun x tsc --noEmit
```

In this repo the system `bun` may be too old; the spike tooling has a recent one:

```sh
/Users/adrienlacombe/ws/kamui/spikes/s1/tools/node_modules/.bin/bun test
```

The tests cover:

- derivation: determinism, different `sub`, different `iss`, different key, injective encoding, always below `2^250` and so below the field prime, a pinned vector;
- same pepper across two allowed `aud` values for the same user;
- rejection of a bad signature, expired token, future or too-old token, unknown `aud`, wrong `iss`, unknown `kid`, `alg: none`, HS256, malformed input;
- key proof: token alone, another device's proof, a signature by another key;
- rate limits, CORS, the JWKS cache, configuration checks;
- logs contain no `sub`, token part, nonce, pepper, key, device key or client address;
- identity: the returned pepper gives the same identity under upstream's `extractIdentity` and under the Cairo formula written out by hand, both of which reproduce the value pinned from the Cairo test `identity_reference`; and the override case rebuilds the original identity from a token under the recovery `aud`.

## Limits

- **The key is read from an environment variable.** That is for development only. Production needs the key in an HSM or KMS behind the `PepperDeriver` interface, generated and backed up as DESIGN.md section 5 describes. None of that exists here.
- Rate-limit state and the JWKS cache are per process. Several instances need shared limits or a limit at the edge.
- If an issuer's JWKS endpoint is down after the cache has expired, the service keeps using the last keys it saw and retries on every request. There is no bound on how stale those keys may be and no backoff.
- One key version only.
- No metrics, no tracing, no TLS (run it behind something that provides TLS and does not log bodies).
- `TRUST_PROXY=true` trusts the last `X-Forwarded-For` hop. Only correct behind exactly one proxy you control.
- The key proof was tested against `@scure/starknet` only, not against the Kamui SDK.
- Not audited, not load-tested, no independent review of the derivation or the code.

## Licence and third-party code

MIT, as the rest of the repo. `src/jwt.ts` is ported from keep-starknet-strange/social-account; see [THIRD_PARTY.md](THIRD_PARTY.md). No Cartridge code was used or consulted.
