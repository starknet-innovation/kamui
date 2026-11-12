//! The owner set, recovery and sessions together (plan D4 and D5): a login on a new device adds
//! a key, and every change of the owner set revokes every session.
use core::poseidon::poseidon_hash_span;
use kamui::jwt::registry::{IJwkRegistryDispatcher, IJwkRegistryDispatcherTrait};
use kamui::jwt::types::Issuer;
use kamui::owners::{IOwnersDispatcherTrait, MAX_OWNERS};
use kamui::session::interface::{
    ISessionKeyManagerDispatcherTrait, ISessionKeyManagerExtDispatcherTrait, SessionData,
};
use kamui::social::component::{
    ISocialRecoverableDispatcher, ISocialRecoverableDispatcherTrait, JWK_REGISTRY_ADDRESS,
};
use snforge_std::signature::stark_curve::{StarkCurveKeyPairImpl, StarkCurveSignerImpl};
use snforge_std::signature::{KeyPair, KeyPairTrait, SignerTrait};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_number,
    start_cheat_caller_address, start_cheat_proof_facts, stop_cheat_caller_address, store,
};
use starknet::account::Call;
use starknet::{ContractAddress, SyscallResultTrait};
use super::test_sessions::{
    Env, FEE_CAP, NOW, add_session, as_owner, default_fees, ext, manager, new_owner_signature,
    owner_key, owners, ping, recover_onto, recovery_facts, session_key, setup, validate_raw,
    validate_session,
};

fn device(n: felt252) -> KeyPair<felt252, felt252> {
    KeyPairTrait::from_secret_key(0x3000 + n)
}

fn add_owner(env: Env, key: KeyPair<felt252, felt252>) {
    let signature = new_owner_signature(env.account, key);
    as_owner(env);
    owners(env.account).add_owner(key.public_key, signature);
}

/// Whether `key` can validate a transaction as an owner.
fn signs_as_owner(env: Env, key: KeyPair<felt252, felt252>) -> bool {
    let (r, s) = key.sign(0x999).unwrap();
    validate_raw(env, ping(env), array![r, s].span(), 0x999, 0) == starknet::VALIDATED
}

fn session_alive(env: Env, nonce: felt252) -> bool {
    validate_session(env, ping(env), nonce) == starknet::VALIDATED
}

const EMPTY: SessionData = SessionData {
    valid_until: 0, max_calls: 0, max_fee_per_tx: 0, allowed_entrypoints_len: 0,
};

//
// Owner set
//

#[test]
fn a_fresh_account_has_no_owner() {
    let env = setup();
    // Undo setup's first recovery by deploying again.
    let class = declare("KamuiAccount").unwrap_syscall().contract_class();
    let mut calldata = array![];
    let aud: ByteArray = "aud";
    aud.serialize(ref calldata);
    calldata.append(0xdef);
    let (fresh, _) = class.deploy(@calldata).unwrap_syscall();
    assert_eq!(owners(fresh).get_owners(), array![]);
    assert_eq!(owners(fresh).get_owners_anchor(), 0);
    let _ = env;
}

#[test]
fn first_recovery_installs_the_first_owner() {
    let env = setup();
    default_fees(env);
    assert_eq!(owners(env.account).get_owners(), array![owner_key().public_key]);
    assert!(owners(env.account).is_owner(owner_key().public_key));
    assert!(owners(env.account).get_owners_anchor() != 0);
    assert!(signs_as_owner(env, owner_key()));
    assert_eq!(ext(env).get_session_epoch(), 1);
}

#[test]
fn a_login_on_a_second_device_adds_a_key_and_revokes_sessions() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![]);
    assert!(session_alive(env, 1));

    recover_onto(env.account, device(1));

    assert_eq!(
        owners(env.account).get_owners(), array![owner_key().public_key, device(1).public_key],
    );
    assert!(signs_as_owner(env, owner_key()));
    assert!(signs_as_owner(env, device(1)));
    assert_eq!(ext(env).get_session_epoch(), 2);
    assert_eq!(manager(env).get_session_data(session_key().public_key), EMPTY);
    assert!(!session_alive(env, 2));
    // The new device, or the old one, can approve a session again.
    add_session(env, 5, FEE_CAP, array![]);
    assert!(session_alive(env, 2));
}

