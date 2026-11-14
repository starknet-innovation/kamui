//! Session keys on the self-paid path (`__validate__`): every SNIP-41 Part C step and its order.
use core::num::traits::Zero;
use kamui::core::{IKamuiAccountDispatcher, IKamuiAccountDispatcherTrait};
use kamui::jwt::registry::{IJwkRegistryDispatcher, IJwkRegistryDispatcherTrait};
use kamui::jwt::types::Issuer;
use kamui::mocks::{ITargetDispatcher, ITargetDispatcherTrait};
use kamui::owners::{IOwnersDispatcher, IOwnersDispatcherTrait, new_owner_message_hash};
use kamui::session::interface::{
    AllowedCall, ISessionKeyManagerDispatcher, ISessionKeyManagerDispatcherTrait,
    ISessionKeyManagerExtDispatcher, ISessionKeyManagerExtDispatcherTrait, SESSION_KEY_INTERFACE_ID,
    SessionData,
};
use kamui::social::component::{
    ISocialRecoverableDispatcher, ISocialRecoverableDispatcherTrait, JWK_REGISTRY_ADDRESS,
};
use kamui::social::proof_facts::{VIRTUAL_SNOS, VIRTUAL_SNOS0};
use openzeppelin_interfaces::introspection::{ISRC5Dispatcher, ISRC5DispatcherTrait};
use openzeppelin_interfaces::src9::ISRC9_V2_ID;
use snforge_std::signature::stark_curve::{StarkCurveKeyPairImpl, StarkCurveSignerImpl};
use snforge_std::signature::{KeyPair, KeyPairTrait, SignerTrait};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_number,
    start_cheat_block_timestamp_global, start_cheat_caller_address, start_cheat_nonce,
    start_cheat_proof_facts, start_cheat_resource_bounds, start_cheat_signature, start_cheat_tip,
    start_cheat_transaction_hash, start_cheat_transaction_version, stop_cheat_caller_address,
};
use starknet::account::Call;
use starknet::{ContractAddress, ResourcesBounds, SyscallResultTrait};

pub const NOW: u64 = 1_000;
pub const VALID_UNTIL: u64 = 5_000;
pub const FEE_CAP: u128 = 1_000_000;
pub const IDENTITY: felt252 = 0xabc;

pub fn owner_key() -> KeyPair<felt252, felt252> {
    KeyPairTrait::from_secret_key(0x1111)
}

pub fn session_key() -> KeyPair<felt252, felt252> {
    KeyPairTrait::from_secret_key(0x2222)
}

#[derive(Drop, Copy)]
pub struct Env {
    pub account: ContractAddress,
    pub target: ContractAddress,
    pub other: ContractAddress,
}

pub fn registry_owner() -> ContractAddress {
    'owner'.try_into().unwrap()
}

/// The key registry at the address the account pins, with two recovery auds. `recover` reads
/// its last revocation block, so every test that recovers needs it.
pub fn deploy_registry() -> IJwkRegistryDispatcher {
    let class = declare("JwkRegistry").unwrap_syscall().contract_class();
    class.deploy_at(@array![registry_owner().into()], JWK_REGISTRY_ADDRESS).unwrap_syscall();
    start_cheat_caller_address(JWK_REGISTRY_ADDRESS, registry_owner());
    let registry = IJwkRegistryDispatcher { contract_address: JWK_REGISTRY_ADDRESS };
    registry.initialize(array![(Issuer::Google, "aud"), (Issuer::Google, "aud2")]);
    registry
}

pub fn setup() -> Env {
    start_cheat_block_timestamp_global(NOW);
    deploy_registry();
    // The production account: deployed from (aud, identity) with no owner. The first owner key
    // arrives the way it does in production, through `recover`, with cheated proof facts.
    let account_class = declare("KamuiAccount").unwrap_syscall().contract_class();
    let mut calldata = array![];
    let aud: ByteArray = "aud";
    aud.serialize(ref calldata);
    calldata.append(IDENTITY);
    let (account, _) = account_class.deploy(@calldata).unwrap_syscall();
    recover_onto(account, owner_key());
    let target_class = declare("Target").unwrap_syscall().contract_class();
    let (target, _) = target_class.deploy(@array![]).unwrap_syscall();
    let (other, _) = target_class.deploy(@array![]).unwrap_syscall();
    Env { account, target, other }
}

