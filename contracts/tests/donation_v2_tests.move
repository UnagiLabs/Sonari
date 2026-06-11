#[test_only]
module contracts::donation_v2_tests;

use contracts::admin;
use contracts::campaign;
use contracts::category_pool;
use contracts::disaster_event;
use contracts::donation;
use contracts::pools;
use sui::clock;
use sui::coin;
use sui::event;
use sui::test_scenario;
use usdc::usdc::USDC;

const ADMIN: address = @0xA11CE;
const DONOR: address = @0xD0A0;

const NOW_MS: u64 = 1_704_170_000_000;

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------

fun initialized_with_campaign(): (test_scenario::Scenario, ID, ID, ID, ID) {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);

    let cap = scenario.take_from_sender<admin::AdminCap>();
    admin::create_disaster_registry(&cap, scenario.ctx());
    scenario.return_to_sender(cap);
    scenario.next_tx(ADMIN);

    let registry_id = category_pool::create_category_registry_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);

    let cap = scenario.take_from_sender<admin::AdminCap>();
    let mut cat_registry = scenario.take_shared_by_id<category_pool::CategoryRegistry>(registry_id);
    admin::create_category_pool(
        &cap,
        &mut cat_registry,
        category_pool::category_earthquake(),
        scenario.ctx(),
    );
    test_scenario::return_shared(cat_registry);
    scenario.return_to_sender(cap);
    scenario.next_tx(ADMIN);

    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(NOW_MS);

    let cat_registry = scenario.take_shared<category_pool::CategoryRegistry>();
    let category_pool = scenario.take_shared<category_pool::CategoryPool>();
    let category_pool_id = category_pool::category_pool_id(&category_pool);
    let mut disaster_registry = scenario.take_shared<disaster_event::DisasterRegistry>();

    let (event_uid, event_revision, de_id) = disaster_event::create_for_campaign_testing(
        &mut disaster_registry,
        campaign::hazard_type_earthquake_for_testing(),
        3u8,
        scenario.ctx(),
    );

    let result = campaign::create_campaign(
        &cat_registry,
        &category_pool,
        de_id,
        event_uid,
        event_revision,
        campaign::hazard_type_earthquake_for_testing(),
        3u8,
        &clock,
        scenario.ctx(),
    );
    assert!(result.is_some());
    let campaign_id = result.destroy_some();

    test_scenario::return_shared(disaster_registry);
    test_scenario::return_shared(cat_registry);
    test_scenario::return_shared(category_pool);
    clock.destroy_for_testing();
    scenario.next_tx(ADMIN);

    let main_pool = scenario.take_shared<pools::MainPool>();
    let main_pool_id = pools::main_pool_id(&main_pool);
    test_scenario::return_shared(main_pool);

    let ops_pool = scenario.take_shared<pools::OperationsPool>();
    let ops_pool_id = pools::operations_pool_id(&ops_pool);
    test_scenario::return_shared(ops_pool);

    (scenario, campaign_id, category_pool_id, main_pool_id, ops_pool_id)
}

// ---------------------------------------------------------------
// 1. donate_to_campaign: splits 90/5/5
// ---------------------------------------------------------------