#[test]
fn an_owner_adding_a_device_revokes_sessions() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![]);
    assert!(session_alive(env, 1));
    add_owner(env, device(1));
    assert!(signs_as_owner(env, device(1)));
    assert!(!session_alive(env, 2));
}

#[test]
fn removing_an_owner_revokes_every_session() {
    let env = setup();
    default_fees(env);
    add_owner(env, device(1));
    add_session(env, 5, FEE_CAP, array![]);
    assert!(session_alive(env, 1));

    as_owner(env);
    owners(env.account).remove_owner(owner_key().public_key);

    assert_eq!(owners(env.account).get_owners(), array![device(1).public_key]);
    assert!(!signs_as_owner(env, owner_key()));
    assert!(signs_as_owner(env, device(1)));
    assert_eq!(ext(env).get_session_epoch(), 3);
    assert_eq!(manager(env).get_session_data(session_key().public_key), EMPTY);
    assert!(!session_alive(env, 2));
}

#[test]
fn sessions_added_after_a_removal_work() {
    let env = setup();
    default_fees(env);
    add_owner(env, device(1));
    as_owner(env);
    owners(env.account).remove_owner(owner_key().public_key);
    add_session(env, 5, FEE_CAP, array![]);
    assert!(session_alive(env, 1));
}

#[test]
#[should_panic(expected: 'Owners: last owner')]
fn the_last_owner_cannot_be_removed() {
    let env = setup();
    as_owner(env);
    owners(env.account).remove_owner(owner_key().public_key);
}

#[test]
#[should_panic(expected: 'Owners: not an owner')]
fn removing_an_unknown_key_panics() {
    let env = setup();
    as_owner(env);
    owners(env.account).remove_owner(device(1).public_key);
}

#[test]
#[should_panic(expected: 'Owners: already an owner')]
fn a_key_cannot_be_added_twice() {
    let env = setup();
    add_owner(env, owner_key());
}

#[test]
#[should_panic(expected: 'Owners: invalid signature')]
fn a_new_owner_must_sign() {
    let env = setup();
    // Signed by another key.
    let signature = new_owner_signature(env.account, device(2));
    as_owner(env);
    owners(env.account).add_owner(device(1).public_key, signature);
}

#[test]
#[should_panic(expected: 'Owners: invalid signature')]
fn a_new_owner_signature_cannot_be_reused_after_the_set_changed() {
    let env = setup();
    let stale = new_owner_signature(env.account, device(1));
    add_owner(env, device(2));
    as_owner(env);
    owners(env.account).add_owner(device(1).public_key, stale);
}

#[test]
#[should_panic(expected: 'Account: unauthorized')]
fn only_the_account_adds_an_owner() {
    let env = setup();
    let signature = new_owner_signature(env.account, device(1));
    start_cheat_caller_address(env.account, env.target);
    owners(env.account).add_owner(device(1).public_key, signature);
}

#[test]
#[should_panic(expected: 'Account: unauthorized')]
fn only_the_account_removes_an_owner() {
    let env = setup();
    add_owner(env, device(1));
    start_cheat_caller_address(env.account, env.target);
    owners(env.account).remove_owner(device(1).public_key);
}

#[test]
#[should_panic(expected: 'Owners: full')]
fn an_owner_cannot_add_past_the_limit() {
    let env = setup();
    let mut n: u32 = 1;
    while n != MAX_OWNERS + 1 {
        add_owner(env, device(n.into()));
        n += 1;
    }
}

#[test]
fn a_recovery_on_a_full_set_replaces_the_oldest_key_and_revokes_sessions() {
    let env = setup();
    default_fees(env);
    let mut n: u32 = 1;
    while n != MAX_OWNERS {
        recover_onto(env.account, device(n.into()));
        n += 1;
    }
    assert_eq!(owners(env.account).get_owners().len(), MAX_OWNERS);
    add_session(env, 5, FEE_CAP, array![]);
    assert!(session_alive(env, 1));

    recover_onto(env.account, device(100));

    let after = owners(env.account).get_owners();
    assert_eq!(after.len(), MAX_OWNERS);
    assert!(!owners(env.account).is_owner(owner_key().public_key));
    assert_eq!(*after.at(0), device(1).public_key);
    assert_eq!(*after.at(MAX_OWNERS - 1), device(100).public_key);
    assert!(!signs_as_owner(env, owner_key()));
    assert!(signs_as_owner(env, device(100)));
    assert_eq!(ext(env).get_session_epoch(), MAX_OWNERS + 1);
    assert!(!session_alive(env, 2));
}

