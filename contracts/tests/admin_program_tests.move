#[test_only]
module contracts::admin_program_tests;

use contracts::admin;
use contracts::program;
use sui::event;
use sui::test_scenario;

const ADMIN: address = @0xA11CE;
const NON_ADMIN: address = @0xB0B;

#[test]
fun init_creates_admin_cap_and_pause_state() {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    {
        assert!(scenario.has_most_recent_for_sender<admin::AdminCap>());
        assert!(test_scenario::has_most_recent_shared<admin::PauseState>());

        let cap = scenario.take_from_sender<admin::AdminCap>();
        let pause_state = scenario.take_shared<admin::PauseState>();

        assert!(!admin::is_global_paused(&pause_state));
        assert!(admin::paused_target_count(&pause_state) == 0);

        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
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
fun admin_can_create_program_and_campaign_and_emit_events() {
    let mut scenario = initialized();

    let cap = scenario.take_from_sender<admin::AdminCap>();
    program::create_program(
        &cap,
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
        &cap,
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

        program::assert_claim_precheck(&pause_state, &program, &campaign);

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

        program::assert_claim_precheck(&pause_state, &other_program, &campaign);

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

        program::assert_claim_precheck(&pause_state, &program, &campaign);

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

        program::assert_claim_precheck(&pause_state, &program, &campaign);

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

        program::assert_claim_precheck(&pause_state, &program, &campaign);

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

        program::assert_claim_precheck(&pause_state, &program, &campaign);

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
        &cap,
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
        &cap,
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

        program::assert_claim_precheck(&pause_state, &program, &campaign);

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(program);
        test_scenario::return_shared(campaign);
    };
}
