module contracts::payload;

use sui::bcs::{Self, BCS};

const INTENT_EARTHQUAKE_ORACLE_PAYLOAD: u8 = 1;
const ORACLE_VERSION: u64 = 1;
const HAZARD_TYPE_EARTHQUAKE: u8 = 1;
const STATUS_FINALIZED: u8 = 3;
const PRIMARY_SOURCE_USGS: u8 = 1;
const CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1: u8 = 1;
const CELL_METRIC_USGS_MMI: u8 = 1;
const CELL_AGGREGATION_GRID_POINT_P90: u8 = 1;
const INTENSITY_SCALE_MMI_X100: u8 = 1;
const MAX_SOURCE_EVENT_ID_BYTES: u64 = 96;
const MAX_TITLE_BYTES: u64 = 160;
const MAX_REGION_BYTES: u64 = 160;
const MAX_URI_BYTES: u64 = 512;
const MAX_MAGNITUDE_X100: u64 = 2000;
const MAX_AFFECTED_CELL_COUNT: u64 = 1_000_000;
const FRESHNESS_WINDOW_MS: u64 = 21_600_000;
const U64_MAX: u64 = 18_446_744_073_709_551_615;

const EInvalidIntent: u64 = 0;
const EUnsupportedVersion: u64 = 1;
const ENonFinalizedStatus: u64 = 2;
const EExpiredFreshness: u64 = 3;
const EInvalidAffectedCellsUriLength: u64 = 4;
const EInvalidAffectedCellCount: u64 = 5;
const EInvalidMagnitude: u64 = 6;
const ETrailingBytes: u64 = 7;
const EInvalidHashLength: u64 = 8;
const EUnsupportedHazardType: u64 = 9;
const EUnsupportedGeoResolution: u64 = 10;
const EUnsupportedPrimarySource: u64 = 11;
const EInvalidSeverityBand: u64 = 12;
const EUnsupportedCellsGenerationMethod: u64 = 13;
const EUnsupportedCellMetric: u64 = 14;
const EUnsupportedCellAggregation: u64 = 15;
const EUnsupportedIntensityScale: u64 = 16;
const EInvalidEventRevision: u64 = 17;
const EInvalidSourceEventIdLength: u64 = 18;
const EInvalidTitleLength: u64 = 19;
const EInvalidRegionLength: u64 = 20;
const EInvalidRawDataUriLength: u64 = 21;
const EInvalidFreshnessDeadline: u64 = 22;

public struct Payload has copy, drop, store {
    intent: u8,
    oracle_version: u64,
    event_uid: vector<u8>,
    hazard_type: u8,
    status: u8,
    event_revision: u32,
    source_event_id: vector<u8>,
    title: vector<u8>,
    region: vector<u8>,
    occurred_at_ms: u64,
    magnitude_x100: u64,
    verified_at_ms: u64,
    source_updated_at_ms: u64,
    primary_source: u8,
    severity_band: u8,
    source_set_hash: vector<u8>,
    raw_data_hash: vector<u8>,
    raw_data_uri: vector<u8>,
    affected_cells_root: vector<u8>,
    affected_cells_uri: vector<u8>,
    affected_cells_data_hash: vector<u8>,
    affected_cell_count: u64,
    geo_resolution: u8,
    cells_generation_method: u8,
    cell_metric: u8,
    cell_aggregation: u8,
    intensity_scale: u8,
    freshness_deadline_ms: u64,
}

public(package) fun decode_finalized(bytes: vector<u8>, now_ms: u64): Payload {
    let mut bcs = bcs::new(bytes);
    let payload = Payload {
        intent: bcs.peel_u8(),
        oracle_version: bcs.peel_u64(),
        event_uid: peel_bytes32(&mut bcs),
        hazard_type: bcs.peel_u8(),
        status: bcs.peel_u8(),
        event_revision: bcs.peel_u32(),
        source_event_id: bcs.peel_vec_u8(),
        title: bcs.peel_vec_u8(),
        region: bcs.peel_vec_u8(),
        occurred_at_ms: bcs.peel_u64(),
        magnitude_x100: bcs.peel_u64(),
        verified_at_ms: bcs.peel_u64(),
        source_updated_at_ms: bcs.peel_u64(),
        primary_source: bcs.peel_u8(),
        severity_band: bcs.peel_u8(),
        source_set_hash: peel_bytes32(&mut bcs),
        raw_data_hash: peel_bytes32(&mut bcs),
        raw_data_uri: bcs.peel_vec_u8(),
        affected_cells_root: peel_bytes32(&mut bcs),
        affected_cells_uri: bcs.peel_vec_u8(),
        affected_cells_data_hash: peel_bytes32(&mut bcs),
        affected_cell_count: bcs.peel_u64(),
        geo_resolution: bcs.peel_u8(),
        cells_generation_method: bcs.peel_u8(),
        cell_metric: bcs.peel_u8(),
        cell_aggregation: bcs.peel_u8(),
        intensity_scale: bcs.peel_u8(),
        freshness_deadline_ms: bcs.peel_u64(),
    };
    assert!(bcs.into_remainder_bytes().length() == 0, ETrailingBytes);
    assert_finalized(&payload, now_ms);
    payload
}

