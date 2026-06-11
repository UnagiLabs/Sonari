module contracts::census_result;

use sui::bcs::{Self, BCS};

const INTENT_FLOOR_CENSUS_V1: vector<u8> = b"SONARI_FLOOR_CENSUS_V1";
const VERIFIER_FAMILY_CENSUS: vector<u8> = b"census";
const VERIFIER_VERSION_V1: u64 = 1;
const BAND_COUNT: u64 = 3;
const MAX_ISSUED_FUTURE_SKEW_MS: u64 = 300_000;

const EInvalidIntent: u64 = 0;
const EInvalidVerifierFamily: u64 = 1;
const EUnsupportedVersion: u64 = 2;
const EInvalidBandCount: u64 = 3;
const ETrailingBytes: u64 = 4;
const EInvalidHashLength: u64 = 5;
const EIssuedAtTooFarInFuture: u64 = 6;

public struct FloorCensusResult has copy, drop, store {
    intent: vector<u8>,
    verifier_family: vector<u8>,
    verifier_version: u64,
    event_uid: vector<u8>,
    event_revision: u32,
    affected_cells_root: vector<u8>,
    registered_members_by_band: vector<u64>,
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
        registered_members_by_band: peel_vec_u64(&mut bcs),
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
    assert!(result.registered_members_by_band.length() == BAND_COUNT, EInvalidBandCount);
    assert_32_bytes(&result.event_uid);
    assert_32_bytes(&result.affected_cells_root);
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

public(package) fun registered_members_by_band(result: &FloorCensusResult): vector<u64> {
    result.registered_members_by_band
}

public(package) fun issued_at_ms(result: &FloorCensusResult): u64 {
    result.issued_at_ms
}
