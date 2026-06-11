#[test_only]
module contracts::pools_v2_tests;

use contracts::admin;
use contracts::pools;
use sui::coin;
use sui::event;
use sui::test_scenario;
use usdc::usdc::USDC;

const ADMIN: address = @0xA11CE;
const RECIPIENT: address = @0xB0B;

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
// MainPool version / field tests
// ---------------------------------------------------------------

#[test]
fun main_pool_version_is_1_after_init() {
    let scenario = initialized();

    let pool = scenario.take_shared<pools::MainPool>();
    assert!(pools::main_pool_version(&pool) == pools::version());
    assert!(pools::main_pool_version(&pool) == 1);
    assert!(pools::main_pool_reserve_floor_usdc(&pool) == pools::main_reserve_floor_usdc());
    assert!(pools::main_pool_reserve_floor_usdc(&pool) == 100_000_000_000);
    assert!(pools::main_pool_total_floor_funded_usdc(&pool) == 0);
    assert!(pools::main_pool_total_swept_in_usdc(&pool) == 0);
    test_scenario::return_shared(pool);

    scenario.end();
}

// ---------------------------------------------------------------
// OperationsPool version / field tests
// ---------------------------------------------------------------

#[test]
fun operations_pool_version_is_1_after_init() {
    let scenario = initialized();

    let pool = scenario.take_shared<pools::OperationsPool>();
    assert!(pools::operations_pool_version(&pool) == pools::version());
    assert!(pools::operations_pool_version(&pool) == 1);
    assert!(pools::operations_pool_total_spent_usdc(&pool) == 0);
    test_scenario::return_shared(pool);

    scenario.end();
}

// ---------------------------------------------------------------
// migrate_main_pool tests
// ---------------------------------------------------------------

#[test]
fun migrate_main_pool_increments_version() {
    let mut scenario = initialized();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pool = scenario.take_shared<pools::MainPool>();
        admin::migrate_main_pool(&cap, &mut pool, 2, scenario.ctx());
        assert!(pools::main_pool_version(&pool) == 2);
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pool);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = pools::EVersionMismatch)]
fun migrate_main_pool_rejects_same_version() {
    let mut scenario = initialized();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pool = scenario.take_shared<pools::MainPool>();
        // version is 1, trying to migrate to 1 should fail
        admin::migrate_main_pool(&cap, &mut pool, 1, scenario.ctx());
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pool);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = pools::EVersionMismatch)]
fun migrate_main_pool_rejects_lower_version() {
    let mut scenario = initialized();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pool = scenario.take_shared<pools::MainPool>();
        // version is 1, trying to go to 0 should fail
        admin::migrate_main_pool(&cap, &mut pool, 0, scenario.ctx());
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pool);
    };

    scenario.end();
}

// ---------------------------------------------------------------
// migrate_operations_pool tests
// ---------------------------------------------------------------

#[test]
fun migrate_operations_pool_increments_version() {
    let mut scenario = initialized();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pool = scenario.take_shared<pools::OperationsPool>();
        admin::migrate_operations_pool(&cap, &mut pool, 2, scenario.ctx());
        assert!(pools::operations_pool_version(&pool) == 2);
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pool);
    };

    scenario.end();
}

// ---------------------------------------------------------------
// main_pool_disposable_floor_usdc tests
// ---------------------------------------------------------------

#[test]
fun main_pool_disposable_respects_reserve_floor_when_balance_is_zero() {
    let scenario = initialized();

    let pool = scenario.take_shared<pools::MainPool>();
    // balance=0, reserve=100_000_000_000 => disposable=0
    assert!(pools::main_pool_disposable_floor_usdc(&pool) == 0);
    test_scenario::return_shared(pool);

    scenario.end();
}

