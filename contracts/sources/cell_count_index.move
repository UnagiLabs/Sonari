module contracts::cell_count_index;

use sui::dynamic_field;
use sui::dynamic_object_field;
use sui::event;

const H3_RESOLUTION_RES7: u8 = 7;
const SHARD_COUNT: u64 = 4_096;

const EShardIndexMismatch: u64 = 0;
const EShardIdMismatch: u64 = 1;
const ECellCountMissing: u64 = 2;
const ECellCountUnderflow: u64 = 3;
const EMembershipRegistryMismatch: u64 = 4;

public struct CellCountIndex has key {
    id: UID,
    membership_registry_id: ID,
    h3_resolution: u8,
    shard_count: u64,
}

public struct CellCountShard has key, store {
    id: UID,
    index_id: ID,
    shard_id: u64,
}

public struct CellCount has copy, drop, store {
    active_count: u64,
}

public struct CellCountIndexCreated has copy, drop {
    index_id: ID,
    membership_registry_id: ID,
    h3_resolution: u8,
    shard_count: u64,
    actor: address,
}

public struct CellCountShardCreated has copy, drop {
    index_id: ID,
    shard_object_id: ID,
    shard_index_id: ID,
    shard_id: u64,
    actor: address,
}

public(package) fun create_index(
    membership_registry_id: ID,
    ctx: &mut TxContext,
): ID {
    let index = CellCountIndex {
        id: object::new(ctx),
        membership_registry_id,
        h3_resolution: H3_RESOLUTION_RES7,
        shard_count: SHARD_COUNT,
    };
    let index_id = object::id(&index);

    event::emit(CellCountIndexCreated {
        index_id,
        membership_registry_id,
        h3_resolution: H3_RESOLUTION_RES7,
        shard_count: SHARD_COUNT,
        actor: ctx.sender(),
    });

    transfer::share_object(index);
    index_id
}

public fun read_count_or_zero(index: &CellCountIndex, h3_cell: u64): u64 {
    let shard_id = shard_id(h3_cell);
    if (!dynamic_object_field::exists_with_type<u64, CellCountShard>(&index.id, shard_id)) {
        return 0
    };

    let shard = dynamic_object_field::borrow<u64, CellCountShard>(&index.id, shard_id);
    assert_valid_shard(index, shard, shard_id);
    if (!dynamic_field::exists_with_type<u64, CellCount>(&shard.id, h3_cell)) {
        return 0
    };

    dynamic_field::borrow<u64, CellCount>(&shard.id, h3_cell).active_count
}

public fun read_counts_or_zero(index: &CellCountIndex, h3_cells: vector<u64>): vector<u64> {
    let mut counts = vector[];
    let mut i = 0;
    while (i < h3_cells.length()) {
        counts.push_back(read_count_or_zero(index, *h3_cells.borrow(i)));
        i = i + 1;
    };
    counts
}

public(package) fun increment_or_create(
    index: &mut CellCountIndex,
    h3_cell: u64,
    ctx: &mut TxContext,
): u64 {
    let shard_id = shard_id(h3_cell);
    ensure_shard(index, shard_id, ctx);
    let index_id = object::id(index);
    let shard = dynamic_object_field::borrow_mut<u64, CellCountShard>(&mut index.id, shard_id);
    assert_valid_shard_for_id(index_id, shard, shard_id);

    if (dynamic_field::exists_with_type<u64, CellCount>(&shard.id, h3_cell)) {
        let count = dynamic_field::borrow_mut<u64, CellCount>(&mut shard.id, h3_cell);
        count.active_count = count.active_count + 1;
        count.active_count
    } else {
        dynamic_field::add(&mut shard.id, h3_cell, CellCount { active_count: 1 });
        1
    }
}

public(package) fun assert_membership_registry_id(index: &CellCountIndex, registry_id: ID) {
    assert!(index.membership_registry_id == registry_id, EMembershipRegistryMismatch);
}

public(package) fun decrement_existing(index: &mut CellCountIndex, h3_cell: u64): u64 {
    let shard_id = shard_id(h3_cell);
    assert!(
        dynamic_object_field::exists_with_type<u64, CellCountShard>(&index.id, shard_id),
        ECellCountMissing,
    );

    let index_id = object::id(index);
    let shard = dynamic_object_field::borrow_mut<u64, CellCountShard>(&mut index.id, shard_id);
    assert_valid_shard_for_id(index_id, shard, shard_id);
    assert!(
        dynamic_field::exists_with_type<u64, CellCount>(&shard.id, h3_cell),
        ECellCountMissing,
    );

    let count = dynamic_field::borrow_mut<u64, CellCount>(&mut shard.id, h3_cell);
    assert!(count.active_count > 0, ECellCountUnderflow);
    count.active_count = count.active_count - 1;
    count.active_count
}

