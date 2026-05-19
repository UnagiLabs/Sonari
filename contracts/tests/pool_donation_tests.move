#[test_only]
module contracts::pool_donation_tests;

use contracts::admin;
use contracts::donation;
use contracts::mock_usdc;
use contracts::pools;
use std::option;
use sui::event;
use sui::object;
use sui::test_scenario;

const ADMIN: address = @0xA11CE;
const DONOR: address = @0xD0A0;
const OTHER_DONOR: address = @0xD0B0;

#[test]
fun admin_can_create_usdc_pools() {
    let mut scenario = initialized();

    let cap = scenario.take_from_sender<admin::AdminCap>();
    pools::create_main_pool(&cap, scenario.ctx());
    scenario.return_to_sender(cap);
    let pool_events = event::events_by_type<pools::PoolCreated>();
    assert!(pool_events.length() == 1);
    let (event_pool_id, pool_kind, related_id, created_at_ms, actor) =
        pools::pool_created_event_fields(*pool_events.borrow(0));
    assert!(pool_kind == pools::pool_kind_main());
    assert!(related_id.is_none());
    assert!(created_at_ms == 0);
    assert!(actor == ADMIN);

    scenario.next_tx(ADMIN);
    let main_pool = scenario.take_shared<pools::MainPool>();
    let main_pool_id = pools::main_pool_id(&main_pool);
    assert!(event_pool_id == main_pool_id);
    test_scenario::return_shared(main_pool);

    scenario.next_tx(ADMIN);
    let cap = scenario.take_from_sender<admin::AdminCap>();
    pools::create_designated_pool(&cap, option::some(main_pool_id), scenario.ctx());
    scenario.return_to_sender(cap);
    let pool_events = event::events_by_type<pools::PoolCreated>();
    assert!(pool_events.length() == 1);
    let (event_pool_id, pool_kind, related_id, created_at_ms, actor) =
        pools::pool_created_event_fields(*pool_events.borrow(0));
    assert!(pool_kind == pools::pool_kind_designated());
    assert!(related_id.destroy_some() == main_pool_id);
    assert!(created_at_ms == 0);
    assert!(actor == ADMIN);

    scenario.next_tx(ADMIN);
    let designated_pool = scenario.take_shared<pools::DesignatedPool>();
    let designated_pool_id = pools::designated_pool_id(&designated_pool);
    assert!(event_pool_id == designated_pool_id);
    test_scenario::return_shared(designated_pool);

    scenario.next_tx(ADMIN);
    let cap = scenario.take_from_sender<admin::AdminCap>();
    pools::create_operations_pool(&cap, scenario.ctx());
    scenario.return_to_sender(cap);
    let pool_events = event::events_by_type<pools::PoolCreated>();
    assert!(pool_events.length() == 1);
    let (event_pool_id, pool_kind, related_id, created_at_ms, actor) =
        pools::pool_created_event_fields(*pool_events.borrow(0));
    assert!(pool_kind == pools::pool_kind_operations());
    assert!(related_id.is_none());
    assert!(created_at_ms == 0);
    assert!(actor == ADMIN);

    scenario.next_tx(ADMIN);
    let operations_pool = scenario.take_shared<pools::OperationsPool>();
    let operations_pool_id = pools::operations_pool_id(&operations_pool);
    assert!(event_pool_id == operations_pool_id);
    test_scenario::return_shared(operations_pool);

    scenario.end();
}