pub fn owners(account: ContractAddress) -> IOwnersDispatcher {
    IOwnersDispatcher { contract_address: account }
}

/// `key`'s signature accepting ownership of `account` at its current owner set.
pub fn new_owner_signature(
    account: ContractAddress, key: KeyPair<felt252, felt252>,
) -> Span<felt252> {
    let anchor = owners(account).get_owners_anchor();
    let (r, s) = key.sign(new_owner_message_hash(account, anchor)).unwrap();
    array![r, s].span()
}

/// Proof facts for a non-override recovery of `account` onto `new_key`, as the sequencer would
/// attach them (format from upstream's tests).
pub fn recovery_facts(account: ContractAddress, new_key: felt252) -> Span<felt252> {
    recovery_facts_at(account, new_key, 10, false)
}

/// The same, for a proof made on top of `base_block`, for a normal or an override recovery.
pub fn recovery_facts_at(
    account: ContractAddress, new_key: felt252, base_block: u64, is_override: bool,
) -> Span<felt252> {
    let anchor = owners(account).get_owners_anchor();
    let message = array![
        account.into(), 0, 5, account.into(), IDENTITY, new_key, anchor, is_override.into(),
    ];
    array![
        1, VIRTUAL_SNOS, 0x11, VIRTUAL_SNOS0, base_block.into(), 0x22, 0x33, 1,
        core::poseidon::poseidon_hash_span(message.span()),
    ]
        .span()
}

/// A proven login on a new device: adds `key` as an owner through `recover`.
pub fn recover_onto(account: ContractAddress, key: KeyPair<felt252, felt252>) {
    start_cheat_proof_facts(account, recovery_facts(account, key.public_key));
    start_cheat_block_number(account, 10);
    // Sent by a relayer, with no caller cheat in the way.
    stop_cheat_caller_address(account);
    ISocialRecoverableDispatcher { contract_address: account }
        .recover(key.public_key, new_owner_signature(account, key));
}

pub fn as_owner(env: Env) {
    start_cheat_caller_address(env.account, env.account);
}

pub fn add_session(env: Env, max_calls: u32, max_fee_per_tx: u128, entrypoints: Array<felt252>) {
    as_owner(env);
    ISessionKeyManagerDispatcher { contract_address: env.account }
        .add_or_update_session_key(
            session_key().public_key, VALID_UNTIL, max_calls, max_fee_per_tx, entrypoints,
        );
}

pub fn call(to: ContractAddress, selector: felt252) -> Call {
    Call { to, selector, calldata: array![].span() }
}

pub fn ping(env: Env) -> Array<Call> {
    array![call(env.target, selector!("ping"))]
}

pub fn bounds(l2_amount: u64, l2_price: u128) -> Span<ResourcesBounds> {
    array![
        ResourcesBounds { resource: 'L1_GAS', max_amount: 0, max_price_per_unit: 0 },
        ResourcesBounds { resource: 'L2_GAS', max_amount: l2_amount, max_price_per_unit: l2_price },
        ResourcesBounds { resource: 'L1_DATA', max_amount: 0, max_price_per_unit: 0 },
    ]
        .span()
}

pub fn session_signature(
    key: KeyPair<felt252, felt252>, hash: felt252, valid_until: felt252,
) -> Span<felt252> {
    let (r, s) = key.sign(hash).unwrap();
    array![key.public_key, r, s, valid_until].span()
}

/// Runs `__validate__` the way the protocol does: zero caller, V3, cheap fee fields.
pub fn validate_raw(
    env: Env, calls: Array<Call>, signature: Span<felt252>, tx_hash: felt252, nonce: felt252,
) -> felt252 {
    start_cheat_caller_address(env.account, Zero::zero());
    start_cheat_signature(env.account, signature);
    start_cheat_transaction_hash(env.account, tx_hash);
    start_cheat_nonce(env.account, nonce);
    IKamuiAccountDispatcher { contract_address: env.account }.__validate__(calls)
}

pub fn default_fees(env: Env) {
    start_cheat_transaction_version(env.account, 3);
    start_cheat_resource_bounds(env.account, bounds(1_000, 10));
    start_cheat_tip(env.account, 0);
}

