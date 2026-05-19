module contracts::pools;

use contracts::admin::AdminCap;
use contracts::mock_usdc::USDC;
use std::option::Option;
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::event;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::TxContext;

const POOL_KIND_MAIN: u8 = 1;
const POOL_KIND_DESIGNATED: u8 = 2;
const POOL_KIND_OPERATIONS: u8 = 3;

const TARGET_KIND_MAIN_POOL: u8 = 11;
const TARGET_KIND_DESIGNATED_POOL: u8 = 12;
const TARGET_KIND_OPERATIONS_POOL: u8 = 13;

public struct MainPool has key {
    id: UID,
    balance: Balance<USDC>,
    total_received_usdc: u64,
    created_at_ms: u64,
}

public struct DesignatedPool has key {
    id: UID,
    balance: Balance<USDC>,
    total_received_usdc: u64,
    related_id: Option<ID>,
    created_at_ms: u64,
}

public struct OperationsPool has key {
    id: UID,
    balance: Balance<USDC>,
    total_received_usdc: u64,
    created_at_ms: u64,
}

public struct PoolCreated has copy, drop {
    pool_id: ID,
    pool_kind: u8,
    related_id: Option<ID>,
    created_at_ms: u64,
    actor: address,
}

public(package) fun create_main_pool(_: &AdminCap, ctx: &mut TxContext) {
    let pool = MainPool {
        id: object::new(ctx),
        balance: balance::zero(),
        total_received_usdc: 0,
        created_at_ms: ctx.epoch_timestamp_ms(),
    };
    let pool_id = object::id(&pool);

    event::emit(PoolCreated {
        pool_id,
        pool_kind: POOL_KIND_MAIN,
        related_id: option::none(),
        created_at_ms: pool.created_at_ms,
        actor: ctx.sender(),
    });

    transfer::share_object(pool);
}

public(package) fun create_designated_pool(
    _: &AdminCap,
    related_id: Option<ID>,
    ctx: &mut TxContext,
) {
    let pool = DesignatedPool {
        id: object::new(ctx),
        balance: balance::zero(),
        total_received_usdc: 0,
        related_id,
        created_at_ms: ctx.epoch_timestamp_ms(),
    };
    let pool_id = object::id(&pool);

    event::emit(PoolCreated {
        pool_id,
        pool_kind: POOL_KIND_DESIGNATED,
        related_id,
        created_at_ms: pool.created_at_ms,
        actor: ctx.sender(),
    });

    transfer::share_object(pool);
}

public(package) fun create_operations_pool(_: &AdminCap, ctx: &mut TxContext) {
    let pool = OperationsPool {
        id: object::new(ctx),
        balance: balance::zero(),
        total_received_usdc: 0,
        created_at_ms: ctx.epoch_timestamp_ms(),
    };
    let pool_id = object::id(&pool);

    event::emit(PoolCreated {
        pool_id,
        pool_kind: POOL_KIND_OPERATIONS,
        related_id: option::none(),
        created_at_ms: pool.created_at_ms,
        actor: ctx.sender(),
    });

    transfer::share_object(pool);
}

public(package) fun deposit_main_usdc(pool: &mut MainPool, coin: Coin<USDC>): u64 {
    let amount = coin::value(&coin);
    pool.balance.join(coin::into_balance(coin));
    pool.total_received_usdc = pool.total_received_usdc + amount;
    amount
}

public(package) fun deposit_designated_usdc(
    pool: &mut DesignatedPool,
    coin: Coin<USDC>,
): u64 {
    let amount = coin::value(&coin);
    pool.balance.join(coin::into_balance(coin));
    pool.total_received_usdc = pool.total_received_usdc + amount;
    amount
}

public(package) fun deposit_operations_usdc(
    pool: &mut OperationsPool,
    coin: Coin<USDC>,
): u64 {
    let amount = coin::value(&coin);
    pool.balance.join(coin::into_balance(coin));
    pool.total_received_usdc = pool.total_received_usdc + amount;
    amount
}

public(package) fun main_pool_summary(pool: &MainPool): (ID, u64, u64, u64) {
    (
        object::id(pool),
        pool.balance.value(),
        pool.total_received_usdc,
        pool.created_at_ms,
    )
}

public(package) fun designated_pool_summary(
    pool: &DesignatedPool,
): (ID, u64, u64, Option<ID>, u64) {
    (
        object::id(pool),
        pool.balance.value(),
        pool.total_received_usdc,
        pool.related_id,
        pool.created_at_ms,
    )
}

public(package) fun operations_pool_summary(pool: &OperationsPool): (ID, u64, u64, u64) {
    (
        object::id(pool),
        pool.balance.value(),
        pool.total_received_usdc,
        pool.created_at_ms,
    )
}

public(package) fun main_pool_id(pool: &MainPool): ID {
    object::id(pool)
}

public(package) fun designated_pool_id(pool: &DesignatedPool): ID {
    object::id(pool)
}

public(package) fun operations_pool_id(pool: &OperationsPool): ID {
    object::id(pool)
}

public(package) fun main_pool_balance_usdc(pool: &MainPool): u64 {
    pool.balance.value()
}

public(package) fun main_pool_total_received_usdc(pool: &MainPool): u64 {
    pool.total_received_usdc
}

public(package) fun designated_pool_balance_usdc(pool: &DesignatedPool): u64 {
    pool.balance.value()
}

public(package) fun designated_pool_total_received_usdc(pool: &DesignatedPool): u64 {
    pool.total_received_usdc
}

public(package) fun operations_pool_balance_usdc(pool: &OperationsPool): u64 {
    pool.balance.value()
}

public(package) fun operations_pool_total_received_usdc(pool: &OperationsPool): u64 {
    pool.total_received_usdc
}

public(package) fun pool_kind_main(): u8 {
    POOL_KIND_MAIN
}

public(package) fun pool_kind_designated(): u8 {
    POOL_KIND_DESIGNATED
}

public(package) fun pool_kind_operations(): u8 {
    POOL_KIND_OPERATIONS
}

public(package) fun target_kind_main_pool(): u8 {
    TARGET_KIND_MAIN_POOL
}

public(package) fun target_kind_designated_pool(): u8 {
    TARGET_KIND_DESIGNATED_POOL
}

public(package) fun target_kind_operations_pool(): u8 {
    TARGET_KIND_OPERATIONS_POOL
}

#[test_only]
public fun pool_created_event_fields(
    event: PoolCreated,
): (ID, u8, Option<ID>, u64, address) {
    let PoolCreated {
        pool_id,
        pool_kind,
        related_id,
        created_at_ms,
        actor,
    } = event;
    (pool_id, pool_kind, related_id, created_at_ms, actor)
}
