//! Spending policies (SNIP-41 Part H) on both execution paths.
use core::num::traits::Zero;
use kamui::core::{
    IKamuiAccountDispatcher, IKamuiAccountDispatcherTrait, OutsideExecutionSNIP12Metadata,
};
use kamui::mocks::{ITargetDispatcher, ITargetDispatcherTrait};
use kamui::session::interface::{
    ISessionKeyManagerExtDispatcher, ISessionKeyManagerExtDispatcherTrait,
};
use kamui::session::spending::{
    ISessionSpendingPolicyDispatcher, ISessionSpendingPolicyDispatcherTrait, SpendingPolicy,
};
use openzeppelin_account::extensions::src9::snip12_utils::OutsideExecutionStructHash;
use openzeppelin_interfaces::src9::{ISRC9_V2Dispatcher, ISRC9_V2DispatcherTrait, OutsideExecution};
use openzeppelin_utils::cryptography::snip12::OffchainMessageHash;
use snforge_std::signature::SignerTrait;
use snforge_std::signature::stark_curve::StarkCurveSignerImpl;
use snforge_std::{
    start_cheat_block_timestamp_global, start_cheat_caller_address, start_cheat_signature,
};
use starknet::account::Call;
use starknet::{ContractAddress, get_contract_address};
use super::test_sessions::{
    Env, FEE_CAP, NOW, VALID_UNTIL, add_session, as_owner, default_fees, owner_key, session_key,
    session_signature, setup, validate_session,
};

const WINDOW: u64 = 600;

fn policies(env: Env) -> ISessionSpendingPolicyDispatcher {
    ISessionSpendingPolicyDispatcher { contract_address: env.account }
}

/// A session that may call anything, with a policy on `env.target`: 100 per call, 250 per window.
fn setup_with_policy() -> Env {
    let env = setup();
    default_fees(env);
    add_session(env, 50, FEE_CAP, array![]);
    as_owner(env);
    policies(env).set_spending_policy(session_key().public_key, env.target, 100, 250, WINDOW);
    env
}

fn token_call(token: ContractAddress, selector: felt252, amount: u256) -> Call {
    Call {
        to: token, selector, calldata: array![0x1234, amount.low.into(), amount.high.into()].span(),
    }
}

fn transfer(env: Env, amount: u256) -> Call {
    token_call(env.target, selector!("transfer"), amount)
}

/// Executes `calls` as a self-paid session transaction: `__execute__` with the session's
/// signature in the transaction info. `__validate__` is covered elsewhere.
fn execute_self_paid(env: Env, calls: Array<Call>) {
    start_cheat_caller_address(env.account, Zero::zero());
    start_cheat_signature(env.account, session_signature(session_key(), 0x1, VALID_UNTIL.into()));
    IKamuiAccountDispatcher { contract_address: env.account }.__execute__(calls);
}

/// Executes `calls` as a sponsored session transaction, at the session's `offset`-th nonce.
fn execute_sponsored(env: Env, calls: Array<Call>, offset: felt252) {
    let base = ISessionKeyManagerExtDispatcher { contract_address: env.account }
        .get_session_nonce_base(session_key().public_key);
    let now = starknet::get_block_timestamp();
    let execution = OutsideExecution {
        caller: 'ANY_CALLER'.try_into().unwrap(),
        nonce: base + offset,
        execute_after: now - 1,
        execute_before: now + 100,
        calls: calls.span(),
    };
    let signature = session_signature(
        session_key(), execution.get_message_hash(env.account), VALID_UNTIL.into(),
    );
    start_cheat_caller_address(env.account, get_contract_address());
    ISRC9_V2Dispatcher { contract_address: env.account }
        .execute_from_outside_v2(execution, signature);
}

fn count(env: Env) -> u32 {
    ITargetDispatcher { contract_address: env.target }.count()
}

fn spent(env: Env) -> u256 {
    policies(env).get_spending_policy(session_key().public_key, env.target).spent_in_window
}

//
// Managing policies
//

#[test]
fn stores_and_returns_a_policy() {
    let env = setup_with_policy();
    assert_eq!(
        policies(env).get_spending_policy(session_key().public_key, env.target),
        SpendingPolicy {
            max_per_call: 100,
            max_per_window: 250,
            window_seconds: WINDOW,
            spent_in_window: 0,
            window_start: NOW,
        },
    );
}