#[test]
fn owners_are_listed_oldest_first_after_a_removal_and_an_addition() {
    let env = setup();
    add_owner(env, device(1));
    add_owner(env, device(2));
    as_owner(env);
    owners(env.account).remove_owner(device(1).public_key);
    // Takes the freed slot, but is the newest.
    add_owner(env, device(3));
    assert_eq!(
        owners(env.account).get_owners(),
        array![owner_key().public_key, device(2).public_key, device(3).public_key],
    );
}

//
// Recovery proofs
//

#[test]
#[should_panic(expected: 'PROOF_MISMATCH')]
fn a_recovery_proof_cannot_be_replayed_after_the_key_was_removed() {
    let env = setup();
    // The proof and signature that add device 1.
    let facts = recovery_facts(env.account, device(1).public_key);
    let signature = new_owner_signature(env.account, device(1));
    recover_onto(env.account, device(1));

    // Device 1 is stolen: the owner removes its key.
    as_owner(env);
    owners(env.account).remove_owner(device(1).public_key);

    // Replaying the same proof must not bring the key back.
    start_cheat_proof_facts(env.account, facts);
    start_cheat_block_number(env.account, 10);
    stop_cheat_caller_address(env.account);
    ISocialRecoverableDispatcher { contract_address: env.account }
        .recover(device(1).public_key, signature);
}

#[test]
#[should_panic(expected: 'Owners: already an owner')]
fn a_recovery_onto_an_existing_owner_is_refused() {
    let env = setup();
    recover_onto(env.account, owner_key());
}

#[test]
fn a_finalized_override_adds_a_key_and_revokes_sessions() {
    let owner: ContractAddress = 'owner'.try_into().unwrap();
    let class = declare("JwkRegistry").unwrap_syscall().contract_class();
    class.deploy_at(@array![owner.into()], JWK_REGISTRY_ADDRESS).unwrap_syscall();
    start_cheat_caller_address(JWK_REGISTRY_ADDRESS, owner);
    IJwkRegistryDispatcher { contract_address: JWK_REGISTRY_ADDRESS }
        .initialize(array![(Issuer::Google, "aud"), (Issuer::Google, "aud2")]);

    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![]);

    // An override queued against the current owner set and ready now.
    let anchor = owners(env.account).get_owners_anchor();
    let pending = poseidon_hash_span([device(1).public_key, anchor].span());
    store(env.account, selector!("pending_recovery"), array![pending].span());
    store(env.account, selector!("pending_ready_at"), array![NOW.into()].span());

    let signature = new_owner_signature(env.account, device(1));
    stop_cheat_caller_address(env.account);
    ISocialRecoverableDispatcher { contract_address: env.account }
        .finalize_override_recovery(device(1).public_key, signature);

    assert!(owners(env.account).is_owner(device(1).public_key));
    assert!(owners(env.account).is_owner(owner_key().public_key));
    assert!(!session_alive(env, 1));
}

//
// Sessions cannot touch owners or recovery
//

#[test]
fn a_session_cannot_manage_owners_or_recovery() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![]);
    for selector in array![
        selector!("add_owner"), selector!("remove_owner"), selector!("recover"),
        selector!("prove_jwt"), selector!("finalize_override_recovery"),
        selector!("cancel_override_recovery"),
    ] {
        let calls = array![Call { to: env.account, selector, calldata: array![].span() }];
        assert_eq!(validate_session(env, calls, 1), 0);
    }
}

#[test]
fn a_session_signature_is_not_an_owner_signature() {
    let env = setup();
    default_fees(env);
    add_session(env, 5, FEE_CAP, array![]);
    assert!(!signs_as_owner(env, session_key()));
}
