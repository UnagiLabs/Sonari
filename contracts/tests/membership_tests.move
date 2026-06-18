#[test_only]
module contracts::membership_tests;

use contracts::accessor;
use contracts::admin;
use contracts::allowed_residence_cell;
use contracts::cell_count_index;
use contracts::membership;
use contracts::pools;
use contracts::reader;
use sui::clock;
use sui::event;
use sui::test_scenario;

const ADMIN: address = @0xA11CE;
const MEMBER: address = @0x51A;
const OTHER: address = @0xC0FFEE;
const HOME_CELL: u64 = 608_819_013_597_790_207;
const PROMOTED_HOME_CELL: u64 = 608_819_013_681_676_287;
const CROSS_SHARD_HOME_CELL: u64 = 608_819_013_597_790_208;
const GEO_RESOLUTION: u8 = 7;
const ALLOWLIST_VERSION: u64 = 1;
const TERMS_VERSION: u64 = 2;
const SIGNED_STATEMENT_HASH: vector<u8> = b"membership-statement-hash";
const HOME_CELL_UPDATED_AT_MS: u64 = 12_345;

#[test]
fun member_registration_issues_active_pass_to_sender_and_records_metadata() {
    let mut scenario = initialized_with_pools();

    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<membership::MembershipRegistry>();
        let mut count_index = scenario.take_shared<cell_count_index::CellCountIndex>();
        let residence_registry =
            scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();
        let registry_id = membership::registry_id(&registry);

        accessor::register_member(
            &pause_state,
            &mut registry,
            &mut count_index,
            &residence_registry,
            HOME_CELL,
            target_proof(),
            TERMS_VERSION,
            SIGNED_STATEMENT_HASH,
            scenario.ctx(),
        );

        let issued_events = event::events_by_type<membership::MembershipPassIssued>();
        assert!(issued_events.length() == 1);
        let (
            event_registry_id,
            event_pass_id,
            event_owner,
            event_pass_lineage_id,
            event_issued_at_ms,
            event_actor,
        ) = membership::membership_pass_issued_event_fields(*issued_events.borrow(0));
        assert!(event_registry_id == registry_id);
        assert!(event_owner == MEMBER);
        assert!(event_issued_at_ms == 0);
        assert!(event_actor == MEMBER);

        assert!(membership::membership_registry_issued_count(&registry) == 1);

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(count_index);
        test_scenario::return_shared(residence_registry);

        scenario.next_tx(MEMBER);
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        let pass_id = object::id(&pass);
        assert!(event_pass_id == pass_id);
        assert!(event_pass_lineage_id == pass_id);
        assert!(membership::membership_pass_owner(&pass) == MEMBER);
        assert!(membership::membership_pass_lineage_id(&pass) == pass_id);
        assert!(membership::membership_pass_status(&pass) == membership::status_active());
        assert!(membership::membership_pass_issued_at_ms(&pass) == 0);
        let (
            account_created_at_ms,
            home_cell,
            home_cell_registered_at_ms,
            terms_version,
            signed_statement_hash,
        ) = membership::membership_pass_mvp_summary(&pass);
        assert!(account_created_at_ms == 0u64);
        assert!(home_cell == HOME_CELL);
        assert!(home_cell_registered_at_ms == 0u64);
        assert!(terms_version == TERMS_VERSION);
        assert!(signed_statement_hash == SIGNED_STATEMENT_HASH);
        scenario.return_to_sender(pass);
    };

    scenario.end();
}

