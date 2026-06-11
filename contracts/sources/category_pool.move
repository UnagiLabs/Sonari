module contracts::category_pool;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::dynamic_field;
use sui::event;
use usdc::usdc::USDC;

const VERSION: u64 = 1;
const CATEGORY_EARTHQUAKE: u8 = 1;
const TARGET_KIND_CATEGORY_POOL: u8 = 14;

const EVersionMismatch: u64 = 0;
const ECategoryAlreadyRegistered: u64 = 1;
const ECategoryNotRegistered: u64 = 2;
const ECategoryPoolMismatch: u64 = 3;
const EInsufficientBalance: u64 = 4;

public struct CategoryPool has key {
    id: UID,
    version: u64,
    category: u8,
    balance: Balance<USDC>,
    total_received_usdc: u64,
    total_floor_funded_usdc: u64,
    created_at_ms: u64,
}

public struct CategoryRegistry has key {
    id: UID,
}

public struct CategoryPoolCreated has copy, drop {
    pool_id: ID,
    category: u8,
    created_at_ms: u64,
    actor: address,
}

// ---------------------------------------------------------------
// package-level constructors
// ---------------------------------------------------------------

public(package) fun create_category_registry(ctx: &mut TxContext): ID {
    let registry = CategoryRegistry {
        id: object::new(ctx),
    };
    let registry_id = object::id(&registry);
    transfer::share_object(registry);
    registry_id
}

// genesis専用: share前のCategoryRegistryを返す。呼び出し元がpoolを追加後にshareする。
public(package) fun new_category_registry(ctx: &mut TxContext): CategoryRegistry {
    CategoryRegistry { id: object::new(ctx) }
}

public(package) fun share_category_registry(registry: CategoryRegistry) {
    transfer::share_object(registry);
}

public(package) fun create_category_registry_with_earthquake_pool(
    ctx: &mut TxContext,
): (ID, ID) {
    let mut registry = CategoryRegistry {
        id: object::new(ctx),
    };
    let registry_id = object::id(&registry);
    let pool_id = create_category_pool(&mut registry, CATEGORY_EARTHQUAKE, ctx);
    transfer::share_object(registry);
    (registry_id, pool_id)
}

public(package) fun create_category_pool(
    registry: &mut CategoryRegistry,
    category: u8,
    ctx: &mut TxContext,
): ID {
    assert!(
        !dynamic_field::exists(&registry.id, category),
        ECategoryAlreadyRegistered,
    );

    let pool = CategoryPool {
        id: object::new(ctx),
        version: VERSION,
        category,
        balance: balance::zero(),
        total_received_usdc: 0,
        total_floor_funded_usdc: 0,
        created_at_ms: ctx.epoch_timestamp_ms(),
    };
    let pool_id = object::id(&pool);

    dynamic_field::add(&mut registry.id, category, pool_id);
    transfer::share_object(pool);

    event::emit(CategoryPoolCreated {
        pool_id,
        category,
        created_at_ms: ctx.epoch_timestamp_ms(),
        actor: ctx.sender(),
    });

    pool_id
}

// ---------------------------------------------------------------
// mutations
// ---------------------------------------------------------------

public(package) fun deposit_category_usdc(
    pool: &mut CategoryPool,
    coin: Coin<USDC>,
): u64 {
    let amount = coin::value(&coin);
    balance::join(&mut pool.balance, coin::into_balance(coin));
    pool.total_received_usdc = pool.total_received_usdc + amount;
    amount
}

public(package) fun fund_floor_from_category(
    pool: &mut CategoryPool,
    amount: u64,
    ctx: &mut TxContext,
): Coin<USDC> {
    assert!(balance::value(&pool.balance) >= amount, EInsufficientBalance);
    pool.total_floor_funded_usdc = pool.total_floor_funded_usdc + amount;
    coin::from_balance(balance::split(&mut pool.balance, amount), ctx)
}

public(package) fun receive_returned_floor(
    pool: &mut CategoryPool,
    coin: Coin<USDC>,
) {
    balance::join(&mut pool.balance, coin::into_balance(coin));
}

// ---------------------------------------------------------------
// guards
// ---------------------------------------------------------------

public(package) fun assert_category_pool_version(pool: &CategoryPool) {
    assert!(pool.version == VERSION, EVersionMismatch);
}

public(package) fun category_pool_id_for_category(
    registry: &CategoryRegistry,
    category: u8,
): ID {
    assert!(dynamic_field::exists(&registry.id, category), ECategoryNotRegistered);
    *dynamic_field::borrow<u8, ID>(&registry.id, category)
}

public(package) fun assert_category_registered(
    registry: &CategoryRegistry,
    category: u8,
    pool_id: ID,
) {
    let registered = category_pool_id_for_category(registry, category);
    assert!(registered == pool_id, ECategoryPoolMismatch);
}

// ---------------------------------------------------------------
// accessors
// ---------------------------------------------------------------

public(package) fun category_pool_id(pool: &CategoryPool): ID {
    object::id(pool)
}

public(package) fun category_pool_version(pool: &CategoryPool): u64 {
    pool.version
}

public(package) fun category_pool_category(pool: &CategoryPool): u8 {
    pool.category
}

public(package) fun category_pool_balance_usdc(pool: &CategoryPool): u64 {
    balance::value(&pool.balance)
}

public(package) fun category_pool_total_received_usdc(pool: &CategoryPool): u64 {
    pool.total_received_usdc
}

public(package) fun category_pool_total_floor_funded_usdc(pool: &CategoryPool): u64 {
    pool.total_floor_funded_usdc
}

public(package) fun category_registry_id(registry: &CategoryRegistry): ID {
    object::id(registry)
}

public(package) fun category_earthquake(): u8 {
    CATEGORY_EARTHQUAKE
}

public(package) fun target_kind_category_pool(): u8 {
    TARGET_KIND_CATEGORY_POOL
}

public(package) fun version(): u64 {
    VERSION
}

// ---------------------------------------------------------------
// test-only helpers
// ---------------------------------------------------------------

#[test_only]
public fun category_pool_created_event_fields(
    event: CategoryPoolCreated,
): (ID, u8, u64, address) {
    let CategoryPoolCreated { pool_id, category, created_at_ms, actor } = event;
    (pool_id, category, created_at_ms, actor)
}

#[test_only]
public fun create_category_registry_for_testing(ctx: &mut TxContext): ID {
    create_category_registry(ctx)
}
