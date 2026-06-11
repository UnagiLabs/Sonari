#[test_only]
module contracts::category_pool_tests;

use contracts::admin;
use contracts::category_pool;
use sui::coin;
use sui::event;
use sui::test_scenario;
use usdc::usdc::USDC;

const ADMIN: address = @0xA11CE;

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------

fun initialized(): test_scenario::Scenario {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);
    scenario
}

// ---------------------------------------------------------------
// 1. create_category_pool registers pool and emits event
// ---------------------------------------------------------------

#[test]
fun create_category_pool_registers_pool_and_emits_event() {
    let mut scenario = initialized();

    let registry_id = category_pool::create_category_registry_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);

    let cap = scenario.take_from_sender<admin::AdminCap>();
    let mut registry = scenario.take_shared_by_id<category_pool::CategoryRegistry>(registry_id);

    let pool_id = admin::create_category_pool(
        &cap,
        &mut registry,
        category_pool::category_earthquake(),
        scenario.ctx(),
    );

    let emitted = event::events_by_type<category_pool::CategoryPoolCreated>();
    assert!(emitted.length() == 1);
    let (ev_pool_id, ev_category, _ev_created_at_ms, ev_actor) =
        category_pool::category_pool_created_event_fields(*emitted.borrow(0));
    assert!(ev_pool_id == pool_id);
    assert!(ev_category == category_pool::category_earthquake());
    assert!(ev_actor == ADMIN);

    let looked_up = category_pool::category_pool_id_for_category(
        &registry,
        category_pool::category_earthquake(),
    );
    assert!(looked_up == pool_id);

    test_scenario::return_shared(registry);
    scenario.return_to_sender(cap);
    scenario.end();
}

// ---------------------------------------------------------------
// 2. duplicate category is rejected
// ---------------------------------------------------------------

#[test]
#[expected_failure(abort_code = category_pool::ECategoryAlreadyRegistered)]
fun duplicate_category_is_rejected() {
    let mut scenario = initialized();

    let registry_id = category_pool::create_category_registry_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);

    let cap = scenario.take_from_sender<admin::AdminCap>();
    let mut registry = scenario.take_shared_by_id<category_pool::CategoryRegistry>(registry_id);

    admin::create_category_pool(
        &cap,
        &mut registry,
        category_pool::category_earthquake(),
        scenario.ctx(),
    );
    // second call for same category must abort
    admin::create_category_pool(
        &cap,
        &mut registry,
        category_pool::category_earthquake(),
        scenario.ctx(),
    );

    test_scenario::return_shared(registry);
    scenario.return_to_sender(cap);
    scenario.end();
}

// ---------------------------------------------------------------
// 3. deposit_category_usdc updates balance and total_received
// ---------------------------------------------------------------

#[test]
fun deposit_category_usdc_updates_balance_and_total() {
    let mut scenario = initialized();

    let registry_id = category_pool::create_category_registry_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);

    let cap = scenario.take_from_sender<admin::AdminCap>();
    let mut registry = scenario.take_shared_by_id<category_pool::CategoryRegistry>(registry_id);

    let pool_id = admin::create_category_pool(
        &cap,
        &mut registry,
        category_pool::category_earthquake(),
        scenario.ctx(),
    );
    test_scenario::return_shared(registry);
    scenario.return_to_sender(cap);

    scenario.next_tx(ADMIN);
    let mut pool = scenario.take_shared_by_id<category_pool::CategoryPool>(pool_id);

    let usdc = coin::mint_for_testing<USDC>(500_000, scenario.ctx());
    let received = category_pool::deposit_category_usdc(&mut pool, usdc);
    assert!(received == 500_000);
    assert!(category_pool::category_pool_balance_usdc(&pool) == 500_000);
    assert!(category_pool::category_pool_total_received_usdc(&pool) == 500_000);

    test_scenario::return_shared(pool);
    scenario.end();
}

// ---------------------------------------------------------------
// 4. fund_floor_from_category updates total_floor_funded and reduces balance
// ---------------------------------------------------------------

#[test]
fun fund_floor_from_category_updates_total_floor_funded() {
    let mut scenario = initialized();

    let registry_id = category_pool::create_category_registry_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);

    let cap = scenario.take_from_sender<admin::AdminCap>();
    let mut registry = scenario.take_shared_by_id<category_pool::CategoryRegistry>(registry_id);
    let pool_id = admin::create_category_pool(
        &cap,
        &mut registry,
        category_pool::category_earthquake(),
        scenario.ctx(),
    );
    test_scenario::return_shared(registry);
    scenario.return_to_sender(cap);

    scenario.next_tx(ADMIN);
    let mut pool = scenario.take_shared_by_id<category_pool::CategoryPool>(pool_id);

    let usdc = coin::mint_for_testing<USDC>(1_000_000, scenario.ctx());
    category_pool::deposit_category_usdc(&mut pool, usdc);

    let extracted = category_pool::fund_floor_from_category(&mut pool, 300_000, scenario.ctx());
    assert!(coin::value(&extracted) == 300_000);
    assert!(category_pool::category_pool_balance_usdc(&pool) == 700_000);
    assert!(category_pool::category_pool_total_floor_funded_usdc(&pool) == 300_000);

    coin::burn_for_testing(extracted);
    test_scenario::return_shared(pool);
    scenario.end();
}

// ---------------------------------------------------------------
// 5. fund_floor_from_category rejects insufficient balance
// ---------------------------------------------------------------

