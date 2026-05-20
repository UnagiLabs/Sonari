module contracts::disaster_event;

use contracts::admin::AdminCap;
use contracts::payload_v1::{Self, Payload};
use sui::dynamic_field;
use sui::event;

const EDuplicateDisasterEvent: u64 = 0;

public struct DisasterRegistry has key {
    id: UID,
    event_count: u64,
}

public struct DisasterEvent has key {
    id: UID,
    event_uid: vector<u8>,
    event_revision: u32,
    hazard_type: u8,
    occurred_at_ms: u64,
    affected_cells_root: vector<u8>,
    affected_cells_data_hash: vector<u8>,
    affected_cell_count: u64,
    min_claim_band: u8,
    created_at_ms: u64,
}

public struct DisasterEventKey has copy, drop, store {
    event_uid: vector<u8>,
    event_revision: u32,
}

public struct DisasterRegistryCreated has copy, drop {
    registry_id: ID,
    created_at_ms: u64,
    actor: address,
}

public struct DisasterEventCreated has copy, drop {
    disaster_event_id: ID,
    event_uid: vector<u8>,
    event_revision: u32,
    hazard_type: u8,
    affected_cells_root: vector<u8>,
    affected_cell_count: u64,
    min_claim_band: u8,
    created_at_ms: u64,
    actor: address,
}

public(package) fun create_disaster_registry(_: &AdminCap, ctx: &mut TxContext) {
    let registry = DisasterRegistry {
        id: object::new(ctx),
        event_count: 0,
    };
    let registry_id = object::id(&registry);
    event::emit(DisasterRegistryCreated {
        registry_id,
        created_at_ms: ctx.epoch_timestamp_ms(),
        actor: ctx.sender(),
    });
    transfer::share_object(registry);
}

public(package) fun create_from_payload(
    _: &AdminCap,
    registry: &mut DisasterRegistry,
    payload: Payload,
    ctx: &mut TxContext,
) {
    let key = DisasterEventKey {
        event_uid: payload_v1::event_uid(&payload),
        event_revision: payload_v1::event_revision(&payload),
    };
    assert!(
        !dynamic_field::exists_with_type<DisasterEventKey, bool>(&registry.id, key),
        EDuplicateDisasterEvent,
    );
    dynamic_field::add(&mut registry.id, key, true);
    registry.event_count = registry.event_count + 1;

    let disaster_event = DisasterEvent {
        id: object::new(ctx),
        event_uid: payload_v1::event_uid(&payload),
        event_revision: payload_v1::event_revision(&payload),
        hazard_type: payload_v1::hazard_type(&payload),
        occurred_at_ms: payload_v1::occurred_at_ms(&payload),
        affected_cells_root: payload_v1::affected_cells_root(&payload),
        affected_cells_data_hash: payload_v1::affected_cells_data_hash(&payload),
        affected_cell_count: payload_v1::affected_cell_count(&payload),
        min_claim_band: payload_v1::min_claim_band(&payload),
        created_at_ms: ctx.epoch_timestamp_ms(),
    };
    let disaster_event_id = object::id(&disaster_event);

    event::emit(DisasterEventCreated {
        disaster_event_id,
        event_uid: disaster_event.event_uid,
        event_revision: disaster_event.event_revision,
        hazard_type: disaster_event.hazard_type,
        affected_cells_root: disaster_event.affected_cells_root,
        affected_cell_count: disaster_event.affected_cell_count,
        min_claim_band: disaster_event.min_claim_band,
        created_at_ms: disaster_event.created_at_ms,
        actor: ctx.sender(),
    });

    transfer::share_object(disaster_event);
}

public fun affected_cells_root(disaster_event: &DisasterEvent): vector<u8> {
    disaster_event.affected_cells_root
}

public fun min_claim_band(disaster_event: &DisasterEvent): u8 {
    disaster_event.min_claim_band
}

public fun disaster_registry_event_count(registry: &DisasterRegistry): u64 {
    registry.event_count
}

#[test_only]
public fun disaster_event_created_event_fields(
    event: DisasterEventCreated,
): (vector<u8>, u32, vector<u8>, u64, address) {
    let DisasterEventCreated {
        disaster_event_id: _,
        event_uid,
        event_revision,
        hazard_type: _,
        affected_cells_root,
        affected_cell_count,
        min_claim_band: _,
        created_at_ms: _,
        actor,
    } = event;
    (
        event_uid,
        event_revision,
        affected_cells_root,
        affected_cell_count,
        actor,
    )
}
