#[test_only]
module contracts::admin_program_tests;

use contracts::admin;
use contracts::claim;
use contracts::disaster_event;
use contracts::donation;
use contracts::identity_registry;
use contracts::membership;
use contracts::metadata_verifier;
use contracts::payout_policy;
use contracts::pools;
use contracts::program;
use sui::event;
use sui::test_scenario;

const ADMIN: address = @0xA11CE;
const NON_ADMIN: address = @0xB0B;

#[test]
fun init_creates_genesis_objects_and_tracking_events() {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());

    let pool_events = event::events_by_type<pools::PoolCreated>();
    assert!(pool_events.length() == 2);
    let (main_pool_id_from_event, main_pool_kind, _, _, _) =
        pools::pool_created_event_fields(*pool_events.borrow(0));
    let (operations_pool_id_from_event, operations_pool_kind, _, _, _) =
        pools::pool_created_event_fields(*pool_events.borrow(1));
    assert!(main_pool_kind == pools::pool_kind_main());
    assert!(operations_pool_kind == pools::pool_kind_operations());

    let donor_events = event::events_by_type<donation::RegistryCreated>();
    assert!(donor_events.length() == 1);
    let (donor_registry_id_from_event, donor_registry_kind, _, _) =
        donation::registry_created_event_fields(*donor_events.borrow(0));
    assert!(donor_registry_kind == donation::registry_kind_donor());

    let membership_events = event::events_by_type<membership::RegistryCreated>();
    assert!(membership_events.length() == 1);
    let (membership_registry_id_from_event, membership_registry_kind, _, _) =
        membership::registry_created_event_fields(*membership_events.borrow(0));
    assert!(membership_registry_kind == membership::registry_kind_membership());

    let verifier_events = event::events_by_type<metadata_verifier::RegistryCreated>();
    assert!(verifier_events.length() == 1);
    let (verifier_registry_id_from_event, verifier_registry_kind, _, _) =
        metadata_verifier::registry_created_event_fields(*verifier_events.borrow(0));
    assert!(verifier_registry_kind == metadata_verifier::registry_kind_verifier());

    let identity_events = event::events_by_type<identity_registry::RegistryCreated>();
    assert!(identity_events.length() == 1);
    let (identity_registry_id_from_event, identity_registry_kind, _, _) =
        identity_registry::registry_created_event_fields(*identity_events.borrow(0));
    assert!(identity_registry_kind == identity_registry::registry_kind_identity());

    let genesis_events = event::events_by_type<admin::GenesisObjectCreated>();
    assert!(genesis_events.length() == 9);
    let (_, claim_index_kind, claim_index_shared, _, _) =
        admin::genesis_object_created_event_fields(*genesis_events.borrow(7));
    assert!(claim_index_kind == admin::genesis_kind_claim_index());
    assert!(claim_index_shared);
    let (_, identity_registry_kind, identity_registry_shared, _, _) =
        admin::genesis_object_created_event_fields(*genesis_events.borrow(8));
    assert!(identity_registry_kind == admin::genesis_kind_identity_registry());
    assert!(identity_registry_shared);

    scenario.next_tx(ADMIN);
    {
        assert!(scenario.has_most_recent_for_sender<admin::AdminCap>());
        assert!(test_scenario::has_most_recent_shared<admin::PauseState>());
        assert!(test_scenario::has_most_recent_shared<pools::MainPool>());
        assert!(test_scenario::has_most_recent_shared<pools::OperationsPool>());
        assert!(test_scenario::has_most_recent_shared<donation::DonorRegistry>());
        assert!(test_scenario::has_most_recent_shared<membership::MembershipRegistry>());
        assert!(test_scenario::has_most_recent_shared<metadata_verifier::VerifierRegistry>());
        assert!(test_scenario::has_most_recent_shared<claim::ClaimIndex>());
        assert!(test_scenario::has_most_recent_shared<identity_registry::IdentityRegistry>());

        let cap = scenario.take_from_sender<admin::AdminCap>();
        let pause_state = scenario.take_shared<admin::PauseState>();
        let main_pool = scenario.take_shared<pools::MainPool>();
        let operations_pool = scenario.take_shared<pools::OperationsPool>();
        let donor_registry = scenario.take_shared<donation::DonorRegistry>();
        let membership_registry = scenario.take_shared<membership::MembershipRegistry>();
        let verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        let claim_index = scenario.take_shared<claim::ClaimIndex>();
        let identity_registry = scenario.take_shared<identity_registry::IdentityRegistry>();

        assert!(!admin::is_global_paused(&pause_state));
        assert!(admin::paused_target_count(&pause_state) == 0);

        assert!(main_pool_id_from_event == pools::main_pool_id(&main_pool));
        assert!(operations_pool_id_from_event == pools::operations_pool_id(&operations_pool));
        assert!(donor_registry_id_from_event == donation::registry_id(&donor_registry));
        assert!(membership_registry_id_from_event == membership::registry_id(&membership_registry));
        assert!(
            verifier_registry_id_from_event == metadata_verifier::registry_id(&verifier_registry),
        );
        assert!(
            identity_registry_id_from_event == identity_registry::registry_id(&identity_registry),
        );

        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(operations_pool);
        test_scenario::return_shared(donor_registry);
        test_scenario::return_shared(membership_registry);
        test_scenario::return_shared(verifier_registry);
        test_scenario::return_shared(claim_index);
        test_scenario::return_shared(identity_registry);
    };

    scenario.end();
}