#[test]
fun member_registration_does_not_deposit_to_operations_pool() {
    let mut scenario = initialized_with_pools();

    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let main_pool = scenario.take_shared<pools::MainPool>();
        let mut registry = scenario.take_shared<membership::MembershipRegistry>();
        let mut count_index = scenario.take_shared<cell_count_index::CellCountIndex>();
        let residence_registry =
            scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();
        let operations_pool = scenario.take_shared<pools::OperationsPool>();

        accessor::register_member(
            &pause_state,
            &mut registry,
            &mut count_index,
            &residence_registry,
            HOME_CELL,
            target_proof(),
            TERMS_VERSION,
            SIGNED_STATEMENT_HASH,
            scenario.ctx(),
        );

        assert!(pools::main_pool_balance_usdc(&main_pool) == 0);
        assert!(pools::main_pool_total_received_usdc(&main_pool) == 0);
        assert!(pools::operations_pool_balance_usdc(&operations_pool) == 0);
        assert!(pools::operations_pool_total_received_usdc(&operations_pool) == 0);

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(count_index);
        test_scenario::return_shared(residence_registry);
        test_scenario::return_shared(operations_pool);
    };

    scenario.end();
}

#[test]
fun valid_residence_proof_allows_initial_registration() {
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);
    scenario.end();
}

#[test]
fun first_registration_increments_home_cell_count_and_creates_shard() {
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let count_index = scenario.take_shared<cell_count_index::CellCountIndex>();
        let shard_id = cell_count_index::shard_id_for_testing(HOME_CELL);
        assert!(cell_count_index::has_shard_for_testing(&count_index, shard_id));
        assert!(cell_count_index::has_cell_for_testing(&count_index, HOME_CELL));
        assert!(reader::read_cell_count_or_zero(&count_index, HOME_CELL) == 1);
        test_scenario::return_shared(count_index);
    };

    scenario.end();
}

#[test]
fun second_member_in_same_home_cell_increments_existing_count() {
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);
    register_member_with_proof(&mut scenario, OTHER, HOME_CELL, target_proof());

    scenario.next_tx(ADMIN);
    {
        let count_index = scenario.take_shared<cell_count_index::CellCountIndex>();
        assert!(reader::read_cell_count_or_zero(&count_index, HOME_CELL) == 2);
        test_scenario::return_shared(count_index);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = accessor::EInvalidResidenceCellProof)]
fun invalid_residence_proof_rejects_initial_registration() {
    let mut scenario = initialized_with_pools();
    register_member_with_proof(&mut scenario, MEMBER, HOME_CELL, vector[]);
    scenario.end();
}

#[test, expected_failure(abort_code = accessor::EInvalidResidenceCellProof)]
fun old_residence_proof_is_invalid_after_root_update() {
    let mut scenario = initialized_with_pools();
    update_residence_root_to_promoted_single_leaf(&mut scenario);
    register_member_with_proof(&mut scenario, MEMBER, HOME_CELL, target_proof());
    scenario.end();
}

#[test]
fun new_residence_proof_is_valid_after_root_update() {
    let mut scenario = initialized_with_pools();
    update_residence_root_to_promoted_single_leaf(&mut scenario);
    register_member_with_proof(&mut scenario, OTHER, PROMOTED_HOME_CELL, vector[]);
    scenario.end();
}

#[test]
fun valid_residence_proof_updates_member_home_cell_at_clock_time() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(HOME_CELL_UPDATED_AT_MS);
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);

    update_member_home_cell_with_proof(
        &mut scenario,
        &clock,
        MEMBER,
        PROMOTED_HOME_CELL,
        promoted_proof(),
    );

    scenario.next_tx(MEMBER);
    {
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        let (
            _account_created_at_ms,
            home_cell,
            home_cell_registered_at_ms,
            _terms_version,
            _signed_statement_hash,
        ) = membership::membership_pass_mvp_summary(&pass);
        assert!(home_cell == PROMOTED_HOME_CELL);
        assert!(home_cell_registered_at_ms == HOME_CELL_UPDATED_AT_MS);
        scenario.return_to_sender(pass);
    };

    scenario.end();
    clock.destroy_for_testing();
}

#[test]
fun same_cell_update_preserves_count_and_event_behavior() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(HOME_CELL_UPDATED_AT_MS);
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);

    update_member_home_cell_with_proof(
        &mut scenario,
        &clock,
        MEMBER,
        HOME_CELL,
        target_proof(),
    );

    scenario.next_tx(ADMIN);
    {
        let count_index = scenario.take_shared<cell_count_index::CellCountIndex>();
        assert!(reader::read_cell_count_or_zero(&count_index, HOME_CELL) == 1);
        test_scenario::return_shared(count_index);
    };

    scenario.end();
    clock.destroy_for_testing();
}

