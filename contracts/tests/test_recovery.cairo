//! The owner set, recovery and sessions together (plan D4 and D5): a login on a new device adds
//! a key, and every change of the owner set revokes every session.
use core::poseidon::poseidon_hash_span;
use garaga::signatures::rsa::RSA2048PublicKey;
use kamui::jwt::rec_aud_component::{
    IWhitelistedAudienceRecoverableDispatcher, IWhitelistedAudienceRecoverableDispatcherTrait,
};
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
    start_cheat_block_timestamp_global, start_cheat_caller_address, start_cheat_proof_facts,
    stop_cheat_caller_address, store,
};
use starknet::SyscallResultTrait;
use starknet::account::Call;
use super::test_sessions::{
    Env, FEE_CAP, NOW, add_session, as_owner, default_fees, ext, manager, new_owner_signature,
    owner_key, owners, ping, recover_onto, recovery_facts, recovery_facts_at, registry_owner,
    session_key, setup, validate_raw, validate_session,
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

//
// Registry revocations (audit findings #1 and #5)
//

fn registry() -> IJwkRegistryDispatcher {
    IJwkRegistryDispatcher { contract_address: JWK_REGISTRY_ADDRESS }
}

/// An RSA key whose 24 limbs are `first`, `first + 1`, ... Distinct `first` values give keys
/// with different material.
fn rsa_key(first: felt252) -> RSA2048PublicKey {
    let mut felts: Array<felt252> = array![];
    let mut limb = first;
    for _ in 0_u32..24 {
        felts.append(limb);
        limb += 1;
    }
    let mut span = felts.span();
    Serde::<RSA2048PublicKey>::deserialize(ref span).unwrap()
}

/// Runs `change` on the registry as its owner, in block `block`.
fn at_block(block: u64) {
    start_cheat_block_number(JWK_REGISTRY_ADDRESS, block);
    start_cheat_caller_address(JWK_REGISTRY_ADDRESS, registry_owner());
}

/// A recovery of `env.account` onto `key`, with a proof made on top of `base_block`.
fn recover_with_base(env: Env, key: KeyPair<felt252, felt252>, base_block: u64) {
    start_cheat_proof_facts(
        env.account, recovery_facts_at(env.account, key.public_key, base_block, false),
    );
    start_cheat_block_number(env.account, base_block + 1);
    stop_cheat_caller_address(env.account);
    ISocialRecoverableDispatcher { contract_address: env.account }
        .recover(key.public_key, new_owner_signature(env.account, key));
}

#[test]
fn the_registry_records_the_block_of_each_revocation() {
    setup();
    assert_eq!(registry().last_revocation_block(), 0);
    assert_eq!(registry().revocation_count(), 0);

    // A new key revokes nothing.
    at_block(50);
    registry().set_key(Issuer::Google, "kid-1", rsa_key(1));
    assert_eq!(registry().last_revocation_block(), 0);
    assert_eq!(registry().revocation_count(), 0);

    // The same material written again revokes nothing.
    at_block(60);
    registry().set_key(Issuer::Google, "kid-1", rsa_key(1));
    assert_eq!(registry().last_revocation_block(), 0);

    // Different material under the same kid withdraws trust from the old key.
    at_block(70);
    registry().set_key(Issuer::Google, "kid-1", rsa_key(100));
    assert_eq!(registry().last_revocation_block(), 70);
    assert_eq!(registry().revocation_count(), 1);

    // So does removing a key, and removing a recovery aud.
    at_block(80);
    registry().remove_key(Issuer::Google, "kid-1");
    assert_eq!(registry().last_revocation_block(), 80);
    assert_eq!(registry().revocation_count(), 2);
    at_block(90);
    IWhitelistedAudienceRecoverableDispatcher { contract_address: JWK_REGISTRY_ADDRESS }
        .remove_whitelisted(Issuer::Google, "aud2");
    assert_eq!(registry().last_revocation_block(), 90);
    assert_eq!(registry().revocation_count(), 3);
}

#[test]
#[should_panic(expected: 'REVOKED_SINCE_PROOF')]
fn a_proof_made_before_a_key_was_removed_cannot_recover() {
    let env = setup();
    at_block(40);
    registry().set_key(Issuer::Google, "kid-1", rsa_key(1));
    // The key is compromised and removed in block 100.
    at_block(100);
    registry().remove_key(Issuer::Google, "kid-1");
    // A proof based on block 99 saw the key as valid.
    recover_with_base(env, device(1), 99);
}

#[test]
#[should_panic(expected: 'REVOKED_SINCE_PROOF')]
fn a_proof_based_in_the_revocation_block_is_refused_too() {
    let env = setup();
    at_block(40);
    registry().set_key(Issuer::Google, "kid-1", rsa_key(1));
    at_block(100);
    registry().remove_key(Issuer::Google, "kid-1");
    recover_with_base(env, device(1), 100);
}

#[test]
fn a_proof_made_after_the_revocation_recovers() {
    let env = setup();
    at_block(40);
    registry().set_key(Issuer::Google, "kid-1", rsa_key(1));
    at_block(100);
    registry().remove_key(Issuer::Google, "kid-1");
    recover_with_base(env, device(1), 101);
    assert!(owners(env.account).is_owner(device(1).public_key));
}

#[test]
#[should_panic(expected: 'REVOKED_SINCE_PROOF')]
fn a_proof_made_before_a_key_was_replaced_cannot_recover() {
    let env = setup();
    at_block(40);
    registry().set_key(Issuer::Google, "kid-1", rsa_key(1));
    at_block(100);
    registry().set_key(Issuer::Google, "kid-1", rsa_key(500));
    recover_with_base(env, device(1), 99);
}

#[test]
#[should_panic(expected: 'REVOKED_SINCE_PROOF')]
fn a_proof_made_before_a_recovery_aud_was_removed_cannot_recover() {
    let env = setup();
    at_block(100);
    IWhitelistedAudienceRecoverableDispatcher { contract_address: JWK_REGISTRY_ADDRESS }
        .remove_whitelisted(Issuer::Google, "aud2");
    recover_with_base(env, device(1), 99);
}

#[test]
fn adding_a_key_or_rewriting_the_same_one_does_not_cancel_proofs() {
    let env = setup();
    at_block(100);
    registry().set_key(Issuer::Google, "kid-1", rsa_key(1));
    at_block(110);
    registry().set_key(Issuer::Google, "kid-1", rsa_key(1));
    at_block(120);
    registry().set_key(Issuer::Google, "kid-2", rsa_key(9));
    // A proof older than all of those writes is still good.
    recover_with_base(env, device(1), 50);
    assert!(owners(env.account).is_owner(device(1).public_key));
}

#[test]
#[should_panic(expected: 'REVOKED_SINCE_PROOF')]
fn an_override_cannot_be_queued_with_a_proof_made_before_a_revocation() {
    let env = setup();
    at_block(100);
    IWhitelistedAudienceRecoverableDispatcher { contract_address: JWK_REGISTRY_ADDRESS }
        .remove_whitelisted(Issuer::Google, "aud2");
    // An override proof based before the aud was removed. Without the check it would be queued
    // with a revocation count taken after the removal, and finalize a week later.
    start_cheat_proof_facts(
        env.account, recovery_facts_at(env.account, device(1).public_key, 99, true),
    );
    start_cheat_block_number(env.account, 101);
    stop_cheat_caller_address(env.account);
    ISocialRecoverableDispatcher { contract_address: env.account }
        .recover(device(1).public_key, array![].span());
}

#[test]
#[should_panic(expected: 'REVOKED_SINCE_PENDING')]
fn replacing_a_key_cancels_an_override_queued_before_it() {
    let env = setup();
    at_block(40);
    registry().set_key(Issuer::Google, "kid-1", rsa_key(1));

    // An override is queued under the registry as it stands (one write, no revocation yet).
    start_cheat_proof_facts(
        env.account, recovery_facts_at(env.account, device(1).public_key, 60, true),
    );
    start_cheat_block_number(env.account, 61);
    stop_cheat_caller_address(env.account);
    ISocialRecoverableDispatcher { contract_address: env.account }
        .recover(device(1).public_key, array![].span());

    // The key it was proven under is replaced.
    at_block(70);
    registry().set_key(Issuer::Google, "kid-1", rsa_key(500));

    // A week later the override must not finalize.
    start_cheat_block_timestamp_global(NOW + 604800 + 1);
    let signature = new_owner_signature(env.account, device(1));
    ISocialRecoverableDispatcher { contract_address: env.account }
        .finalize_override_recovery(device(1).public_key, signature);
}

#[test]
fn an_override_survives_a_new_key_and_a_rewrite_of_the_same_key() {
    let env = setup();
    at_block(40);
    registry().set_key(Issuer::Google, "kid-1", rsa_key(1));
    start_cheat_proof_facts(
        env.account, recovery_facts_at(env.account, device(1).public_key, 60, true),
    );
    start_cheat_block_number(env.account, 61);
    stop_cheat_caller_address(env.account);
    ISocialRecoverableDispatcher { contract_address: env.account }
        .recover(device(1).public_key, array![].span());

    at_block(70);
    registry().set_key(Issuer::Google, "kid-1", rsa_key(1));
    registry().set_key(Issuer::Google, "kid-2", rsa_key(9));

    start_cheat_block_timestamp_global(NOW + 604800 + 1);
    let signature = new_owner_signature(env.account, device(1));
    ISocialRecoverableDispatcher { contract_address: env.account }
        .finalize_override_recovery(device(1).public_key, signature);
    assert!(owners(env.account).is_owner(device(1).public_key));
}