#[test]
#[should_panic(expected: 'Account: unauthorized')]
fn only_the_account_sets_a_policy() {
    let env = setup();
    start_cheat_caller_address(env.account, env.other);
    policies(env).set_spending_policy(session_key().public_key, env.target, 1, 1, 1);
}

#[test]
#[should_panic(expected: 'Account: unauthorized')]
fn only_the_account_removes_a_policy() {
    let env = setup_with_policy();
    start_cheat_caller_address(env.account, env.other);
    policies(env).remove_spending_policy(session_key().public_key, env.target);
}

#[test]
#[should_panic(expected: 'Spending: zero window limit')]
fn a_policy_needs_a_window_limit() {
    let env = setup();
    as_owner(env);
    policies(env).set_spending_policy(session_key().public_key, env.target, 100, 0, WINDOW);
}

#[test]
fn a_session_cannot_change_its_own_policy() {
    let env = setup_with_policy();
    for selector in array![selector!("set_spending_policy"), selector!("remove_spending_policy")] {
        let calls = array![Call { to: env.account, selector, calldata: array![].span() }];
        assert_eq!(validate_session(env, calls, 1), 0);
        // Not on another contract either: the selectors are blocked everywhere.
        let calls = array![Call { to: env.other, selector, calldata: array![].span() }];
        assert_eq!(validate_session(env, calls, 1), 0);
    }
}

//
// Sponsored path
//

#[test]
fn sponsored_spending_within_the_limits_is_recorded() {
    let env = setup_with_policy();
    execute_sponsored(env, array![transfer(env, 100)], 0);
    execute_sponsored(env, array![transfer(env, 100)], 1);
    execute_sponsored(env, array![transfer(env, 50)], 2);
    assert_eq!(count(env), 3);
    assert_eq!(spent(env), 250);
}

#[test]
#[should_panic(expected: 'Spending: over per-call limit')]
fn sponsored_call_over_the_per_call_limit_panics() {
    let env = setup_with_policy();
    execute_sponsored(env, array![transfer(env, 101)], 0);
}

#[test]
#[should_panic(expected: 'Spending: over window limit')]
fn sponsored_spending_over_the_window_limit_panics() {
    let env = setup_with_policy();
    execute_sponsored(env, array![transfer(env, 100)], 0);
    execute_sponsored(env, array![transfer(env, 100)], 1);
    execute_sponsored(env, array![transfer(env, 51)], 2);
}

#[test]
#[should_panic(expected: 'Spending: over window limit')]
fn the_window_limit_counts_every_call_of_a_multicall() {
    let env = setup_with_policy();
    execute_sponsored(env, array![transfer(env, 100), transfer(env, 100), transfer(env, 51)], 0);
}

#[test]
fn a_new_window_resets_the_spent_amount() {
    let env = setup_with_policy();
    execute_sponsored(env, array![transfer(env, 100), transfer(env, 100)], 0);
    assert_eq!(spent(env), 200);

    start_cheat_block_timestamp_global(NOW + WINDOW - 1);
    assert_eq!(spent(env), 200);
    start_cheat_block_timestamp_global(NOW + WINDOW);
    execute_sponsored(env, array![transfer(env, 100)], 1);

    let policy = policies(env).get_spending_policy(session_key().public_key, env.target);
    assert_eq!(policy.spent_in_window, 100);
    assert_eq!(policy.window_start, NOW + WINDOW);
}

#[test]
#[should_panic(expected: 'Spending: over per-call limit')]
fn approve_is_tracked() {
    let env = setup_with_policy();
    execute_sponsored(env, array![token_call(env.target, selector!("approve"), 101)], 0);
}

#[test]
#[should_panic(expected: 'Spending: over per-call limit')]
fn increase_allowance_is_tracked() {
    let env = setup_with_policy();
    execute_sponsored(env, array![token_call(env.target, selector!("increase_allowance"), 101)], 0);
}

#[test]
#[should_panic(expected: 'Spending: over per-call limit')]
fn camel_case_increase_allowance_is_tracked() {
    let env = setup_with_policy();
    execute_sponsored(env, array![token_call(env.target, selector!("increaseAllowance"), 101)], 0);
}

