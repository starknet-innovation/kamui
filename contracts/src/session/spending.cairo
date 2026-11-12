//! Per-token spending limits for session keys: SNIP-41 Part H, as written (starknet-io/SNIPs
//! PR 180 at ae0970c).
//!
//! - A policy belongs to a `(session key, token)` pair and is set by the account owner.
//! - It limits the amount of each `transfer`, `approve`, `increase_allowance` and
//!   `increaseAllowance` call the session makes on that token, and the total over a time window.
//! - As the SNIP says, a pair with no policy is unrestricted. Limiting a session's token calls
//!   is therefore the job of whoever approves the session: set a policy for every token the
//!   session may call.
//! - Checks run when the calls execute, not in `__validate__`, so the spent amount is only
//!   recorded if the transaction goes through.
//!
//! Where the SNIP is silent:
//!
//! - A policy needs `max_per_window > 0`, since 0 is how "no policy" is stored.
//! - Setting a policy starts a fresh window with nothing spent.
//! - A tracked call whose calldata is too short to hold an amount is refused when a policy
//!   exists.
//! - Policies are stored apart from sessions and outlive them. A leftover policy can only
//!   restrict a session key that is registered again.
use starknet::ContractAddress;

#[derive(Drop, Copy, Serde, PartialEq, Debug, starknet::Store)]
pub struct SpendingPolicy {
    /// Maximum amount per individual call.
    pub max_per_call: u256,
    /// Maximum cumulative amount per time window. 0 means there is no policy.
    pub max_per_window: u256,
    /// Duration of the window in seconds.
    pub window_seconds: u64,
    /// Amount spent in the current window.
    pub spent_in_window: u256,
    /// Timestamp at which the current window started.
    pub window_start: u64,
}

#[starknet::interface]
pub trait ISessionSpendingPolicy<TContractState> {
    fn set_spending_policy(
        ref self: TContractState,
        session_key: felt252,
        token: ContractAddress,
        max_per_call: u256,
        max_per_window: u256,
        window_seconds: u64,
    );
    fn get_spending_policy(
        self: @TContractState, session_key: felt252, token: ContractAddress,
    ) -> SpendingPolicy;
    fn remove_spending_policy(ref self: TContractState, session_key: felt252, token: ContractAddress);
}

/// ERC-20 selectors counted as spending (SNIP-41 Part H).
pub fn is_spending_selector(selector: felt252) -> bool {
    selector == selector!("transfer")
        || selector == selector!("approve")
        || selector == selector!("increase_allowance")
        || selector == selector!("increaseAllowance")
}

#[starknet::component]
pub mod SpendingPolicyComponent {
    use core::num::traits::CheckedAdd;
    use core::panic_with_felt252;
    use starknet::account::Call;
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use starknet::{ContractAddress, get_block_timestamp};
    use crate::session::interface::HasAccountOwner;
    use super::{ISessionSpendingPolicy, SpendingPolicy, is_spending_selector};

    #[storage]
    pub struct Storage {
        pub Spending_policies: Map<(felt252, ContractAddress), SpendingPolicy>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        SpendingPolicySet: SpendingPolicySet,
        SpendingPolicyRemoved: SpendingPolicyRemoved,
    }

    #[derive(Drop, starknet::Event)]
    pub struct SpendingPolicySet {
        #[key]
        pub session_key: felt252,
        #[key]
        pub token: ContractAddress,
        pub max_per_call: u256,
        pub max_per_window: u256,
        pub window_seconds: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct SpendingPolicyRemoved {
        #[key]
        pub session_key: felt252,
        #[key]
        pub token: ContractAddress,
    }

    pub mod Errors {
        pub const ZERO_WINDOW_LIMIT: felt252 = 'Spending: zero window limit';
        pub const BAD_CALLDATA: felt252 = 'Spending: bad calldata';
        pub const OVER_CALL_LIMIT: felt252 = 'Spending: over per-call limit';
        pub const OVER_WINDOW_LIMIT: felt252 = 'Spending: over window limit';
    }

