# Registry handoff review — 12 November 2026

**Unsigned review package prepared; no roles changed.** Fresh read-only Sepolia checks at block **18,048,447** (`0x1c92a7bb2bf864fe68feb4ef3d2c91a0b9eff117f0d16df6d77449654cd84aa`) verified the pinned registry and administrator classes, full new administrator public key, both role administrators and run 13's accepted successful native V3 Ping. The controller class/key matched both the proof's canonical receipt block and the current snapshot. This establishes observed on-chain control, not custody/security approval or independent recovery.

| Item | Verified value |
|---|---|
| Registry | `0x4bc2b2afcce053e788511a851e6aeb004d18adb243df4fe852e1b727bd09808` |
| Registry class pin | `0x105b5dc6709f9afbb8cd0b3b99fdc9a518c938c17badfd317c9076d189577c7` |
| Old administrator / current relayer | `0x5bf22a824e3d20dfe018fab5de043a9cab41c45361f4ded0f2e2fc51776118e` |
| New immutable KMS administrator | `0x67141ab3d3b99425c5ecb32cabc9b718b36ec8a5f933fc79e9601d9e23bc09` |
| New administrator class pin | `0x7164c4f64b1c7608b3e88806dc7a24083e728c892f6c7488900665d634ddf79` |
| Controller proof | `0x21046afab78c7f2ee031fce58eb18bcb57f9f2358def5d74af4cf419a4a5072` — successful accepted non-query V3 invoke at block 18,048,325 |
| Current roles | Old account: admin + revoker; new account: neither |

The registry class pin was compared with the existing committed observation, not inferred from an arbitrary live response. ABI and role observations do not replace implementation review. The administrator class/public key pins come from [run 13](../../../../spikes/s1/results/run-13-kms-admin.json). No private KMS identifiers or transaction signatures are in this document.

## Exact unsigned changes

Both batches execute from the **old administrator account** shown above, against the registry shown above. `DEFAULT_ADMIN_ROLE` is `0x0`; `REVOKER_ROLE` is `0x23f34913921da558f105cefb578d87278debbbd073a8d552b5de0d168deee30`. The default admin can also upgrade the registry.

Grant batch, only after custody/security and recovery decisions are reviewed:

```json
[
  {
    "contractAddress": "0x4bc2b2afcce053e788511a851e6aeb004d18adb243df4fe852e1b727bd09808",
    "entrypoint": "grant_role",
    "calldata": [
      "0x0",
      "0x67141ab3d3b99425c5ecb32cabc9b718b36ec8a5f933fc79e9601d9e23bc09"
    ]
  },
  {
    "contractAddress": "0x4bc2b2afcce053e788511a851e6aeb004d18adb243df4fe852e1b727bd09808",
    "entrypoint": "grant_role",
    "calldata": [
      "0x23f34913921da558f105cefb578d87278debbbd073a8d552b5de0d168deee30",
      "0x67141ab3d3b99425c5ecb32cabc9b718b36ec8a5f933fc79e9601d9e23bc09"
    ]
  }
]
```

Conditional renunciation preview, **blocked until both new roles exist and fresh controller checks pass**. Revoker is renounced first, admin last:

```json
[
  {
    "contractAddress": "0x4bc2b2afcce053e788511a851e6aeb004d18adb243df4fe852e1b727bd09808",
    "entrypoint": "renounce_role",
    "calldata": [
      "0x23f34913921da558f105cefb578d87278debbbd073a8d552b5de0d168deee30",
      "0x5bf22a824e3d20dfe018fab5de043a9cab41c45361f4ded0f2e2fc51776118e"
    ]
  },
  {
    "contractAddress": "0x4bc2b2afcce053e788511a851e6aeb004d18adb243df4fe852e1b727bd09808",
    "entrypoint": "renounce_role",
    "calldata": [
      "0x0",
      "0x5bf22a824e3d20dfe018fab5de043a9cab41c45361f4ded0f2e2fc51776118e"
    ]
  }
]
```