#[test]
fun non_admin_cannot_access_admin_cap_required_for_admin_entries() {
    // create_program / create_campaign / pause_* all require &AdminCap.
    // Direct calls without &AdminCap are rejected at compile time, so this
    // fixes the runtime boundary that NON_ADMIN cannot obtain ADMIN's cap.
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());

    scenario.next_tx(NON_ADMIN);
    assert!(!scenario.has_most_recent_for_sender<admin::AdminCap>());

    scenario.end();
}

#[test]
fun admin_wrappers_create_transaction_reachable_setup_objects() {
    let mut scenario = initialized();

    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        admin::create_designated_pool(&cap, option::none(), scenario.ctx());
        admin::create_program(
            &cap,
            7,
            0xFF,
            3,
            option::none(),
            option::none(),
            scenario.ctx(),
        );
        admin::create_default_disaster_policy(&cap, scenario.ctx());
        admin::create_disaster_registry(&cap, scenario.ctx());
        scenario.return_to_sender(cap);
    };
    let pool_events = event::events_by_type<pools::PoolCreated>();
    let (designated_pool_id, designated_pool_kind, _, _, _) =
        pools::pool_created_event_fields(*pool_events.borrow(pool_events.length() - 1));
    assert!(designated_pool_kind == pools::pool_kind_designated());

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let program = scenario.take_shared<program::Program>();
        admin::create_campaign(
            &cap,
            &program,
            9,
            b"metadata-hash",
            option::some(designated_pool_id),
            100,
            200,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(program);
    };

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let program = scenario.take_shared<program::Program>();
        let mut campaign = scenario.take_shared<program::Campaign>();
        let main_pool = scenario.take_shared<pools::MainPool>();
        let designated_pool = scenario.take_shared<pools::DesignatedPool>();
        admin::open_campaign_budget_from_designated_and_main(
            &cap,
            &program,
            &mut campaign,
            &designated_pool,
            &main_pool,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(program);
        test_scenario::return_shared(campaign);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(designated_pool);
    };

    scenario.next_tx(ADMIN);
    {
        let policy = scenario.take_shared<payout_policy::PayoutPolicy>();
        let index = scenario.take_shared<claim::ClaimIndex>();
        let registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let budget = scenario.take_shared<payout_policy::CampaignBudget>();
        test_scenario::return_shared(policy);
        test_scenario::return_shared(index);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(budget);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = program::ECampaignBudgetAlreadyOpened)]