#[test]
#[should_panic(expected: 'Spending: over per-call limit')]
fn the_high_half_of_the_amount_counts() {
    let env = setup_with_policy();
    execute_sponsored(env, array![transfer(env, u256 { low: 1, high: 1 })], 0);
}

#[test]
#[should_panic(expected: 'Spending: bad calldata')]
fn a_tracked_call_without_an_amount_panics() {
    let env = setup_with_policy();
    let call = Call { to: env.target, selector: selector!("transfer"), calldata: array![1].span() };
    execute_sponsored(env, array![call], 0);
}

#[test]
fn a_token_without_a_policy_is_unrestricted() {
    let env = setup_with_policy();
    // `env.other` has no policy: SNIP-41 leaves it unrestricted.
    let big = u256 { low: 0, high: 1 };
    execute_sponsored(env, array![token_call(env.other, selector!("transfer"), big)], 0);
    assert_eq!(ITargetDispatcher { contract_address: env.other }.count(), 1);
    assert_eq!(spent(env), 0);
}

#[test]
fn other_selectors_are_not_tracked() {
    let env = setup_with_policy();
    let ping = Call { to: env.target, selector: selector!("ping"), calldata: array![].span() };
    execute_sponsored(env, array![ping], 0);
    assert_eq!(count(env), 1);
    assert_eq!(spent(env), 0);
}

#[test]
fn removing_a_policy_lifts_the_limits() {
    let env = setup_with_policy();
    as_owner(env);
    policies(env).remove_spending_policy(session_key().public_key, env.target);
    execute_sponsored(env, array![transfer(env, 1_000_000)], 0);
    assert_eq!(count(env), 1);
}

#[test]
fn setting_a_policy_again_starts_a_fresh_window() {
    let env = setup_with_policy();
    execute_sponsored(env, array![transfer(env, 100)], 0);
    as_owner(env);
    policies(env).set_spending_policy(session_key().public_key, env.target, 10, 20, WINDOW);
    assert_eq!(spent(env), 0);
    execute_sponsored(env, array![transfer(env, 10)], 1);
    assert_eq!(spent(env), 10);
}

#[test]
fn an_owner_is_not_limited_by_a_session_policy() {
    let env = setup_with_policy();
    let execution = OutsideExecution {
        caller: 'ANY_CALLER'.try_into().unwrap(),
        nonce: 7,
        execute_after: NOW - 1,
        execute_before: NOW + 100,
        calls: array![transfer(env, 1_000_000)].span(),
    };
    let (r, s) = owner_key().sign(execution.get_message_hash(env.account)).unwrap();
    start_cheat_caller_address(env.account, get_contract_address());
    ISRC9_V2Dispatcher { contract_address: env.account }
        .execute_from_outside_v2(execution, array![r, s].span());
    assert_eq!(count(env), 1);
    assert_eq!(spent(env), 0);
}

//
// Self-paid path
//

#[test]
fn self_paid_spending_within_the_limits_is_recorded() {
    let env = setup_with_policy();
    execute_self_paid(env, array![transfer(env, 100), transfer(env, 100)]);
    assert_eq!(count(env), 2);
    assert_eq!(spent(env), 200);
}

#[test]
#[should_panic(expected: 'Spending: over per-call limit')]
fn self_paid_call_over_the_per_call_limit_panics() {
    let env = setup_with_policy();
    execute_self_paid(env, array![transfer(env, 101)]);
}

#[test]
#[should_panic(expected: 'Spending: over window limit')]
fn self_paid_and_sponsored_spending_share_one_window() {
    let env = setup_with_policy();
    execute_sponsored(env, array![transfer(env, 100), transfer(env, 100)], 0);
    execute_self_paid(env, array![transfer(env, 51)]);
}

#[test]
fn an_owner_transaction_is_not_limited() {
    let env = setup_with_policy();
    start_cheat_caller_address(env.account, Zero::zero());
    // An owner signature has two elements.
    start_cheat_signature(env.account, array![1, 2].span());
    IKamuiAccountDispatcher { contract_address: env.account }
        .__execute__(array![transfer(env, 1_000_000)]);
    assert_eq!(count(env), 1);
    assert_eq!(spent(env), 0);
}