/// A correctly signed session transaction at `nonce`.
pub fn validate_session(env: Env, calls: Array<Call>, nonce: felt252) -> felt252 {
    let tx_hash = 0xabc000 + nonce;
    let signature = session_signature(session_key(), tx_hash, VALID_UNTIL.into());
    validate_raw(env, calls, signature, tx_hash, nonce)
}

pub fn ext(env: Env) -> ISessionKeyManagerExtDispatcher {
    ISessionKeyManagerExtDispatcher { contract_address: env.account }
}

pub fn manager(env: Env) -> ISessionKeyManagerDispatcher {
    ISessionKeyManagerDispatcher { contract_address: env.account }
}

const EMPTY: SessionData = SessionData {
    valid_until: 0, max_calls: 0, max_fee_per_tx: 0, allowed_entrypoints_len: 0,
};

//
// Setup and interface
//

#[test]
fn registers_interfaces() {
    let env = setup();
    let src5 = ISRC5Dispatcher { contract_address: env.account };
    assert!(src5.supports_interface(SESSION_KEY_INTERFACE_ID));
    assert!(src5.supports_interface(ISRC9_V2_ID));
}

#[test]
fn stores_and_returns_session_data() {
    let env = setup();
    add_session(env, 7, FEE_CAP, array![selector!("ping"), selector!("transfer")]);
    let data = manager(env).get_session_data(session_key().public_key);
    assert_eq!(
        data,
        SessionData {
            valid_until: VALID_UNTIL,
            max_calls: 7,
            max_fee_per_tx: FEE_CAP,
            allowed_entrypoints_len: 2,
        },
    );
    assert!(!ext(env).is_session_scoped(session_key().public_key));
}

#[test]
fn stores_extreme_values_without_corruption() {
    let env = setup();
    as_owner(env);
    let max_u64: u64 = 0xffffffffffffffff;
    let max_u32: u32 = 0xffffffff;
    let max_u128: u128 = 0xffffffffffffffffffffffffffffffff;
    manager(env)
        .add_or_update_session_key(session_key().public_key, max_u64, max_u32, max_u128, array![]);
    assert_eq!(
        manager(env).get_session_data(session_key().public_key),
        SessionData {
            valid_until: max_u64,
            max_calls: max_u32,
            max_fee_per_tx: max_u128,
            allowed_entrypoints_len: 0,
        },
    );
}

#[test]
#[should_panic(expected: 'Account: unauthorized')]
fn only_the_account_can_add_a_session() {
    let env = setup();
    manager(env)
        .add_or_update_session_key(session_key().public_key, VALID_UNTIL, 1, FEE_CAP, array![]);
}

#[test]
#[should_panic(expected: 'Account: unauthorized')]
fn only_the_account_can_revoke_a_session() {
    let env = setup();
    add_session(env, 1, FEE_CAP, array![]);
    start_cheat_caller_address(env.account, env.target);
    manager(env).revoke_session_key(session_key().public_key);
}

#[test]
#[should_panic(expected: 'Session: already expired')]
fn cannot_add_an_expired_session() {
    let env = setup();
    as_owner(env);
    manager(env).add_or_update_session_key(session_key().public_key, NOW, 1, FEE_CAP, array![]);
}

//
// Owner path
//

#[test]
fn owner_signature_validates() {
    let env = setup();
    default_fees(env);
    let (r, s) = owner_key().sign(0x123).unwrap();
    assert_eq!(validate_raw(env, ping(env), array![r, s].span(), 0x123, 0), starknet::VALIDATED);
}

#[test]
fn wrong_owner_signature_returns_zero() {
    let env = setup();
    default_fees(env);
    let (r, s) = session_key().sign(0x123).unwrap();
    assert_eq!(validate_raw(env, ping(env), array![r, s].span(), 0x123, 0), 0);
}

#[test]
fn validate_refuses_non_protocol_callers() {
    let env = setup();
    default_fees(env);
    let (r, s) = owner_key().sign(0x123).unwrap();
    start_cheat_signature(env.account, array![r, s].span());
    start_cheat_transaction_hash(env.account, 0x123);
    start_cheat_caller_address(env.account, env.target);
    assert_eq!(
        IKamuiAccountDispatcher { contract_address: env.account }.__validate__(ping(env)), 0,
    );
}