#[test]
fun same_shard_home_cell_move_decrements_old_to_zero_and_increments_new() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(HOME_CELL_UPDATED_AT_MS);
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);

    update_member_home_cell_with_proof(
        &mut scenario,
        &clock,
        MEMBER,
        PROMOTED_HOME_CELL,
        promoted_proof(),
    );

    scenario.next_tx(ADMIN);
    {
        let count_index = scenario.take_shared<cell_count_index::CellCountIndex>();
        assert!(cell_count_index::shard_id_for_testing(HOME_CELL) == cell_count_index::shard_id_for_testing(PROMOTED_HOME_CELL));
        assert!(reader::read_cell_count_or_zero(&count_index, HOME_CELL) == 0);
        assert!(cell_count_index::has_cell_for_testing(&count_index, HOME_CELL));
        assert!(reader::read_cell_count_or_zero(&count_index, PROMOTED_HOME_CELL) == 1);
        test_scenario::return_shared(count_index);
    };

    scenario.end();
    clock.destroy_for_testing();
}

#[test]
fun cross_shard_home_cell_move_decrements_old_and_lazily_creates_new_shard() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(HOME_CELL_UPDATED_AT_MS);
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);
    update_residence_root_to_single_leaf(&mut scenario, CROSS_SHARD_HOME_CELL);

    update_member_home_cell_with_proof(
        &mut scenario,
        &clock,
        MEMBER,
        CROSS_SHARD_HOME_CELL,
        vector[],
    );

    scenario.next_tx(ADMIN);
    {
        let count_index = scenario.take_shared<cell_count_index::CellCountIndex>();
        let new_shard_id = cell_count_index::shard_id_for_testing(CROSS_SHARD_HOME_CELL);
        assert!(cell_count_index::shard_id_for_testing(HOME_CELL) != new_shard_id);
        assert!(cell_count_index::has_shard_for_testing(&count_index, new_shard_id));
        assert!(reader::read_cell_count_or_zero(&count_index, HOME_CELL) == 0);
        assert!(cell_count_index::has_cell_for_testing(&count_index, HOME_CELL));
        assert!(reader::read_cell_count_or_zero(&count_index, CROSS_SHARD_HOME_CELL) == 1);
        test_scenario::return_shared(count_index);
    };

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = cell_count_index::EMembershipRegistryMismatch)]
fun member_home_cell_update_rejects_mismatched_cell_count_index() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(HOME_CELL_UPDATED_AT_MS);
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);
    let wrong_registry_id = operations_pool_id(&mut scenario);

    scenario.next_tx(ADMIN);
    let wrong_index_id =
        cell_count_index::create_index_for_testing(wrong_registry_id, scenario.ctx());

    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let registry = scenario.take_shared<membership::MembershipRegistry>();
        let mut wrong_count_index =
            scenario.take_shared_by_id<cell_count_index::CellCountIndex>(wrong_index_id);
        let residence_registry =
            scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();
        let mut pass = scenario.take_from_sender<membership::MembershipPass>();

        accessor::update_member_home_cell(
            &pause_state,
            &registry,
            &mut wrong_count_index,
            &residence_registry,
            &mut pass,
            &clock,
            PROMOTED_HOME_CELL,
            promoted_proof(),
            scenario.ctx(),
        );

        scenario.return_to_sender(pass);
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(wrong_count_index);
        test_scenario::return_shared(residence_registry);
    };

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = cell_count_index::ECellCountUnderflow)]
fun member_home_cell_update_aborts_when_old_cell_count_is_zero() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(HOME_CELL_UPDATED_AT_MS);
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut count_index = scenario.take_shared<cell_count_index::CellCountIndex>();
        cell_count_index::set_count_for_testing(&mut count_index, HOME_CELL, 0);
        test_scenario::return_shared(count_index);
    };

    update_member_home_cell_with_proof(
        &mut scenario,
        &clock,
        MEMBER,
        PROMOTED_HOME_CELL,
        promoted_proof(),
    );

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = cell_count_index::ECellCountMissing)]
fun member_home_cell_update_aborts_when_old_cell_count_is_missing() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(HOME_CELL_UPDATED_AT_MS);
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut count_index = scenario.take_shared<cell_count_index::CellCountIndex>();
        cell_count_index::remove_count_for_testing(&mut count_index, HOME_CELL);
        test_scenario::return_shared(count_index);
    };

    update_member_home_cell_with_proof(
        &mut scenario,
        &clock,
        MEMBER,
        PROMOTED_HOME_CELL,
        promoted_proof(),
    );

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = accessor::EInvalidResidenceCellProof)]
fun invalid_residence_proof_rejects_member_home_cell_update() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(HOME_CELL_UPDATED_AT_MS);
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);

    update_member_home_cell_with_proof(
        &mut scenario,
        &clock,
        MEMBER,
        PROMOTED_HOME_CELL,
        vector[],
    );

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = membership::EClaimantNotAuthorized)]
fun unrelated_sender_cannot_update_member_home_cell() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(HOME_CELL_UPDATED_AT_MS);
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);

    update_member_home_cell_with_proof(
        &mut scenario,
        &clock,
        OTHER,
        PROMOTED_HOME_CELL,
        promoted_proof(),
    );

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = membership::ERegistryPassMismatch)]
fun current_pass_mismatch_rejects_member_home_cell_update() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(HOME_CELL_UPDATED_AT_MS);
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);
    let wrong_pass_id = operations_pool_id(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut registry = scenario.take_shared<membership::MembershipRegistry>();
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        membership::set_current_pass_id_for_testing(
            &mut registry,
            membership::membership_pass_lineage_id(&pass),
            wrong_pass_id,
        );
        test_scenario::return_shared(registry);
        scenario.return_to_sender(pass);
    };

    update_member_home_cell_with_proof(
        &mut scenario,
        &clock,
        MEMBER,
        PROMOTED_HOME_CELL,
        promoted_proof(),
    );

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = admin::EGlobalPaused)]
fun global_pause_blocks_member_home_cell_update() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(HOME_CELL_UPDATED_AT_MS);
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pause_state = scenario.take_shared<admin::PauseState>();
        admin::pause_global(&cap, &mut pause_state, scenario.ctx());
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
    };

    update_member_home_cell_with_proof(
        &mut scenario,
        &clock,
        MEMBER,
        PROMOTED_HOME_CELL,
        promoted_proof(),
    );

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = admin::ETargetPaused)]
fun membership_registry_target_pause_blocks_member_home_cell_update() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(HOME_CELL_UPDATED_AT_MS);
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);
    let registry_id = membership_registry_id(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pause_state = scenario.take_shared<admin::PauseState>();
        admin::pause_target(
            &cap,
            &mut pause_state,
            reader::target_kind_membership_registry(),
            registry_id,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
    };

    update_member_home_cell_with_proof(
        &mut scenario,
        &clock,
        MEMBER,
        PROMOTED_HOME_CELL,
        promoted_proof(),
    );

    scenario.end();
    clock.destroy_for_testing();
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

    register_member(&mut scenario);
    scenario.end();
}

