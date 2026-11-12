//! The Kamui account: social login and recovery (keep-starknet-strange/social-account), session
//! keys (SNIP-41) and Kamui's own SNIP-9 outside execution, on OpenZeppelin's account.
//!
//! The owner key is 0 until the first recovery. Every key change goes through `set_public_key`,
//! including `recover`, which calls it on the account itself. That one function therefore drops
//! any pending override recovery and revokes every session.
//!
//! Not here yet: the upgrade path (plan D1) and the multi-device owner set (plan D4).
//! Not audited. Do not deploy with real funds.

#[starknet::contract(account)]
pub mod KamuiAccount {
    use SocialComponent::InternalSocialComponentTrait;
    use openzeppelin_account::AccountComponent;
    use openzeppelin_interfaces::accounts::IPublicKey;
    use openzeppelin_introspection::src5::SRC5Component;
    use crate::core::KamuiCoreComponent;
    use crate::session::component::SessionKeyComponent;
    use crate::session::interface::HasAccountOwner;
    use crate::social::component::SocialComponent;

    component!(path: AccountComponent, storage: account, event: AccountEvent);
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
    impl DeclarerImpl = AccountComponent::DeclarerImpl<ContractState>;
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

    // Not embedded: every key change must go through `set_public_key` below.
    impl OZPublicKeyImpl = AccountComponent::PublicKeyImpl<ContractState>;
    impl AccountInternalImpl = AccountComponent::InternalImpl<ContractState>;
    impl SessionInternalImpl = SessionKeyComponent::InternalImpl<ContractState>;
    impl CoreInternalImpl = KamuiCoreComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        account: AccountComponent::Storage,
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
        AccountEvent: AccountComponent::Event,
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
    #[constructor]
    fn constructor(ref self: ContractState, aud: ByteArray, identity: felt252) {
        // Key 0 until the first recovery. The initializer also registers SRC6 in SRC5.
        self.account.initializer(0);
        self.social.initializer(aud, identity);
        self.core.initializer();
    }

    impl AccountOwner of HasAccountOwner<ContractState> {
        fn assert_only_self(self: @ContractState) {
            self.account.assert_only_self();
        }
    }

    #[abi(embed_v0)]
    impl PublicKeyImpl of IPublicKey<ContractState> {
        fn get_public_key(self: @ContractState) -> felt252 {
            OZPublicKeyImpl::get_public_key(self)
        }

        /// The only way the owner key changes, for a rotation and for a recovery alike.
        fn set_public_key(
            ref self: ContractState, new_public_key: felt252, signature: Span<felt252>,
        ) {
            OZPublicKeyImpl::set_public_key(ref self, new_public_key, signature);
            // A pending override was proven against the old key.
            self.social.on_key_changed();
            // The old key may be compromised: no session it approved survives.
            self.session.bump_session_epoch();
        }
    }
}