//
// Steps 1 to 3: signature shape, expiry, existence
//

#[test]
fn session_transaction_validates() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![]);
    assert_eq!(validate_session(env, ping(env), 10), starknet::VALIDATED);
}

#[test]
fn signature_lengths_other_than_2_or_4_return_zero() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![]);
    assert_eq!(validate_raw(env, ping(env), array![].span(), 0x1, 0), 0);
    assert_eq!(validate_raw(env, ping(env), array![1].span(), 0x1, 0), 0);
    assert_eq!(validate_raw(env, ping(env), array![1, 2, 3].span(), 0x1, 0), 0);
    assert_eq!(validate_raw(env, ping(env), array![1, 2, 3, 4, 5].span(), 0x1, 0), 0);
}

#[test]
fn oversized_valid_until_returns_zero_without_panicking() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![]);
    let too_big: felt252 = 0x10000000000000000; // u64::MAX + 1
    let signature = session_signature(session_key(), 0x1, too_big);
    assert_eq!(validate_raw(env, ping(env), signature, 0x1, 0), 0);
}

#[test]
fn expired_session_returns_zero() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![]);
    start_cheat_block_timestamp_global(VALID_UNTIL);
    assert_eq!(validate_session(env, ping(env), 1), starknet::VALIDATED);
    start_cheat_block_timestamp_global(VALID_UNTIL + 1);
    assert_eq!(validate_session(env, ping(env), 2), 0);
}

#[test]
fn unknown_session_returns_zero() {
    let env = setup();
    default_fees(env);
    assert_eq!(validate_session(env, ping(env), 1), 0);
}

#[test]
fn signature_valid_until_must_match_the_stored_one() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![]);
    let later: felt252 = (VALID_UNTIL + 1_000).into();
    let signature = session_signature(session_key(), 0x1, later);
    assert_eq!(validate_raw(env, ping(env), signature, 0x1, 0), 0);
}

#[test]
fn revoked_session_returns_zero_and_reads_as_empty() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![selector!("ping")]);
    as_owner(env);
    manager(env).revoke_session_key(session_key().public_key);
    assert_eq!(manager(env).get_session_data(session_key().public_key), EMPTY);
    assert_eq!(validate_session(env, ping(env), 1), 0);
}

//
// Step 4: transaction limit (nonce anchoring)
//

#[test]
fn max_calls_one_allows_exactly_one_transaction() {
    let env = setup();
    default_fees(env);
    add_session(env, 1, FEE_CAP, array![]);
    assert_eq!(validate_session(env, ping(env), 10), starknet::VALIDATED);
    assert_eq!(validate_session(env, ping(env), 11), 0);
}

#[test]
fn max_calls_zero_allows_nothing() {
    let env = setup();
    default_fees(env);
    add_session(env, 0, FEE_CAP, array![]);
    assert_eq!(validate_session(env, ping(env), 10), 0);
}

#[test]
fn limit_is_anchored_at_the_first_self_paid_nonce() {
    let env = setup();
    default_fees(env);
    add_session(env, 3, FEE_CAP, array![]);
    assert_eq!(ext(env).get_session_nonce_limit(session_key().public_key), 0);
    assert_eq!(validate_session(env, ping(env), 10), starknet::VALIDATED);
    assert_eq!(ext(env).get_session_nonce_limit(session_key().public_key), 13);
    assert_eq!(validate_session(env, ping(env), 11), starknet::VALIDATED);
    assert_eq!(validate_session(env, ping(env), 12), starknet::VALIDATED);
    assert_eq!(validate_session(env, ping(env), 13), 0);
    assert_eq!(ext(env).get_session_nonce_limit(session_key().public_key), 13);
}

#[test]
fn transactions_by_other_signers_use_up_the_range() {
    let env = setup();
    default_fees(env);
    add_session(env, 3, FEE_CAP, array![]);
    assert_eq!(validate_session(env, ping(env), 10), starknet::VALIDATED);
    // The owner sends nonces 11 and 12. The session is left with nothing at 13.
    assert_eq!(validate_session(env, ping(env), 13), 0);
}

