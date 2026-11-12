//! Test-only contracts.

#[starknet::interface]
pub trait ITarget<TContractState> {
    fn ping(ref self: TContractState);
    fn transfer(ref self: TContractState, recipient: felt252, amount: u256);
    fn count(self: @TContractState) -> u32;
}

/// Counts the calls it receives.
#[starknet::contract]
pub mod Target {
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};

    #[storage]
    struct Storage {
        count: u32,
    }

    #[abi(embed_v0)]
    impl TargetImpl of super::ITarget<ContractState> {
        fn ping(ref self: ContractState) {
            self.count.write(self.count.read() + 1);
        }

        fn transfer(ref self: ContractState, recipient: felt252, amount: u256) {
            self.count.write(self.count.read() + 1);
        }

        fn count(self: @ContractState) -> u32 {
            self.count.read()
        }
    }
}

/// A Kamui account with a plain owner key and no social login, for devnets, where there are no
/// SNIP-36 proofs to recover with. Sessions and outside execution are the production code.
#[starknet::contract(account)]
pub mod DevAccount {
    use openzeppelin_account::AccountComponent;
    use openzeppelin_interfaces::accounts::IPublicKey;
    use openzeppelin_introspection::src5::SRC5Component;
    use crate::core::KamuiCoreComponent;
    use crate::session::component::SessionKeyComponent;
    use crate::session::interface::HasAccountOwner;

    component!(path: AccountComponent, storage: account, event: AccountEvent);
    component!(path: SRC5Component, storage: src5, event: SRC5Event);
    component!(path: SessionKeyComponent, storage: session, event: SessionEvent);
    component!(path: KamuiCoreComponent, storage: core, event: CoreEvent);

    #[abi(embed_v0)]
    impl KamuiAccountImpl = KamuiCoreComponent::KamuiAccountImpl<ContractState>;
    #[abi(embed_v0)]
    impl OutsideExecutionV2Impl =
        KamuiCoreComponent::OutsideExecutionV2Impl<ContractState>;
    #[abi(embed_v0)]
    impl SRC5Impl = SRC5Component::SRC5Impl<ContractState>;
    #[abi(embed_v0)]
    impl SessionKeyManagerImpl =
        SessionKeyComponent::SessionKeyManagerImpl<ContractState>;
    #[abi(embed_v0)]
    impl SessionKeyManagerExtImpl =
        SessionKeyComponent::SessionKeyManagerExtImpl<ContractState>;

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
    }

    #[constructor]
    fn constructor(ref self: ContractState, public_key: felt252) {
        self.account.initializer(public_key);
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

        fn set_public_key(
            ref self: ContractState, new_public_key: felt252, signature: Span<felt252>,
        ) {
            OZPublicKeyImpl::set_public_key(ref self, new_public_key, signature);
            self.session.bump_session_epoch();
        }
    }
}
