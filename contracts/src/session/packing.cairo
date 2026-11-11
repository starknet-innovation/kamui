//! Storage packing for session records. Each record is one felt, so a session transaction reads
//! one slot for the configuration and one for the mutable state.
use starknet::storage_access::StorePacking;

const TWO_POW_64: u128 = 0x10000000000000000;
const TWO_POW_96: u128 = 0x1000000000000000000000000;
const TWO_POW_112: u128 = 0x10000000000000000000000000000;
const MASK_16: u128 = 0xffff;
const MASK_32: u128 = 0xffffffff;
const MASK_64: u128 = 0xffffffffffffffff;

/// What the owner set for a session. Written when the session is added, updated or revoked.
/// `valid_until == 0` means the session does not exist.
#[derive(Drop, Copy, PartialEq, Debug)]
pub struct SessionConfig {
    pub valid_until: u64,
    pub max_calls: u32,
    pub max_fee_per_tx: u128,
    /// Number of whitelist entries; 0 means no whitelist.
    pub allowed_len: u16,
    /// Whether whitelist entries are `(contract, selector)` pairs instead of selectors.
    pub scoped: bool,
}

/// Bookkeeping for a session.
#[derive(Drop, Copy, PartialEq, Debug)]
pub struct SessionState {
    /// Incremented every time the session key is added or updated. It keys the whitelist and the
    /// SNIP-9 nonce range, so an update leaves nothing of the previous configuration reachable.
    pub generation: u32,
    /// The account's session epoch when the session was added.
    pub epoch: u32,
    /// Self-paid limit (nonce anchoring): the first account nonce the session can no longer use.
    /// 0 until the session's first self-paid transaction.
    pub nonce_limit: u64,
}

/// Low 128 bits: max_fee_per_tx. High bits: valid_until (64) | max_calls (32) | allowed_len (16)
/// | scoped (1), 113 bits in total, which fits a felt.
pub impl SessionConfigPacking of StorePacking<SessionConfig, felt252> {
    fn pack(value: SessionConfig) -> felt252 {
        let valid_until: u128 = value.valid_until.into();
        let max_calls: u128 = value.max_calls.into();
        let allowed_len: u128 = value.allowed_len.into();
        let scoped: u128 = if value.scoped {
            1
        } else {
            0
        };
        let high = valid_until
            + max_calls * TWO_POW_64
            + allowed_len * TWO_POW_96
            + scoped * TWO_POW_112;
        let packed = u256 { low: value.max_fee_per_tx, high };
        packed.try_into().unwrap()
    }

    fn unpack(value: felt252) -> SessionConfig {
        let packed: u256 = value.into();
        let high = packed.high;
        SessionConfig {
            valid_until: (high & MASK_64).try_into().unwrap(),
            max_calls: ((high / TWO_POW_64) & MASK_32).try_into().unwrap(),
            max_fee_per_tx: packed.low,
            allowed_len: ((high / TWO_POW_96) & MASK_16).try_into().unwrap(),
            scoped: ((high / TWO_POW_112) & 1) == 1,
        }
    }
}

/// nonce_limit (64) | generation (32) | epoch (32): 128 bits.
pub impl SessionStatePacking of StorePacking<SessionState, felt252> {
    fn pack(value: SessionState) -> felt252 {
        let nonce_limit: u128 = value.nonce_limit.into();
        let generation: u128 = value.generation.into();
        let epoch: u128 = value.epoch.into();
        let packed = nonce_limit + generation * TWO_POW_64 + epoch * TWO_POW_96;
        packed.into()
    }

    fn unpack(value: felt252) -> SessionState {
        let packed: u128 = value.try_into().unwrap();
        SessionState {
            nonce_limit: (packed & MASK_64).try_into().unwrap(),
            generation: ((packed / TWO_POW_64) & MASK_32).try_into().unwrap(),
            epoch: ((packed / TWO_POW_96) & MASK_32).try_into().unwrap(),
        }
    }
}