fun ensure_shard(index: &mut CellCountIndex, shard_id: u64, ctx: &mut TxContext) {
    if (dynamic_object_field::exists_with_type<u64, CellCountShard>(&index.id, shard_id)) {
        return
    };

    let shard = CellCountShard {
        id: object::new(ctx),
        index_id: object::id(index),
        shard_id,
    };
    let shard_object_id = object::id(&shard);
    let shard_index_id = shard.index_id;
    dynamic_object_field::add(&mut index.id, shard_id, shard);

    event::emit(CellCountShardCreated {
        index_id: object::id(index),
        shard_object_id,
        shard_index_id,
        shard_id,
        actor: ctx.sender(),
    });
}

fun shard_id(h3_cell: u64): u64 {
    h3_cell % SHARD_COUNT
}

fun assert_valid_shard(index: &CellCountIndex, shard: &CellCountShard, shard_id: u64) {
    assert_valid_shard_for_id(object::id(index), shard, shard_id);
}

fun assert_valid_shard_for_id(index_id: ID, shard: &CellCountShard, shard_id: u64) {
    assert!(shard.index_id == index_id, EShardIndexMismatch);
    assert!(shard.shard_id == shard_id, EShardIdMismatch);
}

#[test_only]
public fun create_index_for_testing(
    membership_registry_id: ID,
    ctx: &mut TxContext,
): ID {
    create_index(membership_registry_id, ctx)
}

#[test_only]
public fun index_fields_for_testing(index: &CellCountIndex): (ID, ID, u8, u64) {
    (
        object::id(index),
        index.membership_registry_id,
        index.h3_resolution,
        index.shard_count,
    )
}

#[test_only]
public fun shard_id_for_testing(h3_cell: u64): u64 {
    shard_id(h3_cell)
}

#[test_only]
public fun has_shard_for_testing(index: &CellCountIndex, shard_id: u64): bool {
    dynamic_object_field::exists_with_type<u64, CellCountShard>(&index.id, shard_id)
}

#[test_only]
public fun shard_object_id_for_testing(index: &CellCountIndex, shard_id: u64): ID {
    object::id(dynamic_object_field::borrow<u64, CellCountShard>(&index.id, shard_id))
}

#[test_only]
public fun has_cell_for_testing(index: &CellCountIndex, h3_cell: u64): bool {
    let shard_id = shard_id(h3_cell);
    if (!dynamic_object_field::exists_with_type<u64, CellCountShard>(&index.id, shard_id)) {
        return false
    };
    let shard = dynamic_object_field::borrow<u64, CellCountShard>(&index.id, shard_id);
    dynamic_field::exists_with_type<u64, CellCount>(&shard.id, h3_cell)
}

#[test_only]
public fun set_count_for_testing(index: &mut CellCountIndex, h3_cell: u64, active_count: u64) {
    let shard_id = shard_id(h3_cell);
    let shard = dynamic_object_field::borrow_mut<u64, CellCountShard>(&mut index.id, shard_id);
    let count = dynamic_field::borrow_mut<u64, CellCount>(&mut shard.id, h3_cell);
    count.active_count = active_count;
}

#[test_only]
public fun remove_count_for_testing(index: &mut CellCountIndex, h3_cell: u64) {
    let shard_id = shard_id(h3_cell);
    let shard = dynamic_object_field::borrow_mut<u64, CellCountShard>(&mut index.id, shard_id);
    let _ = dynamic_field::remove<u64, CellCount>(&mut shard.id, h3_cell);
}

#[test_only]
public fun cell_count_index_created_event_fields(
    event: CellCountIndexCreated,
): (ID, ID, u8, u64, address) {
    let CellCountIndexCreated {
        index_id,
        membership_registry_id,
        h3_resolution,
        shard_count,
        actor,
    } = event;
    (index_id, membership_registry_id, h3_resolution, shard_count, actor)
}

#[test_only]
public fun cell_count_shard_created_event_fields(
    event: CellCountShardCreated,
): (ID, ID, ID, u64, address) {
    let CellCountShardCreated {
        index_id,
        shard_object_id,
        shard_index_id,
        shard_id,
        actor,
    } = event;
    (index_id, shard_object_id, shard_index_id, shard_id, actor)
}
