module contracts::identity_result_v1;

use sui::bcs::{Self, BCS};

const INTENT_IDENTITY_VERIFICATION_V1: vector<u8> = b"SONARI_IDENTITY_VERIFICATION_V1";
const VERIFIER_FAMILY_IDENTITY: vector<u8> = b"identity";
const VERIFIER_VERSION_V1: u64 = 1;
const PROVIDER_KYC: u8 = 1;
const PROVIDER_WORLD_ID: u8 = 2;
const MAX_ISSUED_FUTURE_SKEW_MS: u64 = 300_000;

const EInvalidIntent: u64 = 0;
const EInvalidVerifierFamily: u64 = 1;
const EUnsupportedVersion: u64 = 2;
const EUnsupportedProvider: u64 = 3;
const EUnverifiedResult: u64 = 4;
const EExpiredResult: u64 = 5;
const EInvalidTimeRange: u64 = 6;
const EIssuedAtTooFarInFuture: u64 = 7;
const EInvalidHashLength: u64 = 8;
const ETrailingBytes: u64 = 9;

public struct IdentityVerificationResult has copy, drop, store {
    intent: vector<u8>,
    verifier_family: vector<u8>,
    verifier_version: u64,
    registry_id: vector<u8>,
    membership_id: vector<u8>,
    owner: vector<u8>,
    provider: u8,
    verified: bool,
    duplicate_key_hash: vector<u8>,
    evidence_hash: vector<u8>,
    issued_at_ms: u64,
    expires_at_ms: u64,
    terms_version: u64,
    signed_statement_hash: vector<u8>,
}

public fun decode_verified(bytes: vector<u8>, now_ms: u64): IdentityVerificationResult {
    let mut bcs = bcs::new(bytes);
    let result = IdentityVerificationResult {
        intent: bcs.peel_vec_u8(),
        verifier_family: bcs.peel_vec_u8(),
        verifier_version: bcs.peel_u64(),
        registry_id: peel_bytes32(&mut bcs),
        membership_id: peel_bytes32(&mut bcs),
        owner: peel_bytes32(&mut bcs),
        provider: bcs.peel_u8(),
        verified: bcs.peel_bool(),
        duplicate_key_hash: peel_bytes32(&mut bcs),
        evidence_hash: peel_bytes32(&mut bcs),
        issued_at_ms: bcs.peel_u64(),
        expires_at_ms: bcs.peel_u64(),
        terms_version: bcs.peel_u64(),
        signed_statement_hash: peel_bytes32(&mut bcs),
    };
    assert!(bcs.into_remainder_bytes().length() == 0, ETrailingBytes);
    assert_verified(&result, now_ms);
    result
}

fun assert_verified(result: &IdentityVerificationResult, now_ms: u64) {
    assert!(result.intent == INTENT_IDENTITY_VERIFICATION_V1, EInvalidIntent);
    assert!(result.verifier_family == VERIFIER_FAMILY_IDENTITY, EInvalidVerifierFamily);
    assert!(result.verifier_version == VERIFIER_VERSION_V1, EUnsupportedVersion);
    assert!(
        result.provider == PROVIDER_KYC || result.provider == PROVIDER_WORLD_ID,
        EUnsupportedProvider,
    );
    assert!(result.verified, EUnverifiedResult);
    assert!(result.expires_at_ms > result.issued_at_ms, EInvalidTimeRange);
    assert!(result.expires_at_ms > now_ms, EExpiredResult);
    if (result.issued_at_ms > now_ms) {
        assert!(
            result.issued_at_ms - now_ms <= MAX_ISSUED_FUTURE_SKEW_MS,
            EIssuedAtTooFarInFuture,
        );
    };
    assert_32_bytes(&result.duplicate_key_hash);
    assert_32_bytes(&result.evidence_hash);
    assert_32_bytes(&result.signed_statement_hash);
}

fun peel_bytes32(bcs: &mut BCS): vector<u8> {
    assert!(remainder_length(bcs) >= 32, EInvalidHashLength);
    vector::tabulate!(32, |_| bcs.peel_u8())
}

fun remainder_length(bcs: &BCS): u64 {
    let snapshot = *bcs;
    snapshot.into_remainder_bytes().length()
}

fun assert_32_bytes(bytes: &vector<u8>) {
    assert!(bytes.length() == 32, EInvalidHashLength);
}

public fun identity_result_summary(
    result: &IdentityVerificationResult,
): (
    vector<u8>,
    vector<u8>,
    u64,
    vector<u8>,
    vector<u8>,
    vector<u8>,
    u8,
    bool,
    vector<u8>,
    vector<u8>,
    u64,
    u64,
    u64,
    vector<u8>,
) {
    (
        result.intent,
        result.verifier_family,
        result.verifier_version,
        result.registry_id,
        result.membership_id,
        result.owner,
        result.provider,
        result.verified,
        result.duplicate_key_hash,
        result.evidence_hash,
        result.issued_at_ms,
        result.expires_at_ms,
        result.terms_version,
        result.signed_statement_hash,
    )
}

public fun provider_kyc(): u8 {
    PROVIDER_KYC
}

public fun provider_world_id(): u8 {
    PROVIDER_WORLD_ID
}
