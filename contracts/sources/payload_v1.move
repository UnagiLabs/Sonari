module contracts::payload_v1;

use sui::bcs::{Self, BCS};

const INTENT_DISASTER_ORACLE_PAYLOAD_V1: u8 = 1;
const ORACLE_VERSION_V1: u64 = 1;
const HAZARD_TYPE_EARTHQUAKE: u8 = 1;
const STATUS_FINALIZED: u8 = 3;
const MIN_CLAIM_BAND_V1: u8 = 1;

const EInvalidIntent: u64 = 0;
const EUnsupportedVersion: u64 = 1;
const ENonFinalizedStatus: u64 = 2;
const EExpiredFreshness: u64 = 3;
const EEmptyAffectedCellsUri: u64 = 4;
const ENoAffectedCells: u64 = 5;
const EInvalidMinClaimBand: u64 = 6;
const ETrailingBytes: u64 = 7;
const EInvalidHashLength: u64 = 8;

public struct Payload has copy, drop, store {
    intent: u8,
    oracle_version: u64,
    event_uid: vector<u8>,
    hazard_type: u8,
    status: u8,
    event_revision: u32,
    occurred_at_ms: u64,
    observed_at_ms: u64,
    source_updated_at_ms: u64,
    primary_source: u8,
    severity_band: u8,
    source_set_hash: vector<u8>,
    raw_data_hash: vector<u8>,
    raw_data_uri: vector<u8>,
    affected_cells_root: vector<u8>,
    affected_cells_uri: vector<u8>,
    affected_cells_data_hash: vector<u8>,
    geo_resolution: u8,
    cells_generation_method: u8,
    cell_metric: u8,
    cell_aggregation: u8,
    intensity_scale: u8,
    max_cell_band: u8,
    affected_cell_count: u64,
    min_claim_band: u8,
    freshness_deadline_ms: u64,
}

public fun decode_finalized(bytes: vector<u8>, now_ms: u64): Payload {
    let mut bcs = bcs::new(bytes);
    let payload = Payload {
        intent: bcs.peel_u8(),
        oracle_version: bcs.peel_u64(),
        event_uid: peel_bytes32(&mut bcs),
        hazard_type: bcs.peel_u8(),
        status: bcs.peel_u8(),
        event_revision: bcs.peel_u32(),
        occurred_at_ms: bcs.peel_u64(),
        observed_at_ms: bcs.peel_u64(),
        source_updated_at_ms: bcs.peel_u64(),
        primary_source: bcs.peel_u8(),
        severity_band: bcs.peel_u8(),
        source_set_hash: peel_bytes32(&mut bcs),
        raw_data_hash: peel_bytes32(&mut bcs),
        raw_data_uri: bcs.peel_vec_u8(),
        affected_cells_root: peel_bytes32(&mut bcs),
        affected_cells_uri: bcs.peel_vec_u8(),
        affected_cells_data_hash: peel_bytes32(&mut bcs),
        geo_resolution: bcs.peel_u8(),
        cells_generation_method: bcs.peel_u8(),
        cell_metric: bcs.peel_u8(),
        cell_aggregation: bcs.peel_u8(),
        intensity_scale: bcs.peel_u8(),
        max_cell_band: bcs.peel_u8(),
        affected_cell_count: bcs.peel_u64(),
        min_claim_band: bcs.peel_u8(),
        freshness_deadline_ms: bcs.peel_u64(),
    };
    assert!(bcs.into_remainder_bytes().length() == 0, ETrailingBytes);
    assert_finalized(&payload, now_ms);
    payload
}

fun assert_finalized(payload: &Payload, now_ms: u64) {
    assert!(payload.intent == INTENT_DISASTER_ORACLE_PAYLOAD_V1, EInvalidIntent);
    assert!(payload.oracle_version == ORACLE_VERSION_V1, EUnsupportedVersion);
    assert!(payload.status == STATUS_FINALIZED, ENonFinalizedStatus);
    assert!(payload.freshness_deadline_ms > now_ms, EExpiredFreshness);
    assert!(payload.affected_cells_uri.length() > 0, EEmptyAffectedCellsUri);
    assert!(payload.affected_cell_count > 0, ENoAffectedCells);
    assert!(payload.min_claim_band == MIN_CLAIM_BAND_V1, EInvalidMinClaimBand);
    assert_32_bytes(&payload.event_uid);
    assert_32_bytes(&payload.source_set_hash);
    assert_32_bytes(&payload.raw_data_hash);
    assert_32_bytes(&payload.affected_cells_root);
    assert_32_bytes(&payload.affected_cells_data_hash);
}

fun peel_bytes32(bcs: &mut BCS): vector<u8> {
    vector::tabulate!(32, |_| bcs.peel_u8())
}

fun assert_32_bytes(bytes: &vector<u8>) {
    assert!(bytes.length() == 32, EInvalidHashLength);
}

public fun payload_summary(
    payload: &Payload,
): (u8, u64, vector<u8>, u8, u8, u32, vector<u8>, u64, u8) {
    (
        payload.intent,
        payload.oracle_version,
        payload.event_uid,
        payload.hazard_type,
        payload.status,
        payload.event_revision,
        payload.affected_cells_root,
        payload.affected_cell_count,
        payload.min_claim_band,
    )
}

public fun event_uid(payload: &Payload): vector<u8> {
    payload.event_uid
}

public fun event_revision(payload: &Payload): u32 {
    payload.event_revision
}

public fun hazard_type(payload: &Payload): u8 {
    payload.hazard_type
}

public fun affected_cells_root(payload: &Payload): vector<u8> {
    payload.affected_cells_root
}

public fun affected_cells_data_hash(payload: &Payload): vector<u8> {
    payload.affected_cells_data_hash
}

public fun affected_cell_count(payload: &Payload): u64 {
    payload.affected_cell_count
}

public fun min_claim_band(payload: &Payload): u8 {
    payload.min_claim_band
}

public fun occurred_at_ms(payload: &Payload): u64 {
    payload.occurred_at_ms
}

public fun intent_disaster_oracle_payload_v1(): u8 {
    INTENT_DISASTER_ORACLE_PAYLOAD_V1
}

public fun hazard_type_earthquake(): u8 {
    HAZARD_TYPE_EARTHQUAKE
}

public fun status_finalized(): u8 {
    STATUS_FINALIZED
}
