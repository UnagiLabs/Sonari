#[test_only]
module contracts::identity_result_tests;

use contracts::identity_registry;
use contracts::identity_result_v1;

const NOW_MS: u64 = 1_800_000_000_000;
const ISSUED_AT_MS: u64 = 1_800_000_000_000;
const EXPIRES_AT_MS: u64 = 1_831_536_000_000;
const TOO_FAR_BEFORE_ISSUED_AT_MS: u64 = 1_799_999_699_999;

#[test]
fun fixed_field_order_identity_result_fixture_decodes() {
    let result = identity_result_v1::decode_verified(identity_result_bcs(), NOW_MS);
    let (
        intent,
        verifier_family,
        verifier_version,
        registry_id,
        membership_id,
        owner,
        provider,
        verified,
        duplicate_key_hash,
        evidence_hash,
        issued_at_ms,
        expires_at_ms,
        terms_version,
        signed_statement_hash,
    ) = identity_result_v1::identity_result_summary(&result);

    assert!(intent == b"SONARI_IDENTITY_VERIFICATION_V1");
    assert!(verifier_family == b"identity");
    assert!(verifier_version == 1);
    assert!(registry_id == x"1111111111111111111111111111111111111111111111111111111111111111");
    assert!(membership_id == x"2222222222222222222222222222222222222222222222222222222222222222");
    assert!(owner == x"3333333333333333333333333333333333333333333333333333333333333333");
    assert!(provider == identity_registry::provider_world_id());
    assert!(verified);
    assert!(
        duplicate_key_hash ==
            x"b9dabcfc937c5422b28ddd2db18466a02c1f9fadb5637d120a3a455e23e88a74",
    );
    assert!(
        evidence_hash == x"68893c4e14f913225e4883e1f2f6c2768a0f2673f5ef253386bec3ffda2ac84f",
    );
    assert!(issued_at_ms == ISSUED_AT_MS);
    assert!(expires_at_ms == EXPIRES_AT_MS);
    assert!(terms_version == 1);
    assert!(
        signed_statement_hash ==
            x"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    );
}

#[test, expected_failure(abort_code = identity_result_v1::EInvalidIntent)]
fun wrong_intent_is_rejected() {
    assert_mutated_identity_result_is_rejected(1, 0);
}

#[test, expected_failure(abort_code = identity_result_v1::EInvalidVerifierFamily)]
fun wrong_verifier_family_is_rejected() {
    assert_mutated_identity_result_is_rejected(33, 0x78);
}

#[test, expected_failure(abort_code = identity_result_v1::EUnsupportedVersion)]
fun wrong_verifier_version_is_rejected() {
    assert_mutated_identity_result_is_rejected(41, 2);
}

#[test, expected_failure(abort_code = identity_result_v1::EUnsupportedProvider)]
fun wrong_provider_is_rejected() {
    assert_mutated_identity_result_is_rejected(145, 3);
}

#[test, expected_failure(abort_code = identity_result_v1::EUnverifiedResult)]
fun verified_false_is_rejected() {
    assert_mutated_identity_result_is_rejected(146, 0);
}

#[test, expected_failure(abort_code = identity_result_v1::EExpiredResult)]
fun expired_identity_result_is_rejected() {
    identity_result_v1::decode_verified(identity_result_bcs(), EXPIRES_AT_MS);
}

#[test, expected_failure(abort_code = identity_result_v1::EInvalidTimeRange)]
fun expires_at_must_be_after_issued_at() {
    let mut bytes = identity_result_bcs();
    set_expires_at_to_issued_at(&mut bytes);
    identity_result_v1::decode_verified(bytes, NOW_MS);
}

#[test, expected_failure(abort_code = identity_result_v1::EIssuedAtTooFarInFuture)]
fun issued_at_too_far_in_future_is_rejected() {
    identity_result_v1::decode_verified(identity_result_bcs(), TOO_FAR_BEFORE_ISSUED_AT_MS);
}

#[test, expected_failure(abort_code = identity_result_v1::EInvalidHashLength)]
fun duplicate_key_hash_must_be_32_bytes() {
    identity_result_v1::decode_verified(truncated_identity_result_bcs(178), NOW_MS);
}

#[test, expected_failure(abort_code = identity_result_v1::EInvalidHashLength)]
fun evidence_hash_must_be_32_bytes() {
    identity_result_v1::decode_verified(truncated_identity_result_bcs(210), NOW_MS);
}

#[test, expected_failure(abort_code = identity_result_v1::EInvalidHashLength)]
fun signed_statement_hash_must_be_32_bytes() {
    identity_result_v1::decode_verified(truncated_identity_result_bcs(266), NOW_MS);
}

#[test, expected_failure(abort_code = identity_result_v1::ETrailingBytes)]
fun trailing_bytes_are_rejected() {
    let mut bytes = identity_result_bcs();
    bytes.push_back(0);
    identity_result_v1::decode_verified(bytes, NOW_MS);
}

fun assert_mutated_identity_result_is_rejected(offset: u64, value: u8) {
    let mut bytes = identity_result_bcs();
    *bytes.borrow_mut(offset) = value;
    identity_result_v1::decode_verified(bytes, NOW_MS);
}

fun set_expires_at_to_issued_at(bytes: &mut vector<u8>) {
    *bytes.borrow_mut(219) = 0x00;
    *bytes.borrow_mut(220) = 0x50;
    *bytes.borrow_mut(221) = 0x5c;
    *bytes.borrow_mut(222) = 0x18;
    *bytes.borrow_mut(223) = 0xa3;
    *bytes.borrow_mut(224) = 0x01;
    *bytes.borrow_mut(225) = 0x00;
    *bytes.borrow_mut(226) = 0x00;
}

fun truncated_identity_result_bcs(length: u64): vector<u8> {
    let mut bytes = identity_result_bcs();
    while (bytes.length() > length) {
        bytes.pop_back();
    };
    bytes
}

fun identity_result_bcs(): vector<u8> {
    x"1f534f4e4152495f4944454e544954595f564552494649434154494f4e5f5631086964656e7469747901000000000000001111111111111111111111111111111111111111111111111111111111111111222222222222222222222222222222222222222222222222222222222222222233333333333333333333333333333333333333333333333333333333333333330201b9dabcfc937c5422b28ddd2db18466a02c1f9fadb5637d120a3a455e23e88a7468893c4e14f913225e4883e1f2f6c2768a0f2673f5ef253386bec3ffda2ac84f00505c18a3010000007c0d70aa0100000100000000000000dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
}
