//! Session key interface for Kamui accounts.
//!
//! `ISessionKeyManager`, `SessionData` and `HasAccountOwner` follow SNIP-41 as revised in
//! starknet-io/SNIPs PR 180 (commit ae0970c). `ISessionKeyManagerExt` is Kamui's own extension.
use starknet::ContractAddress;

/// SRC-5 id of `ISessionKeyManager` (SNIP-41 Part G).
pub const SESSION_KEY_INTERFACE_ID: felt252 =
    0x9da822b09dda470480ed02c12ae8745d4ac010023df23c6db0314abe5cdc02;

/// Upper bound on whitelist entries per session, so that setting a session up has a bounded cost.
pub const MAX_ALLOWED_ENTRIES: u32 = 64;

/// A session's configuration (SNIP-41 Part A). All fields are zero for a session that does not
/// exist, was revoked, or belongs to an earlier session epoch.
#[derive(Drop, Copy, Serde, PartialEq, Debug)]
pub struct SessionData {
    pub valid_until: u64,
    pub max_calls: u32,
    pub max_fee_per_tx: u128,
    pub allowed_entrypoints_len: u32,
}

/// One entry of a contract-scoped whitelist (Kamui extension, plan decision D7).
#[derive(Drop, Copy, Serde, PartialEq, Debug)]
pub struct AllowedCall {
    pub to: ContractAddress,
    pub selector: felt252,
}

#[starknet::interface]
pub trait ISessionKeyManager<TContractState> {
    /// Adds a session key or replaces an existing one. Owner only.
    /// Replacing resets the session's usage and its whitelist.
    /// `max_fee_per_tx` is in fri; 0 makes the session paymaster-only.
    /// An empty `allowed_entrypoints` allows every selector that is not blocked.
    fn add_or_update_session_key(
        ref self: TContractState,
        session_key: felt252,
        valid_until: u64,
        max_calls: u32,
        max_fee_per_tx: u128,
        allowed_entrypoints: Array<felt252>,
    );

    /// Revokes a session key. Owner only.
    fn revoke_session_key(ref self: TContractState, session_key: felt252);

    /// Returns the configuration of a session key.
    fn get_session_data(self: @TContractState, session_key: felt252) -> SessionData;
}

/// Kamui extensions to SNIP-41.
#[starknet::interface]
pub trait ISessionKeyManagerExt<TContractState> {
    /// Like `add_or_update_session_key`, but the whitelist names `(contract, selector)` pairs, so
    /// the session can only call those selectors on those contracts. `allowed_calls` must not be
    /// empty. Owner only.
    fn add_or_update_scoped_session_key(
        ref self: TContractState,
        session_key: felt252,
        valid_until: u64,
        max_calls: u32,
        max_fee_per_tx: u128,
        allowed_calls: Array<AllowedCall>,
    );

    /// Revokes every session in one storage write by moving to a new session epoch. Owner only.
    fn revoke_all_sessions(ref self: TContractState);

    /// The current session epoch. Sessions created in an earlier epoch are dead.
    fn get_session_epoch(self: @TContractState) -> u32;

    /// Whether the session's whitelist is contract-scoped.
    fn is_session_scoped(self: @TContractState, session_key: felt252) -> bool;

    /// Whether the session may call `selector` on `to`. Covers the blocklist, the self-call block
    /// and the whitelist; it does not cover expiry, limits or the fee cap.
    fn is_session_call_allowed(
        self: @TContractState, session_key: felt252, to: ContractAddress, selector: felt252,
    ) -> bool;

    /// First SNIP-9 nonce reserved for the session. A sponsored session transaction must use a
    /// nonce in `[base, base + max_calls)`. Changes every time the session is added or updated.
    fn get_session_nonce_base(self: @TContractState, session_key: felt252) -> felt252;

    /// Self-paid limit: the first account nonce the session can no longer use, or 0 if the
    /// session has not sent a self-paid transaction yet.
    fn get_session_nonce_limit(self: @TContractState, session_key: felt252) -> u64;
}

/// The one thing the session component needs from the account that embeds it (SNIP-41 Part A).
pub trait HasAccountOwner<TContractState> {
    /// Must panic unless the caller is the account itself.
    fn assert_only_self(self: @TContractState);
}

/// Selectors a session can never call, on any contract (SNIP-41 Part D, plus Kamui's own).
pub fn is_blocked_selector(selector: felt252) -> bool {
    // SNIP-41 Part D
    selector == selector!("upgrade")
        || selector == selector!("add_or_update_session_key")
        || selector == selector!("revoke_session_key")
        || selector == selector!("__execute__")
        || selector == selector!("set_public_key")
        || selector == selector!("setPublicKey")
        || selector == selector!("execute_from_outside_v2")
        || selector == selector!("set_spending_policy")
        || selector == selector!("remove_spending_policy")
        // Kamui session extensions
        || selector == selector!("add_or_update_scoped_session_key")
        || selector == selector!("revoke_all_sessions")
        // Protocol entry points
        || selector == selector!("__validate__")
        || selector == selector!("__validate_declare__")
        || selector == selector!("__validate_deploy__")
        // Social recovery (keep-starknet-strange/social-account)
        || selector == selector!("recover")
        || selector == selector!("prove_jwt")
        || selector == selector!("finalize_override_recovery")
        || selector == selector!("cancel_override_recovery")
}
