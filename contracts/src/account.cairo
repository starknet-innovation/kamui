//! Kamui account, first cut: OpenZeppelin's single-owner account with Kamui's session keys and
//! its own SNIP-9 outside execution.
//!
//! Not here yet: social login and recovery, the upgrade path (plan D1) and the multi-device
//! owner set (plan D4). Not audited. Do not deploy with real funds.
use starknet::account::Call;

#[starknet::interface]
pub trait IKamuiAccount<TContractState> {
    fn __execute__(ref self: TContractState, calls: Array<Call>) -> Array<Span<felt252>>;
    /// `ref self`: a session's first self-paid transaction records its nonce limit here.
    fn __validate__(ref self: TContractState, calls: Array<Call>) -> felt252;
    fn is_valid_signature(
        self: @TContractState, hash: felt252, signature: Array<felt252>,
    ) -> felt252;
    fn get_public_key(self: @TContractState) -> felt252;
    /// Rotates the owner key and revokes every session.
    fn set_public_key(ref self: TContractState, new_public_key: felt252, signature: Span<felt252>);
}

/// SNIP-12 domain of SNIP-9 v2 outside execution.
pub impl OutsideExecutionSNIP12Metadata of openzeppelin_utils::cryptography::snip12::SNIP12Metadata {
    fn name() -> felt252 {
        'Account.execute_from_outside'
    }
    fn version() -> felt252 {
        2
    }
}

