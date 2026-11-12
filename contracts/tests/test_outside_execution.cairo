//! Session keys on the sponsored path (`execute_from_outside_v2`): SNIP-41 Part F.
use kamui::core::OutsideExecutionSNIP12Metadata;
use kamui::mocks::{ITargetDispatcher, ITargetDispatcherTrait};
use kamui::session::interface::{
    ISessionKeyManagerExtDispatcher, ISessionKeyManagerExtDispatcherTrait,
};
use openzeppelin_account::extensions::src9::snip12_utils::OutsideExecutionStructHash;
use openzeppelin_interfaces::src9::{ISRC9_V2Dispatcher, ISRC9_V2DispatcherTrait, OutsideExecution};
use openzeppelin_utils::cryptography::snip12::OffchainMessageHash;
use snforge_std::signature::SignerTrait;
use snforge_std::signature::stark_curve::StarkCurveSignerImpl;
use snforge_std::{start_cheat_block_timestamp_global, start_cheat_caller_address};
use starknet::account::Call;
use starknet::{ContractAddress, get_contract_address};
use super::test_sessions::{
    Env, FEE_CAP, NOW, VALID_UNTIL, add_session, as_owner, call, owner_key, session_key,
    session_signature, setup,
};

fn any_caller() -> ContractAddress {
    'ANY_CALLER'.try_into().unwrap()
}

fn outside(calls: Span<Call>, nonce: felt252) -> OutsideExecution {
    OutsideExecution {
        caller: any_caller(), nonce, execute_after: NOW - 1, execute_before: NOW + 100, calls,
    }
}

fn ping_calls(env: Env) -> Span<Call> {
    array![call(env.target, selector!("ping"))].span()
}

fn src9(env: Env) -> ISRC9_V2Dispatcher {
    // Sent by a relayer: any address that is not the account.
    start_cheat_caller_address(env.account, get_contract_address());
    ISRC9_V2Dispatcher { contract_address: env.account }
}

fn nonce_base(env: Env) -> felt252 {
    ISessionKeyManagerExtDispatcher { contract_address: env.account }
        .get_session_nonce_base(session_key().public_key)
}

fn session_sign(env: Env, execution: OutsideExecution) -> Span<felt252> {
    session_signature(session_key(), execution.get_message_hash(env.account), VALID_UNTIL.into())
}

fn count(env: Env) -> u32 {
    ITargetDispatcher { contract_address: env.target }.count()
}

#[test]
fn owner_signature_executes() {
    let env = setup();
    let execution = outside(ping_calls(env), 1);
    let (r, s) = owner_key().sign(execution.get_message_hash(env.account)).unwrap();
    src9(env).execute_from_outside_v2(execution, array![r, s].span());
    assert_eq!(count(env), 1);
    assert!(!src9(env).is_valid_outside_execution_nonce(1));
}

#[test]
#[should_panic(expected: 'Kamui: invalid signature')]
fn wrong_owner_signature_panics() {
    let env = setup();
    let execution = outside(ping_calls(env), 1);
    let (r, s) = session_key().sign(execution.get_message_hash(env.account)).unwrap();
    src9(env).execute_from_outside_v2(execution, array![r, s].span());
}

#[test]
#[should_panic(expected: 'Kamui: duplicated nonce')]
fn nonce_cannot_be_replayed() {
    let env = setup();
    let execution = outside(ping_calls(env), 1);
    let (r, s) = owner_key().sign(execution.get_message_hash(env.account)).unwrap();
    src9(env).execute_from_outside_v2(execution, array![r, s].span());
    src9(env).execute_from_outside_v2(execution, array![r, s].span());
}

#[test]
#[should_panic(expected: 'Kamui: now >= execute_before')]
fn expired_window_panics() {
    let env = setup();
    let execution = outside(ping_calls(env), 1);
    let (r, s) = owner_key().sign(execution.get_message_hash(env.account)).unwrap();
    start_cheat_block_timestamp_global(NOW + 100);
    src9(env).execute_from_outside_v2(execution, array![r, s].span());
}

#[test]
fn session_signature_executes_within_its_nonce_range() {
    let env = setup();
    // Paymaster-only session: a zero fee cap does not matter on the sponsored path.
    add_session(env, 2, 0, array![selector!("ping")]);
    let base = nonce_base(env);

    let first = outside(ping_calls(env), base);
    src9(env).execute_from_outside_v2(first, session_sign(env, first));
    let second = outside(ping_calls(env), base + 1);
    src9(env).execute_from_outside_v2(second, session_sign(env, second));
    assert_eq!(count(env), 2);
}

#[test]
#[should_panic(expected: 'Kamui: invalid session')]
fn session_nonce_past_the_range_panics() {
    let env = setup();
    add_session(env, 2, FEE_CAP, array![]);
    let execution = outside(ping_calls(env), nonce_base(env) + 2);
    src9(env).execute_from_outside_v2(execution, session_sign(env, execution));
}

#[test]
#[should_panic(expected: 'Kamui: invalid session')]
fn session_nonce_before_the_range_panics() {
    let env = setup();
    add_session(env, 2, FEE_CAP, array![]);
    let execution = outside(ping_calls(env), nonce_base(env) - 1);
    src9(env).execute_from_outside_v2(execution, session_sign(env, execution));
}