fun campaign_budget_cannot_be_opened_twice_from_designated_and_main() {
    let mut scenario = initialized();
    create_program_campaign_and_designated_pool(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let program = scenario.take_shared<program::Program>();
        let mut campaign = scenario.take_shared<program::Campaign>();
        let main_pool = scenario.take_shared<pools::MainPool>();
        let designated_pool = scenario.take_shared<pools::DesignatedPool>();
        payout_policy::open_campaign_budget_from_designated_and_main(
            &program,
            &mut campaign,
            &designated_pool,
            &main_pool,
            scenario.ctx(),
        );
        test_scenario::return_shared(program);
        test_scenario::return_shared(campaign);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(designated_pool);
    };

    scenario.next_tx(ADMIN);
    {
        let program = scenario.take_shared<program::Program>();
        let mut campaign = scenario.take_shared<program::Campaign>();
        let main_pool = scenario.take_shared<pools::MainPool>();
        let designated_pool = scenario.take_shared<pools::DesignatedPool>();
        payout_policy::open_campaign_budget_from_designated_and_main(
            &program,
            &mut campaign,
            &designated_pool,
            &main_pool,
            scenario.ctx(),
        );
        test_scenario::return_shared(program);
        test_scenario::return_shared(campaign);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(designated_pool);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = program::ECampaignBudgetAlreadyOpened)]
fun main_only_campaign_budget_cannot_be_opened_twice() {
    let mut scenario = initialized();
    create_program_and_campaign(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let program = scenario.take_shared<program::Program>();
        let mut campaign = scenario.take_shared<program::Campaign>();
        let main_pool = scenario.take_shared<pools::MainPool>();
        payout_policy::open_campaign_budget_from_main(
            &program,
            &mut campaign,
            &main_pool,
            scenario.ctx(),
        );
        test_scenario::return_shared(program);
        test_scenario::return_shared(campaign);
        test_scenario::return_shared(main_pool);
    };

    scenario.next_tx(ADMIN);
    {
        let program = scenario.take_shared<program::Program>();
        let mut campaign = scenario.take_shared<program::Campaign>();
        let main_pool = scenario.take_shared<pools::MainPool>();
        payout_policy::open_campaign_budget_from_main(
            &program,
            &mut campaign,
            &main_pool,
            scenario.ctx(),
        );
        test_scenario::return_shared(program);
        test_scenario::return_shared(campaign);
        test_scenario::return_shared(main_pool);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = program::ECampaignPoolMismatch)]
fun campaign_budget_rejects_wrong_campaign_designated_pool() {
    let mut scenario = initialized();
    let (campaign_pool_id, wrong_pool_id) = create_two_designated_pools(&mut scenario);
    create_program_and_campaign_with_pools(
        &mut scenario,
        option::none(),
        option::some(campaign_pool_id),
    );

    open_designated_budget_with_pool(&mut scenario, wrong_pool_id);
    scenario.end();
}

#[test, expected_failure(abort_code = program::ECampaignPoolMismatch)]
fun campaign_budget_rejects_wrong_program_default_pool() {
    let mut scenario = initialized();
    let (default_pool_id, wrong_pool_id) = create_two_designated_pools(&mut scenario);
    create_program_and_campaign_with_pools(
        &mut scenario,
        option::some(default_pool_id),
        option::none(),
    );

    open_designated_budget_with_pool(&mut scenario, wrong_pool_id);
    scenario.end();
}

#[test, expected_failure(abort_code = program::ECampaignDesignatedPoolNotConfigured)]
fun campaign_budget_rejects_unconfigured_designated_pool() {
    let mut scenario = initialized();
    create_program_and_campaign(&mut scenario);
    let designated_pool_id = create_designated_pool_id(&mut scenario);

    open_designated_budget_with_pool(&mut scenario, designated_pool_id);
    scenario.end();
}

#[test, expected_failure(abort_code = program::ECampaignProgramMismatch)]
fun main_budget_rejects_campaign_from_other_program() {
    let mut scenario = initialized();
    create_program_and_campaign(&mut scenario);
    let other_program_id = create_program(&mut scenario, 8);

    scenario.next_tx(ADMIN);
    {
        let mut campaign = scenario.take_shared<program::Campaign>();
        let other_program = scenario.take_shared_by_id<program::Program>(other_program_id);
        let main_pool = scenario.take_shared<pools::MainPool>();
        payout_policy::open_campaign_budget_from_main(
            &other_program,
            &mut campaign,
            &main_pool,
            scenario.ctx(),
        );
        test_scenario::return_shared(campaign);
        test_scenario::return_shared(other_program);
        test_scenario::return_shared(main_pool);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = program::ECampaignProgramMismatch)]