#[test]
fun operations_pool_target_pause_does_not_block_member_registration() {
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

    register_member(&mut scenario);
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
            reader::target_kind_membership_registry(),
            registry_id,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
    };

    register_member(&mut scenario);
    scenario.end();
}

#[test, expected_failure(abort_code = membership::EMembershipPassAlreadyIssued)]
fun duplicate_member_registration_for_same_owner_is_rejected() {
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);
    register_member(&mut scenario);
    scenario.end();
}

#[test, expected_failure(abort_code = cell_count_index::EMembershipRegistryMismatch)]
fun member_registration_rejects_mismatched_cell_count_index() {
    let mut scenario = initialized_with_pools();
    let wrong_registry_id = operations_pool_id(&mut scenario);

    scenario.next_tx(ADMIN);
    let wrong_index_id =
        cell_count_index::create_index_for_testing(wrong_registry_id, scenario.ctx());

    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<membership::MembershipRegistry>();
        let mut wrong_count_index =
            scenario.take_shared_by_id<cell_count_index::CellCountIndex>(wrong_index_id);
        let residence_registry =
            scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();

        accessor::register_member(
            &pause_state,
            &mut registry,
            &mut wrong_count_index,
            &residence_registry,
            HOME_CELL,
            target_proof(),
            TERMS_VERSION,
            SIGNED_STATEMENT_HASH,
            scenario.ctx(),
        );

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(wrong_count_index);
        test_scenario::return_shared(residence_registry);
    };

    scenario.end();
}

