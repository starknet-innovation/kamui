//! Owner set for Kamui accounts (plan decision D4): one key per device, at most `MAX_OWNERS`.
//!
//! - Any owner key signs for the account. An owner signature is `[r, s]`, as for a single-key
//!   account; it is checked against each owner in turn.
//! - A recovery adds the new device's key. If the set is full it replaces the oldest key, so a
//!   user who lost every device can always get back in.
//! - An owner can add a key (which must prove it exists by signing) and remove one, but never
//!   the last one.
//! - `anchor` changes on every change of the set. Recovery proofs and new-owner signatures are
//!   bound to it, so neither can be replayed after the set has changed.
//! - The embedding account is told about every change through `OwnersHooksTrait`.

use core::hash::{HashStateExTrait, HashStateTrait};

/// Maximum number of owner keys. Bounds the cost of checking an owner signature.
pub const MAX_OWNERS: u32 = 5;

#[starknet::interface]
pub trait IOwners<TContractState> {
    /// The owner keys, oldest first.
    fn get_owners(self: @TContractState) -> Array<felt252>;
    fn is_owner(self: @TContractState, key: felt252) -> bool;
    /// A value that changes every time the owner set changes. 0 while there is no owner.
    fn get_owners_anchor(self: @TContractState) -> felt252;
    /// Adds an owner key. Account only. `signature` is the new key's signature over
    /// `new_owner_message_hash(account, anchor)`. Panics if the set is full.
    fn add_owner(ref self: TContractState, new_owner: felt252, signature: Span<felt252>);
    /// Removes an owner key. Account only. The last owner cannot be removed.
    fn remove_owner(ref self: TContractState, owner: felt252);
}

/// What a key signs to become an owner: OpenZeppelin's `accept_ownership` message, with the
/// owner set anchor where OpenZeppelin puts the current owner.
pub fn new_owner_message_hash(account: starknet::ContractAddress, anchor: felt252) -> felt252 {
    core::poseidon::PoseidonTrait::new()
        .update_with('StarkNet Message')
        .update_with('accept_ownership')
        .update_with(account)
        .update_with(anchor)
        .finalize()
}

#[starknet::component]
pub mod OwnersComponent {
    use core::poseidon::poseidon_hash_span;
    use openzeppelin_account::utils::is_valid_stark_signature;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{get_caller_address, get_contract_address};
    use super::{IOwners, MAX_OWNERS, new_owner_message_hash};

    #[storage]
    pub struct Storage {
        /// slot -> owner key, 0 if the slot is empty.
        pub Owners_keys: Map<u32, felt252>,
        /// slot -> value of `Owners_counter` when the key was added, for "oldest".
        pub Owners_added_at: Map<u32, u64>,
        /// Number of changes made to the set so far.
        pub Owners_counter: u64,
        pub Owners_anchor: felt252,
    }

    #[event]
    #[derive(Drop, Debug, PartialEq, starknet::Event)]
    pub enum Event {
        OwnerAdded: OwnerAdded,
        OwnerRemoved: OwnerRemoved,
    }

    #[derive(Drop, Debug, PartialEq, starknet::Event)]
    pub struct OwnerAdded {
        #[key]
        pub owner: felt252,
    }

    #[derive(Drop, Debug, PartialEq, starknet::Event)]
    pub struct OwnerRemoved {
        #[key]
        pub owner: felt252,
    }

    pub mod Errors {
        pub const UNAUTHORIZED: felt252 = 'Account: unauthorized';
        pub const ZERO_KEY: felt252 = 'Owners: zero key';
        pub const ALREADY_OWNER: felt252 = 'Owners: already an owner';
        pub const NOT_OWNER: felt252 = 'Owners: not an owner';
        pub const FULL: felt252 = 'Owners: full';
        pub const LAST_OWNER: felt252 = 'Owners: last owner';
        pub const INVALID_SIGNATURE: felt252 = 'Owners: invalid signature';
    }

    /// Called after every change of the owner set: a key added, removed or replaced.
    pub trait OwnersHooksTrait<TContractState> {
        fn after_owners_changed(ref self: ComponentState<TContractState>);
    }

    #[embeddable_as(OwnersImpl)]
    impl Owners<
        TContractState,
        +HasComponent<TContractState>,
        +OwnersHooksTrait<TContractState>,
        +Drop<TContractState>,
    > of IOwners<ComponentState<TContractState>> {
        fn get_owners(self: @ComponentState<TContractState>) -> Array<felt252> {
            // Oldest first: repeatedly take the smallest `added_at` above the last one taken.
            let mut owners = array![];
            let mut last: u64 = 0;
            loop {
                let mut best_slot = MAX_OWNERS;
                let mut best_at: u64 = 0;
                for slot in 0..MAX_OWNERS {
                    if self.Owners_keys.read(slot) == 0 {
                        continue;
                    }
                    let at = self.Owners_added_at.read(slot);
                    if at > last && (best_slot == MAX_OWNERS || at < best_at) {
                        best_slot = slot;
                        best_at = at;
                    }
                }
                if best_slot == MAX_OWNERS {
                    break;
                }
                owners.append(self.Owners_keys.read(best_slot));
                last = best_at;
            }
            owners
        }

        fn is_owner(self: @ComponentState<TContractState>, key: felt252) -> bool {
            self.is_owner_key(key)
        }

        fn get_owners_anchor(self: @ComponentState<TContractState>) -> felt252 {
            self.Owners_anchor.read()
        }

        fn add_owner(
            ref self: ComponentState<TContractState>, new_owner: felt252, signature: Span<felt252>,
        ) {
            self.assert_only_self();
            self._add(new_owner, signature, false);
        }

        fn remove_owner(ref self: ComponentState<TContractState>, owner: felt252) {
            self.assert_only_self();
            assert(owner != 0, Errors::ZERO_KEY);
            let mut found = MAX_OWNERS;
            let mut count: u32 = 0;
            for slot in 0..MAX_OWNERS {
                let key = self.Owners_keys.read(slot);
                if key != 0 {
                    count += 1;
                    if key == owner {
                        found = slot;
                    }
                }
            }
            assert(found != MAX_OWNERS, Errors::NOT_OWNER);
            assert(count > 1, Errors::LAST_OWNER);

            self.Owners_keys.write(found, 0);
            self._changed('removed', owner);
            self.emit(OwnerRemoved { owner });
            OwnersHooksTrait::after_owners_changed(ref self);
        }
    }

