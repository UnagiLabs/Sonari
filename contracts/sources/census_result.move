module contracts::census_result;

use sui::bcs::{Self, BCS};

const INTENT_FLOOR_CENSUS_V1: vector<u8> = b"SONARI_FLOOR_CENSUS_V1";
const VERIFIER_FAMILY_CENSUS: vector<u8> = b"census";
const VERIFIER_VERSION_V1: u64 = 1;
const BAND_COUNT: u64 = 3;
const H3_RESOLUTION_RES7: u8 = 7;
const SHARD_COUNT: u64 = 4_096;
const MAX_ISSUED_FUTURE_SKEW_MS: u64 = 300_000;

const EInvalidIntent: u64 = 0;
const EInvalidVerifierFamily: u64 = 1;
const EUnsupportedVersion: u64 = 2;
const EInvalidBandCount: u64 = 3;
const ETrailingBytes: u64 = 4;
const EInvalidHashLength: u64 = 5;
const EIssuedAtTooFarInFuture: u64 = 6;
const EInvalidH3Resolution: u64 = 7;
const EInvalidShardCount: u64 = 8;

public struct FloorCensusResult has copy, drop, store {
    intent: vector<u8>,
    verifier_family: vector<u8>,
    verifier_version: u64,
    event_uid: vector<u8>,
    event_revision: u32,
    affected_cells_root: vector<u8>,
    membership_registry_id: ID,
    cell_count_index_id: ID,
    census_checkpoint: u64,
    h3_resolution: u8,
    shard_count: u64,
    registered_members_by_band: vector<u64>,
    counted_cells_root: vector<u8>,
    issued_at_ms: u64,
}

public(package) fun decode_verified(bytes: vector<u8>, now_ms: u64): FloorCensusResult {
    let mut bcs = bcs::new(bytes);
    let result = FloorCensusResult {
        intent: bcs.peel_vec_u8(),
        verifier_family: bcs.peel_vec_u8(),
        verifier_version: bcs.peel_u64(),
        event_uid: peel_bytes32(&mut bcs),
        event_revision: bcs.peel_u32(),
        affected_cells_root: peel_bytes32(&mut bcs),
        membership_registry_id: object::id_from_address(bcs.peel_address()),
        cell_count_index_id: object::id_from_address(bcs.peel_address()),
        census_checkpoint: bcs.peel_u64(),
        h3_resolution: bcs.peel_u8(),
        shard_count: bcs.peel_u64(),
        registered_members_by_band: peel_vec_u64(&mut bcs),
        counted_cells_root: peel_bytes32(&mut bcs),
        issued_at_ms: bcs.peel_u64(),
    };
    assert!(bcs.into_remainder_bytes().length() == 0, ETrailingBytes);
    assert_verified(&result, now_ms);
    result
}

fun assert_verified(result: &FloorCensusResult, now_ms: u64) {
    assert!(result.intent == INTENT_FLOOR_CENSUS_V1, EInvalidIntent);
    assert!(result.verifier_family == VERIFIER_FAMILY_CENSUS, EInvalidVerifierFamily);
    assert!(result.verifier_version == VERIFIER_VERSION_V1, EUnsupportedVersion);
    assert!(result.h3_resolution == H3_RESOLUTION_RES7, EInvalidH3Resolution);
    assert!(result.shard_count == SHARD_COUNT, EInvalidShardCount);
    assert!(result.registered_members_by_band.length() == BAND_COUNT, EInvalidBandCount);
    assert_32_bytes(&result.event_uid);
    assert_32_bytes(&result.affected_cells_root);
    assert_32_bytes(&result.counted_cells_root);
    if (result.issued_at_ms > now_ms) {
        assert!(
            result.issued_at_ms - now_ms <= MAX_ISSUED_FUTURE_SKEW_MS,
            EIssuedAtTooFarInFuture,
        );
    };
}

fun peel_bytes32(bcs: &mut BCS): vector<u8> {
    assert!(remainder_length(bcs) >= 32, EInvalidHashLength);
    vector::tabulate!(32, |_| bcs.peel_u8())
}

fun peel_vec_u64(bcs: &mut BCS): vector<u64> {
    let len = bcs.peel_vec_length();
    vector::tabulate!(len, |_| bcs.peel_u64())
}

fun remainder_length(bcs: &BCS): u64 {
    let snapshot = *bcs;
    snapshot.into_remainder_bytes().length()
}

fun assert_32_bytes(bytes: &vector<u8>) {
    assert!(bytes.length() == 32, EInvalidHashLength);
}

public(package) fun event_uid(result: &FloorCensusResult): vector<u8> {
    result.event_uid
}

public(package) fun event_revision(result: &FloorCensusResult): u32 {
    result.event_revision
}

public(package) fun affected_cells_root(result: &FloorCensusResult): vector<u8> {
    result.affected_cells_root
}

public(package) fun membership_registry_id(result: &FloorCensusResult): ID {
    result.membership_registry_id
}

public(package) fun cell_count_index_id(result: &FloorCensusResult): ID {
    result.cell_count_index_id
}

public(package) fun census_checkpoint(result: &FloorCensusResult): u64 {
    result.census_checkpoint
}

public(package) fun h3_resolution(result: &FloorCensusResult): u8 {
    result.h3_resolution
}

public(package) fun shard_count(result: &FloorCensusResult): u64 {
    result.shard_count
}

public(package) fun registered_members_by_band(result: &FloorCensusResult): vector<u64> {
    result.registered_members_by_band
}

public(package) fun counted_cells_root(result: &FloorCensusResult): vector<u8> {
    result.counted_cells_root
}

public(package) fun issued_at_ms(result: &FloorCensusResult): u64 {
    result.issued_at_ms
}

#[test_only]
public fun new_for_testing(
    event_uid: vector<u8>,
    event_revision: u32,
    affected_cells_root: vector<u8>,
    registered_members_by_band: vector<u64>,
    issued_at_ms: u64,
): FloorCensusResult {
    new_for_testing_with_context(
        event_uid,
        event_revision,
        affected_cells_root,
        object::id_from_address(@0x2222222222222222222222222222222222222222222222222222222222222222),
        object::id_from_address(@0x3333333333333333333333333333333333333333333333333333333333333333),
        41,
        registered_members_by_band,
        x"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        issued_at_ms,
    )
}

#[test_only]
public fun new_for_testing_with_context(
    event_uid: vector<u8>,
    event_revision: u32,
    affected_cells_root: vector<u8>,
    membership_registry_id: ID,
    cell_count_index_id: ID,
    census_checkpoint: u64,
    registered_members_by_band: vector<u64>,
    counted_cells_root: vector<u8>,
    issued_at_ms: u64,
): FloorCensusResult {
    FloorCensusResult {
        intent: INTENT_FLOOR_CENSUS_V1,
        verifier_family: VERIFIER_FAMILY_CENSUS,
        verifier_version: VERIFIER_VERSION_V1,
        event_uid,
        event_revision,
        affected_cells_root,
        membership_registry_id,
        cell_count_index_id,
        census_checkpoint,
        h3_resolution: H3_RESOLUTION_RES7,
        shard_count: SHARD_COUNT,
        registered_members_by_band,
        counted_cells_root,
        issued_at_ms,
    }
}