#[test]
fun registry_current_pass_precheck_matches_pass_and_owner_index() {
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);

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
            status,
            issued_at_ms,
            updated_at_ms,
        ) = membership::membership_record_summary(&registry, pass_lineage_id);
        assert!(record_lineage_id == pass_lineage_id);
        assert!(current_pass_id == pass_id);
        assert!(current_owner == MEMBER);
        assert!(status == membership::status_active());
        assert!(issued_at_ms == 0);
        assert!(updated_at_ms == 0);

        test_scenario::return_shared(registry);
        scenario.return_to_sender(pass);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = membership::ERegistryRecordNotFound)]
fun current_pass_precheck_rejects_missing_registry_record() {
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut registry = scenario.take_shared<membership::MembershipRegistry>();
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);
        membership::remove_membership_record_for_testing(&mut registry, pass_lineage_id);

        membership::assert_current_pass_precheck(&registry, &pass, MEMBER);

        test_scenario::return_shared(registry);
        scenario.return_to_sender(pass);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = membership::ERegistryPassMismatch)]
fun current_pass_precheck_rejects_wrong_current_pass_id() {
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);
    let wrong_pass_id = operations_pool_id(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut registry = scenario.take_shared<membership::MembershipRegistry>();
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        membership::set_current_pass_id_for_testing(
            &mut registry,
            membership::membership_pass_lineage_id(&pass),
            wrong_pass_id,
        );

        membership::assert_current_pass_precheck(&registry, &pass, MEMBER);

        test_scenario::return_shared(registry);
        scenario.return_to_sender(pass);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = membership::ERegistryOwnerMismatch)]
fun current_pass_precheck_rejects_wrong_current_owner() {
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut registry = scenario.take_shared<membership::MembershipRegistry>();
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        membership::set_current_owner_for_testing(
            &mut registry,
            membership::membership_pass_lineage_id(&pass),
            OTHER,
        );

        membership::assert_current_pass_precheck(&registry, &pass, MEMBER);

        test_scenario::return_shared(registry);
        scenario.return_to_sender(pass);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = membership::ERegistryRecordNotActive)]
fun current_pass_precheck_rejects_inactive_registry_record_status() {
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut registry = scenario.take_shared<membership::MembershipRegistry>();
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        membership::set_membership_record_status_for_testing(
            &mut registry,
            membership::membership_pass_lineage_id(&pass),
            membership::status_suspended(),
        );

        membership::assert_current_pass_precheck(&registry, &pass, MEMBER);

        test_scenario::return_shared(registry);
        scenario.return_to_sender(pass);
    };

    scenario.end();
}

#[test]
fun current_pass_precheck_allows_active_pass_owner() {
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let registry = scenario.take_shared<membership::MembershipRegistry>();
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        membership::assert_current_pass_precheck(&registry, &pass, MEMBER);
        test_scenario::return_shared(registry);
        scenario.return_to_sender(pass);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = membership::EMembershipPassNotActive)]
fun suspended_pass_fails_current_pass_precheck() {
    run_inactive_status_precheck(membership::status_suspended());
}

#[test, expected_failure(abort_code = membership::EMembershipPassNotActive)]
fun revoked_pass_fails_current_pass_precheck() {
    run_inactive_status_precheck(membership::status_revoked());
}

