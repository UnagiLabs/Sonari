#[test_only]
module contracts::cell_count_index_tests;

use contracts::cell_count_index;
use contracts::reader;
use sui::event;
use sui::test_scenario;

const ADMIN: address = @0xA11CE;
const MEMBERSHIP_REGISTRY_ID_ADDRESS: address = @0x1234;
const H3_CELL: u64 = 608_819_013_597_790_207;
const SAME_SHARD_H3_CELL: u64 = H3_CELL + 4_096;
const OTHER_H3_CELL: u64 = H3_CELL + 1;

#[test]
fun create_index_sets_fields_and_emits_event() {
    let mut scenario = test_scenario::begin(ADMIN);

    let membership_registry_id = object::id_from_address(MEMBERSHIP_REGISTRY_ID_ADDRESS);
    let index_id = cell_count_index::create_index_for_testing(
        membership_registry_id,
        scenario.ctx(),
    );

    let emitted = event::events_by_type<cell_count_index::CellCountIndexCreated>();
    assert!(emitted.length() == 1);
    let (
        event_index_id,
        event_membership_registry_id,
        event_h3_resolution,
        event_shard_count,
        event_actor,
    ) = cell_count_index::cell_count_index_created_event_fields(*emitted.borrow(0));
    assert!(event_index_id == index_id);
    assert!(event_membership_registry_id == membership_registry_id);
    assert!(event_h3_resolution == 7);
    assert!(event_shard_count == 4_096);
    assert!(event_actor == ADMIN);

    scenario.next_tx(ADMIN);
    {
        let index = scenario.take_shared_by_id<cell_count_index::CellCountIndex>(index_id);
        let (
            field_index_id,
            field_membership_registry_id,
            field_h3_resolution,
            field_shard_count,
        ) = cell_count_index::index_fields_for_testing(&index);
        assert!(field_index_id == index_id);
        assert!(field_membership_registry_id == membership_registry_id);
        assert!(field_h3_resolution == 7);
        assert!(field_shard_count == 4_096);
        test_scenario::return_shared(index);
    };

    scenario.end();
}

#[test]
fun missing_shard_and_missing_cell_read_as_zero() {
    let mut scenario = initialized();
    let index_id = create_index(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut index = scenario.take_shared_by_id<cell_count_index::CellCountIndex>(index_id);
        assert!(reader::read_cell_count_or_zero(&index, H3_CELL) == 0);

        cell_count_index::increment_or_create(&mut index, H3_CELL, scenario.ctx());
        assert!(reader::read_cell_count_or_zero(&index, OTHER_H3_CELL) == 0);

        let counts = reader::read_cell_counts_or_zero(&index, vector[H3_CELL, OTHER_H3_CELL]);
        assert!(*counts.borrow(0) == 1);
        assert!(*counts.borrow(1) == 0);

        test_scenario::return_shared(index);
    };

    scenario.end();
}

#[test]
fun first_increment_lazily_creates_shard_and_cell_count() {
    let mut scenario = initialized();
    let index_id = create_index(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut index = scenario.take_shared_by_id<cell_count_index::CellCountIndex>(index_id);
        let shard_id = cell_count_index::shard_id_for_testing(H3_CELL);

        assert!(!cell_count_index::has_shard_for_testing(&index, shard_id));
        cell_count_index::increment_or_create(&mut index, H3_CELL, scenario.ctx());
        assert!(cell_count_index::has_shard_for_testing(&index, shard_id));
        assert!(reader::read_cell_count_or_zero(&index, H3_CELL) == 1);

        let emitted = event::events_by_type<cell_count_index::CellCountShardCreated>();
        assert!(emitted.length() == 1);
        let (
            event_index_id,
            event_shard_object_id,
            event_shard_index_id,
            event_shard_id,
            event_actor,
        ) = cell_count_index::cell_count_shard_created_event_fields(*emitted.borrow(0));
        assert!(event_index_id == index_id);
        assert!(event_shard_object_id == cell_count_index::shard_object_id_for_testing(&index, shard_id));
        assert!(event_shard_index_id == index_id);
        assert!(event_shard_id == shard_id);
        assert!(event_actor == ADMIN);

        test_scenario::return_shared(index);
    };

    scenario.end();
}

#[test]
fun second_increment_in_same_shard_increments_existing_count() {
    let mut scenario = initialized();
    let index_id = create_index(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut index = scenario.take_shared_by_id<cell_count_index::CellCountIndex>(index_id);
        let shard_id = cell_count_index::shard_id_for_testing(H3_CELL);
        assert!(cell_count_index::shard_id_for_testing(SAME_SHARD_H3_CELL) == shard_id);

        cell_count_index::increment_or_create(&mut index, H3_CELL, scenario.ctx());
        let shard_object_id = cell_count_index::shard_object_id_for_testing(&index, shard_id);
        cell_count_index::increment_or_create(&mut index, H3_CELL, scenario.ctx());
        cell_count_index::increment_or_create(&mut index, SAME_SHARD_H3_CELL, scenario.ctx());

        assert!(reader::read_cell_count_or_zero(&index, H3_CELL) == 2);
        assert!(reader::read_cell_count_or_zero(&index, SAME_SHARD_H3_CELL) == 1);
        assert!(cell_count_index::shard_object_id_for_testing(&index, shard_id) == shard_object_id);

        let emitted = event::events_by_type<cell_count_index::CellCountShardCreated>();
        assert!(emitted.length() == 1);

        test_scenario::return_shared(index);
    };

    scenario.end();
}

#[test]
fun decrement_to_zero_keeps_cell_readable_and_reincrement_works() {
    let mut scenario = initialized();
    let index_id = create_index(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut index = scenario.take_shared_by_id<cell_count_index::CellCountIndex>(index_id);

        cell_count_index::increment_or_create(&mut index, H3_CELL, scenario.ctx());
        assert!(cell_count_index::has_cell_for_testing(&index, H3_CELL));
        cell_count_index::decrement_existing(&mut index, H3_CELL);
        assert!(reader::read_cell_count_or_zero(&index, H3_CELL) == 0);
        assert!(cell_count_index::has_cell_for_testing(&index, H3_CELL));

        cell_count_index::increment_or_create(&mut index, H3_CELL, scenario.ctx());
        assert!(reader::read_cell_count_or_zero(&index, H3_CELL) == 1);
        assert!(cell_count_index::has_cell_for_testing(&index, H3_CELL));

        test_scenario::return_shared(index);
    };

    scenario.end();
}

#[test]
fun shard_id_derives_from_h3_cell_mod_shard_count() {
    assert!(cell_count_index::shard_id_for_testing(H3_CELL) == H3_CELL % 4_096);
    assert!(cell_count_index::shard_id_for_testing(4_096) == 0);
    assert!(cell_count_index::shard_id_for_testing(4_097) == 1);
}

fun initialized(): test_scenario::Scenario {
    test_scenario::begin(ADMIN)
}

fun create_index(scenario: &mut test_scenario::Scenario): ID {
    cell_count_index::create_index_for_testing(
        object::id_from_address(MEMBERSHIP_REGISTRY_ID_ADDRESS),
        scenario.ctx(),
    )
}
