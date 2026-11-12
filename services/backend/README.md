# Kamui backend

The services behind a login: the recover API, the prover it calls, and the rotator that keeps the on-chain key registry in step with Google and Apple.

It is upstream's backend (keep-starknet-strange/social-account, MIT) with the Kamui changes listed in `THIRD_PARTY.md`. It is still a proof of concept: not hardened, not audited.

## What it does

| Part | What it does |
|---|---|
| `POST /recover` | Verifies the login token, confirms the pepper with the pepper service, deploys the account if needed, has the prover prove `prove_jwt`, and submits `recover` from the relayer. This is the path the SDK's `completeLogin` uses. |
| `POST /relay` | Submits `recover` with a proof the browser made. The token never reaches this backend. |
| `POST /deploy` | Relayer-paid deployment for browser proving. Disabled when a pepper service is configured, because there is no token to confirm a pepper with. |
| Prover | The SNIP-36 prover, in Docker. One proof at a time; see the memory note in `compose.yml`. |
| Rotator | Copies the issuers' current signing keys into the on-chain registry. |

## The pepper

When `PEPPER_SERVICE_URL` is set, `/recover` asks the pepper service for the pepper of the request's token, using the key proof the client sends (`keyProof`), and refuses the request unless it equals the pepper the client sent. Nothing is deployed or proven before that.

- On mainnet the service is mandatory and pepper 0 is always refused. The api does not start on mainnet without `PEPPER_SERVICE_URL`.
- On a testnet without the service, any pepper is accepted, including 0.
- If the pepper service is down, `/recover` answers 502. It never falls back to accepting the pepper.

Why: the client picks the pepper it sends, and the pepper decides which account address gets deployed. Without the check, anyone holding a valid token could make the relayer deploy accounts for made-up peppers.

## Run

Bun 1.2 or later, and Docker for the prover.

```sh
bun install
cp .env.example .env.local   # fill in the secrets; deployments.env (committed) holds public addresses only
bun run service:prover       # Docker; needs about 20 GB for the VM, see compose.yml
bun run service:api
bun run service:rotator
```

`deployments.env` points at upstream's registry and prover executor on Sepolia and at the Kamui class declared there on 2026-11-12. The RPC must serve storage proofs for about 100 blocks back; see `../../spikes/s1/README.md`.

The scripts under `src/scripts/` build the contracts with `scarb`. Put the pinned version first on `PATH` as described in `../../contracts/README.md`.

## Test

```sh
bun test
```

17 tests: upstream's 8, and 9 for the pepper confirmation. The pepper tests run three real parts together in process: the SDK builds the key proof, this backend forwards it, and the pepper service answers.

## Not done

- **One live run only.** This folder ran on Sepolia on 2026-11-12 with the pepper service and a non-zero pepper: a first login, a returning device and a new device (`../../spikes/s1/results/RESULTS.md`, run 5).
- **Hardening:** rate limits are per process, there are no metrics or alerts, and the relayer and prover keys are read from environment variables.
- **A watcher** that compares each key written to the registry with the issuer's published keys (plan D8).
- **The prover's real memory need.** It is somewhere between 8 and 19.5 GB per proof.
- **Override recovery with a pepper** has not been exercised.
