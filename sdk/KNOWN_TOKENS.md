# The known-token list

`src/tokens.ts` lists, per network, the tokens Kamui recognises by address (`KNOWN_TOKENS`). On an approval screen a listed token is shown by its symbol, with no caution. Every other token is shown as `says it is "…"` with a warning that anyone can make a token with that name.

**The list is a security control.** A token's symbol comes from the token contract, so any contract can claim any name. The list is the only thing that tells the real USDC from a contract that calls itself USDC. A wrong entry makes a fake token look trusted to every user of every app, on the screen where they decide whether to approve a spend. Leaving a real token off the list costs a warning. Listing a wrong address can cost users their funds. When in doubt, leave it off.

## Owner

**TODO(owner): name the owner.** Nobody owns this list yet. Until someone does, no entry may be added to `mainnet`.

The owner:

- approves every change to the list, as one of the two reviewers below;
- decides which tokens are worth listing, and removes entries that stop meeting the bar;
- re-checks the whole list at least every six months and before each mainnet release, and records the date under [Review log](#review-log);
- is named in [`.github/CODEOWNERS`](../.github/CODEOWNERS) for `sdk/src/tokens.ts` and this file. That entry is a placeholder today (`TODO(owner)`); it only takes effect once it names a GitHub user or team and the branch protection on `main` requires code-owner review.

## What an addition needs

One pull request per change, touching only the list, its test and this file. The pull request body carries the evidence, so that a reviewer can repeat every step without trusting the author.

1. **The issuer's published address.** A link to a page the issuer controls that states the address for this network: the issuer's own documentation or its repository. For a token bridged through StarkGate, the bridge is what issues the Starknet contract, so the primary source is Starknet's list of bridged tokens ([starknet-io/starknet-addresses](https://github.com/starknet-io/starknet-addresses/tree/master/bridged_tokens)) or the [Starknet documentation](https://docs.starknet.io/learn/cheatsheets/chain-info). The link goes in the entry's `source` field.
2. **Two independent sources that agree with it.** For example a block explorer's verified-token label, the bridge contract's own on-chain record of the token, or a second official publication. Two pages by the same publisher count once. A wallet's or an aggregator's token list, a search result, a chat message, an AI model's answer and "the address I have always used" are not sources.
3. **An on-chain check.** `bun run check:tokens <network> [rpc url]` must pass: the contract is deployed on that network and answers the listed symbol and decimals. Paste the output in the pull request. This shows the entry is not a typo. It does not show who issued the token, because a fake answers whatever it likes.
4. **Per-network entries.** An address is checked and listed for each network on its own. That an address is right on Sepolia says nothing about mainnet, and the lookup never falls back from one network to another.
5. **The symbol is the one the contract answers**, and no two entries on a network share a symbol. Two trusted tokens with the same name cannot be told apart on an approval screen. If two real tokens answer the same symbol (see [Pending](#pending)), the owner decides which one is listed, or how they are told apart, before either is added.
6. **Two people.** The author and a reviewer each compare the full address, all 64 hex digits, against the primary source, by copying it from the source and not from the pull request. Comparing the first and last few characters is not enough: look-alike addresses are cheap to make. The reviewer says in the review which sources they opened. One of the two is the owner. A change written by an AI assistant has had no human check: it needs two people.
7. **Mainnet** needs everything above, with the owner as one of the reviewers, and the check in step 3 run against a node the reviewer chose.

Changing an address, symbol or number of decimals is an addition and follows the same steps. Removing an entry needs one reviewer and a reason; it is always safe.

## Format

Checked by `test/tokens.test.ts` on every pull request, with no network:

- address: lowercase, `0x` and 64 hex digits, a valid felt;
- symbol: 1 to 12 letters, digits, dots, dashes or underscores;
- decimals: a whole number from 0 to 36;
- source: an `https://` link;
- no address and no symbol twice on one network.

The same test pins the symbols listed for each network, so a change to the list always shows up as a change to the test too.

## Listed

Sepolia, as checked on 2026-11-14. Mainnet lists STRK and ETH only.

| Token | Address | Primary source | Second source | On chain |
|---|---|---|---|---|
| STRK | `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d` | [Starknet docs, chain info](https://docs.starknet.io/learn/cheatsheets/chain-info) | [starknet-addresses, sepolia.json](https://github.com/starknet-io/starknet-addresses/blob/master/bridged_tokens/sepolia.json) (same publisher) | STRK, 18 |
| ETH | `0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7` | [Starknet docs, chain info](https://docs.starknet.io/learn/cheatsheets/chain-info) | [starknet-addresses, sepolia.json](https://github.com/starknet-io/starknet-addresses/blob/master/bridged_tokens/sepolia.json) (same publisher) | ETH, 18 |
| vSTRK | `0x035c332b8de00874e702b4831c84b22281fb3246f714475496d74e644f35d492` | [Starknet docs, chain info](https://docs.starknet.io/learn/cheatsheets/chain-info) | [starknet-addresses, sepolia.json](https://github.com/starknet-io/starknet-addresses/blob/master/bridged_tokens/sepolia.json) (same publisher) | vSTRK, 18 |
| USDC (native, Circle) | `0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343` | [Circle, USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses) | [Circle blog, native USDC on Starknet](https://www.circle.com/blog/now-available-native-usdc-cctp-on-starknet) (same publisher) | USDC, 6 |
| USDT (StarkGate test token) | `0x02ab8758891e84b968ff11361789070c6b1af2df618d6d2f4a78b0757573c6eb` | [starknet-addresses, sepolia.json](https://github.com/starknet-io/starknet-addresses/blob/master/bridged_tokens/sepolia.json) | none yet | USDT, 6 |
| WBTC (StarkGate test token) | `0x00452bd5c0512a61df7c7be8cfea5e4f893cb40e126bdc40aee6054db955129e` | [starknet-addresses, sepolia.json](https://github.com/starknet-io/starknet-addresses/blob/master/bridged_tokens/sepolia.json) | none yet | WBTC, 8 |

The entries added with this document were collected by an AI assistant from the primary sources above. None of them has two independent sources yet (step 2) or a human check of the address (step 6). Both must be done, and recorded in the review log, before the change that adds them is merged.

## Pending

Not listed. Each needs the steps above before it can be.

| Token | Network | Why it is not listed |
|---|---|---|
| USDC bridged through StarkGate, `0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080` | Sepolia | It is in Starknet's bridged-token list, but on chain it answers the symbol `USDC`, the same as Circle's native USDC. Listing both would put two different trusted tokens called USDC on approval screens. Circle's own Starknet quickstart shows the native address in its text and this bridged address in its code, which is the confusion the list must not repeat. The owner decides: list it under a distinct label (mainnet calls the bridged token USDC.e), or leave it unverified. |
| wstETH | Sepolia | In Starknet's bridged-token list. Not checked against Lido's own publication. |
| EURC | Sepolia | In Starknet's bridged-token list, but Circle's EURC address page does not list Starknet, so the issuer does not confirm it. |
| EKUBO | Sepolia | In Starknet's bridged-token list. Not checked against Ekubo's own publication. |
| USDC, USDC.e, USDT, WBTC, wstETH, DAI and others | Mainnet | No mainnet entry beyond STRK and ETH until the list has an owner. Circle and Starknet publish candidate addresses; none has been through this process. |

## Review log

| Date | Network | Reviewer | What was checked |
|---|---|---|---|
| | | | |
