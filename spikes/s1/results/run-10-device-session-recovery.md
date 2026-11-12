# Run 10: sessions, device removal and a real pepper outage

2026-11-12, Sepolia, Google sign-in. Local keychain, backend, AWS-KMS pepper service and Docker prover; AVNU sponsorship. Same class and account as run 9. Public receipts and state checks are in [run-10-device-session-recovery.json](run-10-device-session-recovery.json). No recovery-file contents, pepper, token or private key are in these artifacts.

| Check | Observed result | Actual fee (STRK) |
|---|---|---:|
| Revoke all sessions from the keychain | Confirmed transaction `0x6bfb7186…4016d`. Session epoch 3 → 4, list 1 → 0. The previously live session now returns zero data, and its previously accepted public signature returns invalid. | 0.062410236669192768 |
| Remove the oldest stale device | Confirmed transaction `0xa57746f6…fccdd`. Owners 3 → 2, epoch 4 → 5. The selected key is no longer an owner; the current key remains one. | 0.075756043407064256 |
| Check signatures after removal | An ownership signature already public in the removed key's old recovery transaction was valid at historical block 18030921 and is invalid now. A public ownership signature from the remaining device is still valid. No private key was accessed for either check. | 0 |
| Recovery-file sign-in with pepper actually stopped | Exported the file before forgetting the local device, then stopped the pepper process. Port 8787 refused connections before and during proving and after recovery confirmation. Google sign-in with the file reached the same account via transaction `0x4cfbc18b…6d97d`. Owners 2 → 3, epoch 5 → 6; the newly recovered device is marked current. | 1.904460023725356768 |
| Restore pepper service | Restarted the same existing service configuration after the confirmed recovery. `/health` returned HTTP 200 with `status: ok`. | |

All three transactions were `SUCCEEDED` and `ACCEPTED_ON_L2` when checked. The final keychain showed the same account, three devices and zero sessions. The recovery file stayed local and private; the test copy was not added to the repository.

The removed key was `0xe422a5fa…e5fa5b`; it was not the current device. The current device before local forgetting was `0x286d5e0b…41b98b`, and the newly recovered current key is `0x4f23d98a…6d7ea0`. “Forget this device” removed only the local stored key: the old device remains in the on-chain owner set until explicitly removed there.

This run used the existing job-based API and is not a crash/restart test of the new durable recovery journal. Device removal followed revoke-all, so no live session remained at removal; its independent epoch bump and owner-signature rejection were checked. The issuer tested was Google.