#[test]
fun donate_to_campaign_splits_90_5_5() {
    let (mut scenario, campaign_id, _cat_pool_id, main_pool_id, ops_pool_id) =
        initialized_with_campaign();

    scenario.next_tx(DONOR);

    let mut camp = scenario.take_shared_by_id<campaign::Campaign>(campaign_id);
    let mut main_pool = scenario.take_shared_by_id<pools::MainPool>(main_pool_id);
    let mut ops_pool = scenario.take_shared_by_id<pools::OperationsPool>(ops_pool_id);

    let coin = coin::mint_for_testing<USDC>(1_000_000, scenario.ctx());
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(NOW_MS); // before donation_end_ms

    donation::donate_to_campaign(
        &mut camp,
        &mut main_pool,
        &mut ops_pool,
        coin,
        clock::timestamp_ms(&clock),
        scenario.ctx(),
    );

    // Campaign balance should be 900_000 (90%)
    assert!(campaign::campaign_total_donated_usdc(&camp) == 900_000);
    // Main pool got 50_000 (5%)
    assert!(pools::main_pool_balance_usdc(&main_pool) == 50_000);
    // Ops pool got 50_000 (5%)
    assert!(pools::operations_pool_balance_usdc(&ops_pool) == 50_000);

    // DonationSplit event
    let events = event::events_by_type<donation::DonationSplit>();
    assert!(events.length() == 1);
    let ev = *events.borrow(0);
    let (target, _primary_pool_id, total, primary, main, ops, overflow, after_end, donor) =
        donation::donation_split_event_fields(ev);
    assert!(target == donation::donation_target_campaign());
    assert!(total == 1_000_000);
    assert!(primary == 900_000);
    assert!(main == 50_000);
    assert!(ops == 50_000);
    assert!(overflow == 0);
    assert!(after_end == false);
    assert!(donor == DONOR);

    clock.destroy_for_testing();
    test_scenario::return_shared(camp);
    test_scenario::return_shared(main_pool);
    test_scenario::return_shared(ops_pool);
    scenario.end();
}

// ---------------------------------------------------------------
// 2. donate_to_campaign: ops_cap overflow goes to main
// ---------------------------------------------------------------

#[test]
fun donate_to_campaign_ops_cap_overflow_goes_to_main() {
    let (mut scenario, campaign_id, _cat_pool_id, main_pool_id, ops_pool_id) =
        initialized_with_campaign();

    scenario.next_tx(DONOR);

    let mut camp = scenario.take_shared_by_id<campaign::Campaign>(campaign_id);
    let mut main_pool = scenario.take_shared_by_id<pools::MainPool>(main_pool_id);
    let mut ops_pool = scenario.take_shared_by_id<pools::OperationsPool>(ops_pool_id);

    // Fill ops almost to cap (cap = 50_000_000_000, leave only 10_000 remaining)
    let remaining_cap = 10_000u64;
    let ops_cap = campaign::campaign_ops_cap_usdc(&camp);
    campaign::set_ops_withheld_for_testing(&mut camp, ops_cap - remaining_cap);

    // Donate 1_000_000: ops portion = 50_000, but only 10_000 fits in cap
    let coin = coin::mint_for_testing<USDC>(1_000_000, scenario.ctx());
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(NOW_MS);

    donation::donate_to_campaign(
        &mut camp,
        &mut main_pool,
        &mut ops_pool,
        coin,
        clock::timestamp_ms(&clock),
        scenario.ctx(),
    );

    // ops_actual = 10_000, overflow = 40_000 goes to main
    // main_total = 50_000 + 40_000 = 90_000
    assert!(pools::operations_pool_balance_usdc(&ops_pool) == 10_000);
    assert!(pools::main_pool_balance_usdc(&main_pool) == 90_000);
    assert!(campaign::campaign_total_donated_usdc(&camp) == 900_000);

    let events = event::events_by_type<donation::DonationSplit>();
    assert!(events.length() == 1);
    let ev = *events.borrow(0);
    let (_, _, _, _, _, ops, overflow, _, _) = donation::donation_split_event_fields(ev);
    assert!(ops == 10_000);
    assert!(overflow == 40_000);

    clock.destroy_for_testing();
    test_scenario::return_shared(camp);
    test_scenario::return_shared(main_pool);
    test_scenario::return_shared(ops_pool);
    scenario.end();
}

// ---------------------------------------------------------------
// 3. donate_to_campaign: after donation_end redirects campaign portion to main
// ---------------------------------------------------------------