    #[embeddable_as(SessionSpendingPolicyImpl)]
    impl SessionSpendingPolicy<
        TContractState,
        +HasComponent<TContractState>,
        +HasAccountOwner<TContractState>,
        +Drop<TContractState>,
    > of ISessionSpendingPolicy<ComponentState<TContractState>> {
        fn set_spending_policy(
            ref self: ComponentState<TContractState>,
            session_key: felt252,
            token: ContractAddress,
            max_per_call: u256,
            max_per_window: u256,
            window_seconds: u64,
        ) {
            self.get_contract().assert_only_self();
            assert(max_per_window != 0, Errors::ZERO_WINDOW_LIMIT);
            self
                .Spending_policies
                .write(
                    (session_key, token),
                    SpendingPolicy {
                        max_per_call,
                        max_per_window,
                        window_seconds,
                        spent_in_window: 0,
                        window_start: get_block_timestamp(),
                    },
                );
            self
                .emit(
                    SpendingPolicySet {
                        session_key, token, max_per_call, max_per_window, window_seconds,
                    },
                );
        }

        fn get_spending_policy(
            self: @ComponentState<TContractState>, session_key: felt252, token: ContractAddress,
        ) -> SpendingPolicy {
            self.Spending_policies.read((session_key, token))
        }

        fn remove_spending_policy(
            ref self: ComponentState<TContractState>, session_key: felt252, token: ContractAddress,
        ) {
            self.get_contract().assert_only_self();
            self
                .Spending_policies
                .write(
                    (session_key, token),
                    SpendingPolicy {
                        max_per_call: 0,
                        max_per_window: 0,
                        window_seconds: 0,
                        spent_in_window: 0,
                        window_start: 0,
                    },
                );
            self.emit(SpendingPolicyRemoved { session_key, token });
        }
    }

    #[generate_trait]
    pub impl InternalImpl<
        TContractState, +HasComponent<TContractState>, +Drop<TContractState>,
    > of InternalTrait<TContractState> {
        /// Applies the session's policies to `calls` and records what they spend. Panics if a
        /// call goes over a limit. Call it when a session's calls are about to execute.
        fn check_and_update_spending(
            ref self: ComponentState<TContractState>, session_key: felt252, calls: Span<Call>,
        ) {
            let now = get_block_timestamp();
            for call in calls {
                if !is_spending_selector(*call.selector) {
                    continue;
                }
                let key = (session_key, *call.to);
                let mut policy = self.Spending_policies.read(key);
                // No policy for this session and token: unrestricted (SNIP-41 Part H).
                if policy.max_per_window == 0 {
                    continue;
                }

                // The amount is the u256 at calldata positions 1 (low) and 2 (high).
                let calldata = *call.calldata;
                assert(calldata.len() >= 3, Errors::BAD_CALLDATA);
                let low: u128 = match (*calldata.at(1)).try_into() {
                    Option::Some(low) => low,
                    Option::None => panic_with_felt252(Errors::BAD_CALLDATA),
                };
                let high: u128 = match (*calldata.at(2)).try_into() {
                    Option::Some(high) => high,
                    Option::None => panic_with_felt252(Errors::BAD_CALLDATA),
                };
                let amount = u256 { low, high };

                assert(amount <= policy.max_per_call, Errors::OVER_CALL_LIMIT);

                // A new window starts once the current one is over.
                let window_end: u128 = policy.window_start.into() + policy.window_seconds.into();
                if now.into() >= window_end {
                    policy.window_start = now;
                    policy.spent_in_window = 0;
                }

                let spent = match policy.spent_in_window.checked_add(amount) {
                    Option::Some(spent) => spent,
                    Option::None => panic_with_felt252(Errors::OVER_WINDOW_LIMIT),
                };
                assert(spent <= policy.max_per_window, Errors::OVER_WINDOW_LIMIT);

                policy.spent_in_window = spent;
                self.Spending_policies.write(key, policy);
            }
        }
    }
}