#[test]
fun general_donation_moves_all_usdc_to_main_pool_and_mints_donor_pass() {
    let mut scenario = initialized_with_pools();

    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let coin = mock_usdc::mint_for_testing(1_000_000, scenario.ctx());

        donation::donate_general_usdc(
            &pause_state,
            &mut registry,
            &mut main_pool,
            coin,
            scenario.ctx(),
        );

        assert!(pools::main_pool_balance_usdc(&main_pool) == 1_000_000);
        assert!(pools::main_pool_total_received_usdc(&main_pool) == 1_000_000);

        let donation_events = event::events_by_type<donation::GeneralDonationReceived>();
        assert!(donation_events.length() == 1);
        let (pool_id, amount, actor) =
            donation::general_donation_received_event_fields(*donation_events.borrow(0));
        assert!(amount == 1_000_000);
        assert!(actor == DONOR);

        let recorded_events = event::events_by_type<donation::DonationRecorded>();
        assert!(recorded_events.length() == 1);
        let (_, donation_index, donation_type, record_pool_id, record_amount, coin_type, actor) =
            donation::donation_recorded_event_fields(*recorded_events.borrow(0));
        assert!(donation_index == 0);
        assert!(donation_type == donation::donation_type_general());
        assert!(record_pool_id == pool_id);
        assert!(record_amount == 1_000_000);
        assert!(coin_type == donation::coin_type_usdc());
        assert!(actor == DONOR);

        let pass_events = event::events_by_type<donation::DonorPassIssued>();
        assert!(pass_events.length() == 1);

        let tier_events = event::events_by_type<donation::DonorTierUpdated>();
        assert!(tier_events.length() == 1);
        let (_, old_tier, new_tier, total_donated, actor) =
            donation::donor_tier_updated_event_fields(*tier_events.borrow(0));
        assert!(old_tier == donation::tier_none());
        assert!(new_tier == donation::tier_silver());
        assert!(total_donated == 1_000_000);
        assert!(actor == DONOR);

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(main_pool);
    };

    scenario.next_tx(DONOR);
    {
        let pass = scenario.take_from_sender<donation::DonorPass>();
        assert!(donation::donor_pass_owner(&pass) == DONOR);
        assert!(donation::donor_pass_total_donated_usdc(&pass) == 1_000_000);
        assert!(donation::donor_pass_donation_count(&pass) == 1);
        assert!(donation::donor_pass_tier(&pass) == donation::tier_silver());
        scenario.return_to_sender(pass);
    };

    scenario.end();
}

#[test]
fun designated_donation_splits_usdc_and_sends_odd_remainder_to_designated_pool() {
    let mut scenario = initialized_with_pools();

    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let mut designated_pool = scenario.take_shared<pools::DesignatedPool>();
        let coin = mock_usdc::mint_for_testing(5, scenario.ctx());

        donation::donate_designated_usdc(
            &pause_state,
            &mut registry,
            &mut main_pool,
            &mut designated_pool,
            coin,
            scenario.ctx(),
        );

        assert!(pools::main_pool_balance_usdc(&main_pool) == 2);
        assert!(pools::main_pool_total_received_usdc(&main_pool) == 2);
        assert!(pools::designated_pool_balance_usdc(&designated_pool) == 3);
        assert!(pools::designated_pool_total_received_usdc(&designated_pool) == 3);

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(designated_pool);
    };

    let donation_events = event::events_by_type<donation::DesignatedDonationReceived>();
    assert!(donation_events.length() == 1);
    let (_, _, amount, main_amount, designated_amount, actor) =
        donation::designated_donation_received_event_fields(*donation_events.borrow(0));
    assert!(amount == 5);
    assert!(main_amount == 2);
    assert!(designated_amount == 3);
    assert!(actor == DONOR);

    scenario.end();
}

#[test]
fun operations_donation_moves_all_usdc_to_operations_pool() {
    let mut scenario = initialized_with_pools();

    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();
        let mut operations_pool = scenario.take_shared<pools::OperationsPool>();
        let coin = mock_usdc::mint_for_testing(250_000, scenario.ctx());

        donation::donate_operations_usdc(
            &pause_state,
            &mut registry,
            &mut operations_pool,
            coin,
            scenario.ctx(),
        );

        assert!(pools::operations_pool_balance_usdc(&operations_pool) == 250_000);
        assert!(pools::operations_pool_total_received_usdc(&operations_pool) == 250_000);

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(operations_pool);
    };

    let donation_events = event::events_by_type<donation::OperationsDonationReceived>();
    assert!(donation_events.length() == 1);
    let (_, amount, actor) =
        donation::operations_donation_received_event_fields(*donation_events.borrow(0));
    assert!(amount == 250_000);
    assert!(actor == DONOR);

    scenario.end();
}