#[test]
#[should_panic(expected: 'Kamui: invalid session')]
fn session_cannot_pick_an_arbitrary_nonce() {
    let env = setup();
    add_session(env, 2, FEE_CAP, array![]);
    let execution = outside(ping_calls(env), 1);
    src9(env).execute_from_outside_v2(execution, session_sign(env, execution));
}

#[test]
#[should_panic(expected: 'Kamui: duplicated nonce')]
fn max_calls_one_cannot_be_used_twice() {
    let env = setup();
    add_session(env, 1, FEE_CAP, array![]);
    let execution = outside(ping_calls(env), nonce_base(env));
    src9(env).execute_from_outside_v2(execution, session_sign(env, execution));
    src9(env).execute_from_outside_v2(execution, session_sign(env, execution));
}

#[test]
fn updating_a_session_moves_its_nonce_range() {
    let env = setup();
    add_session(env, 1, FEE_CAP, array![]);
    let old_base = nonce_base(env);
    let execution = outside(ping_calls(env), old_base);
    src9(env).execute_from_outside_v2(execution, session_sign(env, execution));

    add_session(env, 1, FEE_CAP, array![]);
    let new_base = nonce_base(env);
    assert!(new_base != old_base);
    let execution = outside(ping_calls(env), new_base);
    src9(env).execute_from_outside_v2(execution, session_sign(env, execution));
    assert_eq!(count(env), 2);
}

#[test]
#[should_panic(expected: 'Kamui: invalid session')]
fn old_nonce_range_is_dead_after_an_update() {
    let env = setup();
    add_session(env, 2, FEE_CAP, array![]);
    let old_base = nonce_base(env);
    add_session(env, 2, FEE_CAP, array![]);
    let execution = outside(ping_calls(env), old_base + 1);
    src9(env).execute_from_outside_v2(execution, session_sign(env, execution));
}

#[test]
#[should_panic(expected: 'Kamui: invalid session')]
fn whitelist_is_enforced() {
    let env = setup();
    add_session(env, 2, FEE_CAP, array![selector!("ping")]);
    let calls = array![call(env.target, selector!("transfer"))].span();
    let execution = outside(calls, nonce_base(env));
    src9(env).execute_from_outside_v2(execution, session_sign(env, execution));
}

#[test]
#[should_panic(expected: 'Kamui: invalid session')]
fn blocklist_is_enforced() {
    let env = setup();
    add_session(env, 2, FEE_CAP, array![]);
    let calls = array![call(env.account, selector!("add_or_update_session_key"))].span();
    let execution = outside(calls, nonce_base(env));
    src9(env).execute_from_outside_v2(execution, session_sign(env, execution));
}

#[test]
#[should_panic(expected: 'Kamui: invalid session')]
fn nested_outside_execution_is_refused() {
    let env = setup();
    add_session(env, 2, FEE_CAP, array![]);
    let calls = array![call(env.account, selector!("execute_from_outside_v2"))].span();
    let execution = outside(calls, nonce_base(env));
    src9(env).execute_from_outside_v2(execution, session_sign(env, execution));
}

#[test]
#[should_panic(expected: 'Kamui: invalid session')]
fn signature_over_other_calls_panics() {
    let env = setup();
    add_session(env, 2, FEE_CAP, array![]);
    let signed = outside(ping_calls(env), nonce_base(env));
    let signature = session_sign(env, signed);
    let sent = outside(array![call(env.other, selector!("ping"))].span(), nonce_base(env));
    src9(env).execute_from_outside_v2(sent, signature);
}

#[test]
#[should_panic(expected: 'Kamui: invalid session')]
fn expired_session_panics() {
    let env = setup();
    add_session(env, 2, FEE_CAP, array![]);
    start_cheat_block_timestamp_global(VALID_UNTIL + 1);
    let execution = OutsideExecution {
        caller: any_caller(),
        nonce: nonce_base(env),
        execute_after: VALID_UNTIL,
        execute_before: VALID_UNTIL + 100,
        calls: ping_calls(env),
    };
    src9(env).execute_from_outside_v2(execution, session_sign(env, execution));
}

#[test]
#[should_panic(expected: 'Kamui: invalid session')]
fn revoked_sessions_panic() {
    let env = setup();
    add_session(env, 2, FEE_CAP, array![]);
    as_owner(env);
    ISessionKeyManagerExtDispatcher { contract_address: env.account }.revoke_all_sessions();
    let execution = outside(ping_calls(env), nonce_base(env));
    src9(env).execute_from_outside_v2(execution, session_sign(env, execution));
}

#[test]
fn nonce_is_marked_used_only_by_a_successful_execution() {
    let env = setup();
    add_session(env, 1, FEE_CAP, array![selector!("ping")]);
    let base = nonce_base(env);
    assert!(src9(env).is_valid_outside_execution_nonce(base));
    let execution = outside(ping_calls(env), base);
    src9(env).execute_from_outside_v2(execution, session_sign(env, execution));
    assert!(!src9(env).is_valid_outside_execution_nonce(base));
}

#[test]
#[should_panic(expected: 'Kamui: invalid session')]
fn session_signature_cannot_pass_as_an_owner_signature() {
    let env = setup();
    // No session registered: a 4-element signature never reaches the owner check.
    let execution = outside(ping_calls(env), 1);
    src9(env).execute_from_outside_v2(execution, session_sign(env, execution));
}
