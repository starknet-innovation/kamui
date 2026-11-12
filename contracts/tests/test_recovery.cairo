//! Social recovery and sessions together: any change of owner key, by recovery or by override,
//! revokes every session. Proof-facts helpers follow upstream's `test_recover.cairo`.
use core::hash::{HashStateExTrait, HashStateTrait};
use core::poseidon::{PoseidonTrait, poseidon_hash_span};
use kamui::jwt::registry::{IJwkRegistryDispatcher, IJwkRegistryDispatcherTrait};
use kamui::jwt::types::Issuer;
use kamui::session::interface::{
    ISessionKeyManagerDispatcherTrait, ISessionKeyManagerExtDispatcherTrait, SessionData,
};
use kamui::social::component::{
    ISocialRecoverableDispatcher, ISocialRecoverableDispatcherTrait, JWK_REGISTRY_ADDRESS,
};
use kamui::social::proof_facts::{VIRTUAL_SNOS, VIRTUAL_SNOS0};
use openzeppelin_interfaces::accounts::{IPublicKeyDispatcher, IPublicKeyDispatcherTrait};
use snforge_std::signature::stark_curve::{StarkCurveKeyPairImpl, StarkCurveSignerImpl};
use snforge_std::signature::{KeyPair, KeyPairTrait, SignerTrait};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_number,
    start_cheat_caller_address, start_cheat_proof_facts, stop_cheat_caller_address, store,
};
use starknet::{ContractAddress, SyscallResultTrait};
use super::test_sessions::{
    Env, FEE_CAP, IDENTITY, NOW, add_session, default_fees, ext, manager, owner_key, ping,
    session_key, setup, validate_session,
};

fn new_owner() -> KeyPair<felt252, felt252> {
    KeyPairTrait::from_secret_key(0x3333)
}

/// The new key's signature over OpenZeppelin's accept_ownership message.
fn accept_ownership(account: ContractAddress, current_key: felt252) -> Span<felt252> {
    let message = PoseidonTrait::new()
        .update_with('StarkNet Message')
        .update_with('accept_ownership')
        .update_with(account)
        .update_with(current_key)
        .finalize();
    let (r, s) = new_owner().sign(message).unwrap();
    array![r, s].span()
}

/// Proof facts for a non-override recovery from `current_key` to the new owner key, as the
/// sequencer would attach them.
fn recovery_facts(account: ContractAddress, current_key: felt252) -> Span<felt252> {
    let message = array![
        account.into(), 0, 5, account.into(), IDENTITY, new_owner().public_key, current_key, 0,
    ];
    array![
        1, VIRTUAL_SNOS, 0x11, VIRTUAL_SNOS0, 10, 0x22, 0x33, 1,
        poseidon_hash_span(message.span()),
    ]
        .span()
}

fn recover(env: Env, current_key: felt252) {
    start_cheat_proof_facts(env.account, recovery_facts(env.account, current_key));
    start_cheat_block_number(env.account, 10);
    // Sent by a relayer. No caller cheat: `recover` calls `set_public_key` on the account
    // itself, and that inner call must really come from the account.
    stop_cheat_caller_address(env.account);
    ISocialRecoverableDispatcher { contract_address: env.account }
        .recover(new_owner().public_key, accept_ownership(env.account, current_key));
}

fn deploy_registry() {
    let owner: ContractAddress = 'owner'.try_into().unwrap();
    let class = declare("JwkRegistry").unwrap_syscall().contract_class();
    class.deploy_at(@array![owner.into()], JWK_REGISTRY_ADDRESS).unwrap_syscall();
    start_cheat_caller_address(JWK_REGISTRY_ADDRESS, owner);
    IJwkRegistryDispatcher { contract_address: JWK_REGISTRY_ADDRESS }
        .initialize(array![(Issuer::Google, "aud"), (Issuer::Google, "aud2")]);
}

const EMPTY: SessionData = SessionData {
    valid_until: 0, max_calls: 0, max_fee_per_tx: 0, allowed_entrypoints_len: 0,
};

#[test]
fn recovery_revokes_every_session() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![]);
    assert_eq!(validate_session(env, ping(env), 1), starknet::VALIDATED);

    recover(env, owner_key().public_key);

    let key = IPublicKeyDispatcher { contract_address: env.account }.get_public_key();
    assert_eq!(key, new_owner().public_key);
    assert_eq!(ext(env).get_session_epoch(), 1);
    assert_eq!(manager(env).get_session_data(session_key().public_key), EMPTY);
    assert_eq!(validate_session(env, ping(env), 2), 0);
}

#[test]
fn sessions_added_after_a_recovery_work() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![]);
    recover(env, owner_key().public_key);

    add_session(env, 5, FEE_CAP, array![]);
    assert_eq!(validate_session(env, ping(env), 2), starknet::VALIDATED);
}

#[test]
fn first_recovery_from_key_zero_bumps_the_epoch() {
    let env = setup();
    // A freshly deployed account: no key yet.
    store(env.account, selector!("Account_public_key"), array![0].span());
    recover(env, 0);
    let key = IPublicKeyDispatcher { contract_address: env.account }.get_public_key();
    assert_eq!(key, new_owner().public_key);
    assert_eq!(ext(env).get_session_epoch(), 1);
}

#[test]
fn finalized_override_revokes_every_session() {
    deploy_registry();
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![]);

    // An override queued against the current key and ready now.
    let current = owner_key().public_key;
    let pending = poseidon_hash_span([new_owner().public_key, current].span());
    store(env.account, selector!("pending_recovery"), array![pending].span());
    store(env.account, selector!("pending_ready_at"), array![NOW.into()].span());

    stop_cheat_caller_address(env.account);
    ISocialRecoverableDispatcher { contract_address: env.account }
        .finalize_override_recovery(new_owner().public_key, accept_ownership(env.account, current));

    assert_eq!(ext(env).get_session_epoch(), 1);
    assert_eq!(validate_session(env, ping(env), 1), 0);
}

#[test]
fn a_session_cannot_start_or_cancel_a_recovery() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![]);
    for selector in array![
        selector!("recover"), selector!("prove_jwt"), selector!("finalize_override_recovery"),
        selector!("cancel_override_recovery"), selector!("set_public_key"),
    ] {
        let calls = array![
            starknet::account::Call { to: env.account, selector, calldata: array![].span() },
        ];
        assert_eq!(validate_session(env, calls, 1), 0);
    }
}
