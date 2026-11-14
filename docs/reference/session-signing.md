# Session signing

What an SDK in another language must implement to send calls with a Kamui session key, with test vectors generated from the TypeScript SDK. The reference implementation is [`sdk/src/outside.ts`](https://github.com/starknet-innovation/kamui/blob/main/sdk/src/outside.ts) and [`sdk/src/sessions.ts`](https://github.com/starknet-innovation/kamui/blob/main/sdk/src/sessions.ts); the contract side is [`contracts/src/core.cairo`](https://github.com/starknet-innovation/kamui/blob/main/contracts/src/core.cairo) and [`contracts/src/session/component.cairo`](https://github.com/starknet-innovation/kamui/blob/main/contracts/src/session/component.cairo).

There is no Kamui SDK outside TypeScript yet. This page is the specification one would follow.

## What you need

| Primitive | Notes |
|---|---|
| Felt arithmetic | Integers modulo the Stark field prime `2^251 + 17·2^192 + 1`. |
| Poseidon hash over a list of felts | Starknet's `poseidon_hash_span` (`computePoseidonHashOnElements` in starknet.js). |
| `starknet_keccak` | Keccak-256 of the ASCII bytes, keeping the low 250 bits. Used for selectors and type hashes. |
| Stark-curve ECDSA | Key generation and signing on the Stark curve. Use a maintained Starknet library for your language; do not write the curve yourself. |
| A Starknet RPC client | Two view calls on the account, to pick a nonce. |

A **short string** is the ASCII bytes of a text of at most 31 characters, read as one big-endian number: `ANY_CALLER` is `0x414e595f43414c4c4552`.

## The session key

A Stark-curve private key, generated where it will be used and never sent anywhere. In the TypeScript SDK it is 31 random bytes, which is always a valid key. The **public key** is the x coordinate of the public point; that felt is what the connect request carries and what the account stores.

## A sponsored call

A sponsored session call is an SNIP-9 version 2 outside execution: `execute_from_outside_v2` on the user's account, signed by the session key and submitted by a relayer.

### 1. Pick a nonce

A session can use exactly `maxCalls` nonces on this path: `base`, `base + 1`, … `base + maxCalls − 1`, in any order. The account refuses any other nonce from a session.

1. `base` = `get_session_nonce_base(session_public_key)` on the account. It changes when the session is registered again, so read it from the chain; do not compute or hard-code it.
2. Take the first `base + i`, `0 ≤ i < maxCalls`, for which `is_valid_outside_execution_nonce(nonce)` returns 1.
3. If there is none, the session has used all its calls.

Remember `i` and start the next scan from `i + 1`. A nonce is spent only when the call succeeds on chain. After a timeout, check the chain before reusing one.

### 2. Hash

The SNIP-12 revision 1 message hash of the `OutsideExecution`. Every `H(…)` is Poseidon over the list.

```
domainHash  = H( typeHash(StarknetDomain), 'Account.execute_from_outside', 2, chainId, 1 )
callHash_k  = H( typeHash(Call), to_k, selector_k, H(calldata_k) )
structHash  = H( typeHash(OutsideExecution), caller, nonce, execute_after, execute_before, H(callHash_1 … callHash_n) )
messageHash = H( 'StarkNet Message', domainHash, account, structHash )
```

- `'Account.execute_from_outside'` and `'StarkNet Message'` are short strings. The version is the number `2` and the revision the number `1`, not the characters.
- `chainId` is the short string of the chain name: `SN_SEPOLIA` is `0x534e5f5345504f4c4941`, `SN_MAIN` is `0x534e5f4d41494e`. Use the `chainId` from the connect answer.
- `account` is the user's account address, from the connect answer.
- `selector_k` is `starknet_keccak` of the entry point name.
- `H()` of an empty list is still a hash: a call with no arguments hashes `H()`, not zero.
- `caller` is `ANY_CALLER` unless you name the relayer. `execute_after` is 0 unless you want a delay.

A type hash is `starknet_keccak` of the encoded type, exactly these strings (quotes included):

| Type | Encoded |
|---|---|
| `StarknetDomain` | `"StarknetDomain"("name":"shortstring","version":"shortstring","chainId":"shortstring","revision":"shortstring")` |
| `Call` | `"Call"("To":"ContractAddress","Selector":"selector","Calldata":"felt*")` |
| `OutsideExecution` | `"OutsideExecution"("Caller":"ContractAddress","Nonce":"felt","Execute After":"u128","Execute Before":"u128","Calls":"Call*")"Call"("To":"ContractAddress","Selector":"selector","Calldata":"felt*")` |

### 3. Sign

Stark-curve ECDSA over `messageHash` with the session private key gives `r` and `s`. The signature is four felts:

```
[ session_public_key, r, s, valid_until ]
```

`valid_until` is the session's expiry exactly as it was approved. The account compares it with the stored value and refuses a signature that carries any other. Four felts is how the account tells a session signature from an owner's (two).

### 4. Build the call

Calldata of `execute_from_outside_v2`, all felts:

```
caller, nonce, execute_after, execute_before,
n,                                              number of calls
  to_1, selector_1, len(calldata_1), calldata_1…,
  …
4, session_public_key, r, s, valid_until        the signature, with its length
```

Post `{ "account": "<account>", "calldata": [ … ] }` to the [sponsor endpoint](/guide/sponsorship), felts as `0x` hex strings.

### What the account checks

In this order; a failure reverts the transaction.

1. `caller` is `ANY_CALLER` or the address submitting.
2. `execute_after < now < execute_before`, both strict, by block time. The SDK sets `execute_before` to `valid_until`.
3. The nonce is unused.
4. The signature has four felts; the block time is not past `valid_until`; the session exists and its stored `valid_until` equals the one in the signature.
5. The nonce is one of the session's `maxCalls` reserved nonces.
6. Every call is in the session's scope, is not to the account itself and is not a blocked entry point.
7. The signature verifies over the message hash under the session public key.
8. The spending limits hold for token calls.

## A self-paid transaction

A session with `maxFeePerTx > 0` can also send ordinary invoke transactions. The signature has the same four felts, over the **transaction hash**. Computing a Starknet invoke v3 transaction hash is standard and not specific to Kamui. Always estimate fees with validation enabled: an estimate that skips `__validate__` is too low for a session.

## Test vectors

[`sdk/test/vectors/session-signing.json`](https://github.com/starknet-innovation/kamui/blob/main/sdk/test/vectors/session-signing.json), generated by [`sdk/test/vectors/generate.ts`](https://github.com/starknet-innovation/kamui/blob/main/sdk/test/vectors/generate.ts). A test in the SDK fails if the file is not what the SDK produces, or if the hashes on this page (implemented step by step, using only Poseidon and `starknet_keccak`) differ from what the SDK signs.

The file holds a test session key, the type hashes and short strings above, and three outside executions. Each has its inputs and every intermediate value:

| Field | Check that your implementation… |
|---|---|
| `selectors`, `domainHash`, `callHashes`, `structHash`, `messageHash` | computes the same values from `input` |
| `signature` | has the same first and last felt; that **your** `r, s` verify over `messageHash` under `session.publicKey`; and that the file's `r, s` verify in your library |
| `calldata`, `sponsorBody` | builds the same list, given the file's signature |

`r` and `s` in the file come from deterministic signing (RFC 6979, as starknet.js does it). A library that picks its nonce differently gives other values that are just as valid, so compare by verifying, not by equality.

The cases:

1. One call with no arguments and the SDK defaults: any caller, `execute_before` = `valid_until`.
2. Two calls with arguments, one a token `transfer` (a `u256` is two felts, low then high), and a large nonce.
3. Mainnet chain id, a named caller, and a window that opens later and closes before `valid_until`.

`selfPaid` is one four-felt signature over a transaction hash.

## Not covered

- Building a connect request and reading the answer: [Keychain protocol](/reference/protocol).
- Signing SNIP-12 messages with a session (`sessionSignTypedData` in the SDK): the same four-felt signature over the message hash of your own typed data. See [Signing messages with a session](/reference/protocol#signing-messages-with-a-session). The vectors here cover outside executions only.
- Getting a session into a native app: [Bounce page](/native/bounce-page).
- The contract was not exercised with a signature produced by another language. The vectors pin the TypeScript SDK's output, which is what the contract tests and Sepolia use.
