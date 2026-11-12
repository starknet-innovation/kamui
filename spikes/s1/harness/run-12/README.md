# Run-12 live harness

These tools were used for the bounded local-PostgreSQL/Sepolia regression in `../../results/run-12-postgres-regression.md`. They are not general deployment commands and carry no continuing authority to spend. The original four-attempt allowance is consumed and funding is paused.

Only `run-12-preflight.ts` is a standalone public read-only check. The remaining tools require the private `KAMUI_RUN12_DIRECTORY` created for this run. Its policy/runtime files and server credential were never committed. API startup uses the existing backend's ordinary configuration; no private key is read/exported by this harness. Start the API wrapper from `services/backend` so Bun resolves the existing runtime settings, after stopping any prior API/nonce writer. Do not enable or recreate a spending policy without a new approved allowance.

- `run-12-api.ts`: normal API wrapper, approved cap/payer checks and isolated PostgreSQL configuration.
- `run-12-control.ts`: stopped-API initialization/pause/resume/cap changes, or read-only aggregate summary.
- `run-12-stop-api.ts`: stop only this wrapper's API while no unfinished recovery exists.
- `run-12-recovery-stop.ts`: stop only after an independently accepted successful recovery receipt, retaining whether its journal was unfinished after process exit. Never stop between intent commit and unknown broadcast to manufacture a test.
- `run-12-browser-observer.mjs`: statuses/public hashes only; does not inspect request bodies, headers or browser storage. Disconnecting its CDP client does not delete either browser profile.
- `run-12-receipt.ts`: independent public receipt and resource-bound checks, excluding calldata.
- `run-12-session-state.ts`: derive the public session key from its on-chain event and query historical/current state, never browser storage.

The current private handoff retains the PostgreSQL volume/journal/debits, paused state, private SQL backup and both device profiles. Standard launch configuration remains legacy SQLite and is not this PostgreSQL continuation. Never remove/reset that history or a device profile to repeat these tests. No AWS or external AVNU control was tested by these tools.
