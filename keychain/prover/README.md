# Pinned SNIP-36 browser runtime

Files listed in manifest.json are unchanged from snip-36-prover-wasm v1.0.1 at the recorded commit. Apache-2.0 LICENSE and THIRD_PARTY_NOTICES.md accompany them. No replay UI or persistent receipt store is included.

From keychain, run `bun scripts/prover-assets.ts` to download the two release binaries and verify all assets, or pass the path to an upstream checkout to install its verified binaries. Binaries are gitignored; do not rebuild silently or substitute another circuit. `--check` validates an offline installation. The server verifies the manifest before serving any prover file. Application adapters live in src/proving.ts; upstream sources remain unchanged.
