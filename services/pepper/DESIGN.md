# Pepper service: design note

Status: draft for review, 2026-11-12. Implements plan decision D2. A reference implementation of the recommended design is in `src/` (see `README.md` for its limits).

This note makes one recommendation per topic and lists the decisions it needs from the project owner in section 10. Statements about third-party products that were not checked are listed in section 12.

## 1. Context

- An account's `identity = poseidon(iss, aud, sub, pepper)`. `iss`, `aud` and `sub` are Cairo ByteArrays, the pepper is one felt252 (`contracts/src/jwt/types.cairo`).
- The account address is derived from `(class hash, aud, identity)`.
- The contract never checks the pepper. In `prove_jwt` the caller supplies it and the contract only checks that the resulting identity equals the stored one (`contracts/src/social/component.cairo`). In override recovery it rebuilds the identity under the account's original `aud` with the same pepper.
- So the pepper must be the same for a user under every `aud`. It is a function of `(iss, sub)` only.
- The pepper is fixed for the life of an account. Accounts are not upgradeable (D1).

## 2. What the pepper protects, and what it does not

### Without a pepper (pepper = 0)

`iss` is one of two public strings. `aud` is SNF's OAuth client id, visible in every login URL. The class hash is public. The only unknown in the address is `sub`.

Anyone who knows a user's `sub` can compute the user's address and read its balances and history. Who knows a `sub`:

- Google: per Google's documentation the `sub` is one identifier per Google account, the same for every app. Every app or site the user has signed into with Google holds it, and so does anyone who obtains one of those apps' user tables.
- Apple: per Apple's documentation the `sub` is scoped to the developer team, so only SNF's own apps see the value used here.