#[test]
fn updating_a_session_resets_its_usage() {
    let env = setup();
    default_fees(env);
    add_session(env, 1, FEE_CAP, array![]);
    assert_eq!(validate_session(env, ping(env), 10), starknet::VALIDATED);
    assert_eq!(validate_session(env, ping(env), 11), 0);
    add_session(env, 1, FEE_CAP, array![]);
    assert_eq!(ext(env).get_session_nonce_limit(session_key().public_key), 0);
    assert_eq!(validate_session(env, ping(env), 11), starknet::VALIDATED);
}

//
// Step 4b: fee cap
//

#[test]
fn zero_fee_cap_makes_the_session_paymaster_only() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, 0, array![]);
    assert_eq!(validate_session(env, ping(env), 1), 0);
}

#[test]
fn fee_cap_is_inclusive() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, 10_000, array![]);
    start_cheat_resource_bounds(env.account, bounds(1_000, 10)); // 10_000
    assert_eq!(validate_session(env, ping(env), 1), starknet::VALIDATED);
    start_cheat_resource_bounds(env.account, bounds(1_001, 10)); // 10_010
    assert_eq!(validate_session(env, ping(env), 2), 0);
}

#[test]
fn fee_cap_sums_every_resource() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, 10_000, array![]);
    let all = array![
        ResourcesBounds { resource: 'L1_GAS', max_amount: 1, max_price_per_unit: 1 },
        ResourcesBounds { resource: 'L2_GAS', max_amount: 1_000, max_price_per_unit: 10 },
        ResourcesBounds { resource: 'L1_DATA', max_amount: 0, max_price_per_unit: 0 },
    ]
        .span();
    start_cheat_resource_bounds(env.account, all); // 10_001
    assert_eq!(validate_session(env, ping(env), 1), 0);
}

#[test]
fn fee_cap_counts_the_tip() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, 10_000, array![]);
    start_cheat_resource_bounds(env.account, bounds(1_000, 9)); // 9_000
    start_cheat_tip(env.account, 1); // + 1_000 = 10_000
    assert_eq!(validate_session(env, ping(env), 1), starknet::VALIDATED);
    start_cheat_tip(env.account, 2); // + 2_000 = 11_000
    assert_eq!(validate_session(env, ping(env), 2), 0);
}

#[test]
fn huge_fee_fields_return_zero_without_panicking() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, 0xffffffffffffffffffffffffffffffff, array![]);
    let max_u64: u64 = 0xffffffffffffffff;
    let max_u128: u128 = 0xffffffffffffffffffffffffffffffff;
    let all = array![
        ResourcesBounds { resource: 'L1_GAS', max_amount: max_u64, max_price_per_unit: max_u128 },
        ResourcesBounds { resource: 'L2_GAS', max_amount: max_u64, max_price_per_unit: max_u128 },
        ResourcesBounds { resource: 'L1_DATA', max_amount: max_u64, max_price_per_unit: max_u128 },
    ]
        .span();
    start_cheat_resource_bounds(env.account, all);
    start_cheat_tip(env.account, max_u128);
    assert_eq!(validate_session(env, ping(env), 1), 0);
}

#[test]
fn transactions_that_are_not_v3_are_refused() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![]);
    start_cheat_transaction_version(env.account, 1);
    assert_eq!(validate_session(env, ping(env), 1), 0);
    start_cheat_transaction_version(env.account, 0x100000000000000000000000000000003);
    assert_eq!(validate_session(env, ping(env), 1), starknet::VALIDATED);
}

//
// Steps 5, 5b, 6: blocklist, self-call block, whitelist
//

fn blocked_selectors() -> Array<felt252> {
    array![
        selector!("upgrade"), selector!("add_or_update_session_key"),
        selector!("revoke_session_key"), selector!("__execute__"), selector!("set_public_key"),
        selector!("setPublicKey"), selector!("execute_from_outside_v2"),
        selector!("set_spending_policy"), selector!("remove_spending_policy"),
        selector!("add_or_update_scoped_session_key"), selector!("revoke_all_sessions"),
        selector!("add_owner"), selector!("remove_owner"), selector!("__validate__"),
        selector!("__validate_declare__"), selector!("__validate_deploy__"), selector!("recover"),
        selector!("prove_jwt"), selector!("finalize_override_recovery"),
        selector!("cancel_override_recovery"),
    ]
}

