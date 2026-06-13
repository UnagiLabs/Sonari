#[test_only]
module contracts::pool_donation_tests;

use contracts::accessor;
use contracts::admin;
use contracts::donation;
use contracts::pools;
use contracts::reader;
use sui::coin;
use sui::event;
use sui::test_scenario;
use usdc::usdc::USDC;

const ADMIN: address = @0xA11CE;
const DONOR: address = @0xD0A0;
const OTHER_DONOR: address = @0xD0B0;

#[test]
fun init_creates_singleton_pools() {
    let mut scenario = initialized();

    scenario.next_tx(ADMIN);
    assert!(test_scenario::has_most_recent_shared<pools::MainPool>());
    assert!(test_scenario::has_most_recent_shared<pools::OperationsPool>());

    scenario.end();
}

#[test]
fun general_donation_splits_main_ops_and_records_pass() {
    let mut scenario = initialized_with_pools();

    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let mut ops_pool = scenario.take_shared<pools::OperationsPool>();

        let mut pass = accessor::issue_donor_pass(&pause_state, &mut registry, scenario.ctx());
        let coin = coin::mint_for_testing<USDC>(1_000_000, scenario.ctx());

        accessor::donate_general(
            &pause_state,
            &registry,
            &mut pass,
            &mut main_pool,
            &mut ops_pool,
            coin,
            scenario.ctx(),
        );

        // 95% to main, 5% to ops
        assert!(pools::main_pool_balance_usdc(&main_pool) == 950_000);
        assert!(pools::operations_pool_balance_usdc(&ops_pool) == 50_000);

        // the full amount is recorded in the pass
        assert!(donation::donor_pass_owner(&pass) == DONOR);
        assert!(donation::donor_pass_donation_count(&pass) == 1);
        assert!(donation::donor_pass_total_donated_usdc(&pass) == 1_000_000);
        assert!(donation::donor_pass_tier(&pass) == donation::tier_silver());

        let (_idx, dtype, _program_id, _campaign_id, _pool_id, amount, coin_type, _ts) =
            reader::donation_record_summary(&pass, 0);
        assert!(dtype == donation::donation_type_general());
        assert!(amount == 1_000_000);
        assert!(coin_type == donation::coin_type_usdc());

        let pass_events = event::events_by_type<donation::DonorPassIssued>();
        assert!(pass_events.length() == 1);
        let recorded_events = event::events_by_type<donation::DonationRecorded>();
        assert!(recorded_events.length() == 1);
        let split_events = event::events_by_type<donation::DonationSplit>();
        assert!(split_events.length() == 1);

        accessor::transfer_donor_pass(pass, scenario.ctx());
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(ops_pool);
    };

    // the pass is soulbound-transferred to the donor
    scenario.next_tx(DONOR);
    {
        let pass = scenario.take_from_sender<donation::DonorPass>();
        assert!(donation::donor_pass_owner(&pass) == DONOR);
        scenario.return_to_sender(pass);
    };

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
        let mut ops_pool = scenario.take_shared<pools::OperationsPool>();

        let mut pass = accessor::issue_donor_pass(&pause_state, &mut registry, scenario.ctx());
        let coin = coin::mint_for_testing<USDC>(0, scenario.ctx());

        accessor::donate_general(
            &pause_state,
            &registry,
            &mut pass,
            &mut main_pool,
            &mut ops_pool,
            coin,
            scenario.ctx(),
        );

        accessor::transfer_donor_pass(pass, scenario.ctx());
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(ops_pool);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = admin::EGlobalPaused)]
fun global_pause_blocks_donation() {
    let mut scenario = initialized_with_pools();

    // issue a pass before pausing so the donation reaches the pause check
    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();
        let pass = accessor::issue_donor_pass(&pause_state, &mut registry, scenario.ctx());
        accessor::transfer_donor_pass(pass, scenario.ctx());
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
    };

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
        let registry = scenario.take_shared<donation::DonorRegistry>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let mut ops_pool = scenario.take_shared<pools::OperationsPool>();
        let mut pass = scenario.take_from_sender<donation::DonorPass>();
        let coin = coin::mint_for_testing<USDC>(1, scenario.ctx());

        accessor::donate_general(
            &pause_state,
            &registry,
            &mut pass,
            &mut main_pool,
            &mut ops_pool,
            coin,
            scenario.ctx(),
        );

        scenario.return_to_sender(pass);
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(ops_pool);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = admin::ETargetPaused)]
fun target_pause_blocks_pool_donation() {
    let mut scenario = initialized_with_pools();
    let main_pool_id = main_pool_id(&mut scenario);

    // issue a pass before pausing so the donation reaches the pause check
    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();
        let pass = accessor::issue_donor_pass(&pause_state, &mut registry, scenario.ctx());
        accessor::transfer_donor_pass(pass, scenario.ctx());
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
    };

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
        let registry = scenario.take_shared<donation::DonorRegistry>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let mut ops_pool = scenario.take_shared<pools::OperationsPool>();
        let mut pass = scenario.take_from_sender<donation::DonorPass>();
        let coin = coin::mint_for_testing<USDC>(1, scenario.ctx());

        accessor::donate_general(
            &pause_state,
            &registry,
            &mut pass,
            &mut main_pool,
            &mut ops_pool,
            coin,
            scenario.ctx(),
        );

        scenario.return_to_sender(pass);
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(ops_pool);
    };

    scenario.end();
}

