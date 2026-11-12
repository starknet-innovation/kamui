//! What every Kamui account shares: transaction validation and execution with owner and
//! session signatures, and Kamui's own SNIP-9 outside execution.
//!
//! A component so that the production account (`KamuiAccount`, social login) and the devnet
//! account (`mocks::DevAccount`, plain key) run exactly the same code.
use starknet::account::Call;

#[starknet::interface]
pub trait IKamuiAccount<TContractState> {
    fn __execute__(ref self: TContractState, calls: Array<Call>) -> Array<Span<felt252>>;
    /// `ref self`: a session's first self-paid transaction records its nonce limit here.
    fn __validate__(ref self: TContractState, calls: Array<Call>) -> felt252;
    fn is_valid_signature(
        self: @TContractState, hash: felt252, signature: Array<felt252>,
    ) -> felt252;
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

#[starknet::component]
pub mod KamuiCoreComponent {
    use OwnersComponent::ReadTrait as OwnersReadTrait;
    use SRC5Component::InternalTrait as SRC5InternalTrait;
    use SessionKeyComponent::InternalTrait as SessionInternalTrait;
    use core::num::traits::Zero;
    use openzeppelin_account::extensions::src9::snip12_utils::OutsideExecutionStructHash;
    use openzeppelin_account::utils::is_tx_version_valid;
    use openzeppelin_interfaces::accounts::ISRC6_ID;
    use openzeppelin_interfaces::src9::{ISRC9_V2, ISRC9_V2_ID, OutsideExecution};
    use openzeppelin_introspection::src5::SRC5Component;
    use openzeppelin_utils::cryptography::snip12::OffchainMessageHash;
    use openzeppelin_utils::execution::execute_calls;
    use starknet::account::Call;
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use starknet::{get_block_timestamp, get_caller_address, get_contract_address, get_tx_info};
    use crate::owners::OwnersComponent;
    use crate::session::component::SessionKeyComponent;
    use crate::session::interface::SESSION_KEY_INTERFACE_ID;
    use super::{IKamuiAccount, OutsideExecutionSNIP12Metadata};

    #[storage]
    pub struct Storage {
        /// SNIP-9 nonces already used.
        pub SRC9_nonces: Map<felt252, bool>,
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

    #[embeddable_as(KamuiAccountImpl)]
    impl KamuiAccount<
        TContractState,
        +HasComponent<TContractState>,
        impl Owners: OwnersComponent::HasComponent<TContractState>,
        impl Session: SessionKeyComponent::HasComponent<TContractState>,
        +SRC5Component::HasComponent<TContractState>,
        +Drop<TContractState>,
    > of IKamuiAccount<ComponentState<TContractState>> {
        /// Session restrictions are enforced in `__validate__`, on the same calls.
        fn __execute__(
            ref self: ComponentState<TContractState>, calls: Array<Call>,
        ) -> Array<Span<felt252>> {
            assert(get_caller_address().is_zero(), Errors::INVALID_CALLER);
            assert(is_tx_version_valid(), Errors::INVALID_TX_VERSION);
            execute_calls(calls.span())
        }

        /// 2 elements: any owner key. 4 elements: session (SNIP-41). Anything else is refused.
        /// Returns 0 instead of panicking on an invalid signature.
        fn __validate__(ref self: ComponentState<TContractState>, calls: Array<Call>) -> felt252 {
            // Only the protocol validates transactions. A contract calling this mid-transaction
            // would see the outer transaction's signature.
            if !get_caller_address().is_zero() {
                return 0;
            }
            let tx_info = get_tx_info().unbox();
            let signature = tx_info.signature;
            let valid = if signature.len() == 2 {
                let owners = get_dep_component!(@self, Owners);
                owners.is_valid_owner_signature(tx_info.transaction_hash, signature)
            } else if signature.len() == 4 {
                let mut session = get_dep_component_mut!(ref self, Session);
                session.validate_session_transaction(calls.span())
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
        /// expired; whitelists and limits cannot apply because there are no calls to check
        /// (SNIP-41; plan section 7).
        fn is_valid_signature(
            self: @ComponentState<TContractState>, hash: felt252, signature: Array<felt252>,
        ) -> felt252 {
            let signature = signature.span();
            let valid = if signature.len() == 2 {
                let owners = get_dep_component!(self, Owners);
                owners.is_valid_owner_signature(hash, signature)
            } else if signature.len() == 4 {
                let session = get_dep_component!(self, Session);
                session.is_valid_session_signature(hash, signature)
            } else {
                false
            };
            if valid {
                starknet::VALIDATED
            } else {
                0
            }
        }
    }

    #[embeddable_as(OutsideExecutionV2Impl)]
    impl OutsideExecutionV2<
        TContractState,
        +HasComponent<TContractState>,
        impl Owners: OwnersComponent::HasComponent<TContractState>,
        impl Session: SessionKeyComponent::HasComponent<TContractState>,
        +SRC5Component::HasComponent<TContractState>,
        +Drop<TContractState>,
    > of ISRC9_V2<ComponentState<TContractState>> {
        /// SNIP-9 v2. Unlike OpenZeppelin's component, the signature is checked here and not
        /// through `is_valid_signature`, so a session signature is checked against the calls:
        /// whitelist first, then signature, then the nonce write that records the transaction
        /// (SNIP-41 Part F.5).
        fn execute_from_outside_v2(
            ref self: ComponentState<TContractState>,
            outside_execution: OutsideExecution,
            signature: Span<felt252>,
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
                let session = get_dep_component!(@self, Session);
                assert(
                    session
                        .validate_session_outside_execution(
                            outside_execution.calls, nonce, message_hash, signature,
                        ),
                    Errors::INVALID_SESSION,
                );
            } else {
                let owners = get_dep_component!(@self, Owners);
                assert(
                    owners.is_valid_owner_signature(message_hash, signature),
                    Errors::INVALID_SIGNATURE,
                );
            }

            // Recorded after the signature check and before the calls run (reentrancy).
            self.SRC9_nonces.write(nonce, true);

            execute_calls(outside_execution.calls)
        }

        fn is_valid_outside_execution_nonce(
            self: @ComponentState<TContractState>, nonce: felt252,
        ) -> bool {
            !self.SRC9_nonces.read(nonce)
        }
    }

    #[generate_trait]
    pub impl InternalImpl<
        TContractState,
        +HasComponent<TContractState>,
        impl SRC5: SRC5Component::HasComponent<TContractState>,
        +Drop<TContractState>,
    > of InternalTrait<TContractState> {
        /// Registers the SRC-6 account, SNIP-9 v2 and SNIP-41 interface ids.
        fn initializer(ref self: ComponentState<TContractState>) {
            let mut src5 = get_dep_component_mut!(ref self, SRC5);
            src5.register_interface(ISRC6_ID);
            src5.register_interface(ISRC9_V2_ID);
            src5.register_interface(SESSION_KEY_INTERFACE_ID);
        }
    }
}