These are unsigned call descriptions with no nonce, resource bounds, signature or broadcast. Do not submit the conditional preview as a current executable plan. The actual `prepare-renounce` command still refuses while the new account lacks either role and requires an explicit controller acknowledgement plus a fresh accepted receipt/class/full-key check.

Private mode-0600 input, fresh review and grant artifacts are already prepared under `/Users/adrienlacombe/.kamui-admin-sepolia/registry-handoff-2026-11-12/`. Preserve them; outputs are exclusive and cannot be overwritten. Read-only refresh into a new private directory:

```sh
python3 -B infra/aws/lean/readiness/registry_handoff.py review \
  --private-input /Users/adrienlacombe/.kamui-admin-sepolia/registry-handoff-2026-11-12/handoff-input.json \
  --private-output-directory /Users/adrienlacombe/.kamui-admin-sepolia/registry-handoff-refresh
```

After a separately reviewed grant has actually succeeded and the operator has rechecked KMS access, prepare the real renunciation into a fresh directory:

```sh
python3 -B infra/aws/lean/readiness/registry_handoff.py prepare-renounce \
  --private-input /Users/adrienlacombe/.kamui-admin-sepolia/registry-handoff-2026-11-12/handoff-input.json \
  --private-output-directory /Users/adrienlacombe/.kamui-admin-sepolia/registry-handoff-renounce \
  --new-controller-confirmed
```

Keep all API/rotator/other nonce writers stopped during the actual grant/renounce sequence. After successful renunciation, run `verify` against another fresh snapshot, confirm both old roles absent and both new roles present, and check watcher health and JWK/audience state. Do not restart a hosted API whose relayer still retains registry authority. The user has removed Sepolia STRK permission caps; no new fee-permission question is required. That spending authorization does not itself approve custody or the role batches.

## Decisions and remaining reviews

1. **Recovery design — decided.** For **Sepolia only**, the user selected **sole KMS administrator; accept loss-of-key risk** on 12 November 2026 after reviewing the shared-bootstrap and immutable-account limitation. No independent fallback administrator is being prepared. The three KMS roles still share the existing bootstrap principal; a policy-recovery role cannot recover a deleted key or the immutable account after that key is lost. This is explicit risk acceptance, not proof of independent recovery or approval of the remaining permission/custody findings. Record this decision in the private review under the recovery evidence reference; do not mark the complete wallet-security review accepted solely from this answer.
2. **Effective permissions and custody acceptance.** Review actual KMS key-policy administration, signing-role trust/assumption, operator authentication, key-disable/deletion controls, inherited permissions and whether any backend/pepper host principal can obtain effective signing or policy-changing authority. **Recommendation:** operator-only signing, no hosted access, and an independent review of the immutable account and its upgrade consequences before grant. This work did not assert an IAM audit or mark review flags accepted.
3. **Exact authority change.** Review the concrete grants above after decisions 1–2. **Recommendation:** grant, verify both roles and current control, then freshly prepare and review renunciation; never combine grant and removal into one opaque step. The tested Ping is the control proof; it does not replace the final current-access check.

## Verification

`registry_handoff.py review` and `prepare-grant` completed against live Sepolia using the read-only RPC allowlist. The new review action verifies the controller proof before returning a grant plus explicitly conditional renounce preview. A regression requires canonical controller-proof blocks to have accepted status. Eleven targeted Python handoff tests pass. No KMS request, AWS mutation, signing, paid transaction, registry update or GitHub action occurred in this workstream.

## Mainnet is separate

The user explicitly accepts this setup for Sepolia now and requires a proper separately reviewed KMS setup for mainnet. No sole-key/shared-bootstrap acceptance or unsigned Sepolia role plan in this document authorizes mainnet custody, deployment or registry authority. Mainnet access separation, recovery/governance and key-loss/disable/deletion procedures require their own design and review.
