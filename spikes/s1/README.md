# S1: measure proof time

Goal: real numbers for login and recovery time, backend prover and browser prover, to settle D4 and D9 in [PLAN.md](../../PLAN.md).

State on 2026-11-11: set up and run once per prover. Results are in [results/RESULTS.md](results/RESULTS.md). The backend prover needs its memory cap raised (`backend/compose.override.yml`, 20 GB) and the api needs bun 1.2 or later (a local copy is in `tools/`).

## What is ready

- `social-account/` is the upstream repo at `e168134` (MIT). Contracts build with scarb 2.20.1; backend and client dependencies are installed.
- Prover image pulled: `ghcr.io/starknet-innovation/snip-36-prover-backend@sha256:3624a08b…8a4f` (arm64, built 2026-11-10).
- Browser prover wasm modules downloaded into `social-account/client/public/prover/` (sizes match the manifest).
- `social-account/backend/.env.local` and `social-account/client/.env.local` exist with the non-secret values filled in. Both are gitignored.
- `harness/preflight.ts` passes: the Sepolia deployment that upstream committed can be reused as it is. The class is declared, `ProverExecutor` is deployed, the registry holds both of Google's current keys, and the configured RPC (`api.zan.top` public Sepolia) serves storage proofs about 100 blocks back. `starknet-sepolia-rpc.publicnode.com` does not work: it only serves them for the newest block. So no registry owner account and no class declaration are needed.

Machine: Apple M3 Max, 36 GB. Docker VM has about 23 GB, above the prover's 8 GB cap. This is a high-end machine, so its numbers are a best case, not "mid-range hardware".

## What you need to supply

Fill these in yourself; do not paste keys into a chat.

1. **Google OAuth client.** A Web client in the Google Cloud console with `http://localhost:5173/callback` as an authorized redirect URI. Put its client ID in `VITE_GOOGLE_CLIENT_ID` (client) and `AUTHORIZED_GOOGLE_RECOVERY_CLIENT_ID` (backend).
2. **Relayer account.** A Sepolia account with some test STRK. `RELAYER_ADDRESS` and `RELAYER_PRIVATE_KEY` in the backend file. Each proof-carrying transaction pays a flat 75M L2 gas.
3. **Prover account.** A second Sepolia account, unfunded, that signs the virtual `prove_jwt` transaction. `PROVER_ACCOUNT_ADDRESS` and `PROVER_ACCOUNT_PRIVATE_KEY`. It has to exist on chain for the virtual transaction to validate (my reading, not tested); the relayer can deploy it.

Apple is skipped: it needs an https tunnel and a registered domain. `AUTHORIZED_APPLE_RECOVERY_CLIENT_ID` is set to a placeholder so the api starts.

## Run

The pinned tools are not first on `PATH` on this machine (an older scarb in `~/.local/bin` wins). Only needed if you rebuild or test the contracts:

```sh
export PATH="$(asdf where scarb 2.20.1)/bin:$(asdf where starknet-foundry 0.64.0)/bin:$PATH"
```

Four terminals, from `social-account/`:

```sh
cd backend && bun run service:prover      # Docker prover on 127.0.0.1:9900
cd backend && bun run service:api         # http://localhost:3000
cd client && bun run dev                  # http://localhost:5173
cd ../harness && ./sample-prover.sh       # memory and CPU samples, Ctrl-C prints the peak
```

Check first with `cd harness && bun run preflight`.

## What to record

Run each case three times and note the machine.

| Case | How | Where the number comes from |
|---|---|---|
| Backend proof, first login | Log in with Google in the demo app (deploys, proves, recovers) | Prover log phase timings (`docker logs -f social-prover-1`), api log timestamps, wall clock from click to usable account |
| Backend proof, recovery | Log in again with a new device key | Same |
| Browser proof, standard build | Demo app with local proving, standard build | Browser console, wall clock, Chromium task manager for memory |
| Browser proof, memory build | Same with the memory build | Same |
| Wait after proving | Time between proof ready and `recover` accepted | api log (base block must be 10 blocks old) |
| Proof size | Per proof | api log line `proof for …: N bytes` (limit 480,000) |

For a mid-range number, repeat the backend case with the Docker VM limited to 4 CPUs, and the browser cases on a 16 GB laptop.

## Decision rule

From PLAN.md D4: if click-to-usable for a recovery is above about 30 seconds on the backend path, the multi-device owner set is needed in v1. If the browser path does not finish on a 16 GB machine, D9 stays "backend proving by default".
