# Run 12 — live PostgreSQL funding and recovery regression

12 November 2026. **Passed** against the existing Sepolia account with a separate local PostgreSQL database. The original SQLite databases/configuration were not migrated or changed. This run did not deploy AWS infrastructure or use AVNU; the local relayer enforced signed fee bounds.

[Structured result](run-12-postgres-regression.json), [public receipts](run-12-receipts.json), [final funding state](run-12-funding-final.json).

## Authorized bounds and accepted transactions

The user approved at most **four paid attempts**, **12 test STRK total**, and **5 test STRK per attempt**. The private policy used a seven-day rolling window to prevent a short test delay resetting its limits: two wallet operations (2 STRK each/4 aggregate), one app Ping (1 STRK) and one recovery (5 STRK). Deployment and external AVNU funding were off. No counter or debit history was cleared.

| Action | Transaction | Block | Actual fee, test STRK |
|---|---|---:|---:|
| Owner wallet: approve Ping session | [0x3cf1511e52…](https://sepolia.voyager.online/tx/0x3cf1511e52169d7492a280ccd70315393fede2c9402959c6c39ca44742d623d) | 18039567 | 0.090118862679797632 |
| Approved-app sponsored Ping | [0x6131830584…](https://sepolia.voyager.online/tx/0x6131830584adc23b746d802335825ed2951571b78331b9866882b2b6beb3893) | 18039672 | 0.053049700459370512 |
| Google client-proof recovery | [0x6d5b8c8d81…](https://sepolia.voyager.online/tx/0x6d5b8c8d81ba7b3c21942646fa57c151952ab978540384b79aa0db19e2f3cd7) | 18039851 | 1.915151238840210720 |
| Owner wallet: revoke all sessions | [0x3acce14431…](https://sepolia.voyager.online/tx/0x3acce144315d938c553d7024741aae44e0f0183c8298490e6f3d7fa23718987) | 18039929 | 0.058042888368109584 |

All four receipts were independently read as **ACCEPTED_ON_L2 / SUCCEEDED**. Actual fees totaled **2.116362690347488448 test STRK**. Conservative signed maxima/durable debits totaled **4.748786677424971200 STRK**, below the approved 12 STRK; each individual signed maximum stayed below 5 STRK. The [postflight](run-12-postflight.json) independently reconfirmed five owners/epoch nine and a relayer balance decrease exactly equal to the four receipts' total fee. These figures use integer fri arithmetic, not rounded estimates. No further paid attempt is authorized by this run.

## Wallet and approved-app authorization

The user clicked the concrete session approval in bundled Chromium 153: Ping only on the existing target, at most 20 sponsored and 20 self-paid calls with the self-paid fee cap zero, expiring in two hours. The private approved-app funding policy allowed only one paid Ping. Its new `/wallet/sponsor` owner-authorized transaction succeeded. The approved app server then supplied its separate credential for one `/sponsor` Ping; the credential was not placed in browser configuration. The fourth transaction exercised `revoke_all_sessions` through the wallet route using the newly recovered owner.

No owner was removed, no arbitrary external call was sponsored through the wallet route, and no registry-administrator transaction occurred. Adversarial route behavior is covered by the local tests separately; this live run did not exhaust every refused selector/shape.

## Pause, container/API restart and persistent caps

After the first wallet debit, the API was stopped before each operator mutation. Pause was persisted, the PostgreSQL container was restarted against its retained named volume, and the API restarted. A fresh unused session nonce was refused with **503 SPENDING_PAUSED**. Another API restart retained that refusal.

The API was then stopped, resumed and restarted with a temporarily tighter global cap of one already-debited attempt. Another fresh valid Ping was refused with **429 FUNDING_CAP**. The durable ledger still contained exactly the original wallet debit after all three refusals. These were valid, unused-nonce requests that reached the funding decision after fee preflight, not replays of a mined nonce. The policy was returned only to the original approved four-attempt/12-STRK bounds before sending the one Ping. No failed/ambiguous send was refunded.

## Browser proof and orphaned-job reconciliation

A separate independent **bundled Chromium 153.0.8010.12** profile performed the user-assisted Google sign-in and pinned client-side proof. The original fourth-owner profile stayed untouched; no browser cookies, local storage or private keys were copied/exported. Both current Google RS256/65537 moduli matched the pinned on-chain registry before proving.

The monitor waited for an independently accepted, successful recovery receipt before stopping the API, avoiding the intent-before-broadcast uncertainty window. Its journal row was unfinished **after the API process had stopped**. The same PostgreSQL database was reopened; startup/status reconciliation settled the original transaction hash. The browser retried **nine 502 API_UNAVAILABLE status responses** and completed its original flow without another relay submission. Exactly one `/relay` submission and one recovery job were observed. [Restart event](run-12-restart-event.json), [new-browser route trace](run-12-browser-events-9223.json).

This establishes live orphaned-intent reconciliation after an accepted transaction, not automatic rebroadcast or proof reconstruction. It does not establish behavior after an unbroadcast intent, physical disk loss or a pre-confirmed-only transaction.

## Independent account/session checks

[Owner checks](run-12-owner-state.json) confirm owners **4 → 5**, all four previous keys retained, the one added key recognized by `is_owner`, and the account class unchanged. The fifth device slot is now occupied; another new device will need an explicitly authorized old-device removal first. No removal was attempted here.

The test session's public key was derived from its public `SessionKeySet` event, never from browser storage. Historical block **18,039,834** shows the session live with epoch **7**, 20 calls, one scope and zero self-paid fee. After recovery, the account getter returned no live session at epoch **8**. A fresh stale-session Ping was refused during fee preflight with **400 REVERTED**, without another debit. Revoke-all then increased the epoch to **9**. [Session-state checks](run-12-session-states.json), [original-browser trace](run-12-browser-events-9222.json).

## Final local state and retained data

Funding was paused through the stopped-API operator control, then the API restarted on the same PostgreSQL database. Final state: **paused**, four debits (wallet two, sponsor one, recovery one), one succeeded recovery job, zero registry display rows. The PostgreSQL named volume, journal/debit history, private SQL dump and both browser profiles remain retained. Read-only observers were stopped; both browser windows remain open.

The existing backend `.env.local`, original SQLite files and ordinary launch configuration were not changed. **Ordinary `kamui-api`/`bun run service:api` launch still returns to that legacy configuration; do not treat it as the PostgreSQL continuation.** A private run-12 launcher/handoff record was retained outside Git. Do not delete/reset the volume or profile to reuse limits or recover a slot. Paused state and conservative history must survive any continuation.

## Privacy and scope

Public artifacts retain route/status/error codes, transaction hashes/fees, public owner/session checks and aggregate counters only. They contain no JWT, pepper, private key, signed request, proof bytes, raw job capability, server credential, Google identity or browser profile. Payloads/headers/storage were not recorded by the network observer. Normal browser/API signing/proving remained in its existing memory path.

No AWS resource/permission/DNS change, image publication, registry-owner handoff, GitHub post, first-account deployment or AVNU external-control validation was performed. Local PostgreSQL/container restarts are not power-loss or hosted S3 restore evidence. The hosted/operator package and actual cloud acceptance remain separate work.
