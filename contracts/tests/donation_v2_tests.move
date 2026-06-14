#[test_only]
module contracts::donation_v2_tests;

use contracts::accessor;
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
    let mut registry = scenario.take_shared<donation::DonorRegistry>();
    let mut pass = donation::issue_donor_pass(&mut registry, scenario.ctx());

    let coin = coin::mint_for_testing<USDC>(1_000_000, scenario.ctx());
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(NOW_MS); // before donation_end_ms

    donation::donate_to_campaign(
        &registry,
        &mut pass,
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

    // donation is recorded in the pass with the full amount
    assert!(donation::donor_pass_donation_count(&pass) == 1);
    assert!(donation::donor_pass_total_donated_usdc(&pass) == 1_000_000);
    let (rec_idx, rec_type, _program_id, rec_campaign_id, _pool_id, rec_amount, _coin_type, _ts) =
        donation::donation_record_summary(&pass, 0);
    assert!(rec_idx == 0);
    assert!(rec_type == donation::donation_type_campaign());
    assert!(rec_campaign_id.is_some());
    assert!(rec_amount == 1_000_000);
    let recorded = event::events_by_type<donation::DonationRecorded>();
    assert!(recorded.length() == 1);

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

    donation::transfer_donor_pass(pass, scenario.ctx());
    clock.destroy_for_testing();
    test_scenario::return_shared(camp);
    test_scenario::return_shared(main_pool);
    test_scenario::return_shared(ops_pool);
    test_scenario::return_shared(registry);
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
    let mut registry = scenario.take_shared<donation::DonorRegistry>();
    let mut pass = donation::issue_donor_pass(&mut registry, scenario.ctx());

    // Fill ops almost to cap (cap = 50_000_000_000, leave only 10_000 remaining)
    let remaining_cap = 10_000u64;
    let ops_cap = campaign::campaign_ops_cap_usdc(&camp);
    campaign::set_ops_withheld_for_testing(&mut camp, ops_cap - remaining_cap);

    // Donate 1_000_000: ops portion = 50_000, but only 10_000 fits in cap
    let coin = coin::mint_for_testing<USDC>(1_000_000, scenario.ctx());
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(NOW_MS);

    donation::donate_to_campaign(
        &registry,
        &mut pass,
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

    // pass records the full donated amount regardless of ops_cap redistribution
    assert!(donation::donor_pass_total_donated_usdc(&pass) == 1_000_000);

    let events = event::events_by_type<donation::DonationSplit>();
    assert!(events.length() == 1);
    let ev = *events.borrow(0);
    let (_, _, _, _, _, ops, overflow, _, _) = donation::donation_split_event_fields(ev);
    assert!(ops == 10_000);
    assert!(overflow == 40_000);

    donation::transfer_donor_pass(pass, scenario.ctx());
    clock.destroy_for_testing();
    test_scenario::return_shared(camp);
    test_scenario::return_shared(main_pool);
    test_scenario::return_shared(ops_pool);
    test_scenario::return_shared(registry);
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
    let mut registry = scenario.take_shared<donation::DonorRegistry>();
    let mut pass = donation::issue_donor_pass(&mut registry, scenario.ctx());

    let donation_end = campaign::campaign_donation_end_ms(&camp);
    let after_end_ms = donation_end + 1;

    let coin = coin::mint_for_testing<USDC>(1_000_000, scenario.ctx());
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(after_end_ms);

    donation::donate_to_campaign(
        &registry,
        &mut pass,
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

    // pass records the full donated amount even when the campaign portion is redirected
    assert!(donation::donor_pass_total_donated_usdc(&pass) == 1_000_000);

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

    donation::transfer_donor_pass(pass, scenario.ctx());
    clock.destroy_for_testing();
    test_scenario::return_shared(camp);
    test_scenario::return_shared(main_pool);
    test_scenario::return_shared(ops_pool);
    test_scenario::return_shared(registry);
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
    let mut registry = scenario.take_shared<donation::DonorRegistry>();
    let mut pass = donation::issue_donor_pass(&mut registry, scenario.ctx());

    let coin = coin::mint_for_testing<USDC>(500_000, scenario.ctx());

    donation::donate_to_category(
        &registry,
        &mut pass,
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

    // donation is recorded in the pass with the full amount and category type
    assert!(donation::donor_pass_donation_count(&pass) == 1);
    assert!(donation::donor_pass_total_donated_usdc(&pass) == 500_000);
    let (_rec_idx, rec_type, _program_id, rec_campaign_id, _pool_id, rec_amount, _coin_type, _ts) =
        donation::donation_record_summary(&pass, 0);
    assert!(rec_type == donation::donation_type_category());
    assert!(rec_campaign_id.is_none());
    assert!(rec_amount == 500_000);

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

    donation::transfer_donor_pass(pass, scenario.ctx());
    test_scenario::return_shared(cat_pool);
    test_scenario::return_shared(main_pool);
    test_scenario::return_shared(ops_pool);
    test_scenario::return_shared(registry);
    scenario.end();
}

// ---------------------------------------------------------------
// 5. donate_general: splits 95/5
// ---------------------------------------------------------------

#[test]
fun donate_general_splits_95_5() {
    let (mut scenario, _campaign_id, _cat_pool_id, main_pool_id, ops_pool_id) =
        initialized_with_campaign();

    scenario.next_tx(DONOR);

    let mut main_pool = scenario.take_shared_by_id<pools::MainPool>(main_pool_id);
    let mut ops_pool = scenario.take_shared_by_id<pools::OperationsPool>(ops_pool_id);
    let mut registry = scenario.take_shared<donation::DonorRegistry>();
    let mut pass = donation::issue_donor_pass(&mut registry, scenario.ctx());

    let coin = coin::mint_for_testing<USDC>(1_000_000, scenario.ctx());

    donation::donate_general(
        &registry,
        &mut pass,
        &mut main_pool,
        &mut ops_pool,
        coin,
        scenario.ctx(),
    );

    // 950_000 to main (95%), 50_000 to ops (5%)
    assert!(pools::main_pool_balance_usdc(&main_pool) == 950_000);
    assert!(pools::operations_pool_balance_usdc(&ops_pool) == 50_000);

    // donation is recorded in the pass with the full amount and general type
    assert!(donation::donor_pass_donation_count(&pass) == 1);
    assert!(donation::donor_pass_total_donated_usdc(&pass) == 1_000_000);
    let (_rec_idx, rec_type, _program_id, rec_campaign_id, _pool_id, rec_amount, _coin_type, _ts) =
        donation::donation_record_summary(&pass, 0);
    assert!(rec_type == donation::donation_type_general());
    assert!(rec_campaign_id.is_none());
    assert!(rec_amount == 1_000_000);

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

    donation::transfer_donor_pass(pass, scenario.ctx());
    test_scenario::return_shared(main_pool);
    test_scenario::return_shared(ops_pool);
    test_scenario::return_shared(registry);
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
    let mut registry = scenario.take_shared<donation::DonorRegistry>();
    let mut pass = donation::issue_donor_pass(&mut registry, scenario.ctx());

    let coin = coin::mint_for_testing<USDC>(0, scenario.ctx());
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(NOW_MS);

    donation::donate_to_campaign(
        &registry,
        &mut pass,
        &mut camp,
        &mut main_pool,
        &mut ops_pool,
        coin,
        clock::timestamp_ms(&clock),
        scenario.ctx(),
    );

    donation::transfer_donor_pass(pass, scenario.ctx());
    clock.destroy_for_testing();
    test_scenario::return_shared(camp);
    test_scenario::return_shared(main_pool);
    test_scenario::return_shared(ops_pool);
    test_scenario::return_shared(registry);
    scenario.end();
}

// ---------------------------------------------------------------
// STEP 1: issue_donor_pass / transfer_donor_pass
// ---------------------------------------------------------------

fun initialized(): test_scenario::Scenario {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);
    scenario
}

#[test]
fun issue_donor_pass_returns_unissued_pass_and_emits_event() {
    let mut scenario = initialized();

    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();

        let pass = accessor::issue_donor_pass(&pause_state, &mut registry, scenario.ctx());

        assert!(donation::donor_pass_owner(&pass) == DONOR);
        assert!(donation::donor_pass_donation_count(&pass) == 0);
        assert!(donation::donor_pass_total_donated_usdc(&pass) == 0);
        assert!(donation::donor_pass_total_donated_usdc_display(&pass) == b"0".to_string());
        assert!(donation::donor_pass_tier(&pass) == donation::tier_none());

        let issued = event::events_by_type<donation::DonorPassIssued>();
        assert!(issued.length() == 1);

        accessor::transfer_donor_pass(pass, scenario.ctx());

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

#[test]
fun transfer_donor_pass_sends_pass_to_sender() {
    let mut scenario = initialized();

    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();
        let pass = accessor::issue_donor_pass(&pause_state, &mut registry, scenario.ctx());
        accessor::transfer_donor_pass(pass, scenario.ctx());
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
    };

    scenario.next_tx(DONOR);
    {
        let pass = scenario.take_from_sender<donation::DonorPass>();
        assert!(donation::donor_pass_owner(&pass) == DONOR);
        scenario.return_to_sender(pass);
    };

    scenario.end();
}

#[test]
#[expected_failure(abort_code = donation::EDonorPassAlreadyIssued)]
fun issue_donor_pass_twice_for_same_donor_aborts() {
    let mut scenario = initialized();

    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();
        let pass = accessor::issue_donor_pass(&pause_state, &mut registry, scenario.ctx());
        accessor::transfer_donor_pass(pass, scenario.ctx());
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
    };

    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();
        let pass = accessor::issue_donor_pass(&pause_state, &mut registry, scenario.ctx());
        accessor::transfer_donor_pass(pass, scenario.ctx());
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
    };

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
    let mut registry = scenario.take_shared<donation::DonorRegistry>();
    let mut pass = donation::issue_donor_pass(&mut registry, scenario.ctx());

    // Donate 1 unit: primary = floor(1 * 9000 / 10000) = 0, ops = floor(1 * 500 / 10000) = 0, main = 1
    let coin = coin::mint_for_testing<USDC>(1, scenario.ctx());
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(NOW_MS);

    donation::donate_to_campaign(
        &registry,
        &mut pass,
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

    // pass records the full 1 unit even when split rounds everything to main
    assert!(donation::donor_pass_total_donated_usdc(&pass) == 1);

    donation::transfer_donor_pass(pass, scenario.ctx());
    clock.destroy_for_testing();
    test_scenario::return_shared(camp);
    test_scenario::return_shared(main_pool);
    test_scenario::return_shared(ops_pool);
    test_scenario::return_shared(registry);
    scenario.end();
}

#[test]
fun donor_pass_tracks_display_total_separately_from_raw_units() {
    let (mut scenario, _campaign_id, _cat_pool_id, main_pool_id, ops_pool_id) =
        initialized_with_campaign();

    scenario.next_tx(DONOR);

    let mut main_pool = scenario.take_shared_by_id<pools::MainPool>(main_pool_id);
    let mut ops_pool = scenario.take_shared_by_id<pools::OperationsPool>(ops_pool_id);
    let mut registry = scenario.take_shared<donation::DonorRegistry>();
    let mut pass = donation::issue_donor_pass(&mut registry, scenario.ctx());

    assert_display_after_general_donation(
        &registry,
        &mut pass,
        &mut main_pool,
        &mut ops_pool,
        1,
        b"0.000001".to_string(),
        scenario.ctx(),
    );
    assert_display_after_general_donation(
        &registry,
        &mut pass,
        &mut main_pool,
        &mut ops_pool,
        999_999,
        b"1".to_string(),
        scenario.ctx(),
    );
    assert_display_after_general_donation(
        &registry,
        &mut pass,
        &mut main_pool,
        &mut ops_pool,
        4_000_000,
        b"5".to_string(),
        scenario.ctx(),
    );
    assert_display_after_general_donation(
        &registry,
        &mut pass,
        &mut main_pool,
        &mut ops_pool,
        1,
        b"5.000001".to_string(),
        scenario.ctx(),
    );
    assert_display_after_general_donation(
        &registry,
        &mut pass,
        &mut main_pool,
        &mut ops_pool,
        9_999,
        b"5.01".to_string(),
        scenario.ctx(),
    );

    assert!(donation::donor_pass_total_donated_usdc(&pass) == 5_010_000);
    let (_rec_idx, _rec_type, _program_id, _campaign_id, rec_amount, _coin_type, _ts) =
        donation::donation_record_fields_for_testing(&pass, 4);
    assert!(rec_amount == 9_999);

    let recorded = event::events_by_type<donation::DonationRecorded>();
    let (_pass_id, _idx, _typ, _pool_id, event_amount, _coin_type, _actor) =
        donation::donation_recorded_event_fields(*recorded.borrow(4));
    assert!(event_amount == 9_999);

    donation::transfer_donor_pass(pass, scenario.ctx());
    test_scenario::return_shared(main_pool);
    test_scenario::return_shared(ops_pool);
    test_scenario::return_shared(registry);
    scenario.end();
}

fun assert_display_after_general_donation(
    registry: &donation::DonorRegistry,
    pass: &mut donation::DonorPass,
    main_pool: &mut pools::MainPool,
    ops_pool: &mut pools::OperationsPool,
    amount: u64,
    expected_display: std::string::String,
    ctx: &mut TxContext,
) {
    let coin = coin::mint_for_testing<USDC>(amount, ctx);
    donation::donate_general(registry, pass, main_pool, ops_pool, coin, ctx);
    assert!(donation::donor_pass_total_donated_usdc_display(pass) == expected_display);
}