    /// Read-only helpers. No hooks needed, so other components can depend on these alone.
    #[generate_trait]
    pub impl ReadImpl<
        TContractState, +HasComponent<TContractState>, +Drop<TContractState>,
    > of ReadTrait<TContractState> {
        fn assert_only_self(self: @ComponentState<TContractState>) {
            assert(get_caller_address() == get_contract_address(), Errors::UNAUTHORIZED);
        }

        fn is_owner_key(self: @ComponentState<TContractState>, key: felt252) -> bool {
            if key == 0 {
                return false;
            }
            let mut found = false;
            for slot in 0..MAX_OWNERS {
                if self.Owners_keys.read(slot) == key {
                    found = true;
                    break;
                }
            }
            found
        }

        /// Whether `signature` is `[r, s]` by any owner key over `hash`.
        fn is_valid_owner_signature(
            self: @ComponentState<TContractState>, hash: felt252, signature: Span<felt252>,
        ) -> bool {
            if signature.len() != 2 {
                return false;
            }
            let mut valid = false;
            for slot in 0..MAX_OWNERS {
                let key = self.Owners_keys.read(slot);
                if key != 0 && is_valid_stark_signature(hash, key, signature) {
                    valid = true;
                    break;
                }
            }
            valid
        }

        fn anchor(self: @ComponentState<TContractState>) -> felt252 {
            self.Owners_anchor.read()
        }
    }

    #[generate_trait]
    pub impl InternalImpl<
        TContractState,
        +HasComponent<TContractState>,
        +OwnersHooksTrait<TContractState>,
        +Drop<TContractState>,
    > of InternalTrait<TContractState> {
        /// Adds the first owner without a signature. For constructors only.
        fn initializer(ref self: ComponentState<TContractState>, owner: felt252) {
            assert(owner != 0, Errors::ZERO_KEY);
            self.Owners_keys.write(0, owner);
            self._changed('added', owner);
            self.Owners_added_at.write(0, self.Owners_counter.read());
            self.emit(OwnerAdded { owner });
        }

        /// Adds the key a recovery proved. Replaces the oldest key if the set is full.
        /// The caller must have checked the proof.
        fn add_recovered_owner(
            ref self: ComponentState<TContractState>, new_owner: felt252, signature: Span<felt252>,
        ) {
            self._add(new_owner, signature, true);
        }

        fn _add(
            ref self: ComponentState<TContractState>,
            new_owner: felt252,
            signature: Span<felt252>,
            replace_oldest_if_full: bool,
        ) {
            assert(new_owner != 0, Errors::ZERO_KEY);
            assert(!self.is_owner_key(new_owner), Errors::ALREADY_OWNER);

            // The new key must exist: it signs the account and the current anchor.
            let message = new_owner_message_hash(get_contract_address(), self.Owners_anchor.read());
            assert(
                is_valid_stark_signature(message, new_owner, signature), Errors::INVALID_SIGNATURE,
            );

            // First empty slot, or the oldest key's slot if there is none.
            let mut target = MAX_OWNERS;
            let mut oldest_slot = 0;
            let mut oldest_at: u64 = 0;
            for slot in 0..MAX_OWNERS {
                if self.Owners_keys.read(slot) == 0 {
                    target = slot;
                    break;
                }
                let at = self.Owners_added_at.read(slot);
                if slot == 0 || at < oldest_at {
                    oldest_slot = slot;
                    oldest_at = at;
                }
            }

            let mut replaced: felt252 = 0;
            if target == MAX_OWNERS {
                assert(replace_oldest_if_full, Errors::FULL);
                target = oldest_slot;
                replaced = self.Owners_keys.read(target);
            }

            self.Owners_keys.write(target, new_owner);
            self._changed('added', new_owner);
            self.Owners_added_at.write(target, self.Owners_counter.read());
            if replaced != 0 {
                self.emit(OwnerRemoved { owner: replaced });
            }
            self.emit(OwnerAdded { owner: new_owner });
            OwnersHooksTrait::after_owners_changed(ref self);
        }

        /// Bumps the change counter and moves the anchor.
        fn _changed(ref self: ComponentState<TContractState>, what: felt252, key: felt252) {
            let counter = self.Owners_counter.read() + 1;
            self.Owners_counter.write(counter);
            let anchor = poseidon_hash_span(
                array!['kamui.owners', self.Owners_anchor.read(), what, key, counter.into()].span(),
            );
            self.Owners_anchor.write(anchor);
        }
    }
}