#[test]
fun main_pool_disposable_above_reserve() {
    let mut scenario = initialized();

    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<pools::MainPool>();
        let reserve = pools::main_reserve_floor_usdc();
        // deposit reserve + 100
        let coin = coin::mint_for_testing<USDC>(reserve + 100, scenario.ctx());
        pools::deposit_main_usdc(&mut pool, coin);
        assert!(pools::main_pool_disposable_floor_usdc(&pool) == 100);
        test_scenario::return_shared(pool);
    };

    scenario.end();
}

// ---------------------------------------------------------------
// fund_floor_from_main tests
// ---------------------------------------------------------------

#[test]
fun fund_floor_from_main_updates_total() {
    let mut scenario = initialized();

    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<pools::MainPool>();
        let reserve = pools::main_reserve_floor_usdc();
        // deposit reserve + 500 so we have 500 disposable
        let coin = coin::mint_for_testing<USDC>(reserve + 500, scenario.ctx());
        pools::deposit_main_usdc(&mut pool, coin);

        let funded_coin = pools::fund_floor_from_main(&mut pool, 300, scenario.ctx());
        assert!(pools::main_pool_total_floor_funded_usdc(&pool) == 300);
        assert!(coin::value(&funded_coin) == 300);
        // balance should be reserve + 500 - 300 = reserve + 200
        assert!(pools::main_pool_balance_usdc(&pool) == reserve + 200);

        transfer::public_transfer(funded_coin, ADMIN);
        test_scenario::return_shared(pool);
    };

    scenario.end();
}

// ---------------------------------------------------------------
// receive_swept_to_main tests
// ---------------------------------------------------------------

#[test]
fun receive_swept_to_main_updates_total_swept() {
    let mut scenario = initialized();

    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<pools::MainPool>();
        let coin = coin::mint_for_testing<USDC>(1_000, scenario.ctx());
        pools::receive_swept_to_main(&mut pool, coin);
        assert!(pools::main_pool_total_swept_in_usdc(&pool) == 1_000);
        assert!(pools::main_pool_balance_usdc(&pool) == 1_000);
        test_scenario::return_shared(pool);
    };

    scenario.end();
}

// ---------------------------------------------------------------
// spend_operations tests
// ---------------------------------------------------------------

#[test]
fun spend_operations_emits_ops_spend_event() {
    let mut scenario = initialized();

    scenario.next_tx(ADMIN);
    {
        let mut ops_pool = scenario.take_shared<pools::OperationsPool>();
        // fund the ops pool
        let coin = coin::mint_for_testing<USDC>(5_000, scenario.ctx());
        pools::deposit_operations_usdc(&mut ops_pool, coin);
        test_scenario::return_shared(ops_pool);
    };

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut ops_pool = scenario.take_shared<pools::OperationsPool>();

        admin::spend_operations(&cap, &mut ops_pool, 1_000, RECIPIENT, 42, scenario.ctx());

        assert!(pools::operations_pool_total_spent_usdc(&ops_pool) == 1_000);
        assert!(pools::operations_pool_balance_usdc(&ops_pool) == 4_000);

        let events = event::events_by_type<pools::OpsSpend>();
        assert!(events.length() == 1);
        let (pool_id, amount, recipient, reason_code, actor) =
            pools::ops_spend_event_fields(*events.borrow(0));
        assert!(pool_id == pools::operations_pool_id(&ops_pool));
        assert!(amount == 1_000);
        assert!(recipient == RECIPIENT);
        assert!(reason_code == 42);
        assert!(actor == ADMIN);

        scenario.return_to_sender(cap);
        test_scenario::return_shared(ops_pool);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = pools::EInsufficientPayoutBalance)]
fun spend_operations_rejects_insufficient_balance() {
    let mut scenario = initialized();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut ops_pool = scenario.take_shared<pools::OperationsPool>();
        // balance is 0, try to spend 1
        admin::spend_operations(&cap, &mut ops_pool, 1, RECIPIENT, 0, scenario.ctx());
        scenario.return_to_sender(cap);
        test_scenario::return_shared(ops_pool);
    };

    scenario.end();
}
