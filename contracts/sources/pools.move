module contracts::pools;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::event;
use usdc::usdc::USDC;

const POOL_KIND_MAIN: u8 = 1;
const POOL_KIND_DESIGNATED: u8 = 2;
const POOL_KIND_OPERATIONS: u8 = 3;

const TARGET_KIND_MAIN_POOL: u8 = 11;
const TARGET_KIND_DESIGNATED_POOL: u8 = 12;
const TARGET_KIND_OPERATIONS_POOL: u8 = 13;

const VERSION: u64 = 1;
const MAIN_RESERVE_FLOOR_USDC: u64 = 100_000_000_000;

const EInsufficientPayoutBalance: u64 = 0;
const EVersionMismatch: u64 = 1;

public struct MainPool has key {
    id: UID,
    balance: Balance<USDC>,
    version: u64,
    total_floor_funded_usdc: u64,
    total_swept_in_usdc: u64,
    reserve_floor_usdc: u64,
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
    version: u64,
    total_spent_usdc: u64,
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

public struct OpsSpend has copy, drop {
    pool_id: ID,
    amount: u64,
    recipient: address,
    reason_code: u8,
    actor: address,
}

public(package) fun create_main_pool(ctx: &mut TxContext): ID {
    let pool = MainPool {
        id: object::new(ctx),
        balance: balance::zero(),
        version: VERSION,
        total_floor_funded_usdc: 0,
        total_swept_in_usdc: 0,
        reserve_floor_usdc: MAIN_RESERVE_FLOOR_USDC,
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
    pool_id
}

public(package) fun create_designated_pool(
    related_id: Option<ID>,
    ctx: &mut TxContext,
): ID {
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
    pool_id
}

public(package) fun create_operations_pool(ctx: &mut TxContext): ID {
    let pool = OperationsPool {
        id: object::new(ctx),
        balance: balance::zero(),
        version: VERSION,
        total_spent_usdc: 0,
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
    pool_id
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

public(package) fun withdraw_main_usdc(
    pool: &mut MainPool,
    amount: u64,
    ctx: &mut TxContext,
): Coin<USDC> {
    assert!(pool.balance.value() >= amount, EInsufficientPayoutBalance);
    coin::from_balance(pool.balance.split(amount), ctx)
}

public(package) fun withdraw_designated_usdc(
    pool: &mut DesignatedPool,
    amount: u64,
    ctx: &mut TxContext,
): Coin<USDC> {
    assert!(pool.balance.value() >= amount, EInsufficientPayoutBalance);
    coin::from_balance(pool.balance.split(amount), ctx)
}

public(package) fun assert_main_pool_version(pool: &MainPool) {
    assert!(pool.version == VERSION, EVersionMismatch);
}

public(package) fun assert_operations_pool_version(pool: &OperationsPool) {
    assert!(pool.version == VERSION, EVersionMismatch);
}

public(package) fun migrate_main_pool_to_version(pool: &mut MainPool, new_version: u64) {
    assert!(new_version > pool.version, EVersionMismatch);
    pool.version = new_version;
}

public(package) fun migrate_operations_pool_to_version(
    pool: &mut OperationsPool,
    new_version: u64,
) {
    assert!(new_version > pool.version, EVersionMismatch);
    pool.version = new_version;
}

public(package) fun main_pool_disposable_floor_usdc(pool: &MainPool): u64 {
    let bal = pool.balance.value();
    if (bal > pool.reserve_floor_usdc) {
        bal - pool.reserve_floor_usdc
    } else {
        0
    }
}

public(package) fun fund_floor_from_main(
    pool: &mut MainPool,
    amount: u64,
    ctx: &mut TxContext,
): Coin<USDC> {
    assert!(amount <= main_pool_disposable_floor_usdc(pool), EInsufficientPayoutBalance);
    pool.total_floor_funded_usdc = pool.total_floor_funded_usdc + amount;
    coin::from_balance(pool.balance.split(amount), ctx)
}

public(package) fun receive_swept_to_main(pool: &mut MainPool, coin: Coin<USDC>) {
    let value = coin::value(&coin);
    pool.total_swept_in_usdc = pool.total_swept_in_usdc + value;
    pool.balance.join(coin::into_balance(coin));
}

public(package) fun spend_from_operations(
    pool: &mut OperationsPool,
    amount: u64,
    recipient: address,
    reason_code: u8,
    ctx: &mut TxContext,
): Coin<USDC> {
    assert!(pool.balance.value() >= amount, EInsufficientPayoutBalance);
    pool.total_spent_usdc = pool.total_spent_usdc + amount;
    let coin = coin::from_balance(pool.balance.split(amount), ctx);
    event::emit(OpsSpend {
        pool_id: object::id(pool),
        amount,
        recipient,
        reason_code,
        actor: ctx.sender(),
    });
    coin
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

public(package) fun main_pool_version(pool: &MainPool): u64 {
    pool.version
}

public(package) fun main_pool_total_floor_funded_usdc(pool: &MainPool): u64 {
    pool.total_floor_funded_usdc
}

public(package) fun main_pool_total_swept_in_usdc(pool: &MainPool): u64 {
    pool.total_swept_in_usdc
}

public(package) fun main_pool_reserve_floor_usdc(pool: &MainPool): u64 {
    pool.reserve_floor_usdc
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

public(package) fun operations_pool_version(pool: &OperationsPool): u64 {
    pool.version
}

public(package) fun operations_pool_total_spent_usdc(pool: &OperationsPool): u64 {
    pool.total_spent_usdc
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

public(package) fun version(): u64 {
    VERSION
}

public(package) fun main_reserve_floor_usdc(): u64 {
    MAIN_RESERVE_FLOOR_USDC
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

#[test_only]
public fun ops_spend_event_fields(event: OpsSpend): (ID, u64, address, u8, address) {
    let OpsSpend {
        pool_id,
        amount,
        recipient,
        reason_code,
        actor,
    } = event;
    (pool_id, amount, recipient, reason_code, actor)
}