fun assert_finalized(payload: &Payload, now_ms: u64) {
    assert!(payload.intent == INTENT_EARTHQUAKE_ORACLE_PAYLOAD, EInvalidIntent);
    assert!(payload.oracle_version == ORACLE_VERSION, EUnsupportedVersion);
    assert!(payload.hazard_type == HAZARD_TYPE_EARTHQUAKE, EUnsupportedHazardType);
    assert!(payload.status == STATUS_FINALIZED, ENonFinalizedStatus);
    assert!(payload.event_revision > 0, EInvalidEventRevision);
    assert!(length_in_range(&payload.source_event_id, 1, MAX_SOURCE_EVENT_ID_BYTES), EInvalidSourceEventIdLength);
    assert!(length_in_range(&payload.title, 1, MAX_TITLE_BYTES), EInvalidTitleLength);
    assert!(length_in_range(&payload.region, 1, MAX_REGION_BYTES), EInvalidRegionLength);
    assert!(
        1 <= payload.magnitude_x100 && payload.magnitude_x100 <= MAX_MAGNITUDE_X100,
        EInvalidMagnitude,
    );
    assert!(payload.primary_source == PRIMARY_SOURCE_USGS, EUnsupportedPrimarySource);
    assert!(1 <= payload.severity_band && payload.severity_band <= 3, EInvalidSeverityBand);
    assert!(
        payload.cells_generation_method ==
            CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1,
        EUnsupportedCellsGenerationMethod,
    );
    assert!(payload.cell_metric == CELL_METRIC_USGS_MMI, EUnsupportedCellMetric);
    assert!(payload.cell_aggregation == CELL_AGGREGATION_GRID_POINT_P90, EUnsupportedCellAggregation);
    assert!(payload.intensity_scale == INTENSITY_SCALE_MMI_X100, EUnsupportedIntensityScale);
    assert!(length_in_range(&payload.raw_data_uri, 1, MAX_URI_BYTES), EInvalidRawDataUriLength);
    assert!(length_in_range(&payload.affected_cells_uri, 1, MAX_URI_BYTES), EInvalidAffectedCellsUriLength);
    assert!(
        1 <= payload.affected_cell_count && payload.affected_cell_count <= MAX_AFFECTED_CELL_COUNT,
        EInvalidAffectedCellCount,
    );
    assert!(payload.geo_resolution == 7, EUnsupportedGeoResolution);
    assert!(payload.verified_at_ms <= U64_MAX - FRESHNESS_WINDOW_MS, EInvalidFreshnessDeadline);
    assert!(
        payload.freshness_deadline_ms == payload.verified_at_ms + FRESHNESS_WINDOW_MS,
        EInvalidFreshnessDeadline,
    );
    assert!(payload.freshness_deadline_ms > now_ms, EExpiredFreshness);
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

fun length_in_range(bytes: &vector<u8>, min: u64, max: u64): bool {
    let length = bytes.length();
    min <= length && length <= max
}

public(package) fun payload_summary(
    payload: &Payload,
): (
    u8,
    u64,
    vector<u8>,
    u8,
    u8,
    u32,
    vector<u8>,
    vector<u8>,
    vector<u8>,
    u64,
    u64,
    u64,
    u8,
    u8,
    vector<u8>,
    u64,
) {
    (
        payload.intent,
        payload.oracle_version,
        payload.event_uid,
        payload.hazard_type,
        payload.status,
        payload.event_revision,
        payload.source_event_id,
        payload.title,
        payload.region,
        payload.magnitude_x100,
        payload.verified_at_ms,
        payload.source_updated_at_ms,
        payload.primary_source,
        payload.severity_band,
        payload.affected_cells_root,
        payload.affected_cell_count,
    )
}

public(package) fun event_uid(payload: &Payload): vector<u8> {
    payload.event_uid
}

public(package) fun event_revision(payload: &Payload): u32 {
    payload.event_revision
}

public(package) fun hazard_type(payload: &Payload): u8 {
    payload.hazard_type
}

public(package) fun oracle_version(payload: &Payload): u64 {
    payload.oracle_version
}

public(package) fun source_event_id(payload: &Payload): vector<u8> {
    payload.source_event_id
}

public(package) fun title(payload: &Payload): vector<u8> {
    payload.title
}

public(package) fun region(payload: &Payload): vector<u8> {
    payload.region
}

public(package) fun magnitude_x100(payload: &Payload): u64 {
    payload.magnitude_x100
}

public(package) fun verified_at_ms(payload: &Payload): u64 {
    payload.verified_at_ms
}

public(package) fun source_updated_at_ms(payload: &Payload): u64 {
    payload.source_updated_at_ms
}

public(package) fun primary_source(payload: &Payload): u8 {
    payload.primary_source
}

public(package) fun source_set_hash(payload: &Payload): vector<u8> {
    payload.source_set_hash
}

public(package) fun raw_data_hash(payload: &Payload): vector<u8> {
    payload.raw_data_hash
}

public(package) fun raw_data_uri(payload: &Payload): vector<u8> {
    payload.raw_data_uri
}

public(package) fun affected_cells_root(payload: &Payload): vector<u8> {
    payload.affected_cells_root
}

public(package) fun affected_cells_uri(payload: &Payload): vector<u8> {
    payload.affected_cells_uri
}

public(package) fun affected_cells_data_hash(payload: &Payload): vector<u8> {
    payload.affected_cells_data_hash
}

public(package) fun affected_cell_count(payload: &Payload): u64 {
    payload.affected_cell_count
}

public(package) fun occurred_at_ms(payload: &Payload): u64 {
    payload.occurred_at_ms
}

public(package) fun freshness_deadline_ms(payload: &Payload): u64 {
    payload.freshness_deadline_ms
}

public(package) fun intent_earthquake_oracle_payload(): u8 {
    INTENT_EARTHQUAKE_ORACLE_PAYLOAD
}

public(package) fun hazard_type_earthquake(): u8 {
    HAZARD_TYPE_EARTHQUAKE
}

public(package) fun status_finalized(): u8 {
    STATUS_FINALIZED
}