fun designated_budget_rejects_campaign_from_other_program() {
    let mut scenario = initialized();
    create_program_and_campaign(&mut scenario);
    let other_program_id = create_program(&mut scenario, 8);
    let designated_pool_id = create_designated_pool_id(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut campaign = scenario.take_shared<program::Campaign>();
        let other_program = scenario.take_shared_by_id<program::Program>(other_program_id);
        let main_pool = scenario.take_shared<pools::MainPool>();
        let designated_pool =
            scenario.take_shared_by_id<pools::DesignatedPool>(designated_pool_id);
        payout_policy::open_campaign_budget_from_designated_and_main(
            &other_program,
            &mut campaign,
            &designated_pool,
            &main_pool,
            scenario.ctx(),
        );
        test_scenario::return_shared(campaign);
        test_scenario::return_shared(other_program);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(designated_pool);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = program::ECampaignDesignatedPoolRequired)]
fun main_only_budget_rejects_configured_designated_pool() {
    let mut scenario = initialized();
    let designated_pool_id = create_designated_pool_id(&mut scenario);
    create_program_and_campaign_with_pools(
        &mut scenario,
        option::some(designated_pool_id),
        option::none(),
    );

    open_main_only_budget(&mut scenario);
    scenario.end();
}

#[test]
fun campaign_budget_uses_campaign_pool_before_program_default_pool() {
    let mut scenario = initialized();
    let (default_pool_id, campaign_pool_id) = create_two_designated_pools(&mut scenario);
    create_program_and_campaign_with_pools(
        &mut scenario,
        option::some(default_pool_id),
        option::some(campaign_pool_id),
    );

    open_designated_budget_with_pool(&mut scenario, campaign_pool_id);
    scenario.end();
}

#[test]
fun admin_can_create_program_and_campaign_and_emit_events() {
    let mut scenario = initialized();

    let cap = scenario.take_from_sender<admin::AdminCap>();
    program::create_program(
        7,
        0xFF,
        3,
        option::none(),
        option::none(),
        scenario.ctx(),
    );
    scenario.return_to_sender(cap);

    let program_events = event::events_by_type<program::ProgramCreated>();
    assert!(program_events.length() == 1);
    let (
        program_id_from_event,
        program_type,
        pass_metadata,
        verifier_family,
        created_at_ms,
        actor,
    ) = program::program_created_event_fields(*program_events.borrow(0));
    assert!(program_type == 7);
    assert!(pass_metadata == 0xFF);
    assert!(verifier_family == 3);
    assert!(created_at_ms == 0);
    assert!(actor == ADMIN);

    scenario.next_tx(ADMIN);
    let cap = scenario.take_from_sender<admin::AdminCap>();
    let program = scenario.take_shared<program::Program>();
    assert!(program::id(&program) == program_id_from_event);
    program::create_campaign(
        &program,
        9,
        b"metadata-hash",
        option::none(),
        100,
        200,
        scenario.ctx(),
    );
    scenario.return_to_sender(cap);
    test_scenario::return_shared(program);

    let campaign_events = event::events_by_type<program::CampaignCreated>();
    assert!(campaign_events.length() == 1);
    let (
        event_campaign_id,
        event_program_id,
        campaign_type,
        metadata_hash,
        claim_start_ms,
        claim_end_ms,
        created_at_ms,
        actor,
    ) = program::campaign_created_event_fields(*campaign_events.borrow(0));
    assert!(event_program_id == program_id_from_event);
    assert!(campaign_type == 9);
    assert!(metadata_hash == b"metadata-hash");
    assert!(claim_start_ms == 100);
    assert!(claim_end_ms == 200);
    assert!(created_at_ms == 0);
    assert!(actor == ADMIN);

    scenario.next_tx(ADMIN);
    let campaign = scenario.take_shared<program::Campaign>();
    assert!(program::campaign_id(&campaign) == event_campaign_id);
    test_scenario::return_shared(campaign);

    scenario.end();
}