#[test, expected_failure(abort_code = membership::EMembershipPassNotActive)]
fun migrated_pass_fails_current_pass_precheck() {
    run_inactive_status_precheck(membership::status_migrated());
}

#[test, expected_failure(abort_code = membership::EClaimantNotAuthorized)]
fun unrelated_claimant_fails_current_pass_precheck() {
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let registry = scenario.take_shared<membership::MembershipRegistry>();
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        membership::assert_current_pass_precheck(&registry, &pass, OTHER);
        test_scenario::return_shared(registry);
        scenario.return_to_sender(pass);
    };

    scenario.end();
}

#[test]
fun duplicate_claim_key_uses_pass_lineage_id_and_campaign_id() {
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);
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

#[test]
fun register_member_emits_home_cell_registered_event() {
    let mut scenario = initialized_with_pools();

    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<membership::MembershipRegistry>();
        let mut count_index = scenario.take_shared<cell_count_index::CellCountIndex>();
        let residence_registry =
            scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();

        accessor::register_member(
            &pause_state,
            &mut registry,
            &mut count_index,
            &residence_registry,
            HOME_CELL,
            target_proof(),
            TERMS_VERSION,
            SIGNED_STATEMENT_HASH,
            scenario.ctx(),
        );

        let home_cell_events =
            event::events_by_type<membership::HomeCellRegistered>();
        assert!(home_cell_events.length() == 1);
        let (event_lineage, event_home_cell, event_registered_at) =
            membership::home_cell_registered_event_fields(*home_cell_events.borrow(0));
        assert!(event_home_cell == HOME_CELL);
        assert!(event_registered_at == 0);

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(count_index);
        test_scenario::return_shared(residence_registry);

        scenario.next_tx(MEMBER);
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        assert!(event_lineage == membership::membership_pass_lineage_id(&pass));
        scenario.return_to_sender(pass);
    };

    scenario.end();
}

#[test]
fun update_home_cell_emits_home_cell_registered_event() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(HOME_CELL_UPDATED_AT_MS);
    let mut scenario = initialized_with_pools();
    register_member(&mut scenario);

    // update トランザクション内でイベント確認まで行う
    scenario.next_tx(MEMBER);
    let pass_lineage_id_for_check = {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let registry = scenario.take_shared<membership::MembershipRegistry>();
        let mut count_index = scenario.take_shared<cell_count_index::CellCountIndex>();
        let residence_registry =
            scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();
        let mut pass = scenario.take_from_sender<membership::MembershipPass>();

        accessor::update_member_home_cell(
            &pause_state,
            &registry,
            &mut count_index,
            &residence_registry,
            &mut pass,
            &clock,
            PROMOTED_HOME_CELL,
            promoted_proof(),
            scenario.ctx(),
        );

        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);
        let home_cell_events =
            event::events_by_type<membership::HomeCellRegistered>();
        assert!(home_cell_events.length() == 1);
        let (event_lineage, event_home_cell, event_registered_at) =
            membership::home_cell_registered_event_fields(*home_cell_events.borrow(0));
        assert!(event_lineage == pass_lineage_id);
        assert!(event_home_cell == PROMOTED_HOME_CELL);
        assert!(event_registered_at == HOME_CELL_UPDATED_AT_MS);

        scenario.return_to_sender(pass);
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(count_index);
        test_scenario::return_shared(residence_registry);
        pass_lineage_id
    };
    let _ = pass_lineage_id_for_check;

    scenario.end();
    clock.destroy_for_testing();
}

fun initialized_with_pools(): test_scenario::Scenario {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    let cap = scenario.take_from_sender<admin::AdminCap>();
    let mut residence_registry =
        scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();
    admin::update_allowed_residence_cell_root(
        &cap,
        &mut residence_registry,
        residence_root(),
        GEO_RESOLUTION,
        ALLOWLIST_VERSION,
        source_hash(),
        scenario.ctx(),
    );
    scenario.return_to_sender(cap);
    test_scenario::return_shared(residence_registry);

    scenario.next_tx(ADMIN);
    scenario
}