#[test, expected_failure(abort_code = donation::EZeroDonation)]
fun zero_amount_donation_is_rejected() {
    let mut scenario = initialized_with_pools();

    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let coin = mock_usdc::mint_for_testing(0, scenario.ctx());

        donation::donate_general_usdc(
            &pause_state,
            &mut registry,
            &mut main_pool,
            coin,
            scenario.ctx(),
        );

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(main_pool);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = admin::EGlobalPaused)]
fun global_pause_blocks_donation() {
    let mut scenario = initialized_with_pools();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pause_state = scenario.take_shared<admin::PauseState>();
        admin::pause_global(&cap, &mut pause_state, scenario.ctx());
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
    };

    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let coin = mock_usdc::mint_for_testing(1, scenario.ctx());

        donation::donate_general_usdc(
            &pause_state,
            &mut registry,
            &mut main_pool,
            coin,
            scenario.ctx(),
        );

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(main_pool);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = admin::ETargetPaused)]
fun target_pause_blocks_pool_donation() {
    let mut scenario = initialized_with_pools();
    let main_pool_id = main_pool_id(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pause_state = scenario.take_shared<admin::PauseState>();
        admin::pause_target(
            &cap,
            &mut pause_state,
            pools::target_kind_main_pool(),
            main_pool_id,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
    };

    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let coin = mock_usdc::mint_for_testing(1, scenario.ctx());

        donation::donate_general_usdc(
            &pause_state,
            &mut registry,
            &mut main_pool,
            coin,
            scenario.ctx(),
        );

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(main_pool);
    };

    scenario.end();
}

#[test]
fun second_donation_updates_existing_pass_and_appends_record_without_new_issue_event() {
    let mut scenario = initialized_with_pools();

    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let coin = mock_usdc::mint_for_testing(1, scenario.ctx());

        donation::donate_general_usdc(
            &pause_state,
            &mut registry,
            &mut main_pool,
            coin,
            scenario.ctx(),
        );

        let tier_events = event::events_by_type<donation::DonorTierUpdated>();
        assert!(tier_events.length() == 1);

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(main_pool);
    };

    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let registry = scenario.take_shared<donation::DonorRegistry>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let mut pass = scenario.take_from_sender<donation::DonorPass>();
        let coin = mock_usdc::mint_for_testing(999_999, scenario.ctx());

        donation::donate_general_usdc_with_pass(
            &pause_state,
            &registry,
            &mut main_pool,
            &mut pass,
            coin,
            scenario.ctx(),
        );

        assert!(donation::donor_pass_total_donated_usdc(&pass) == 1_000_000);
        assert!(donation::donor_pass_donation_count(&pass) == 2);
        assert!(donation::donor_pass_tier(&pass) == donation::tier_silver());

        let (donation_index, donation_type, _, _, amount, coin_type, _) =
            donation::donation_record_fields_for_testing(&pass, 1);
        assert!(donation_index == 1);
        assert!(donation_type == donation::donation_type_general());
        assert!(amount == 999_999);
        assert!(coin_type == donation::coin_type_usdc());

        let pass_events = event::events_by_type<donation::DonorPassIssued>();
        assert!(pass_events.length() == 0);
        let recorded_events = event::events_by_type<donation::DonationRecorded>();
        assert!(recorded_events.length() == 1);
        let tier_events = event::events_by_type<donation::DonorTierUpdated>();
        assert!(tier_events.length() == 1);

        scenario.return_to_sender(pass);
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(main_pool);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = donation::EDonorPassAlreadyIssued)]
fun donor_cannot_mint_second_pass_by_reusing_first_donation_entry() {
    let mut scenario = initialized_with_pools();

    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let coin = mock_usdc::mint_for_testing(1, scenario.ctx());

        donation::donate_general_usdc(
            &pause_state,
            &mut registry,
            &mut main_pool,
            coin,
            scenario.ctx(),
        );

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(main_pool);
    };

    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let coin = mock_usdc::mint_for_testing(1, scenario.ctx());

        donation::donate_general_usdc(
            &pause_state,
            &mut registry,
            &mut main_pool,
            coin,
            scenario.ctx(),
        );

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(main_pool);
    };

    scenario.end();
}