(Both statements are from memory of the issuers' documentation and should be confirmed; see section 12.)

It also works in reverse: someone holding a list of `sub`s can test each against an address.

### With a pepper

The address can be computed only by a party that knows the pepper. Those are:

| Party | Knows the pepper? | Why |
|---|---|---|
| The user's devices | Yes | They ask for it after login. |
| The pepper service (whoever holds its key) | Yes, for any `(iss, sub)` | It derives it. |
| SNF's recover API and prover, with backend proving (D9) | Yes, for each user who logs in | The client sends the JWT and the pepper. |
| Other apps that know the user's `sub` | No | |
| Google or Apple | No | They know the `sub` and can see that the user logs in to Kamui, but cannot compute the address. |
| A chain observer | No | The chain shows the identity hash, not its inputs. Whether the pepper can be read from a SNIP-36 proof or its public facts was not checked (section 12). |

### What the pepper is not

- **Not an authentication factor.** Knowing a pepper does not let anyone recover an account. Recovery needs a token signed by the issuer whose nonce commits to the new key. The pepper only decides who can link a login identity to an address.
- **No protection against SNF.** SNF runs the service and, through the keychain and prover, sees its users' `sub`s. SNF can compute the address of every user. This belongs in the public trust statement (plan section 7).
- **No protection against the issuers taking over an account.** Google and Apple can still mint a token for any of their users (plan section 7).
- **No on-chain privacy.** The address and its activity are public as before. Once a user tells someone their address, the pepper has nothing left to hide from that person.

### What the service operator can do

- Compute the address for any `(iss, sub)` it knows.
- Refuse to answer, for everyone or for chosen users. That blocks account creation and logins on new devices. It does not affect existing device keys.
- Return a wrong pepper. The client then derives a different, empty account. The user's real account is untouched, but the user sees no funds, and anything sent to the wrong address is only reachable while that wrong pepper can be obtained again.
- It cannot take over an account or move funds by itself.

## 3. Derivation

### Options

| Option | How | For | Against |
|---|---|---|---|
| **A. Keyed PRF** | `HMAC-SHA-256(key, iss, sub)`, mapped to a felt | One standard primitive. The MAC can run inside an HSM or KMS so the key never leaves it. Stateless: the only thing to back up is one 32-byte key, once. | One key holder. The service sees the `sub` (it has to, to authenticate the caller). |
| B. Random pepper per user, stored | Database row per `(iss, sub)` | No master key whose leak exposes everyone at once. | The database must be backed up continuously, and rows lost since the last backup are accounts that can never be recovered. It stores a table from login identity to pepper, which is the sensitive link itself. Rejected. |
| C. OPRF (RFC 9497) | Client blinds the input, service evaluates without seeing it | The service would not learn which user it derives for. | The service must authenticate the caller with the JWT, which contains the `sub`, so it sees the input anyway unless the client also proves in zero knowledge that the blinded input matches the token. With backend proving (D9) SNF's prover receives the JWT and the pepper regardless. No gain in v1. The verifiable variant would let clients detect a wrong answer; noted for later. |
| D. Threshold (split key) | The key is shared among n parties; t must cooperate for each answer | No single party can leak or lose the key. | HMAC needs general multi-party computation to split. A Diffie-Hellman style PRF (`H2(x, H1(x)^k)`, the construction under RFC 9497) splits naturally with Shamir shares, but that is a different function with different outputs, needs several independent operators, and has no ready-made HSM or KMS operation. More parts to run and audit. |

### Recommendation: A

`pepper = low 250 bits of HMAC-SHA-256(key, encode(iss, sub))`, with a single 256-bit key generated offline, held in an HSM or KMS for operation, and backed up as Shamir shares (section 5).

The choice between A and D is the one that cannot be revisited. Peppers are permanent, so the function chosen at launch is the function for those accounts forever. Moving from A to a threshold scheme later is only possible for new accounts (a second key version), or by running multi-party computation over HMAC. If "no single party holds the key" is a launch requirement, choose D now. This is question 1 in section 10.

### Exact definition

```
message = "kamui.pepper.v1" || 0x00
          || u32be(len(iss)) || utf8(iss)
          || u32be(len(sub)) || utf8(sub)
mac     = HMAC-SHA-256(key, message)            // 32 bytes
pepper  = big_endian_integer(mac) mod 2^250     // clear the top 6 bits
```

- The tag separates this use of the key from any other. The length prefixes make the encoding injective: no two `(iss, sub)` pairs give the same message.
- `iss` is the exact claim string the contract accepts (`https://accounts.google.com` or `https://appleid.apple.com`). `aud` is deliberately not an input.
- The pepper is returned as lowercase `0x` hex.

### Mapping to a felt252, and why it is safe

The Starknet field prime is `P = 2^251 + 17 * 2^192 + 1`. A 250-bit integer is below `2^250`, which is below `P`, so every output is a valid felt with no reduction step.

- **Unpredictable.** HMAC-SHA-256 is assumed to be a PRF. Dropping bits of a PRF output leaves a PRF, so without the key the pepper is indistinguishable from a uniform 250-bit value. Guessing one succeeds with probability `2^-250`.
- **No bias.** Truncation gives each of the `2^250` values equal weight. Reducing 256 bits modulo `P` instead would make some residues about 3% more likely than others; that would not be exploitable here, but truncation avoids having to argue it. Reducing a 512-bit output modulo `P` would also be unbiased but needs a second primitive and big-integer arithmetic for no benefit.
- **One representation.** Every pepper is already canonical (below `P`), so the hex string, the calldata felt and the value hashed on chain are the same number everywhere. A value at or above `P` would be reduced by some tools and rejected by others.
- **Opaque to the contract.** The contract appends the pepper as the last felt after three length-delimited ByteArrays and hashes with Poseidon. It places no other requirement on the value.
- **Simple to reproduce.** A KMS returns the 32-byte MAC; the mapping is a mask. An auditor can check a test vector by hand.

A pepper of exactly 0 has probability `2^-250` and is not special-cased.

## 4. Authentication

The service answers only a caller who shows a current login for the user in question.

Checks, in order:

1. `alg` is `RS256`. Anything else, including `none` and HMAC algorithms, is refused before a key is looked up.
2. `iss` is one of the two issuers the contract accepts, by exact string.
3. The signature verifies against the issuer's JWKS key with the token's `kid`. Keys are cached (one hour); an unknown `kid` triggers at most one refetch per minute.
4. `exp` is in the future. No leeway.
5. `iat` is not in the future (60 s leeway) and not older than a maximum age (default 600 s).
6. `aud` is in the allow-list for that issuer. Under D3 the list is the keychain client and the override-recovery client. Tokens issued to any other app are refused, so another app cannot use its own users' Google logins to collect their Kamui peppers.
7. `nonce` is present and is a lowercase hex felt, the only form `prove_jwt` accepts.
8. Key proof (see below).

### The nonce and the key proof

The keychain sets the OAuth nonce to `poseidon(new_pubkey, blinding)`, and `prove_jwt` checks it. The service uses the same binding: the request carries `public_key`, `blinding` and a signature by that key over `poseidon("kamui.pepper.v1", nonce)`. The service checks that the nonce opens to `(public_key, blinding)` and that the signature verifies.

Effect: a token on its own does not yield a pepper. The caller must also hold the device key the login was made for.

### Replay

The service is deterministic and keeps no state, so replaying a request returns the same pepper and changes nothing. The only harm from replay is disclosure of the pepper to someone who should not have it.

- A captured token alone (from a log, a proxy, browser history): refused, because of the key proof.
- A captured token plus `public_key` and `blinding`, without the private key: refused.
- A captured complete request: accepted until the token expires or passes the maximum age. A party in that position (it terminates TLS) can usually read the response as well, so one-time-use tracking would add state without closing anything. Not done.
- The maximum token age bounds all of the above to minutes.

### Rate limiting

- Per client address, before the token is parsed: bounds the cost of junk requests.
- Per `(iss, sub)`, after the token verifies: a user needs a pepper a few times a year, not a few times a minute. Invalid tokens do not count against the user they name.
- JWKS refetch is throttled so random `kid`s cannot make the service flood the issuer.

The reference keeps these counters in process memory. Production needs a limit at the edge and a shared store if there is more than one instance.

## 5. Key management

This is the part that matters most. Losing the key ends social recovery for every account, permanently.

### Generation

- Generated once, in a scripted, witnessed ceremony on an offline machine, from the operating system's random source: 32 bytes.
- At the ceremony, record the key check value (a 16-hex-character fingerprint under its own HMAC tag, `keyCheckValue` in `src/derive.ts`) and the pepper for one fixed test input. Both are safe to write down and are what later drills compare against.
- Split the key into Shamir shares (t of n; the numbers and the custodians are question 2) before it leaves the machine. Wipe the machine.
- Separate keys for Sepolia and mainnet. The mainnet key is never loaded anywhere a testnet key is.

### Storage and operation

- In production the key is an HMAC key inside an HSM or a cloud KMS, marked non-exportable there. The service calls the MAC operation and applies the 250-bit mask. It never holds the key. The `PepperDeriver` interface in `src/derive.ts` is the seam for this.
- The requirement that decides the product: it must accept **imported** key material for an HMAC-SHA-256 key. A key generated inside a KMS and not exportable cannot be backed up outside that provider, and then the provider account is a single point of permanent loss. Candidate products are in section 12; none was verified.
- A second copy in an independent HSM or KMS (another provider or at least another account and region), imported at the same ceremony, as a warm standby.
- Access to the MAC operation is limited to the service's own identity. No human role can call it in production. Calls are audit-logged by the KMS.
- The service runs in its own cloud account or project, apart from the prover, relayer and web front ends.
- The service compares the key check value at startup and refuses to run on a mismatch. A wrong key would not fail loudly by itself: every user would simply get a different, empty account.

### Rotation

Rotation in the usual sense is not possible. A new key gives a new pepper, a new identity and a new address, and the old account's stored identity can no longer be reproduced, so the old account loses social recovery. There is one key for the life of the system.

What can be done:

- **Move the same key** to a different HSM, KMS or provider, by importing the same material from the backup shares. This should be rehearsed.
- **Add a key version for new accounts only.** The response carries `key_version`. With two versions, the service returns both peppers and the SDK uses the oldest version whose address is deployed, else the newest. This doubles the lookups and should stay a contingency. The reference implements one version.

### Backup and drills

- The backup is the Shamir shares, on offline media, with custodians in different places and, ideally, different legal entities. No one location or person holds a quorum.
- A restore drill before the first mainnet account, and then on a fixed schedule (suggested: twice a year, and after any custodian change): a quorum rebuilds the key on an offline machine, computes the key check value and the test pepper, compares them with the ceremony record, and wipes the machine.
- Proposed launch gate: no mainnet account until one full restore drill has passed.
- Custodian changes re-split the key (new shares for everyone), not hand over an old share.

### Key loss

If the key is gone from the HSMs and no quorum of shares can be assembled:

- No pepper can be derived, so no user can run `prove_jwt` again: no account creation, no login on a new device, no override recovery. This cannot be repaired, because accounts cannot be upgraded.
- Existing device keys and sessions keep working. A user with a working device can add another device key as an owner, or move funds out.
- A user with no working device has lost the account.
- A device that cached its pepper (section 6) can still prove for its own user.

### Key compromise

If someone copies the key:

- With a list of `sub`s they can compute those users' addresses. The privacy the pepper gave is gone for existing accounts and cannot be restored, since their peppers cannot change.
- No funds are at risk from the key alone.
- Response: tell users plainly; decide whether new accounts move to a new key version; review how the key left. Whether this is a notifiable incident is a legal question (section 11).

## 6. Availability

The service is stateless. It needs the key holder (KMS) and, to verify tokens, the issuers' JWKS (cached; known keys keep being served if an issuer is briefly unreachable).

When the service is down:

| Action | Works? |
|---|---|
| Transactions from a device that already has an owner key | Yes |
| Existing sessions | Yes |
| Creating an account | No |
| First login on a new device (adds a key through `recover`) | No, unless that device has a cached pepper |
| Override recovery | No |

### Caching rules for clients

- The keychain may store the pepper next to the device key, in the keychain origin, protected the same way. It has no expiry: the value never changes. Remove it when the user signs out or forgets the device.
- Never pass the pepper to the embedding app, put it in a URL, or send it to analytics or error reporting.
- Never fall back to pepper 0 or any default when the service is unreachable or returns an error. Fail the login. A fallback produces a different, empty account.
- Refuse a response whose pepper is `0x0` or not below `2^250`.
- If the device remembers the address it used before for this login and the freshly derived address differs, stop and report. That is the symptom of a wrong service key.
- Responses are sent with `Cache-Control: no-store`. Nothing between client and service may cache them.

## 7. Logging and data handling

The service stores nothing. Its only durable output is logs.

Never logged, by the service or by anything in front of it (load balancer, WAF, tracing, error reporting):

- the token or any part of it, `sub`, email or other claims;
- the pepper, the key, the MAC;
- the nonce, `public_key`, `blinding`, the key-proof signature;
- request or response bodies;
- the text of unexpected errors (it may quote input); only the error class.

Logged per request: time, request id, outcome code, HTTP status, duration, and, once the signature has verified, the issuer name (`google` or `apple`), the position of the `aud` in the allow-list, and the key version. The log entry type in `src/log.ts` is closed: there is no field that can carry anything else, and a test checks the output.

Client addresses are used in memory for rate limiting and are not logged by the reference. Per-user rate-limit buckets are keyed by a MAC under a random per-process key, so memory holds no raw `sub`. Whether to log client addresses for abuse handling, and for how long logs are kept, are questions 8 and section 11.

TLS must end inside the trust boundary of the service. A third party that terminates TLS in front of it sees tokens and peppers.

## 8. API

### `POST /v1/pepper`

Request (`Content-Type: application/json`):

```json
{
  "jwt": "<the issuer's ID token>",
  "public_key": "0x…",
  "blinding": "0x…",
  "signature": ["0x…", "0x…"]
}
```

`public_key` and `blinding` are the values behind the token's nonce. `signature` is the Stark-curve signature `[r, s]` by that key over `poseidon(0x6b616d75692e7065707065722e7631, nonce)`; the first element is the short string `kamui.pepper.v1`.

Response `200`:

```json
{ "pepper": "0x…", "key_version": 1 }
```

Errors are `{ "error": "<CODE>" }`:

| Status | Codes |
|---|---|
| 400 | `BAD_JSON`, `BAD_REQUEST`, `BAD_JWT`, `UNSUPPORTED_ALG`, `BAD_PAYLOAD`, `BAD_NONCE`, `BAD_KEY_PROOF` |
| 401 | `WRONG_ISSUER`, `UNKNOWN_KID`, `BAD_SIGNATURE`, `TOKEN_EXPIRED`, `TOKEN_NOT_YET_VALID`, `TOKEN_TOO_OLD`, `NONCE_MISMATCH`, `BAD_KEY_PROOF_SIGNATURE` |
| 403 | `WRONG_AUDIENCE`, `ORIGIN_NOT_ALLOWED` |
| 405, 413, 415 | `METHOD_NOT_ALLOWED`, `BODY_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE` |
| 429 | `RATE_LIMITED` |
| 500, 503 | `INTERNAL`, `JWKS_UNAVAILABLE` |

`GET /health` returns `{ "status": "ok" }`.

CORS allows only the keychain origin. CORS is not the access control; the token and key proof are.

### Use by the client SDK

Upstream's SDK marks the place: "A pepper service would be asked here, once the token exists" (`client/src/sdk/client.ts`, `NO_PEPPER`). After the redirect, when the ID token is in hand and its nonce has been checked against the stored one:

1. Sign `poseidon("kamui.pepper.v1", nonce)` with the new device key.
2. `POST /v1/pepper` with the token, public key, blinding and signature.
3. Use the pepper to compute the identity and address (normal login), and pass it wherever `NO_PEPPER` is passed today: to `prove_jwt` calldata for browser proving, or in the `pepper` field of the recover request for backend proving.
4. Apply the caching rules in section 6.

For override recovery the flow is the same. The token is issued to the recovery client; the service returns the same pepper; `prove_jwt` rebuilds the original identity with it.

### Use by the recover API

The recover request already has a `pepper` field (`backend/src/services/recovery/recover.ts`). Nothing in its shape changes. Recommended additions on SNF's side:

- Refuse `pepper = 0` on mainnet.
- Before paying to deploy a new account, confirm that the pepper is the service's for that token, through an internal authenticated call. Otherwise a modified client can have the relayer deploy accounts with peppers of its choosing. That costs gas and creates accounts outside the scheme; it does not endanger other users. (Question 5.)
- Do not log the pepper. Upstream's recover code logs addresses and transaction hashes only.

An alternative is for the recover API to fetch the pepper itself and return the address, so the pepper never reaches the browser in the backend-proving flow. It makes the browser-proving flow different from the backend one and was not chosen here.

## 9. What the reference implements

Everything in sections 3, 4 and 8, the log rules in section 7, the startup key check, and an in-memory key for development. Not implemented: an HSM or KMS deriver, shared rate-limit state, multiple key versions, the internal call for the recover API, metrics. See `README.md`.

## 10. Open questions for the project owner

1. Single key holder (HMAC-SHA-256 in an HSM or KMS, recommended) or a threshold scheme across several independent parties from day one? Peppers are permanent, so this cannot be changed later for existing accounts.
2. Which HSM or KMS holds the production key, who are the backup share custodians, and what is the quorum (t of n)?
3. Require the key proof (a device-key signature bound to the token nonce) on every pepper request? Recommended yes; the SDK must then implement it.
4. Is 600 seconds the right maximum token age, given how long a login and proof take end to end?
5. Should the recover API confirm the pepper with this service before it pays for a deployment, and refuse `pepper = 0` on mainnet?
6. Should users be able to export their pepper (a recovery file) as protection against loss of the service key? It helps only users who keep the file, and a leaked file reveals that user's address.
7. For Apple, will the keychain client and the override-recovery client be under the same Apple developer team? If Apple's `sub` is team-scoped and they are not, the `sub` differs between the two and override recovery cannot reproduce the identity, whatever the pepper.
8. How long are logs kept, and may client addresses be logged for abuse handling?
9. Does the service run in its own cloud account with its own on-call, apart from the prover and relayer (recommended), and who has administrative access to that account?
10. Who approves changes to the audience allow-list? It decides which OAuth clients can obtain peppers, and it should follow the D3 governance for the override whitelist.
11. Is a successful backup restore drill a hard gate before the first mainnet account (recommended)?

## 11. Needs legal and privacy review

Nothing below is a conclusion. Each item needs review by counsel or a privacy specialist before launch.

- Whether the `sub`, the pepper and the derived address are personal data under the laws that apply to SNF and its users, what SNF's role and legal basis are, and what the privacy notice must say. The pepper is exactly the link between a Google or Apple identity and an on-chain address.
- How data-subject rights (access, erasure) apply to a value that is derived on demand from a key, and to an address that is permanent and public.
- The public wording of what SNF can learn: that it can compute any user's address from their `sub`, and that with backend proving its prover sees each login token.
- The wording "non-custodial" given that SNF's service is needed for recovery and its loss ends recovery (plan section 7).
- Google's and Apple's sign-in terms and policies: using ID tokens and the `sub` this way, and sending ID tokens to SNF's backend.
- Logs: retention period, whether client addresses may be kept, where logs are stored, and transfers across borders.
- The cloud or HSM provider as a processor: contract terms, location of the key, and the provider's own access.
- Backup share custodians: who they are, in which jurisdictions, under what agreement, and what happens on departure, dispute or death.
- Continuity: what SNF commits to if it stops operating the service or ceases to exist, since accounts then lose recovery.
- Key compromise: whether it is a notifiable breach, to whom and within what time.
- Requests from authorities to map a login identity to an address or the reverse: SNF is technically able to answer them. Policy and disclosure.
- Liability if the key is lost and users permanently lose access to recovery.

## 12. Not verified

- That Google's `sub` is the same across all OAuth clients and Apple's is scoped to the developer team. Written from memory of the issuers' documentation.
- Which HSM and KMS products offer HMAC-SHA-256 as a MAC operation **with imported key material**. AWS KMS and Google Cloud KMS are believed to offer HMAC keys; import support for them was not checked for either. This must be confirmed before a product is chosen.
- Whether the pepper, which is an input to `prove_jwt`, can be recovered from a SNIP-36 proof or its public facts. If it can, a chain observer who also knows the `sub` learns nothing new (they still need the pepper first), but it should be checked.
- Typical lifetimes of Google and Apple ID tokens, which bound the replay window together with the maximum age.
- The key proof was tested against `@scure/starknet` signatures only. The SDK under `sdk/` was being written at the same time and was not read; the two must be checked against each other.
- No load or latency measurement was made.
- The security argument for the derivation rests on HMAC-SHA-256 being a PRF, the standard assumption. No independent cryptographic review of this note has taken place.

This document needs legal review before SNF relies on any statement in it about legal, regulatory or privacy matters, and a human review overall before it is shared outside the team.

## 13. Decisions taken

These override the earlier sections where they differ.

### 2026-11-12: the key is generated by AWS KMS and never leaves it

The operational key is an HMAC KMS key (`HMAC_256`, used with `HMAC_SHA_256`) whose key material AWS KMS generates. The alternative, importing key material from an offline ceremony, was considered and not taken.

What this changes in section 5:

- **No ceremony, no shares, no custodians.** There is no copy of the key outside AWS, so question 2's custodians and quorum no longer apply.
- **No restore drill.** There is nothing to restore from. Question 11's launch gate becomes: the guardrails below are in place and reviewed, and a failover to a replica Region has been exercised.
- **The key cannot be moved.** "Move the same key to another provider" is no longer possible. Existing accounts depend on this AWS key for as long as they exist.
- **The key check value still works.** It is one `GenerateMac` call on the fixed tag, recorded when the key is created, and compared at startup.
- **The derivation is unchanged.** `GenerateMac` with `HMAC_SHA_256` computes the same function as the reference; the service still applies the 250-bit mask. `PepperDeriver` in `src/derive.ts` is where a KMS-backed implementation goes. It is not written yet.

The risk accepted with this choice: if the KMS key is deleted, or SNF permanently loses access to the AWS account that holds it, no pepper can ever be derived again. The effects are those listed under "Key loss" in section 5, and nothing can repair them, because accounts are not upgradeable.

What protects the key instead of a backup:

- **Multi-Region replicas** of the key, so that the loss of one Region does not lose the key. To verify: that a KMS-generated HMAC key can be multi-Region.
- **Deletion guardrails:** a key policy and an organisation-level policy that deny `kms:ScheduleKeyDeletion` and `kms:DisableKey` to everyone, the maximum waiting period if deletion is ever scheduled, and an alarm on any attempt.
- **Account protection:** the key in its own AWS account, very few administrators, hardware MFA on the root user, documented break-glass access, and billing and contact details that cannot lapse. Losing the account is losing the key.
- **Audit:** every use of the key is recorded by CloudTrail, with alerts on unusual volume.
- **Client caching** (section 6) and, if adopted, **pepper export** (question 6). With no backup of the key, an exported pepper is the only protection a user can hold against its loss. Question 6 now deserves a yes unless there is a reason against it.

Facts about AWS KMS used here, from its documentation as found on 2026-11-12, to be checked against the current KMS Developer Guide before the key is created:

- HMAC KMS keys exist and support `GenerateMac`.
- Key material generated by KMS cannot be exported.
- KMS custom key stores (CloudHSM-backed or external) do not support HMAC keys.
- Automatic rotation does not exist for HMAC keys, which matches this design: the key is never rotated.

### 2026-11-12: users can export their pepper

Answers question 6 with yes. The key has no backup outside AWS KMS, so an exported pepper is the one protection a user can hold against its loss.

- The export is done by the client, which already holds the pepper after a login. The service does not change and gains no export endpoint.
- The file format and its checks are in the SDK (`sdk/src/pepper.ts`): the pepper, the key version, and what is needed to recognise the account it belongs to (chain, class hash, `iss`, `aud`, address). It does not contain the user's `sub`, a token or any key.
- A login can take the pepper from the file instead of asking the service. The client must check that the file's pepper, with the login token's claims, gives the file's account address before using it.
- What the file gives away: its holder learns that user's account address. It gives no access to the account: recovery still needs a login token from the issuer and a proof.
- The keychain should offer the export after the first login, explain what the file is for, and let the user protect it with a passphrase. Passphrase protection is not implemented in the SDK yet.
