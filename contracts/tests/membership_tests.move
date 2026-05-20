#[test_only]
module contracts::membership_tests;

use contracts::accessor;
use contracts::admin;
use contracts::membership;
use contracts::pools;
use sui::coin;
use sui::event;
use sui::test_scenario;
use usdc::usdc::USDC;

const ADMIN: address = @0xA11CE;
const MEMBER: address = @0x51A;
const PAYOUT: address = @0xB0B;
const OTHER: address = @0xC0FFEE;

#[test]
fun member_registration_issues_active_pass_to_sender_and_records_metadata() {
    let mut scenario = initialized_with_pools();

    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<membership::MembershipRegistry>();
        let registry_id = membership::registry_id(&registry);
        let mut operations_pool = scenario.take_shared<pools::OperationsPool>();
        let operations_pool_id = pools::operations_pool_id(&operations_pool);
        let fee = coin::mint_for_testing<USDC>(500_000, scenario.ctx());

        accessor::register_member_usdc(
            &pause_state,
            &mut registry,
            &mut operations_pool,
            fee,
            PAYOUT,
            scenario.ctx(),
        );

        assert!(pools::operations_pool_balance_usdc(&operations_pool) == 500_000);
        assert!(pools::operations_pool_total_received_usdc(&operations_pool) == 500_000);

        let issued_events = event::events_by_type<membership::MembershipPassIssued>();
        assert!(issued_events.length() == 1);
        let (
            event_registry_id,
            event_pass_id,
            event_owner,
            event_payout_address,
            event_pass_lineage_id,
            event_operations_pool_id,
            event_fee_amount,
            event_issued_at_ms,
            event_actor,
        ) = membership::membership_pass_issued_event_fields(*issued_events.borrow(0));
        assert!(event_registry_id == registry_id);
        assert!(event_owner == MEMBER);
        assert!(event_payout_address == PAYOUT);
        assert!(event_operations_pool_id == operations_pool_id);
        assert!(event_fee_amount == 500_000);
        assert!(event_issued_at_ms == 0);
        assert!(event_actor == MEMBER);

        assert!(membership::membership_registry_issued_count(&registry) == 1);

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(operations_pool);

        scenario.next_tx(MEMBER);
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        let pass_id = object::id(&pass);
        assert!(event_pass_id == pass_id);
        assert!(event_pass_lineage_id == pass_id);
        assert!(membership::membership_pass_owner(&pass) == MEMBER);
        assert!(membership::membership_pass_payout_address(&pass) == PAYOUT);
        assert!(membership::membership_pass_lineage_id(&pass) == pass_id);
        assert!(membership::membership_pass_status(&pass) == membership::status_active());
        assert!(membership::membership_pass_issued_at_ms(&pass) == 0);
        assert!(membership::membership_pass_last_metadata_update_ms(&pass) == 0);
        scenario.return_to_sender(pass);
    };

    scenario.end();
}

#[test]
fun verification_fee_only_deposits_to_operations_pool() {
    let mut scenario = initialized_with_pools();

    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let main_pool = scenario.take_shared<pools::MainPool>();
        let designated_pool = scenario.take_shared<pools::DesignatedPool>();
        let mut registry = scenario.take_shared<membership::MembershipRegistry>();
        let mut operations_pool = scenario.take_shared<pools::OperationsPool>();
        let fee = coin::mint_for_testing<USDC>(42, scenario.ctx());

        accessor::register_member_usdc(
            &pause_state,
            &mut registry,
            &mut operations_pool,
            fee,
            PAYOUT,
            scenario.ctx(),
        );

        assert!(pools::main_pool_balance_usdc(&main_pool) == 0);
        assert!(pools::main_pool_total_received_usdc(&main_pool) == 0);
        assert!(pools::designated_pool_balance_usdc(&designated_pool) == 0);
        assert!(pools::designated_pool_total_received_usdc(&designated_pool) == 0);
        assert!(pools::operations_pool_balance_usdc(&operations_pool) == 42);
        assert!(pools::operations_pool_total_received_usdc(&operations_pool) == 42);

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(designated_pool);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(operations_pool);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = membership::EInvalidPayoutAddress)]
fun zero_payout_address_is_rejected() {
    let mut scenario = initialized_with_pools();

    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<membership::MembershipRegistry>();
        let mut operations_pool = scenario.take_shared<pools::OperationsPool>();
        let fee = coin::mint_for_testing<USDC>(1, scenario.ctx());

        accessor::register_member_usdc(
            &pause_state,
            &mut registry,
            &mut operations_pool,
            fee,
            @0x0,
            scenario.ctx(),
        );

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(operations_pool);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = membership::EZeroVerificationFee)]
fun zero_verification_fee_is_rejected() {
    let mut scenario = initialized_with_pools();

    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<membership::MembershipRegistry>();
        let mut operations_pool = scenario.take_shared<pools::OperationsPool>();
        let fee = coin::mint_for_testing<USDC>(0, scenario.ctx());

        accessor::register_member_usdc(
            &pause_state,
            &mut registry,
            &mut operations_pool,
            fee,
            PAYOUT,
            scenario.ctx(),
        );

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(operations_pool);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = admin::EGlobalPaused)]
fun global_pause_blocks_member_registration() {
    let mut scenario = initialized_with_pools();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pause_state = scenario.take_shared<admin::PauseState>();
        admin::pause_global(&cap, &mut pause_state, scenario.ctx());
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
    };

    register_member(&mut scenario, 1);
    scenario.end();
}