#[test]
fun donate_to_campaign_after_donation_end_redirects_to_main() {
    let (mut scenario, campaign_id, _cat_pool_id, main_pool_id, ops_pool_id) =
        initialized_with_campaign();

    scenario.next_tx(DONOR);

    let mut camp = scenario.take_shared_by_id<campaign::Campaign>(campaign_id);
    let mut main_pool = scenario.take_shared_by_id<pools::MainPool>(main_pool_id);
    let mut ops_pool = scenario.take_shared_by_id<pools::OperationsPool>(ops_pool_id);

    let donation_end = campaign::campaign_donation_end_ms(&camp);
    let after_end_ms = donation_end + 1;

    let coin = coin::mint_for_testing<USDC>(1_000_000, scenario.ctx());
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(after_end_ms);

    donation::donate_to_campaign(
        &mut camp,
        &mut main_pool,
        &mut ops_pool,
        coin,
        clock::timestamp_ms(&clock),
        scenario.ctx(),
    );

    // Campaign portion (900_000) redirected to main → main gets 900_000 + 50_000 = 950_000
    assert!(campaign::campaign_total_donated_usdc(&camp) == 0);
    assert!(pools::main_pool_balance_usdc(&main_pool) == 950_000);
    assert!(pools::operations_pool_balance_usdc(&ops_pool) == 50_000);

    let events = event::events_by_type<donation::DonationSplit>();
    assert!(events.length() == 1);
    let ev = *events.borrow(0);
    let (_, _, _, primary, main, ops, overflow, after_end, _) =
        donation::donation_split_event_fields(ev);
    assert!(primary == 900_000); // calculated amount
    assert!(main == 950_000);    // includes redirected primary
    assert!(ops == 50_000);
    assert!(overflow == 0);
    assert!(after_end == true);

    clock.destroy_for_testing();
    test_scenario::return_shared(camp);
    test_scenario::return_shared(main_pool);
    test_scenario::return_shared(ops_pool);
    scenario.end();
}

// ---------------------------------------------------------------
// 4. donate_to_category: splits 90/5/5
// ---------------------------------------------------------------

#[test]
fun donate_to_category_splits_90_5_5() {
    let (mut scenario, _campaign_id, cat_pool_id, main_pool_id, ops_pool_id) =
        initialized_with_campaign();

    scenario.next_tx(DONOR);

    let mut cat_pool = scenario.take_shared_by_id<category_pool::CategoryPool>(cat_pool_id);
    let mut main_pool = scenario.take_shared_by_id<pools::MainPool>(main_pool_id);
    let mut ops_pool = scenario.take_shared_by_id<pools::OperationsPool>(ops_pool_id);

    let coin = coin::mint_for_testing<USDC>(500_000, scenario.ctx());

    donation::donate_to_category(
        &mut cat_pool,
        &mut main_pool,
        &mut ops_pool,
        coin,
        scenario.ctx(),
    );

    // 450_000 to category (90%), 25_000 to main (5%), 25_000 to ops (5%)
    assert!(category_pool::category_pool_balance_usdc(&cat_pool) == 450_000);
    assert!(pools::main_pool_balance_usdc(&main_pool) == 25_000);
    assert!(pools::operations_pool_balance_usdc(&ops_pool) == 25_000);

    let events = event::events_by_type<donation::DonationSplit>();
    assert!(events.length() == 1);
    let ev = *events.borrow(0);
    let (target, _primary_pool_id, total, primary, main, ops, overflow, after_end, donor) =
        donation::donation_split_event_fields(ev);
    assert!(target == donation::donation_target_category());
    assert!(total == 500_000);
    assert!(primary == 450_000);
    assert!(main == 25_000);
    assert!(ops == 25_000);
    assert!(overflow == 0);
    assert!(after_end == false);
    assert!(donor == DONOR);

    test_scenario::return_shared(cat_pool);
    test_scenario::return_shared(main_pool);
    test_scenario::return_shared(ops_pool);
    scenario.end();
}

// ---------------------------------------------------------------
// 5. donate_general_split: splits 95/5
// ---------------------------------------------------------------