#[test]
#[expected_failure(abort_code = category_pool::EInsufficientBalance)]
fun fund_floor_from_category_rejects_insufficient_balance() {
    let mut scenario = initialized();

    let registry_id = category_pool::create_category_registry_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);

    let cap = scenario.take_from_sender<admin::AdminCap>();
    let mut registry = scenario.take_shared_by_id<category_pool::CategoryRegistry>(registry_id);
    let pool_id = admin::create_category_pool(
        &cap,
        &mut registry,
        category_pool::category_earthquake(),
        scenario.ctx(),
    );
    test_scenario::return_shared(registry);
    scenario.return_to_sender(cap);

    scenario.next_tx(ADMIN);
    let mut pool = scenario.take_shared_by_id<category_pool::CategoryPool>(pool_id);

    let usdc = coin::mint_for_testing<USDC>(100, scenario.ctx());
    category_pool::deposit_category_usdc(&mut pool, usdc);

    let extracted = category_pool::fund_floor_from_category(&mut pool, 999_999, scenario.ctx());
    coin::burn_for_testing(extracted);
    test_scenario::return_shared(pool);
    scenario.end();
}

// ---------------------------------------------------------------
// 6. receive_returned_floor restores balance
// ---------------------------------------------------------------

#[test]
fun receive_returned_floor_restores_balance() {
    let mut scenario = initialized();

    let registry_id = category_pool::create_category_registry_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);

    let cap = scenario.take_from_sender<admin::AdminCap>();
    let mut registry = scenario.take_shared_by_id<category_pool::CategoryRegistry>(registry_id);
    let pool_id = admin::create_category_pool(
        &cap,
        &mut registry,
        category_pool::category_earthquake(),
        scenario.ctx(),
    );
    test_scenario::return_shared(registry);
    scenario.return_to_sender(cap);

    scenario.next_tx(ADMIN);
    let mut pool = scenario.take_shared_by_id<category_pool::CategoryPool>(pool_id);

    let usdc = coin::mint_for_testing<USDC>(1_000_000, scenario.ctx());
    category_pool::deposit_category_usdc(&mut pool, usdc);

    let extracted = category_pool::fund_floor_from_category(&mut pool, 400_000, scenario.ctx());
    assert!(category_pool::category_pool_balance_usdc(&pool) == 600_000);
    assert!(category_pool::category_pool_total_floor_funded_usdc(&pool) == 400_000);

    category_pool::receive_returned_floor(&mut pool, extracted);
    assert!(category_pool::category_pool_balance_usdc(&pool) == 1_000_000);
    // total_floor_funded_usdc is cumulative — must NOT decrease
    assert!(category_pool::category_pool_total_floor_funded_usdc(&pool) == 400_000);

    test_scenario::return_shared(pool);
    scenario.end();
}

// ---------------------------------------------------------------
// 7. version is 1 after create
// ---------------------------------------------------------------

#[test]
fun version_is_1_after_create() {
    let mut scenario = initialized();

    let registry_id = category_pool::create_category_registry_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);

    let cap = scenario.take_from_sender<admin::AdminCap>();
    let mut registry = scenario.take_shared_by_id<category_pool::CategoryRegistry>(registry_id);
    let pool_id = admin::create_category_pool(
        &cap,
        &mut registry,
        category_pool::category_earthquake(),
        scenario.ctx(),
    );
    test_scenario::return_shared(registry);
    scenario.return_to_sender(cap);

    scenario.next_tx(ADMIN);
    let pool = scenario.take_shared_by_id<category_pool::CategoryPool>(pool_id);
    assert!(category_pool::category_pool_version(&pool) == category_pool::version());
    assert!(category_pool::category_pool_version(&pool) == 1);
    category_pool::assert_category_pool_version(&pool);

    test_scenario::return_shared(pool);
    scenario.end();
}

// ---------------------------------------------------------------
// 8. assert_category_registered passes for correct pool
// ---------------------------------------------------------------

#[test]
fun assert_category_registered_passes_for_correct_pool() {
    let mut scenario = initialized();

    let registry_id = category_pool::create_category_registry_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);

    let cap = scenario.take_from_sender<admin::AdminCap>();
    let mut registry = scenario.take_shared_by_id<category_pool::CategoryRegistry>(registry_id);
    let pool_id = admin::create_category_pool(
        &cap,
        &mut registry,
        category_pool::category_earthquake(),
        scenario.ctx(),
    );

    // must not abort
    category_pool::assert_category_registered(
        &registry,
        category_pool::category_earthquake(),
        pool_id,
    );

    test_scenario::return_shared(registry);
    scenario.return_to_sender(cap);
    scenario.end();
}

// ---------------------------------------------------------------
// 9. assert_category_registered rejects wrong pool
// ---------------------------------------------------------------

#[test]
#[expected_failure(abort_code = category_pool::ECategoryPoolMismatch)]
fun assert_category_registered_rejects_wrong_pool() {
    let mut scenario = initialized();

    let registry_id = category_pool::create_category_registry_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);

    let cap = scenario.take_from_sender<admin::AdminCap>();
    let mut registry = scenario.take_shared_by_id<category_pool::CategoryRegistry>(registry_id);
    admin::create_category_pool(
        &cap,
        &mut registry,
        category_pool::category_earthquake(),
        scenario.ctx(),
    );

    let fake_id = object::id_from_address(@0xDEAD);
    category_pool::assert_category_registered(
        &registry,
        category_pool::category_earthquake(),
        fake_id,
    );

    test_scenario::return_shared(registry);
    scenario.return_to_sender(cap);
    scenario.end();
}
