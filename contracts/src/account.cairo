//! The Kamui account: social login and recovery (keep-starknet-strange/social-account), an
//! owner set with one key per device, session keys (SNIP-41) and Kamui's own SNIP-9 outside
//! execution.
//!
//! The account is deployed from `(aud, identity)` with no owner. A login proves the identity and
//! adds the device's key; a later login on another device adds another key.
//!
//! Whenever the owner set changes (a login on a new device, a key added or removed by an
//! owner), every session is revoked and any pending override recovery is dropped (plan D5).
//!
//! Not upgradeable (plan D1). Not audited. Do not deploy with real funds.

#[starknet::contract(account)]
pub mod KamuiAccount {
    use SocialComponent::InternalSocialComponentTrait;
    use openzeppelin_introspection::src5::SRC5Component;
    use crate::core::KamuiCoreComponent;
    use crate::owners::OwnersComponent;
    use crate::session::component::SessionKeyComponent;
    use crate::session::interface::HasAccountOwner;
    use crate::social::component::{RecoveryTarget, SocialComponent};

    component!(path: OwnersComponent, storage: owners, event: OwnersEvent);
    component!(path: SRC5Component, storage: src5, event: SRC5Event);
    component!(path: SessionKeyComponent, storage: session, event: SessionEvent);
    component!(path: KamuiCoreComponent, storage: core, event: CoreEvent);
    component!(path: SocialComponent, storage: social, event: SocialEvent);

    #[abi(embed_v0)]
    impl KamuiAccountImpl = KamuiCoreComponent::KamuiAccountImpl<ContractState>;
    #[abi(embed_v0)]
    impl OutsideExecutionV2Impl =
        KamuiCoreComponent::OutsideExecutionV2Impl<ContractState>;
    #[abi(embed_v0)]
    impl OwnersImpl = OwnersComponent::OwnersImpl<ContractState>;
    #[abi(embed_v0)]
    impl SRC5Impl = SRC5Component::SRC5Impl<ContractState>;
    #[abi(embed_v0)]
    impl SessionKeyManagerImpl =
        SessionKeyComponent::SessionKeyManagerImpl<ContractState>;
    #[abi(embed_v0)]
    impl SessionKeyManagerExtImpl =
        SessionKeyComponent::SessionKeyManagerExtImpl<ContractState>;
    #[abi(embed_v0)]
    impl SocialRecoverableImpl =
        SocialComponent::SocialRecoverableImpl<ContractState>;

    impl OwnersReadImpl = OwnersComponent::ReadImpl<ContractState>;
    impl OwnersInternalImpl = OwnersComponent::InternalImpl<ContractState>;
    impl SessionInternalImpl = SessionKeyComponent::InternalImpl<ContractState>;
    impl CoreInternalImpl = KamuiCoreComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        owners: OwnersComponent::Storage,
        #[substorage(v0)]
        src5: SRC5Component::Storage,
        #[substorage(v0)]
        session: SessionKeyComponent::Storage,
        #[substorage(v0)]
        core: KamuiCoreComponent::Storage,
        #[substorage(v0)]
        social: SocialComponent::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        OwnersEvent: OwnersComponent::Event,
        #[flat]
        SRC5Event: SRC5Component::Event,
        #[flat]
        SessionEvent: SessionKeyComponent::Event,
        #[flat]
        CoreEvent: KamuiCoreComponent::Event,
        #[flat]
        SocialEvent: SocialComponent::Event,
    }

    /// The address commits to `(aud, identity)` only, so it can be computed from a login.
    /// There is no owner until the first recovery.
    #[constructor]
    fn constructor(ref self: ContractState, aud: ByteArray, identity: felt252) {
        self.social.initializer(aud, identity);
        self.core.initializer();
    }

    impl AccountOwner of HasAccountOwner<ContractState> {
        fn assert_only_self(self: @ContractState) {
            self.owners.assert_only_self();
        }
    }

    impl OwnersHooks of OwnersComponent::OwnersHooksTrait<ContractState> {
        fn after_owners_changed(ref self: OwnersComponent::ComponentState<ContractState>) {
            let mut contract = self.get_contract_mut();
            // A pending override was proven against the previous owner set.
            contract.social.on_key_changed();
            // Sessions do not survive a change of owners: a new login may mean an old key is
            // compromised.
            contract.session.bump_session_epoch();
        }
    }

    impl Recovery of RecoveryTarget<ContractState> {
        fn recovery_anchor(self: @ContractState) -> felt252 {
            self.owners.anchor()
        }

        fn apply_recovery(
            ref self: ContractState, new_pubkey: felt252, signature: Span<felt252>,
        ) {
            self.owners.add_recovered_owner(new_pubkey, signature);
        }
    }
}