#[test]
fun donate_general_split_splits_95_5() {
    let (mut scenario, _campaign_id, _cat_pool_id, main_pool_id, ops_pool_id) =
        initialized_with_campaign();

    scenario.next_tx(DONOR);

    let mut main_pool = scenario.take_shared_by_id<pools::MainPool>(main_pool_id);
    let mut ops_pool = scenario.take_shared_by_id<pools::OperationsPool>(ops_pool_id);

    let coin = coin::mint_for_testing<USDC>(1_000_000, scenario.ctx());

    donation::donate_general_split(
        &mut main_pool,
        &mut ops_pool,
        coin,
        scenario.ctx(),
    );

    // 950_000 to main (95%), 50_000 to ops (5%)
    assert!(pools::main_pool_balance_usdc(&main_pool) == 950_000);
    assert!(pools::operations_pool_balance_usdc(&ops_pool) == 50_000);

    let events = event::events_by_type<donation::DonationSplit>();
    assert!(events.length() == 1);
    let ev = *events.borrow(0);
    let (target, primary_pool_id, total, primary, main, ops, overflow, after_end, donor) =
        donation::donation_split_event_fields(ev);
    assert!(target == donation::donation_target_none());
    assert!(primary_pool_id.is_none());
    assert!(total == 1_000_000);
    assert!(primary == 0);
    assert!(main == 950_000);
    assert!(ops == 50_000);
    assert!(overflow == 0);
    assert!(after_end == false);
    assert!(donor == DONOR);

    test_scenario::return_shared(main_pool);
    test_scenario::return_shared(ops_pool);
    scenario.end();
}

// ---------------------------------------------------------------
// 6. donate_to_campaign: zero amount is rejected
// ---------------------------------------------------------------

#[test]
#[expected_failure(abort_code = donation::EZeroDonation)]
fun donate_to_campaign_zero_amount_is_rejected() {
    let (mut scenario, campaign_id, _cat_pool_id, main_pool_id, ops_pool_id) =
        initialized_with_campaign();

    scenario.next_tx(DONOR);

    let mut camp = scenario.take_shared_by_id<campaign::Campaign>(campaign_id);
    let mut main_pool = scenario.take_shared_by_id<pools::MainPool>(main_pool_id);
    let mut ops_pool = scenario.take_shared_by_id<pools::OperationsPool>(ops_pool_id);

    let coin = coin::mint_for_testing<USDC>(0, scenario.ctx());
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(NOW_MS);

    donation::donate_to_campaign(
        &mut camp,
        &mut main_pool,
        &mut ops_pool,
        coin,
        clock::timestamp_ms(&clock),
        scenario.ctx(),
    );

    clock.destroy_for_testing();
    test_scenario::return_shared(camp);
    test_scenario::return_shared(main_pool);
    test_scenario::return_shared(ops_pool);
    scenario.end();
}

// ---------------------------------------------------------------
// 7. donate_to_campaign: rounding stays in main
// ---------------------------------------------------------------

#[test]
fun donate_to_campaign_rounding_stays_in_main() {
    let (mut scenario, campaign_id, _cat_pool_id, main_pool_id, ops_pool_id) =
        initialized_with_campaign();

    scenario.next_tx(DONOR);

    let mut camp = scenario.take_shared_by_id<campaign::Campaign>(campaign_id);
    let mut main_pool = scenario.take_shared_by_id<pools::MainPool>(main_pool_id);
    let mut ops_pool = scenario.take_shared_by_id<pools::OperationsPool>(ops_pool_id);

    // Donate 1 unit: primary = floor(1 * 9000 / 10000) = 0, ops = floor(1 * 500 / 10000) = 0, main = 1
    let coin = coin::mint_for_testing<USDC>(1, scenario.ctx());
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(NOW_MS);

    donation::donate_to_campaign(
        &mut camp,
        &mut main_pool,
        &mut ops_pool,
        coin,
        clock::timestamp_ms(&clock),
        scenario.ctx(),
    );

    assert!(campaign::campaign_total_donated_usdc(&camp) == 0);
    assert!(pools::main_pool_balance_usdc(&main_pool) == 1);
    assert!(pools::operations_pool_balance_usdc(&ops_pool) == 0);

    clock.destroy_for_testing();
    test_scenario::return_shared(camp);
    test_scenario::return_shared(main_pool);
    test_scenario::return_shared(ops_pool);
    scenario.end();
}