#[test]
fun active_claim_precheck_passes() {
    let mut scenario = initialized();
    create_program_and_campaign(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let program = scenario.take_shared<program::Program>();
        let campaign = scenario.take_shared<program::Campaign>();

        admin::assert_claim_precheck(&pause_state, &program, &campaign);

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(program);
        test_scenario::return_shared(campaign);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = admin::EGlobalPaused)]
fun global_pause_blocks_claim_precheck() {
    let mut scenario = initialized();
    create_program_and_campaign(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pause_state = scenario.take_shared<admin::PauseState>();
        admin::pause_global(&cap, &mut pause_state, scenario.ctx());
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
    };

    run_precheck(&mut scenario);
    scenario.end();
}

#[test]
fun unpause_allows_claim_precheck_again() {
    let mut scenario = initialized();
    create_program_and_campaign(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pause_state = scenario.take_shared<admin::PauseState>();
        admin::pause_global(&cap, &mut pause_state, scenario.ctx());
        admin::unpause_global(&cap, &mut pause_state, scenario.ctx());
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
    };

    run_precheck(&mut scenario);
    scenario.end();
}

#[test, expected_failure(abort_code = admin::ETargetPaused)]
fun program_target_pause_blocks_claim_precheck() {
    let mut scenario = initialized();
    let (program_id, _) = create_program_and_campaign(&mut scenario);

    pause_target(&mut scenario, program::target_kind_program(), program_id);

    run_precheck(&mut scenario);
    scenario.end();
}

#[test, expected_failure(abort_code = admin::ETargetPaused)]
fun campaign_target_pause_blocks_claim_precheck() {
    let mut scenario = initialized();
    let (_, campaign_id) = create_program_and_campaign(&mut scenario);

    pause_target(&mut scenario, program::target_kind_campaign(), campaign_id);

    run_precheck(&mut scenario);
    scenario.end();
}

#[test]
fun unpause_target_allows_claim_precheck_again() {
    let mut scenario = initialized();
    let (_, campaign_id) = create_program_and_campaign(&mut scenario);

    pause_target(&mut scenario, program::target_kind_campaign(), campaign_id);

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pause_state = scenario.take_shared<admin::PauseState>();
        admin::unpause_target(
            &cap,
            &mut pause_state,
            program::target_kind_campaign(),
            campaign_id,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
    };

    run_precheck(&mut scenario);
    scenario.end();
}

#[test]
fun pause_events_include_scope_target_and_actor() {
    let mut scenario = initialized();
    let (program_id, _) = create_program_and_campaign(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pause_state = scenario.take_shared<admin::PauseState>();
        admin::pause_global(&cap, &mut pause_state, scenario.ctx());
        admin::unpause_global(&cap, &mut pause_state, scenario.ctx());
        admin::pause_target(
            &cap,
            &mut pause_state,
            program::target_kind_program(),
            program_id,
            scenario.ctx(),
        );
        admin::unpause_target(
            &cap,
            &mut pause_state,
            program::target_kind_program(),
            program_id,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
    };

    let paused_events = event::events_by_type<admin::Paused>();
    assert!(paused_events.length() == 2);
    let (scope, target_kind, target_id, actor) =
        admin::paused_event_fields(*paused_events.borrow(0));
    assert!(scope == admin::scope_global());
    assert!(target_kind == admin::target_kind_none());
    assert!(target_id.is_none());
    assert!(actor == ADMIN);

    let (scope, target_kind, target_id, actor) =
        admin::paused_event_fields(*paused_events.borrow(1));
    assert!(scope == admin::scope_target());
    assert!(target_kind == program::target_kind_program());
    assert!(target_id.destroy_some() == program_id);
    assert!(actor == ADMIN);

    let unpaused_events = event::events_by_type<admin::Unpaused>();
    assert!(unpaused_events.length() == 2);
    let (scope, target_kind, target_id, actor) =
        admin::unpaused_event_fields(*unpaused_events.borrow(0));
    assert!(scope == admin::scope_global());
    assert!(target_kind == admin::target_kind_none());
    assert!(target_id.is_none());
    assert!(actor == ADMIN);

    let (scope, target_kind, target_id, actor) =
        admin::unpaused_event_fields(*unpaused_events.borrow(1));
    assert!(scope == admin::scope_target());
    assert!(target_kind == program::target_kind_program());
    assert!(target_id.destroy_some() == program_id);
    assert!(actor == ADMIN);

    scenario.end();
}

#[test, expected_failure(abort_code = program::ECampaignProgramMismatch)]
fun campaign_from_other_program_fails_precheck() {
    let mut scenario = initialized();
    create_program_and_campaign(&mut scenario);
    let other_program_id = create_program(&mut scenario, 8);

    scenario.next_tx(ADMIN);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let campaign = scenario.take_shared<program::Campaign>();
        let other_program = scenario.take_shared_by_id<program::Program>(other_program_id);

        admin::assert_claim_precheck(&pause_state, &other_program, &campaign);

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(campaign);
        test_scenario::return_shared(other_program);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = program::EProgramNotActive)]
