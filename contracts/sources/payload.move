module contracts::payload;

use sui::bcs::{Self, BCS};

const INTENT_EARTHQUAKE_ORACLE_PAYLOAD: u8 = 1;
const ORACLE_VERSION: u64 = 1;
const HAZARD_TYPE_EARTHQUAKE: u8 = 1;
const STATUS_FINALIZED: u8 = 3;
const MAX_SOURCE_EVENT_ID_BYTES: u64 = 96;
const MAX_TITLE_BYTES: u64 = 160;
const MAX_REGION_BYTES: u64 = 160;
const MAX_URI_BYTES: u64 = 512;
const MAX_AFFECTED_CELL_COUNT: u64 = 1_000_000;
const FRESHNESS_WINDOW_MS: u64 = 21_600_000;
const U64_MAX: u64 = 18_446_744_073_709_551_615;

const EInvalidIntent: u64 = 0;
const EUnsupportedVersion: u64 = 1;
const ENonFinalizedStatus: u64 = 2;
const EExpiredFreshness: u64 = 3;
const EInvalidEvidenceManifestUriLength: u64 = 4;
const EInvalidAffectedCellCount: u64 = 5;
const ETrailingBytes: u64 = 7;
const EInvalidHashLength: u64 = 8;
const EUnsupportedHazardType: u64 = 9;
const EInvalidSeverityBand: u64 = 12;
const EInvalidEventRevision: u64 = 17;
const EInvalidSourceEventIdLength: u64 = 18;
const EInvalidTitleLength: u64 = 19;
const EInvalidRegionLength: u64 = 20;
const EInvalidFreshnessDeadline: u64 = 22;

public struct Payload has copy, drop, store {
    intent: u8,
    oracle_version: u64,
    event_uid: vector<u8>,
    event_revision: u32,
    source_event_id: vector<u8>,
    title: vector<u8>,
    region: vector<u8>,
    occurred_at_ms: u64,
    hazard_type: u8,
    status: u8,
    severity_band: u8,
    affected_cells_root: vector<u8>,
    affected_cell_count: u64,
    evidence_manifest_uri: vector<u8>,
    evidence_manifest_hash: vector<u8>,
    verified_at_ms: u64,
    freshness_deadline_ms: u64,
}

public(package) fun decode_finalized(bytes: vector<u8>, now_ms: u64): Payload {
    let mut bcs = bcs::new(bytes);
    let payload = Payload {
        intent: bcs.peel_u8(),
        oracle_version: bcs.peel_u64(),
        event_uid: peel_bytes32(&mut bcs),
        event_revision: bcs.peel_u32(),
        source_event_id: bcs.peel_vec_u8(),
        title: bcs.peel_vec_u8(),
        region: bcs.peel_vec_u8(),
        occurred_at_ms: bcs.peel_u64(),
        hazard_type: bcs.peel_u8(),
        status: bcs.peel_u8(),
        severity_band: bcs.peel_u8(),
        affected_cells_root: peel_bytes32(&mut bcs),
        affected_cell_count: bcs.peel_u64(),
        evidence_manifest_uri: bcs.peel_vec_u8(),
        evidence_manifest_hash: peel_bytes32(&mut bcs),
        verified_at_ms: bcs.peel_u64(),
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
    assert!(1 <= payload.severity_band && payload.severity_band <= 3, EInvalidSeverityBand);
    assert!(
        1 <= payload.affected_cell_count && payload.affected_cell_count <= MAX_AFFECTED_CELL_COUNT,
        EInvalidAffectedCellCount,
    );
    assert!(
        length_in_range(&payload.evidence_manifest_uri, 1, MAX_URI_BYTES),
        EInvalidEvidenceManifestUriLength,
    );
    assert!(payload.verified_at_ms <= U64_MAX - FRESHNESS_WINDOW_MS, EInvalidFreshnessDeadline);
    assert!(
        payload.freshness_deadline_ms == payload.verified_at_ms + FRESHNESS_WINDOW_MS,
        EInvalidFreshnessDeadline,
    );
    assert!(payload.freshness_deadline_ms > now_ms, EExpiredFreshness);
    assert_32_bytes(&payload.event_uid);
    assert_32_bytes(&payload.affected_cells_root);
    assert_32_bytes(&payload.evidence_manifest_hash);
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
    u32,
    vector<u8>,
    vector<u8>,
    vector<u8>,
    u64,
    u8,
    u8,
    u8,
    vector<u8>,
    u64,
    vector<u8>,
    vector<u8>,
    u64,
    u64,
) {
    (
        payload.intent,
        payload.oracle_version,
        payload.event_uid,
        payload.event_revision,
        payload.source_event_id,
        payload.title,
        payload.region,
        payload.occurred_at_ms,
        payload.hazard_type,
        payload.status,
        payload.severity_band,
        payload.affected_cells_root,
        payload.affected_cell_count,
        payload.evidence_manifest_uri,
        payload.evidence_manifest_hash,
        payload.verified_at_ms,
        payload.freshness_deadline_ms,
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

public(package) fun verified_at_ms(payload: &Payload): u64 {
    payload.verified_at_ms
}

public(package) fun severity_band(payload: &Payload): u8 {
    payload.severity_band
}

public(package) fun affected_cells_root(payload: &Payload): vector<u8> {
    payload.affected_cells_root
}

public(package) fun affected_cell_count(payload: &Payload): u64 {
    payload.affected_cell_count
}

public(package) fun evidence_manifest_uri(payload: &Payload): vector<u8> {
    payload.evidence_manifest_uri
}

public(package) fun evidence_manifest_hash(payload: &Payload): vector<u8> {
    payload.evidence_manifest_hash
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
