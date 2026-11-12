use starknet::ContractAddress;

/// SNIP-5 id of `ISocialRecoverable`
pub const SOCIAL_COMPONENT_ID: felt252 =
    0x208f33e072a27c962fa7268bbcedf164f801e76c0272646a0846ec641a81e35;

/// How many blocks after its base block a recovery proof stays usable, on both paths.
/// The token checks (`exp`, `iat`, the registry key) ran at the base block, so without a
/// limit an expired token or a removed issuer key would stay provable against the past.
/// Sized for in-browser proving: about 4 minutes of proving at Sepolia's ~1.7 s
/// blocks is ~150 blocks; 1000 leaves room for slow machines and one retry.
pub const PROOF_VALIDITY_BLOCKS: u64 = 1000;

/// Unix seconds of how much a recovery can be delayed, so
/// the affected party has a chance to cancel.
/// Fixed at 7 days.
pub const RECOVERY_DELAY: u64 = 604800;

/// Unix seconds after `pending_ready_at` during which an override can still be finalized.
/// After that the pending record is dead and a new proof is needed. Fixed at 7 days.
pub const FINALIZE_WINDOW: u64 = 604800;

/// Pinned Registry contract address
pub const JWK_REGISTRY_ADDRESS: ContractAddress =
    0x4bc2b2afcce053e788511a851e6aeb004d18adb243df4fe852e1b727bd09808;

#[starknet::interface]
pub trait ISocialRecoverable<T> {
    fn prove_jwt(
        ref self: T,
        header_b64: ByteArray,
        payload_b64: ByteArray,
        kid: ByteArray,
        rsa_hint: Span<felt252>,
        new_pubkey: felt252,
        blinding: felt252,
        pepper: felt252,
    );
    fn recover(ref self: T, new_pubkey: felt252, signature: Span<felt252>);
    fn identity(self: @T) -> felt252;

    fn finalize_override_recovery(ref self: T, new_pubkey: felt252, signature: Span<felt252>);
    fn cancel_override_recovery(ref self: T);
}

/// Kamui change to upstream: how the component reaches the account's keys. Upstream calls
/// `get_public_key` and `set_public_key` on the account; Kamui has an owner set instead.
pub trait RecoveryTarget<TContractState> {
    /// The value a recovery proof is bound to (the `current_pubkey` slot of the proven message).
    /// Must change whenever the account's keys change, so a proof cannot be replayed.
    fn recovery_anchor(self: @TContractState) -> felt252;
    /// Gives `new_pubkey` access to the account. Called once the proof has been checked.
    fn apply_recovery(ref self: TContractState, new_pubkey: felt252, signature: Span<felt252>);
}

#[derive(Drop, Debug, PartialEq, starknet::Event)]
pub struct RecoveredEvent {
    pub new_pubkey: felt252,
}

#[derive(Drop, Debug, PartialEq, starknet::Event)]
pub struct PendingOverrideRecoveryEvent {
    pub new_pubkey: felt252,
    pub ready_at: u64,
}

#[derive(Drop, Debug, PartialEq, starknet::Event)]
pub struct PendingOverrideRecoveryCanceledEvent {}

#[starknet::component]
pub mod SocialComponent {
    use SRC5Component::InternalTrait;
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use openzeppelin_introspection::src5::SRC5Component;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::syscalls::send_message_to_l1_syscall;
    use starknet::{
        SyscallResultTrait, get_block_number, get_block_timestamp, get_caller_address,
        get_contract_address, get_execution_info,
    };
    use crate::jwt::registry::{IJwkRegistryDispatcher, IJwkRegistryDispatcherTrait};
    use crate::jwt::types::JwtPayloadTrait;
    use crate::jwt::verification::{verify_and_extract, verify_recovery_aud};
    use crate::social::proof_facts::ProofFactsVerificationTrait;
    use super::{
        FINALIZE_WINDOW, ISocialRecoverable, RecoveryTarget, JWK_REGISTRY_ADDRESS, PROOF_VALIDITY_BLOCKS,
        PendingOverrideRecoveryCanceledEvent, PendingOverrideRecoveryEvent, RECOVERY_DELAY,
        RecoveredEvent, SOCIAL_COMPONENT_ID,
    };


