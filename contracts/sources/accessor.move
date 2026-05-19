module contracts::accessor;

use contracts::admin::PauseState;
use contracts::donation::{Self, DonorPass, DonorRegistry};
use contracts::mock_usdc::USDC;
use contracts::pools::{Self, DesignatedPool, MainPool, OperationsPool};
use std::option::Option;
use sui::coin::Coin;
use sui::object::ID;
use sui::tx_context::TxContext;

public fun donate_general_usdc(
    pause_state: &PauseState,
    registry: &mut DonorRegistry,
    main_pool: &mut MainPool,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
) {
    donation::donate_general_usdc(pause_state, registry, main_pool, coin, ctx);
}

public fun donate_general_usdc_with_pass(
    pause_state: &PauseState,
    registry: &DonorRegistry,
    main_pool: &mut MainPool,
    pass: &mut DonorPass,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
) {
    donation::donate_general_usdc_with_pass(
        pause_state,
        registry,
        main_pool,
        pass,
        coin,
        ctx,
    );
}

public fun donate_designated_usdc(
    pause_state: &PauseState,
    registry: &mut DonorRegistry,
    main_pool: &mut MainPool,
    designated_pool: &mut DesignatedPool,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
) {
    donation::donate_designated_usdc(
        pause_state,
        registry,
        main_pool,
        designated_pool,
        coin,
        ctx,
    );
}

public fun donate_designated_usdc_with_pass(
    pause_state: &PauseState,
    registry: &DonorRegistry,
    main_pool: &mut MainPool,
    designated_pool: &mut DesignatedPool,
    pass: &mut DonorPass,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
) {
    donation::donate_designated_usdc_with_pass(
        pause_state,
        registry,
        main_pool,
        designated_pool,
        pass,
        coin,
        ctx,
    );
}

public fun donate_operations_usdc(
    pause_state: &PauseState,
    registry: &mut DonorRegistry,
    operations_pool: &mut OperationsPool,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
) {
    donation::donate_operations_usdc(pause_state, registry, operations_pool, coin, ctx);
}

public fun donate_operations_usdc_with_pass(
    pause_state: &PauseState,
    registry: &DonorRegistry,
    operations_pool: &mut OperationsPool,
    pass: &mut DonorPass,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
) {
    donation::donate_operations_usdc_with_pass(
        pause_state,
        registry,
        operations_pool,
        pass,
        coin,
        ctx,
    );
}

public fun donor_pass_summary(pass: &DonorPass): (address, ID, u64, u64, u64, u64, u8) {
    donation::donor_pass_summary(pass)
}

public fun donation_record_summary(
    pass: &DonorPass,
    donation_index: u64,
): (u64, u8, Option<ID>, Option<ID>, ID, u64, vector<u8>, u64) {
    donation::donation_record_summary(pass, donation_index)
}

public fun main_pool_summary(pool: &MainPool): (ID, u64, u64, u64) {
    pools::main_pool_summary(pool)
}

public fun designated_pool_summary(pool: &DesignatedPool): (ID, u64, u64, Option<ID>, u64) {
    pools::designated_pool_summary(pool)
}

public fun operations_pool_summary(pool: &OperationsPool): (ID, u64, u64, u64) {
    pools::operations_pool_summary(pool)
}