#[test]
fun tier_update_event_is_emitted_only_when_tier_changes() {
    let mut scenario = initialized_with_pools();

    scenario.next_tx(OTHER_DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let coin = mock_usdc::mint_for_testing(1, scenario.ctx());

        donation::donate_general_usdc(
            &pause_state,
            &mut registry,
            &mut main_pool,
            coin,
            scenario.ctx(),
        );

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(main_pool);
    };

    scenario.next_tx(OTHER_DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let registry = scenario.take_shared<donation::DonorRegistry>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let mut pass = scenario.take_from_sender<donation::DonorPass>();
        let coin = mock_usdc::mint_for_testing(99, scenario.ctx());

        donation::donate_general_usdc_with_pass(
            &pause_state,
            &registry,
            &mut main_pool,
            &mut pass,
            coin,
            scenario.ctx(),
        );

        assert!(donation::donor_pass_tier(&pass) == donation::tier_bronze());

        let tier_events = event::events_by_type<donation::DonorTierUpdated>();
        assert!(tier_events.length() == 0);

        scenario.return_to_sender(pass);
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(main_pool);
    };

    scenario.end();
}

fun initialized(): test_scenario::Scenario {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);
    scenario
}

fun initialized_with_pools(): test_scenario::Scenario {
    let mut scenario = initialized();
    create_donor_registry(&mut scenario);
    create_all_pools(&mut scenario);
    scenario
}

fun create_donor_registry(scenario: &mut test_scenario::Scenario) {
    let cap = scenario.take_from_sender<admin::AdminCap>();
    donation::create_donor_registry(&cap, scenario.ctx());
    scenario.return_to_sender(cap);

    scenario.next_tx(ADMIN);
}

fun create_all_pools(
    scenario: &mut test_scenario::Scenario,
): (object::ID, object::ID, object::ID) {
    let cap = scenario.take_from_sender<admin::AdminCap>();
    pools::create_main_pool(&cap, scenario.ctx());
    scenario.return_to_sender(cap);

    scenario.next_tx(ADMIN);
    let main_pool = scenario.take_shared<pools::MainPool>();
    let main_pool_id = pools::main_pool_id(&main_pool);
    test_scenario::return_shared(main_pool);

    scenario.next_tx(ADMIN);
    let cap = scenario.take_from_sender<admin::AdminCap>();
    pools::create_designated_pool(&cap, option::some(main_pool_id), scenario.ctx());
    scenario.return_to_sender(cap);

    scenario.next_tx(ADMIN);
    let designated_pool = scenario.take_shared<pools::DesignatedPool>();
    let designated_pool_id = pools::designated_pool_id(&designated_pool);
    test_scenario::return_shared(designated_pool);

    scenario.next_tx(ADMIN);
    let cap = scenario.take_from_sender<admin::AdminCap>();
    pools::create_operations_pool(&cap, scenario.ctx());
    scenario.return_to_sender(cap);

    scenario.next_tx(ADMIN);
    let operations_pool = scenario.take_shared<pools::OperationsPool>();
    let operations_pool_id = pools::operations_pool_id(&operations_pool);
    test_scenario::return_shared(operations_pool);

    (main_pool_id, designated_pool_id, operations_pool_id)
}

fun main_pool_id(scenario: &mut test_scenario::Scenario): object::ID {
    scenario.next_tx(ADMIN);
    let main_pool = scenario.take_shared<pools::MainPool>();
    let main_pool_id = pools::main_pool_id(&main_pool);
    test_scenario::return_shared(main_pool);
    main_pool_id
}