    #[storage]
    pub struct Storage {
        original_aud: ByteArray,
        /// poseidon(iss, aud, sub) of the Google account allowed to recover this one.
        identity: felt252,
        /// timestamp of the last recovery.
        last_recovery: u64,
        // h(new_pubkey, current_pubkey) assigned when the user runs recover with override
        pending_recovery: felt252,
        // block timestamp + RECOVERY_DELAY
        pending_ready_at: u64,
        // registry revocation_count when the override was queued
        pending_revocation_count: u64,
    }

    #[event]
    #[derive(Drop, Debug, PartialEq, starknet::Event)]
    pub enum Event {
        Recovered: RecoveredEvent,
        PendingOverrideRecovery: PendingOverrideRecoveryEvent,
        PendingOverrideRecoveryCanceled: PendingOverrideRecoveryCanceledEvent,
    }

    #[embeddable_as(SocialRecoverableImpl)]
    impl SocialRecoverable<
        TContractState,
        +HasComponent<TContractState>,
        +RecoveryTarget<TContractState>,
        +Drop<TContractState>,
    > of ISocialRecoverable<ComponentState<TContractState>> {
        fn prove_jwt(
            ref self: ComponentState<TContractState>,
            header_b64: ByteArray,
            payload_b64: ByteArray,
            kid: ByteArray,
            rsa_hint: Span<felt252>,
            new_pubkey: felt252,
            blinding: felt252,
            pepper: felt252,
        ) {
            let jwt_payload = verify_and_extract(
                header_b64, payload_b64, kid, rsa_hint, JWK_REGISTRY_ADDRESS,
            );

            let last_recovery = self.last_recovery.read();
            let nonce = poseidon_hash_span([new_pubkey, blinding].span());
            assert(jwt_payload.exp > get_block_timestamp(), 'TOKEN_EXPIRED');
            assert(jwt_payload.nonce == nonce, 'NONCE_MISMATCH');
            assert(jwt_payload.iat > last_recovery, 'STALE_IAT');

            let mut is_override = false;
            let identity = self.identity.read();
            if (jwt_payload.identity(pepper) != identity) {
                // First check if the user is the same
                // Reconstruct identity from original aud.
                let original_aud = self.original_aud.read();
                let original_identity = jwt_payload.identity_from_other_aud(@original_aud, pepper);
                assert(original_identity == identity, 'WRONG_IDENTITY');
                // Since this is the same user, check if this aud
                // is whitelisted from recovering the account
                assert(
                    verify_recovery_aud(@jwt_payload, JWK_REGISTRY_ADDRESS), 'INVALID_RECOVERY_AUD',
                );
                is_override = true;
            }

            let account_address = get_contract_address();
            let current_pubkey = self.get_contract().recovery_anchor();

            send_message_to_l1_syscall(
                to_address: Zero::zero(),
                payload: [
                    account_address.into(), identity, new_pubkey, current_pubkey,
                    is_override.into(),
                ]
                    .span(),
            )
                .unwrap_syscall();
        }

        fn recover(
            ref self: ComponentState<TContractState>, new_pubkey: felt252, signature: Span<felt252>,
        ) {
            let info = get_execution_info();
            let account_address = get_contract_address();
            let current_pubkey = self.get_contract().recovery_anchor();
            let identity = self.identity.read();

            let facts = ProofFactsVerificationTrait::extract_verified_program(info);
            let is_override = facts
                .verify(
                    account_address,
                    array![account_address.into(), identity, new_pubkey, current_pubkey],
                );

            assert(
                get_block_number() <= facts.base_block_number + PROOF_VALIDITY_BLOCKS,
                'STALE_PROOF',
            );
            // Kamui: the token was checked against the registry as it stood at the proof's base
            // block. If a key or a recovery aud has been revoked since, the proof rests on trust
            // that was withdrawn, however recent it is. This holds for both paths: without it a
            // normal recovery would go through, and an override would be queued with a
            // revocation count taken after the revocation. Strictly after: a proof based in the
            // revocation's own block is refused too, whichever way the prover orders that block.
            assert(
                facts.base_block_number > registry().last_revocation_block(), 'REVOKED_SINCE_PROOF',
            );

            if is_override {
                let ready_at = get_block_timestamp() + RECOVERY_DELAY;
                self
                    .pending_recovery
                    .write(poseidon_hash_span([new_pubkey, current_pubkey].span()));
                self.pending_ready_at.write(ready_at);
                self.pending_revocation_count.write(registry().revocation_count());
                self.emit(PendingOverrideRecoveryEvent { new_pubkey, ready_at });
            } else {
                let mut contract = self.get_contract_mut();
                contract.apply_recovery(new_pubkey, signature);
                self.last_recovery.write(get_block_timestamp());

                self.emit(RecoveredEvent { new_pubkey });
            }
        }

        fn identity(self: @ComponentState<TContractState>) -> felt252 {
            self.identity.read()
        }

        fn finalize_override_recovery(
            ref self: ComponentState<TContractState>, new_pubkey: felt252, signature: Span<felt252>,
        ) {
            let current_pubkey = self.get_contract().recovery_anchor();

            let pending_recovery = self.pending_recovery.read();
            assert(pending_recovery != 0, 'NO_PENDING_RECOVERY');
            assert(
                pending_recovery == poseidon_hash_span([new_pubkey, current_pubkey].span()),
                'PENDING_RECOVERY_MISSMATCH',
            );

            let now = get_block_timestamp();
            let ready_at = self.pending_ready_at.read();
            assert(now >= ready_at, 'PENDING_RECOVERY_NOT_READY');
            assert(now <= ready_at + FINALIZE_WINDOW, 'PENDING_RECOVERY_EXPIRED');
            // A key or aud removed since the override was queued cancels it.
            assert(
                self.pending_revocation_count.read() == registry().revocation_count(),
                'REVOKED_SINCE_PENDING',
            );

            // Clear before the key change, so the on_key_changed hook sees nothing to cancel.
            clear_pending(ref self);
            let mut contract = self.get_contract_mut();
            contract.apply_recovery(new_pubkey, signature);

            self.last_recovery.write(get_block_timestamp());

            self.emit(RecoveredEvent { new_pubkey });
        }

        fn cancel_override_recovery(ref self: ComponentState<TContractState>) {
            let caller = get_caller_address();
            assert(caller == get_contract_address(), 'Account: unauthorized');

            clear_pending(ref self);
            self.emit(PendingOverrideRecoveryCanceledEvent {});
        }
    }