#[test]
fn blocked_selectors_are_refused_without_a_whitelist() {
    let env = setup();
    default_fees(env);
    add_session(env, 100, FEE_CAP, array![]);
    let mut nonce = 1;
    for selector in blocked_selectors() {
        // On the account itself and on another contract.
        assert_eq!(validate_session(env, array![call(env.account, selector)], nonce), 0);
        assert_eq!(validate_session(env, array![call(env.target, selector)], nonce), 0);
        nonce += 1;
    }
}

#[test]
fn blocked_selectors_are_refused_even_when_whitelisted() {
    let env = setup();
    default_fees(env);
    add_session(env, 100, FEE_CAP, blocked_selectors());
    let mut nonce = 1;
    for selector in blocked_selectors() {
        assert_eq!(validate_session(env, array![call(env.target, selector)], nonce), 0);
        nonce += 1;
    }
}

#[test]
fn one_blocked_call_poisons_a_multicall() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![]);
    let calls = array![
        call(env.target, selector!("ping")), call(env.target, selector!("upgrade")),
        call(env.target, selector!("ping")),
    ];
    assert_eq!(validate_session(env, calls, 1), 0);
}

#[test]
fn a_session_never_calls_the_account_itself() {
    let env = setup();
    default_fees(env);
    // Without a whitelist.
    add_session(env, 5, FEE_CAP, array![]);
    assert_eq!(validate_session(env, array![call(env.account, selector!("ping"))], 1), 0);
    assert_eq!(validate_session(env, array![call(env.account, selector!("get_owners"))], 1), 0);
    // And with one that names the selector.
    add_session(env, 5, FEE_CAP, array![selector!("ping")]);
    assert_eq!(validate_session(env, array![call(env.account, selector!("ping"))], 1), 0);
}

#[test]
fn empty_call_list_is_refused() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![]);
    assert_eq!(validate_session(env, array![], 1), 0);
}

#[test]
fn whitelist_is_enforced_on_every_call() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![selector!("ping")]);
    assert_eq!(validate_session(env, ping(env), 1), starknet::VALIDATED);
    assert_eq!(validate_session(env, array![call(env.target, selector!("transfer"))], 2), 0);
    let mixed = array![
        call(env.target, selector!("ping")), call(env.target, selector!("transfer")),
    ];
    assert_eq!(validate_session(env, mixed, 2), 0);
    // A selector whitelist is not tied to a contract.
    assert_eq!(
        validate_session(env, array![call(env.other, selector!("ping"))], 2), starknet::VALIDATED,
    );
}

#[test]
fn updating_with_fewer_entrypoints_leaves_no_stale_selector() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![selector!("ping"), selector!("transfer")]);
    assert_eq!(
        validate_session(env, array![call(env.target, selector!("transfer"))], 1),
        starknet::VALIDATED,
    );
    add_session(env, 5, FEE_CAP, array![selector!("ping")]);
    assert_eq!(validate_session(env, array![call(env.target, selector!("transfer"))], 2), 0);
    assert_eq!(validate_session(env, ping(env), 2), starknet::VALIDATED);
}

#[test]
fn revoking_and_re_adding_leaves_no_stale_selector() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![selector!("transfer")]);
    as_owner(env);
    manager(env).revoke_session_key(session_key().public_key);
    add_session(env, 5, FEE_CAP, array![selector!("ping")]);
    assert_eq!(validate_session(env, array![call(env.target, selector!("transfer"))], 1), 0);
}

#[test]
fn scoped_whitelist_ties_a_selector_to_a_contract() {
    let env = setup();
    default_fees(env);
    as_owner(env);
    ext(env)
        .add_or_update_scoped_session_key(
            session_key().public_key,
            VALID_UNTIL,
            5,
            FEE_CAP,
            array![AllowedCall { to: env.target, selector: selector!("ping") }],
        );
    assert!(ext(env).is_session_scoped(session_key().public_key));
    assert!(
        ext(env).is_session_call_allowed(session_key().public_key, env.target, selector!("ping")),
    );
    assert!(
        !ext(env).is_session_call_allowed(session_key().public_key, env.other, selector!("ping")),
    );
    assert_eq!(validate_session(env, ping(env), 1), starknet::VALIDATED);
    assert_eq!(validate_session(env, array![call(env.other, selector!("ping"))], 2), 0);
    assert_eq!(validate_session(env, array![call(env.target, selector!("transfer"))], 2), 0);
}

