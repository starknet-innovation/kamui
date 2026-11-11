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
