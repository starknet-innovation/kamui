//! K1 account tests use ephemeral test keys only; no AWS access or deployed account.
use core::num::traits::Zero;
use super::kms_k1_vector::{X, Y, HASH, R, S};
use openzeppelin_interfaces::access::accesscontrol::{IAccessControlDispatcher, IAccessControlDispatcherTrait};
use kamui::mocks::{ITargetDispatcher, ITargetDispatcherTrait};
use kamui::kms_admin::{IKmsAdminDispatcher, IKmsAdminDispatcherTrait};
use snforge_std::signature::secp256k1_curve::{
    Secp256k1CurveKeyPair, Secp256k1CurveKeyPairImpl, Secp256k1CurveSignerImpl,
};
use snforge_std::signature::{KeyPairTrait, SignerTrait};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_caller_address,
    start_cheat_signature, start_cheat_transaction_hash, start_cheat_transaction_version,
};
use starknet::secp256_trait::Secp256PointTrait;
use starknet::SyscallResultTrait;
use starknet::account::Call;

fn setup() -> (IKmsAdminDispatcher, Secp256k1CurveKeyPair) {
    let key = KeyPairTrait::generate();
    let (x, y) = Secp256PointTrait::get_coordinates(key.public_key).unwrap_syscall();
    let mut data = array![];
    x.serialize(ref data); y.serialize(ref data);
    let (address, _) = declare("KmsK1Admin").unwrap_syscall().contract_class().deploy(@data).unwrap_syscall();
    (IKmsAdminDispatcher { contract_address: address }, key)
}
fn sig(key: Secp256k1CurveKeyPair, hash: felt252) -> Array<felt252> {
    let (r, s) = key.sign(hash.into()).unwrap();
    let mut data = array![];
    r.serialize(ref data); s.serialize(ref data);
    data
}
fn protocol(account: IKmsAdminDispatcher, key: Secp256k1CurveKeyPair) {
    start_cheat_caller_address(account.contract_address, Zero::zero());
    start_cheat_transaction_version(account.contract_address, 3);
    start_cheat_transaction_hash(account.contract_address, 0x123456);
    start_cheat_signature(account.contract_address, sig(key, 0x123456).span());
}
#[test]
fn raw_digest_signature_and_public_key() {
    let (account, key) = setup();
    assert_eq!(account.get_public_key(), key.public_key.get_coordinates().unwrap_syscall());
    assert_eq!(account.is_valid_signature(0x123456, sig(key, 0x123456)), starknet::VALIDATED);
    assert_eq!(account.is_valid_signature(0x123457, sig(key, 0x123456)), 0);
    let other = KeyPairTrait::generate();
    assert_eq!(account.is_valid_signature(0x123456, sig(other, 0x123456)), 0);
}
#[test]
fn malformed_signatures_and_high_s_rejected() {
    let (account, key) = setup();
    assert_eq!(account.is_valid_signature(1, array![]), 0);
    assert_eq!(account.is_valid_signature(1, array![1, 2]), 0);
    assert_eq!(account.is_valid_signature(1, array![0, 0, 0, 0]), 0);
    assert_eq!(account.is_valid_signature(1, array![0x100000000000000000000000000000000, 0, 1, 0]), 0);
    let (r, s) = key.sign(1).unwrap();
    let high_s = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141_u256 - s;
    let mut data = array![];
    r.serialize(ref data); high_s.serialize(ref data);
    assert_eq!(account.is_valid_signature(1, data), 0);
}
#[test]
fn protocol_validation_and_execution() {
    let (account, key) = setup();
    protocol(account, key);
    assert_eq!(account.__validate__(array![]), starknet::VALIDATED);
    let (target, _) = declare("Target").unwrap_syscall().contract_class().deploy(@array![]).unwrap_syscall();
    account.__execute__(array![Call { to: target, selector: selector!("ping"), calldata: array![].span() }]);
    assert_eq!(ITargetDispatcher { contract_address: target }.count(), 1);
}
#[test]
fn query_version_and_deploy_validation() {
    let (account, key) = setup();
    protocol(account, key);
    start_cheat_transaction_version(account.contract_address, 0x100000000000000000000000000000003);
    assert_eq!(account.__validate__(array![]), starknet::VALIDATED);
    let (x, y) = account.get_public_key();
    assert_eq!(account.__validate_deploy__(0x55, 0x11, x, y), starknet::VALIDATED);
}
#[test]
#[should_panic(expected: 'KMS: invalid caller')]
fn direct_contract_execution_rejected() {
    let (account, _) = setup();
    account.__execute__(array![]);
}
#[test]
#[should_panic(expected: 'KMS: invalid version')]
fn v0_execution_rejected() {
    let (account, key) = setup();
    protocol(account, key);
    start_cheat_transaction_version(account.contract_address, 0);
    account.__execute__(array![]);
}
#[test]
#[should_panic(expected: 'KMS: invalid signature')]
fn wrong_transaction_hash_rejected() {
    let (account, key) = setup();
    protocol(account, key);
    start_cheat_transaction_hash(account.contract_address, 0x123457);
    account.__validate__(array![]);
}
#[test]
#[should_panic(expected: 'KMS: invalid public key')]
fn infinity_public_key_rejected() {
    declare("KmsK1Admin").unwrap_syscall().contract_class().deploy(@array![0, 0, 0, 0]).unwrap_syscall();
}
#[test]
#[should_panic(expected: 'KMS: invalid public key')]
fn off_curve_public_key_rejected() {
    declare("KmsK1Admin").unwrap_syscall().contract_class().deploy(@array![1, 0, 1, 0]).unwrap_syscall();
}

#[test]
fn shared_typescript_der_vector_validates_in_cairo() {
    let mut data = array![]; X.serialize(ref data); Y.serialize(ref data);
    let (address, _) = declare("KmsK1Admin").unwrap_syscall().contract_class().deploy(@data).unwrap_syscall();
    let account = IKmsAdminDispatcher { contract_address: address };
    let mut signature = array![]; R.serialize(ref signature); S.serialize(ref signature);
    assert_eq!(account.is_valid_signature(HASH, signature), starknet::VALIDATED);
}

#[test]
fn admin_account_can_grant_and_renounce_actual_registry_roles() {
    let (account, key) = setup();
    protocol(account, key);
    let (registry, _) = declare("JwkRegistry").unwrap_syscall().contract_class()
        .deploy(@array![account.contract_address.into()]).unwrap_syscall();
    let access = IAccessControlDispatcher { contract_address: registry };
    let next: starknet::ContractAddress = 0xbeef.try_into().unwrap();
    assert!(access.has_role(0, account.contract_address));
    account.__execute__(array![
        Call { to: registry, selector: selector!("grant_role"), calldata: array![0, next.into()].span() },
        Call { to: registry, selector: selector!("renounce_role"), calldata: array![0, account.contract_address.into()].span() },
    ]);
    assert!(access.has_role(0, next));
    assert!(!access.has_role(0, account.contract_address));
}