#[test]
#[should_panic(expected: 'Session: empty scope')]
fn scoped_whitelist_cannot_be_empty() {
    let env = setup();
    as_owner(env);
    ext(env)
        .add_or_update_scoped_session_key(
            session_key().public_key, VALID_UNTIL, 5, FEE_CAP, array![],
        );
}

//
// Steps 7 and 8: signature, then record
//

#[test]
fn signature_by_another_key_returns_zero() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![]);
    // Signed by the owner key but presented as the session key.
    let (r, s) = owner_key().sign(0x1).unwrap();
    let signature = array![session_key().public_key, r, s, VALID_UNTIL.into()].span();
    assert_eq!(validate_raw(env, ping(env), signature, 0x1, 1), 0);
}

#[test]
fn signature_over_another_hash_returns_zero() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![]);
    let signature = session_signature(session_key(), 0x1, VALID_UNTIL.into());
    assert_eq!(validate_raw(env, ping(env), signature, 0x2, 1), 0);
}

#[test]
fn nothing_is_recorded_when_the_signature_is_invalid() {
    let env = setup();
    default_fees(env);
    add_session(env, 1, FEE_CAP, array![]);
    let bad = session_signature(session_key(), 0x1, VALID_UNTIL.into());
    assert_eq!(validate_raw(env, ping(env), bad, 0x2, 10), 0);
    assert_eq!(ext(env).get_session_nonce_limit(session_key().public_key), 0);
    // The one allowed transaction is still available, at a later nonce.
    assert_eq!(validate_session(env, ping(env), 20), starknet::VALIDATED);
    assert_eq!(ext(env).get_session_nonce_limit(session_key().public_key), 21);
}

#[test]
fn nothing_is_recorded_when_a_call_is_refused() {
    let env = setup();
    default_fees(env);
    add_session(env, 1, FEE_CAP, array![selector!("ping")]);
    assert_eq!(validate_session(env, array![call(env.target, selector!("transfer"))], 10), 0);
    assert_eq!(ext(env).get_session_nonce_limit(session_key().public_key), 0);
}

//
// Session epoch
//

#[test]
fn revoke_all_sessions_kills_every_session() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![]);
    as_owner(env);
    let before = ext(env).get_session_epoch();
    ext(env).revoke_all_sessions();
    assert_eq!(ext(env).get_session_epoch(), before + 1);
    assert_eq!(manager(env).get_session_data(session_key().public_key), EMPTY);
    assert_eq!(validate_session(env, ping(env), 1), 0);
    // A session added afterwards works.
    add_session(env, 5, FEE_CAP, array![]);
    assert_eq!(validate_session(env, ping(env), 1), starknet::VALIDATED);
}

//
// is_valid_signature and execution
//

#[test]
fn is_valid_signature_accepts_owner_and_live_session() {
    let env = setup();
    let account = IKamuiAccountDispatcher { contract_address: env.account };
    let (r, s) = owner_key().sign(0x77).unwrap();
    assert_eq!(account.is_valid_signature(0x77, array![r, s]), starknet::VALIDATED);

    let (r, s) = session_key().sign(0x77).unwrap();
    let signature = array![session_key().public_key, r, s, VALID_UNTIL.into()];
    assert_eq!(account.is_valid_signature(0x77, signature.clone()), 0);
    add_session(env, 5, FEE_CAP, array![]);
    assert_eq!(account.is_valid_signature(0x77, signature.clone()), starknet::VALIDATED);
    start_cheat_block_timestamp_global(VALID_UNTIL + 1);
    assert_eq!(account.is_valid_signature(0x77, signature), 0);
}

#[test]
fn execute_runs_the_calls() {
    let env = setup();
    default_fees(env);
    start_cheat_caller_address(env.account, Zero::zero());
    IKamuiAccountDispatcher { contract_address: env.account }.__execute__(ping(env));
    assert_eq!(ITargetDispatcher { contract_address: env.target }.count(), 1);
}

#[test]
#[should_panic(expected: 'Kamui: invalid caller')]
fn execute_refuses_non_protocol_callers() {
    let env = setup();
    default_fees(env);
    start_cheat_caller_address(env.account, env.target);
    IKamuiAccountDispatcher { contract_address: env.account }.__execute__(ping(env));
}