fun inactive_program_fails_precheck() {
    let mut scenario = initialized();
    create_program_and_campaign(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut program = scenario.take_shared<program::Program>();
        let campaign = scenario.take_shared<program::Campaign>();
        program::set_program_status_for_testing(&mut program, program::status_inactive());

        admin::assert_claim_precheck(&pause_state, &program, &campaign);

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(program);
        test_scenario::return_shared(campaign);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = program::EProgramNotActive)]
fun closed_program_fails_precheck() {
    let mut scenario = initialized();
    create_program_and_campaign(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut program = scenario.take_shared<program::Program>();
        let campaign = scenario.take_shared<program::Campaign>();
        program::set_program_status_for_testing(&mut program, program::status_closed());

        admin::assert_claim_precheck(&pause_state, &program, &campaign);

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(program);
        test_scenario::return_shared(campaign);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = program::ECampaignNotActive)]
fun inactive_campaign_fails_precheck() {
    let mut scenario = initialized();
    create_program_and_campaign(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let program = scenario.take_shared<program::Program>();
        let mut campaign = scenario.take_shared<program::Campaign>();
        program::set_campaign_status_for_testing(&mut campaign, program::status_inactive());

        admin::assert_claim_precheck(&pause_state, &program, &campaign);

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(program);
        test_scenario::return_shared(campaign);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = program::ECampaignNotActive)]
fun closed_campaign_fails_precheck() {
    let mut scenario = initialized();
    create_program_and_campaign(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let program = scenario.take_shared<program::Program>();
        let mut campaign = scenario.take_shared<program::Campaign>();
        program::set_campaign_status_for_testing(&mut campaign, program::status_closed());

        admin::assert_claim_precheck(&pause_state, &program, &campaign);

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(program);
        test_scenario::return_shared(campaign);
    };

    scenario.end();
}

fun initialized(): test_scenario::Scenario {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);
    scenario
}

fun create_program(scenario: &mut test_scenario::Scenario, program_type: u8): object::ID {
    let cap = scenario.take_from_sender<admin::AdminCap>();
    program::create_program(
        program_type,
        0xFF,
        3,
        option::none(),
        option::none(),
        scenario.ctx(),
    );
    scenario.return_to_sender(cap);

    scenario.next_tx(ADMIN);
    let program = scenario.take_shared<program::Program>();
    let program_id = program::id(&program);
    test_scenario::return_shared(program);

    program_id
}

fun create_program_and_campaign(
    scenario: &mut test_scenario::Scenario,
): (object::ID, object::ID) {
    let program_id = create_program(scenario, 7);

    scenario.next_tx(ADMIN);
    let cap = scenario.take_from_sender<admin::AdminCap>();
    let program = scenario.take_shared<program::Program>();
    program::create_campaign(
        &program,
        9,
        b"metadata-hash",
        option::none(),
        100,
        200,
        scenario.ctx(),
    );
    scenario.return_to_sender(cap);
    test_scenario::return_shared(program);

    scenario.next_tx(ADMIN);
    let campaign = scenario.take_shared<program::Campaign>();
    let campaign_id = program::campaign_id(&campaign);
    test_scenario::return_shared(campaign);

    (program_id, campaign_id)
}