#[test]
fun second_donation_appends_record_without_new_issue_event() {
    let mut scenario = initialized_with_pools();

    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let mut ops_pool = scenario.take_shared<pools::OperationsPool>();

        let mut pass = accessor::issue_donor_pass(&pause_state, &mut registry, scenario.ctx());

        let coin1 = coin::mint_for_testing<USDC>(1, scenario.ctx());
        accessor::donate_general(
            &pause_state,
            &registry,
            &mut pass,
            &mut main_pool,
            &mut ops_pool,
            coin1,
            scenario.ctx(),
        );

        let coin2 = coin::mint_for_testing<USDC>(999_999, scenario.ctx());
        accessor::donate_general(
            &pause_state,
            &registry,
            &mut pass,
            &mut main_pool,
            &mut ops_pool,
            coin2,
            scenario.ctx(),
        );

        // both donations are recorded on the same pass
        assert!(donation::donor_pass_donation_count(&pass) == 2);
        assert!(donation::donor_pass_total_donated_usdc(&pass) == 1_000_000);

        let (donation_index, donation_type, _, _, _, amount, coin_type, _) =
            reader::donation_record_summary(&pass, 1);
        assert!(donation_index == 1);
        assert!(donation_type == donation::donation_type_general());
        assert!(amount == 999_999);
        assert!(coin_type == donation::coin_type_usdc());

        // the pass is issued only once
        let pass_events = event::events_by_type<donation::DonorPassIssued>();
        assert!(pass_events.length() == 1);
        let recorded_events = event::events_by_type<donation::DonationRecorded>();
        assert!(recorded_events.length() == 2);

        accessor::transfer_donor_pass(pass, scenario.ctx());
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(ops_pool);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = donation::EDonorPassOwnerMismatch)]
fun donate_general_rejects_owner_mismatch() {
    let mut scenario = initialized_with_pools();

    // DONOR issues a registered pass
    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();
        let pass = accessor::issue_donor_pass(&pause_state, &mut registry, scenario.ctx());
        accessor::transfer_donor_pass(pass, scenario.ctx());
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
    };

    // OTHER_DONOR tries to donate with DONOR's pass
    scenario.next_tx(OTHER_DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let registry = scenario.take_shared<donation::DonorRegistry>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let mut ops_pool = scenario.take_shared<pools::OperationsPool>();
        let mut pass = test_scenario::take_from_address<donation::DonorPass>(&scenario, DONOR);
        let coin = coin::mint_for_testing<USDC>(1, scenario.ctx());

        accessor::donate_general(
            &pause_state,
            &registry,
            &mut pass,
            &mut main_pool,
            &mut ops_pool,
            coin,
            scenario.ctx(),
        );

        test_scenario::return_to_address(DONOR, pass);
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(ops_pool);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = donation::EDonorPassAlreadyIssued)]
fun donor_cannot_issue_second_pass() {
    let mut scenario = initialized_with_pools();

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

fun initialized(): test_scenario::Scenario {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);
    scenario
}

fun initialized_with_pools(): test_scenario::Scenario {
    initialized()
}

fun main_pool_id(scenario: &mut test_scenario::Scenario): object::ID {
    scenario.next_tx(ADMIN);
    let main_pool = scenario.take_shared<pools::MainPool>();
    let main_pool_id = pools::main_pool_id(&main_pool);
    test_scenario::return_shared(main_pool);
    main_pool_id
}