fun register_member(scenario: &mut test_scenario::Scenario) {
    register_member_with_proof(scenario, MEMBER, HOME_CELL, target_proof());
}

fun register_member_with_proof(
    scenario: &mut test_scenario::Scenario,
    member: address,
    home_cell: u64,
    proof: vector<allowed_residence_cell::ProofStep>,
) {
    scenario.next_tx(member);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<membership::MembershipRegistry>();
        let mut count_index = scenario.take_shared<cell_count_index::CellCountIndex>();
        let residence_registry =
            scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();

        accessor::register_member(
            &pause_state,
            &mut registry,
            &mut count_index,
            &residence_registry,
            home_cell,
            proof,
            TERMS_VERSION,
            SIGNED_STATEMENT_HASH,
            scenario.ctx(),
        );

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(count_index);
        test_scenario::return_shared(residence_registry);
    };
}

fun update_member_home_cell_with_proof(
    scenario: &mut test_scenario::Scenario,
    clock: &clock::Clock,
    sender: address,
    home_cell: u64,
    proof: vector<allowed_residence_cell::ProofStep>,
) {
    scenario.next_tx(sender);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let registry = scenario.take_shared<membership::MembershipRegistry>();
        let mut count_index = scenario.take_shared<cell_count_index::CellCountIndex>();
        let residence_registry =
            scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();
        let mut pass = test_scenario::take_from_address<membership::MembershipPass>(
            scenario,
            MEMBER,
        );

        accessor::update_member_home_cell(
            &pause_state,
            &registry,
            &mut count_index,
            &residence_registry,
            &mut pass,
            clock,
            home_cell,
            proof,
            scenario.ctx(),
        );

        test_scenario::return_to_address(MEMBER, pass);
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(count_index);
        test_scenario::return_shared(residence_registry);
    };
}

fun update_residence_root_to_promoted_single_leaf(scenario: &mut test_scenario::Scenario) {
    update_residence_root_to_single_leaf(scenario, PROMOTED_HOME_CELL);
}

fun update_residence_root_to_single_leaf(scenario: &mut test_scenario::Scenario, home_cell: u64) {
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut residence_registry =
            scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();
        admin::update_allowed_residence_cell_root(
            &cap,
            &mut residence_registry,
            allowed_residence_cell::leaf_hash_for_testing(
                home_cell,
                GEO_RESOLUTION,
                ALLOWLIST_VERSION,
            ),
            GEO_RESOLUTION,
            ALLOWLIST_VERSION,
            source_hash(),
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(residence_registry);
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
    register_member(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let registry = scenario.take_shared<membership::MembershipRegistry>();
        let mut pass = scenario.take_from_sender<membership::MembershipPass>();
        membership::set_status_for_testing(&mut pass, status);
        membership::assert_current_pass_precheck(&registry, &pass, MEMBER);
        test_scenario::return_shared(registry);
        scenario.return_to_sender(pass);
    };

    scenario.end();
}

fun target_proof(): vector<allowed_residence_cell::ProofStep> {
    vector[
        accessor::new_residence_proof_step_left(
            x"07985a56b782bd13b8ec079d4c243c8c2399605872223fc86066f59f4ae37569",
        ),
        accessor::new_residence_proof_step_right(
            x"8f8a501ba455071229e715f5eccb4322190440fa2ecb6b72d123378648b60ec7",
        ),
    ]
}

fun promoted_proof(): vector<allowed_residence_cell::ProofStep> {
    vector[
        accessor::new_residence_proof_step_left(
            x"312e3863ccf00e446423342e1acebdab8e7119ee19dae854904de693225c2678",
        ),
    ]
}

fun residence_root(): vector<u8> {
    x"a26a12dc49754fde5b90e6bff69d1bc8b51fb8a3de07aa9122a9a2958bb75020"
}

fun source_hash(): vector<u8> {
    x"1111111111111111111111111111111111111111111111111111111111111111"
}