fun create_program_and_campaign_with_pools(
    scenario: &mut test_scenario::Scenario,
    default_pool_id: Option<object::ID>,
    campaign_pool_id: Option<object::ID>,
) {
    let cap = scenario.take_from_sender<admin::AdminCap>();
    program::create_program(
        7,
        0xFF,
        3,
        option::none(),
        default_pool_id,
        scenario.ctx(),
    );
    scenario.return_to_sender(cap);

    scenario.next_tx(ADMIN);
    let cap = scenario.take_from_sender<admin::AdminCap>();
    let program = scenario.take_shared<program::Program>();
    program::create_campaign(
        &program,
        9,
        b"metadata-hash",
        campaign_pool_id,
        100,
        200,
        scenario.ctx(),
    );
    scenario.return_to_sender(cap);
    test_scenario::return_shared(program);
}

fun create_program_campaign_and_designated_pool(scenario: &mut test_scenario::Scenario) {
    let designated_pool_id = create_designated_pool_id(scenario);
    create_program_and_campaign_with_pools(
        scenario,
        option::none(),
        option::some(designated_pool_id),
    );
}

fun create_designated_pool_id(scenario: &mut test_scenario::Scenario): object::ID {
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        admin::create_designated_pool(&cap, option::none(), scenario.ctx());
        scenario.return_to_sender(cap);
    };

    let pool_events = event::events_by_type<pools::PoolCreated>();
    let (pool_id, pool_kind, _, _, _) =
        pools::pool_created_event_fields(*pool_events.borrow(pool_events.length() - 1));
    assert!(pool_kind == pools::pool_kind_designated());

    scenario.next_tx(ADMIN);
    pool_id
}

fun create_two_designated_pools(
    scenario: &mut test_scenario::Scenario,
): (object::ID, object::ID) {
    let first_pool_id = create_designated_pool_id(scenario);
    let second_pool_id = create_designated_pool_id(scenario);
    (first_pool_id, second_pool_id)
}

fun open_main_only_budget(scenario: &mut test_scenario::Scenario) {
    scenario.next_tx(ADMIN);
    {
        let program = scenario.take_shared<program::Program>();
        let mut campaign = scenario.take_shared<program::Campaign>();
        let main_pool = scenario.take_shared<pools::MainPool>();
        payout_policy::open_campaign_budget_from_main(
            &program,
            &mut campaign,
            &main_pool,
            scenario.ctx(),
        );
        test_scenario::return_shared(program);
        test_scenario::return_shared(campaign);
        test_scenario::return_shared(main_pool);
    };
}

fun open_designated_budget_with_pool(
    scenario: &mut test_scenario::Scenario,
    designated_pool_id: object::ID,
) {
    scenario.next_tx(ADMIN);
    {
        let program = scenario.take_shared<program::Program>();
        let mut campaign = scenario.take_shared<program::Campaign>();
        let main_pool = scenario.take_shared<pools::MainPool>();
        let designated_pool =
            scenario.take_shared_by_id<pools::DesignatedPool>(designated_pool_id);
        payout_policy::open_campaign_budget_from_designated_and_main(
            &program,
            &mut campaign,
            &designated_pool,
            &main_pool,
            scenario.ctx(),
        );
        test_scenario::return_shared(program);
        test_scenario::return_shared(campaign);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(designated_pool);
    };
}

fun pause_target(
    scenario: &mut test_scenario::Scenario,
    target_kind: u8,
    target_id: object::ID,
) {
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pause_state = scenario.take_shared<admin::PauseState>();
        admin::pause_target(&cap, &mut pause_state, target_kind, target_id, scenario.ctx());
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
    };
}

fun run_precheck(scenario: &mut test_scenario::Scenario) {
    scenario.next_tx(ADMIN);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let program = scenario.take_shared<program::Program>();
        let campaign = scenario.take_shared<program::Campaign>();

        admin::assert_claim_precheck(&pause_state, &program, &campaign);

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(program);
        test_scenario::return_shared(campaign);
    };
}