    #[generate_trait]
    pub impl InternalSocialComponentImpl<
        TContractState,
        +HasComponent<TContractState>,
        impl SRC5: SRC5Component::HasComponent<TContractState>,
        +Drop<TContractState>,
    > of InternalSocialComponentTrait<TContractState> {
        fn initializer(
            ref self: ComponentState<TContractState>, aud: ByteArray, identity: felt252,
        ) {
            let mut src5_component = get_dep_component_mut!(ref self, SRC5);
            src5_component.register_interface(SOCIAL_COMPONENT_ID);

            self.original_aud.write(aud);
            self.identity.write(identity);
        }

        /// The contract must call this after every public key change, including the plain
        /// `set_public_key` entry point. A pending override is bound to the key it was proven
        /// against; if the key is ever reused, a stale record would become valid again.
        fn on_key_changed(ref self: ComponentState<TContractState>) {
            if self.pending_recovery.read() != 0 {
                clear_pending(ref self);
                self.emit(PendingOverrideRecoveryCanceledEvent {});
            }
        }
    }

    fn registry() -> IJwkRegistryDispatcher {
        IJwkRegistryDispatcher { contract_address: JWK_REGISTRY_ADDRESS }
    }

    fn clear_pending<TContractState, +HasComponent<TContractState>>(
        ref self: ComponentState<TContractState>,
    ) {
        self.pending_recovery.write(0);
        self.pending_ready_at.write(0);
    }
}
