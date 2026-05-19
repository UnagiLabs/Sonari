module contracts::mock_usdc;

use sui::coin::{Self, Coin};
use sui::tx_context::TxContext;

/// Package-local USDC stand-in until the mainnet USDC type is bound.
public struct USDC has drop {}

public fun decimals(): u8 {
    6
}

#[test_only]
public fun mint_for_testing(amount: u64, ctx: &mut TxContext): Coin<USDC> {
    coin::mint_for_testing<USDC>(amount, ctx)
}
