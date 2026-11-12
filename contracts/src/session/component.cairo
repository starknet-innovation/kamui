//! Session keys for Kamui accounts, written from SNIP-41 as revised in starknet-io/SNIPs PR 180
//! (commit ae0970c). Embeddable in any account that implements `HasAccountOwner`.
//!
//! How this implementation fills in what the SNIP leaves open:
//!
//! - Message hash. A self-paid session transaction is signed over the protocol transaction hash.
//!   A sponsored one is signed over the SNIP-9 `OutsideExecution` message hash.
//! - `valid_until` in the signature must equal the stored value. Nothing else binds it.
//! - Transaction limit, self-paid path: nonce anchoring. The first self-paid transaction, at
//!   account nonce `a`, stores `a + max_calls`. Later ones need `nonce < a + max_calls` and write
//!   nothing.
//! - Transaction limit, sponsored path: a bounded SNIP-9 nonce range. The session may only use
//!   nonces in `[base, base + max_calls)`, so the account's SNIP-9 replay-protection write is the
//!   only write.
//! - Whitelists are keyed by a per-session generation that increases on every add or update.
//!   Entries of an earlier generation can never match again, so they are not cleared one by one.
//!   This meets the intent of SNIP-41 Part E (no stale selector can match) without its writes.
//!
//! Kamui extensions:
//!
//! - A session can never call the account itself, whatever its whitelist (the SNIP recommends
//!   this only for sessions without a whitelist).
//! - Contract-scoped whitelists (`add_or_update_scoped_session_key`).
//! - A session epoch: bumping it revokes every session in one write. The account must bump it
//!   whenever its owners change.
#[starknet::component]
pub mod SessionKeyComponent {
    use core::ecdsa::check_ecdsa_signature;
    use core::poseidon::poseidon_hash_span;
    use starknet::account::Call;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_contract_address, get_tx_info};
    use crate::session::interface::{
        AllowedCall, HasAccountOwner, ISessionKeyManager, ISessionKeyManagerExt,
        MAX_ALLOWED_ENTRIES, SessionData, is_blocked_selector,
    };
    use crate::session::packing::{
        SessionConfig, SessionConfigPacking, SessionState, SessionStatePacking,
    };

    /// Invoke transaction version 3, and the same with the query (simulation) offset.
    const TX_V3: felt252 = 3;
    const TX_V3_QUERY: felt252 = 0x100000000000000000000000000000003;
    /// The protocol sends three resource bounds. Anything much longer is refused.
    const MAX_RESOURCE_BOUNDS: u32 = 8;

    #[storage]
    pub struct Storage {
        pub Session_config: Map<felt252, SessionConfig>,
        pub Session_state: Map<felt252, SessionState>,
        /// (session key, generation, entry) -> allowed. The entry is a selector, or for a scoped
        /// session `poseidon(contract, selector)`.
        pub Session_allowed: Map<(felt252, u32, felt252), bool>,
        pub Session_epoch: u32,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        SessionKeySet: SessionKeySet,
        SessionKeyRevoked: SessionKeyRevoked,
        AllSessionsRevoked: AllSessionsRevoked,
    }

    #[derive(Drop, starknet::Event)]
    pub struct SessionKeySet {
        #[key]
        pub session_key: felt252,
        pub valid_until: u64,
        pub max_calls: u32,
        pub max_fee_per_tx: u128,
        pub allowed_len: u32,
        pub scoped: bool,
        pub generation: u32,
    }

    #[derive(Drop, starknet::Event)]
    pub struct SessionKeyRevoked {
        #[key]
        pub session_key: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct AllSessionsRevoked {
        pub new_epoch: u32,
    }

    pub mod Errors {
        pub const ZERO_KEY: felt252 = 'Session: zero key';
        pub const ALREADY_EXPIRED: felt252 = 'Session: already expired';
        pub const TOO_MANY_ENTRIES: felt252 = 'Session: too many entries';
        pub const EMPTY_SCOPE: felt252 = 'Session: empty scope';
        pub const ZERO_ENTRY: felt252 = 'Session: zero entry';
    }

    //
    // External
    //

    #[embeddable_as(SessionKeyManagerImpl)]
    impl SessionKeyManager<
        TContractState,
        +HasComponent<TContractState>,
        +HasAccountOwner<TContractState>,
        +Drop<TContractState>,
    > of ISessionKeyManager<ComponentState<TContractState>> {
        fn add_or_update_session_key(
            ref self: ComponentState<TContractState>,
            session_key: felt252,
            valid_until: u64,
            max_calls: u32,
            max_fee_per_tx: u128,
            allowed_entrypoints: Array<felt252>,
        ) {
            self.get_contract().assert_only_self();
            self
                ._set_session(
                    session_key,
                    valid_until,
                    max_calls,
                    max_fee_per_tx,
                    allowed_entrypoints.span(),
                    false,
                );
        }

        fn revoke_session_key(ref self: ComponentState<TContractState>, session_key: felt252) {
            self.get_contract().assert_only_self();
            // The state slot is kept: its generation must keep increasing if the key comes back.
            self
                .Session_config
                .write(
                    session_key,
                    SessionConfig {
                        valid_until: 0,
                        max_calls: 0,
                        max_fee_per_tx: 0,
                        allowed_len: 0,
                        scoped: false,
                    },
                );
            self.emit(SessionKeyRevoked { session_key });
        }

        fn get_session_data(
            self: @ComponentState<TContractState>, session_key: felt252,
        ) -> SessionData {
            match self._load_live(session_key) {
                Option::Some((
                    config, _,
                )) => SessionData {
                    valid_until: config.valid_until,
                    max_calls: config.max_calls,
                    max_fee_per_tx: config.max_fee_per_tx,
                    allowed_entrypoints_len: config.allowed_len.into(),
                },
                Option::None => SessionData {
                    valid_until: 0, max_calls: 0, max_fee_per_tx: 0, allowed_entrypoints_len: 0,
                },
            }
        }
    }

    #[embeddable_as(SessionKeyManagerExtImpl)]
    impl SessionKeyManagerExt<
        TContractState,
        +HasComponent<TContractState>,
        +HasAccountOwner<TContractState>,
        +Drop<TContractState>,
    > of ISessionKeyManagerExt<ComponentState<TContractState>> {
        fn add_or_update_scoped_session_key(
            ref self: ComponentState<TContractState>,
            session_key: felt252,
            valid_until: u64,
            max_calls: u32,
            max_fee_per_tx: u128,
            allowed_calls: Array<AllowedCall>,
        ) {
            self.get_contract().assert_only_self();
            assert(allowed_calls.len() != 0, Errors::EMPTY_SCOPE);
            let mut entries: Array<felt252> = array![];
            for allowed in allowed_calls.span() {
                entries.append(scoped_entry(*allowed.to, *allowed.selector));
            }
            self
                ._set_session(
                    session_key, valid_until, max_calls, max_fee_per_tx, entries.span(), true,
                );
        }

        fn revoke_all_sessions(ref self: ComponentState<TContractState>) {
            self.get_contract().assert_only_self();
            self.bump_session_epoch();
        }

        fn get_session_epoch(self: @ComponentState<TContractState>) -> u32 {
            self.Session_epoch.read()
        }

        fn is_session_scoped(self: @ComponentState<TContractState>, session_key: felt252) -> bool {
            match self._load_live(session_key) {
                Option::Some((config, _)) => config.scoped,
                Option::None => false,
            }
        }

        fn is_session_call_allowed(
            self: @ComponentState<TContractState>,
            session_key: felt252,
            to: ContractAddress,
            selector: felt252,
        ) -> bool {
            match self._load_live(session_key) {
                Option::Some((
                    config, state,
                )) => self._is_call_allowed(session_key, config, state, to, selector),
                Option::None => false,
            }
        }

        fn get_session_nonce_base(
            self: @ComponentState<TContractState>, session_key: felt252,
        ) -> felt252 {
            nonce_base(session_key, self.Session_state.read(session_key).generation)
        }

        fn get_session_nonce_limit(
            self: @ComponentState<TContractState>, session_key: felt252,
        ) -> u64 {
            match self._load_live(session_key) {
                Option::Some((_, state)) => state.nonce_limit,
                Option::None => 0,
            }
        }
    }

    //
    // Internal: what the embedding account calls
    //

    #[generate_trait]
    pub impl InternalImpl<
        TContractState, +HasComponent<TContractState>, +Drop<TContractState>,
    > of InternalTrait<TContractState> {
        /// Validates the current transaction as a self-paid session transaction: SNIP-41 Part C,
        /// steps 1 to 8, in that order. Call from `__validate__` when the signature has 4
        /// elements. Returns false instead of panicking. Writes at most once, and only on the
        /// session's first self-paid transaction.
        fn validate_session_transaction(
            ref self: ComponentState<TContractState>, calls: Span<Call>,
        ) -> bool {
            let tx_info = get_tx_info().unbox();

            // Steps 1 to 3: signature shape, expiry, session exists.
            let (session_key, r, s, config, state) = match self
                ._open_session(tx_info.signature) {
                Option::Some(opened) => opened,
                Option::None => { return false; },
            };

            // Step 4: transaction limit (nonce anchoring).
            if config.max_calls == 0 {
                return false;
            }
            let nonce: u64 = match tx_info.nonce.try_into() {
                Option::Some(nonce) => nonce,
                Option::None => { return false; },
            };
            let anchored = state.nonce_limit != 0;
            if anchored && nonce >= state.nonce_limit {
                return false;
            }

            // Step 4b: fee cap.
            if config.max_fee_per_tx == 0 {
                return false;
            }
            if !fee_within_cap(config.max_fee_per_tx) {
                return false;
            }

            // Steps 5, 5b and 6: blocklist, self-call block, whitelist.
            if !self._are_calls_allowed(session_key, config, state, calls) {
                return false;
            }

            // Step 7: signature over the transaction hash.
            if !check_ecdsa_signature(tx_info.transaction_hash, session_key, r, s) {
                return false;
            }

            // Step 8: record, only now. Anchor the limit on the first self-paid transaction.
            if !anchored {
                let limit: u128 = nonce.into() + config.max_calls.into();
                let nonce_limit: u64 = match limit.try_into() {
                    Option::Some(nonce_limit) => nonce_limit,
                    Option::None => { return false; },
                };
                self
                    .Session_state
                    .write(
                        session_key,
                        SessionState {
                            generation: state.generation, epoch: state.epoch, nonce_limit,
                        },
                    );
            }
            true
        }

        /// Validates a session signature on a SNIP-9 `OutsideExecution` (SNIP-41 Part F.5).
        /// Whitelist checks run before the signature check. This function writes nothing: the
        /// caller must mark `nonce` as used after it returns true, and that write is what
        /// records the transaction against the session's limit.
        fn validate_session_outside_execution(
            self: @ComponentState<TContractState>,
            calls: Span<Call>,
            nonce: felt252,
            message_hash: felt252,
            signature: Span<felt252>,
        ) -> bool {
            let (session_key, r, s, config, state) = match self._open_session(signature) {
                Option::Some(opened) => opened,
                Option::None => { return false; },
            };

            // Transaction limit: the nonce must be one of the `max_calls` reserved ones.
            let offset: felt252 = nonce - nonce_base(session_key, state.generation);
            let offset: u128 = match offset.try_into() {
                Option::Some(offset) => offset,
                Option::None => { return false; },
            };
            if offset >= config.max_calls.into() {
                return false;
            }

            if !self._are_calls_allowed(session_key, config, state, calls) {
                return false;
            }

            check_ecdsa_signature(message_hash, session_key, r, s)
        }

        /// For `is_valid_signature`: session exists, is not expired, and signed `hash`.
        /// There is no call context here, so whitelists and limits cannot be enforced.
        fn is_valid_session_signature(
            self: @ComponentState<TContractState>, hash: felt252, signature: Span<felt252>,
        ) -> bool {
            match self._open_session(signature) {
                Option::Some((
                    session_key, r, s, _, _,
                )) => check_ecdsa_signature(hash, session_key, r, s),
                Option::None => false,
            }
        }

        /// Revokes every session. The account must call this whenever its owners change.
        fn bump_session_epoch(ref self: ComponentState<TContractState>) {
            let new_epoch = self.Session_epoch.read() + 1;
            self.Session_epoch.write(new_epoch);
            self.emit(AllSessionsRevoked { new_epoch });
        }

        fn _set_session(
            ref self: ComponentState<TContractState>,
            session_key: felt252,
            valid_until: u64,
            max_calls: u32,
            max_fee_per_tx: u128,
            entries: Span<felt252>,
            scoped: bool,
        ) {
            assert(session_key != 0, Errors::ZERO_KEY);
            assert(valid_until > get_block_timestamp(), Errors::ALREADY_EXPIRED);
            assert(entries.len() <= MAX_ALLOWED_ENTRIES, Errors::TOO_MANY_ENTRIES);

            // A new generation resets usage and orphans the previous whitelist.
            let generation = self.Session_state.read(session_key).generation + 1;
            self
                .Session_state
                .write(
                    session_key,
                    SessionState { generation, epoch: self.Session_epoch.read(), nonce_limit: 0 },
                );

            for entry in entries {
                assert(*entry != 0, Errors::ZERO_ENTRY);
                self.Session_allowed.write((session_key, generation, *entry), true);
            }

            let allowed_len: u16 = entries.len().try_into().unwrap();
            self
                .Session_config
                .write(
                    session_key,
                    SessionConfig { valid_until, max_calls, max_fee_per_tx, allowed_len, scoped },
                );
            self
                .emit(
                    SessionKeySet {
                        session_key,
                        valid_until,
                        max_calls,
                        max_fee_per_tx,
                        allowed_len: entries.len(),
                        scoped,
                        generation,
                    },
                );
        }

        /// The session's records, if it exists in the current epoch.
        fn _load_live(
            self: @ComponentState<TContractState>, session_key: felt252,
        ) -> Option<(SessionConfig, SessionState)> {
            let config = self.Session_config.read(session_key);
            if config.valid_until == 0 {
                return Option::None;
            }
            let state = self.Session_state.read(session_key);
            if state.epoch != self.Session_epoch.read() {
                return Option::None;
            }
            Option::Some((config, state))
        }

        /// SNIP-41 Part C steps 1 to 3 for a `[session_pubkey, r, s, valid_until]` signature.
        /// Returns `(session_key, r, s, config, state)`.
        fn _open_session(
            self: @ComponentState<TContractState>, signature: Span<felt252>,
        ) -> Option<(felt252, felt252, felt252, SessionConfig, SessionState)> {
            if signature.len() != 4 {
                return Option::None;
            }
            let session_key = *signature.at(0);

            // Step 1: no panic on a `valid_until` that does not fit a u64.
            let valid_until: u64 = match (*signature.at(3)).try_into() {
                Option::Some(valid_until) => valid_until,
                Option::None => { return Option::None; },
            };

            // Step 2: expiry.
            if get_block_timestamp() > valid_until {
                return Option::None;
            }

            // Step 3: the session exists, in this epoch, with this expiry.
            let (config, state) = match self._load_live(session_key) {
                Option::Some(live) => live,
                Option::None => { return Option::None; },
            };
            if config.valid_until != valid_until {
                return Option::None;
            }

            Option::Some((session_key, *signature.at(1), *signature.at(2), config, state))
        }

        /// SNIP-41 Part C steps 5, 5b and 6 for every call. An empty call list is refused.
        fn _are_calls_allowed(
            self: @ComponentState<TContractState>,
            session_key: felt252,
            config: SessionConfig,
            state: SessionState,
            calls: Span<Call>,
        ) -> bool {
            if calls.len() == 0 {
                return false;
            }
            let mut allowed = true;
            for call in calls {
                if !self._is_call_allowed(session_key, config, state, *call.to, *call.selector) {
                    allowed = false;
                    break;
                }
            }
            allowed
        }

        fn _is_call_allowed(
            self: @ComponentState<TContractState>,
            session_key: felt252,
            config: SessionConfig,
            state: SessionState,
            to: ContractAddress,
            selector: felt252,
        ) -> bool {
            // Step 5: admin blocklist, on any contract.
            if is_blocked_selector(selector) {
                return false;
            }
            // Step 5b: a session never calls the account itself.
            if to == get_contract_address() {
                return false;
            }
            // Step 6: whitelist, if there is one.
            if config.allowed_len == 0 {
                return true;
            }
            let entry = if config.scoped {
                scoped_entry(to, selector)
            } else {
                selector
            };
            self.Session_allowed.read((session_key, state.generation, entry))
        }
    }

    //
    // Helpers
    //

    /// Whitelist entry of a contract-scoped session.
    pub fn scoped_entry(to: ContractAddress, selector: felt252) -> felt252 {
        poseidon_hash_span(array!['kamui.session.scope', to.into(), selector].span())
    }

    /// First SNIP-9 nonce reserved for a session at a given generation.
    pub fn nonce_base(session_key: felt252, generation: u32) -> felt252 {
        poseidon_hash_span(array!['kamui.session.nonce', session_key, generation.into()].span())
    }

    /// SNIP-41 Part C, fee cap: an upper bound on what the current transaction can be charged,
    /// from its own fee fields, compared to `cap`. Never panics. Transactions whose fee cannot be
    /// bounded (anything but V3) are refused.
    fn fee_within_cap(cap: u128) -> bool {
        let tx_info = get_tx_info().unbox();
        if tx_info.version != TX_V3 && tx_info.version != TX_V3_QUERY {
            return false;
        }
        let bounds = tx_info.resource_bounds;
        if bounds.len() > MAX_RESOURCE_BOUNDS {
            return false;
        }
        // Each product is below 2^192 and there are at most 8 of them, so u256 cannot overflow.
        let mut max_fee: u256 = 0;
        let mut l2_gas_amount: u256 = 0;
        for bound in bounds {
            let amount: u256 = (*bound.max_amount).into();
            let price: u256 = (*bound.max_price_per_unit).into();
            max_fee += amount * price;
            if *bound.resource == 'L2_GAS' {
                l2_gas_amount += amount;
            }
        }
        let tip: u256 = tx_info.tip.into();
        max_fee += tip * l2_gas_amount;
        max_fee <= cap.into()
    }
}