#[starknet::contract(account)]
pub mod KamuiAccount {
    use core::num::traits::Zero;
    use openzeppelin_account::AccountComponent;
    use openzeppelin_account::extensions::src9::snip12_utils::OutsideExecutionStructHash;
    use openzeppelin_account::utils::is_tx_version_valid;
    use openzeppelin_interfaces::src9::{ISRC9_V2, ISRC9_V2_ID, OutsideExecution};
    use openzeppelin_introspection::src5::SRC5Component;
    use openzeppelin_utils::cryptography::snip12::OffchainMessageHash;
    use openzeppelin_utils::execution::execute_calls;
    use starknet::account::Call;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
    };
    use starknet::{
        get_block_timestamp, get_caller_address, get_contract_address, get_tx_info,
    };
    use crate::session::component::SessionKeyComponent;
    use crate::session::interface::{HasAccountOwner, SESSION_KEY_INTERFACE_ID};
    use super::{IKamuiAccount, OutsideExecutionSNIP12Metadata};

    component!(path: AccountComponent, storage: account, event: AccountEvent);
    component!(path: SRC5Component, storage: src5, event: SRC5Event);
    component!(path: SessionKeyComponent, storage: session, event: SessionEvent);

    // OZ's SRC6 and PublicKey impls are not embedded: `__validate__`, `is_valid_signature` and
    // `set_public_key` are Kamui's own, below.
    #[abi(embed_v0)]
    impl DeclarerImpl = AccountComponent::DeclarerImpl<ContractState>;
    #[abi(embed_v0)]
    impl DeployableImpl = AccountComponent::DeployableImpl<ContractState>;
    #[abi(embed_v0)]
    impl SRC5Impl = SRC5Component::SRC5Impl<ContractState>;
    #[abi(embed_v0)]
    impl SessionKeyManagerImpl =
        SessionKeyComponent::SessionKeyManagerImpl<ContractState>;
    #[abi(embed_v0)]
    impl SessionKeyManagerExtImpl =
        SessionKeyComponent::SessionKeyManagerExtImpl<ContractState>;

    impl AccountInternalImpl = AccountComponent::InternalImpl<ContractState>;
    impl SRC5InternalImpl = SRC5Component::InternalImpl<ContractState>;
    impl SessionInternalImpl = SessionKeyComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        account: AccountComponent::Storage,
        #[substorage(v0)]
        src5: SRC5Component::Storage,
        #[substorage(v0)]
        session: SessionKeyComponent::Storage,
        /// SNIP-9 nonces already used.
        SRC9_nonces: Map<felt252, bool>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        AccountEvent: AccountComponent::Event,
        #[flat]
        SRC5Event: SRC5Component::Event,
        #[flat]
        SessionEvent: SessionKeyComponent::Event,
    }

    pub mod Errors {
        pub const INVALID_CALLER: felt252 = 'Kamui: invalid caller';
        pub const INVALID_TX_VERSION: felt252 = 'Kamui: invalid tx version';
        pub const INVALID_AFTER: felt252 = 'Kamui: now <= execute_after';
        pub const INVALID_BEFORE: felt252 = 'Kamui: now >= execute_before';
        pub const DUPLICATED_NONCE: felt252 = 'Kamui: duplicated nonce';
        pub const INVALID_SIGNATURE: felt252 = 'Kamui: invalid signature';
        pub const INVALID_SESSION: felt252 = 'Kamui: invalid session';
    }

    #[constructor]
    fn constructor(ref self: ContractState, public_key: felt252) {
        self.account.initializer(public_key);
        self.src5.register_interface(ISRC9_V2_ID);
        self.src5.register_interface(SESSION_KEY_INTERFACE_ID);
    }

    impl AccountOwner of HasAccountOwner<ContractState> {
        fn assert_only_self(self: @ContractState) {
            self.account.assert_only_self();
        }
    }

    #[abi(embed_v0)]
    impl KamuiAccountImpl of IKamuiAccount<ContractState> {
        /// Session restrictions are enforced in `__validate__`, on the same calls.
        fn __execute__(ref self: ContractState, calls: Array<Call>) -> Array<Span<felt252>> {
            assert(get_caller_address().is_zero(), Errors::INVALID_CALLER);
            assert(is_tx_version_valid(), Errors::INVALID_TX_VERSION);
            execute_calls(calls.span())
        }

        /// 2 elements: owner. 4 elements: session (SNIP-41). Anything else is refused.
        /// Returns 0 instead of panicking on an invalid signature.
        fn __validate__(ref self: ContractState, calls: Array<Call>) -> felt252 {
            // Only the protocol validates transactions. A contract calling this mid-transaction
            // would see the outer transaction's signature.
            if !get_caller_address().is_zero() {
                return 0;
            }
            let tx_info = get_tx_info().unbox();
            let signature = tx_info.signature;
            let valid = if signature.len() == 2 {
                self.account._is_valid_signature(tx_info.transaction_hash, signature)
            } else if signature.len() == 4 {
                self.session.validate_session_transaction(calls.span())
            } else {
                false
            };
            if valid {
                starknet::VALIDATED
            } else {
                0
            }
        }

        /// Read-only. A session signature is accepted here if the session exists and is not
        /// expired; whitelists and limits cannot apply because there are no calls to check.
        fn is_valid_signature(
            self: @ContractState, hash: felt252, signature: Array<felt252>,
        ) -> felt252 {
            let signature = signature.span();
            let valid = if signature.len() == 2 {
                self.account._is_valid_signature(hash, signature)
            } else if signature.len() == 4 {
                self.session.is_valid_session_signature(hash, signature)
            } else {
                false
            };
            if valid {
                starknet::VALIDATED
            } else {
                0
            }
        }

        fn get_public_key(self: @ContractState) -> felt252 {
            self.account.Account_public_key.read()
        }

        fn set_public_key(
            ref self: ContractState, new_public_key: felt252, signature: Span<felt252>,
        ) {
            self.account.assert_only_self();
            let current = self.account.Account_public_key.read();
            self.account.assert_valid_new_owner(current, new_public_key, signature);
            self.account._set_public_key(new_public_key);
            // The old key may be compromised: no session it approved survives.
            self.session.bump_session_epoch();
        }
    }

    #[abi(embed_v0)]
    impl OutsideExecutionV2Impl of ISRC9_V2<ContractState> {
        /// SNIP-9 v2. Unlike OpenZeppelin's component, the signature is checked here and not
        /// through `is_valid_signature`, so a session signature is checked against the calls:
        /// whitelist first, then signature, then the nonce write that records the transaction
        /// (SNIP-41 Part F.5).
        fn execute_from_outside_v2(
            ref self: ContractState, outside_execution: OutsideExecution, signature: Span<felt252>,
        ) -> Array<Span<felt252>> {
            if outside_execution.caller.into() != 'ANY_CALLER' {
                assert(get_caller_address() == outside_execution.caller, Errors::INVALID_CALLER);
            }

            let now = get_block_timestamp();
            assert(outside_execution.execute_after < now, Errors::INVALID_AFTER);
            assert(now < outside_execution.execute_before, Errors::INVALID_BEFORE);

            let nonce = outside_execution.nonce;
            assert(!self.SRC9_nonces.read(nonce), Errors::DUPLICATED_NONCE);

            let message_hash = outside_execution.get_message_hash(get_contract_address());
            if signature.len() == 4 {
                assert(
                    self
                        .session
                        .validate_session_outside_execution(
                            outside_execution.calls, nonce, message_hash, signature,
                        ),
                    Errors::INVALID_SESSION,
                );
            } else {
                assert(
                    self.account._is_valid_signature(message_hash, signature),
                    Errors::INVALID_SIGNATURE,
                );
            }

            // Recorded after the signature check and before the calls run (reentrancy).
            self.SRC9_nonces.write(nonce, true);

            execute_calls(outside_execution.calls)
        }

        fn is_valid_outside_execution_nonce(self: @ContractState, nonce: felt252) -> bool {
            !self.SRC9_nonces.read(nonce)
        }
    }
}