#[test, expected_failure(abort_code = admin::ETargetPaused)]
fun operations_pool_target_pause_blocks_member_registration() {
    let mut scenario = initialized_with_pools();
    let operations_pool_id = operations_pool_id(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pause_state = scenario.take_shared<admin::PauseState>();
        admin::pause_target(
            &cap,
            &mut pause_state,
            pools::target_kind_operations_pool(),
            operations_pool_id,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
    };

    register_member(&mut scenario, 1);
    scenario.end();
}

#[test, expected_failure(abort_code = admin::ETargetPaused)]
fun membership_registry_target_pause_blocks_member_registration() {
    let mut scenario = initialized_with_pools();
    let registry_id = membership_registry_id(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pause_state = scenario.take_shared<admin::PauseState>();
        admin::pause_target(
            &cap,
            &mut pause_state,
            membership::target_kind_membership_registry(),
            registry_id,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
    };

    register_member(&mut scenario, 1);
    scenario.end();
}

#[test, expected_failure(abort_code = membership::EMembershipPassAlreadyIssued)]
fun duplicate_member_registration_for_same_owner_is_rejected() {
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario, 1);
    register_member(&mut scenario, 1);
    scenario.end();
}

#[test]
fun registry_current_pass_precheck_matches_pass_and_owner_index() {
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario, 1);

    scenario.next_tx(MEMBER);
    {
        let registry = scenario.take_shared<membership::MembershipRegistry>();
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        let pass_id = object::id(&pass);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);

        membership::assert_current_pass_precheck(&registry, &pass, MEMBER);
        assert!(membership::membership_owner_lineage_id(&registry, MEMBER) == pass_lineage_id);

        let (
            record_lineage_id,
            current_pass_id,
            current_owner,
            current_payout_address,
            status,
            issued_at_ms,
            updated_at_ms,
        ) = membership::membership_record_summary(&registry, pass_lineage_id);
        assert!(record_lineage_id == pass_lineage_id);
        assert!(current_pass_id == pass_id);
        assert!(current_owner == MEMBER);
        assert!(current_payout_address == PAYOUT);
        assert!(status == membership::status_active());
        assert!(issued_at_ms == 0);
        assert!(updated_at_ms == 0);

        test_scenario::return_shared(registry);
        scenario.return_to_sender(pass);
    };

    scenario.end();
}

#[test]
fun claim_precheck_allows_active_pass_owner_and_payout_address() {
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario, 1);

    scenario.next_tx(MEMBER);
    {
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        membership::assert_claim_precheck(&pass, MEMBER);
        membership::assert_claim_precheck(&pass, PAYOUT);
        scenario.return_to_sender(pass);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = membership::EMembershipPassNotActive)]
fun suspended_pass_fails_claim_precheck() {
    run_inactive_status_precheck(membership::status_suspended());
}

#[test, expected_failure(abort_code = membership::EMembershipPassNotActive)]
fun revoked_pass_fails_claim_precheck() {
    run_inactive_status_precheck(membership::status_revoked());
}

#[test, expected_failure(abort_code = membership::EMembershipPassNotActive)]
fun migrated_pass_fails_claim_precheck() {
    run_inactive_status_precheck(membership::status_migrated());
}

#[test, expected_failure(abort_code = membership::EClaimantNotAuthorized)]
fun unrelated_claimant_fails_claim_precheck() {
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario, 1);

    scenario.next_tx(MEMBER);
    {
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        membership::assert_claim_precheck(&pass, OTHER);
        scenario.return_to_sender(pass);
    };

    scenario.end();
}

#[test]
fun duplicate_claim_key_uses_pass_lineage_id_and_campaign_id() {
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario, 1);
    let campaign_id = operations_pool_id(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        let (key_pass_lineage_id, key_campaign_id) =
            membership::duplicate_claim_key(&pass, campaign_id);
        assert!(key_pass_lineage_id == membership::membership_pass_lineage_id(&pass));
        assert!(key_campaign_id == campaign_id);
        scenario.return_to_sender(pass);
    };

    scenario.end();
}

fun initialized_with_pools(): test_scenario::Scenario {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    let cap = scenario.take_from_sender<admin::AdminCap>();
    admin::create_designated_pool(&cap, option::none(), scenario.ctx());
    scenario.return_to_sender(cap);

    scenario.next_tx(ADMIN);
    scenario
}

fun register_member(scenario: &mut test_scenario::Scenario, fee_amount: u64) {
    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<membership::MembershipRegistry>();
        let mut operations_pool = scenario.take_shared<pools::OperationsPool>();
        let fee = coin::mint_for_testing<USDC>(fee_amount, scenario.ctx());

        accessor::register_member_usdc(
            &pause_state,
            &mut registry,
            &mut operations_pool,
            fee,
            PAYOUT,
            scenario.ctx(),
        );

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(operations_pool);
    };
}

fun operations_pool_id(scenario: &mut test_scenario::Scenario): object::ID {
    scenario.next_tx(ADMIN);
    let operations_pool = scenario.take_shared<pools::OperationsPool>();
    let operations_pool_id = pools::operations_pool_id(&operations_pool);
    test_scenario::return_shared(operations_pool);
    operations_pool_id
}

fun membership_registry_id(scenario: &mut test_scenario::Scenario): object::ID {
    scenario.next_tx(ADMIN);
    let registry = scenario.take_shared<membership::MembershipRegistry>();
    let registry_id = membership::registry_id(&registry);
    test_scenario::return_shared(registry);
    registry_id
}

fun run_inactive_status_precheck(status: u8) {
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario, 1);

    scenario.next_tx(MEMBER);
    {
        let mut pass = scenario.take_from_sender<membership::MembershipPass>();
        membership::set_status_for_testing(&mut pass, status);
        membership::assert_claim_precheck(&pass, MEMBER);
        scenario.return_to_sender(pass);
    };

    scenario.end();
}
