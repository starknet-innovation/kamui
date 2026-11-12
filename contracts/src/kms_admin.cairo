//! Separate, immutable secp256k1 operator account. No social recovery, sessions or upgrades.
//! AWS KMS signs the 32-byte big-endian transaction hash with MessageType=DIGEST.
//! Signature ABI: [r.low, r.high, s.low, s.high], with canonical low-s.
//! Not audited; registry roles must not be handed over before custody/security review.
#[starknet::interface]
pub trait IKmsAdmin<T> {
    fn __validate__(self: @T, calls: Array<starknet::account::Call>) -> felt252;
    fn __execute__(ref self: T, calls: Array<starknet::account::Call>) -> Array<Span<felt252>>;
    fn __validate_deploy__(
        self: @T, class_hash: felt252, salt: felt252, public_key_x: u256, public_key_y: u256,
    ) -> felt252;
    fn is_valid_signature(self: @T, hash: felt252, signature: Array<felt252>) -> felt252;
    fn get_public_key(self: @T) -> (u256, u256);
}

#[starknet::contract(account)]
pub mod KmsK1Admin {
    use core::num::traits::Zero;
    use openzeppelin_utils::execution::execute_calls;
    use starknet::account::Call;
    use starknet::secp256_trait::{Secp256Trait, is_valid_signature};
    use starknet::secp256k1::Secp256k1Point;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{SyscallResultTrait, get_caller_address, get_tx_info};

    #[storage]
    struct Storage {
        public_key_x: u256,
        public_key_y: u256,
    }

    #[constructor]
    fn constructor(ref self: ContractState, public_key_x: u256, public_key_y: u256) {
        assert(
            !(public_key_x == 0 && public_key_y == 0)
                && Secp256Trait::<Secp256k1Point>::secp256_ec_new_syscall(public_key_x, public_key_y).unwrap_syscall().is_some(),
            'KMS: invalid public key',
        );
        self.public_key_x.write(public_key_x);
        self.public_key_y.write(public_key_y);
    }

    // V3 and its query form only. V0 must never bypass validation through execution.
    fn assert_protocol_v3() {
        assert(get_caller_address().is_zero(), 'KMS: invalid caller');
        let version = get_tx_info().unbox().version;
        assert(version == 3 || version == 0x100000000000000000000000000000003, 'KMS: invalid version');
    }

    fn verify(self: @ContractState, hash: felt252, signature: Span<felt252>) -> bool {
        if signature.len() != 4 { return false; }
        let Some(r_low) = (*signature.at(0)).try_into() else { return false; };
        let Some(r_high) = (*signature.at(1)).try_into() else { return false; };
        let Some(s_low) = (*signature.at(2)).try_into() else { return false; };
        let Some(s_high) = (*signature.at(3)).try_into() else { return false; };
        let r = u256 { low: r_low, high: r_high };
        let s = u256 { low: s_low, high: s_high };
        let key = Secp256Trait::<Secp256k1Point>::secp256_ec_new_syscall(self.public_key_x.read(), self.public_key_y.read())
            .unwrap_syscall().unwrap();
        // corelib checks 0 < r < n and 0 < s <= n/2 before curve operations.
        is_valid_signature::<Secp256k1Point>(hash.into(), r, s, key)
    }

    fn validate(self: @ContractState) -> felt252 {
        assert_protocol_v3();
        let info = get_tx_info().unbox();
        assert(verify(self, info.transaction_hash, info.signature), 'KMS: invalid signature');
        starknet::VALIDATED
    }

    #[abi(embed_v0)]
    impl Admin of super::IKmsAdmin<ContractState> {
        fn __validate__(self: @ContractState, calls: Array<Call>) -> felt252 {
            validate(self)
        }

        fn __execute__(ref self: ContractState, calls: Array<Call>) -> Array<Span<felt252>> {
            assert_protocol_v3();
            execute_calls(calls.span())
        }

        fn __validate_deploy__(
            self: @ContractState, class_hash: felt252, salt: felt252,
            public_key_x: u256, public_key_y: u256,
        ) -> felt252 {
            validate(self)
        }

        fn is_valid_signature(
            self: @ContractState, hash: felt252, signature: Array<felt252>,
        ) -> felt252 {
            if verify(self, hash, signature.span()) { starknet::VALIDATED } else { 0 }
        }

        fn get_public_key(self: @ContractState) -> (u256, u256) {
            (self.public_key_x.read(), self.public_key_y.read())
        }
    }
}
