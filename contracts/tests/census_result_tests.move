#[test_only]
module contracts::census_result_tests;

use contracts::census_result;

const NOW_MS: u64 = 1_800_000_000_000;

// ------------------------------------------------------------
// Census result BCS fixture (valid)
//
// Fields:
//   intent              = b"SONARI_FLOOR_CENSUS_V1"  (ULEB128 len + bytes)
//   verifier_family     = b"census"                  (ULEB128 len + bytes)
//   verifier_version    = 1                          (u64 LE)
//   event_uid           = [0x11; 32]                 (32 raw bytes)
//   event_revision      = 1                          (u32 LE)
//   affected_cells_root = [0xaa; 32]                 (32 raw bytes)
//   registered_members_by_band = [100, 200, 300]     (ULEB128 len + 3 × u64 LE)
//   issued_at_ms        = 1_800_000_000_000          (u64 LE)
// ------------------------------------------------------------
fun valid_census_result_bcs(): vector<u8> {
    x"16534f4e4152495f464c4f4f525f43454e5355535f56310663656e7375730100000000000000111111111111111111111111111111111111111111111111111111111111111101000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa036400000000000000c8000000000000002c0100000000000000505c18a3010000"
}

fun four_band_census_result_bcs(): vector<u8> {
    x"16534f4e4152495f464c4f4f525f43454e5355535f56310663656e7375730100000000000000111111111111111111111111111111111111111111111111111111111111111101000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa046400000000000000c8000000000000002c01000000000000900100000000000000505c18a3010000"
}

fun mutated_bcs(offset: u64, value: u8): vector<u8> {
    let mut bytes = valid_census_result_bcs();
    *bytes.borrow_mut(offset) = value;
    bytes
}

#[test]
fun valid_census_result_decodes_correctly() {
    let result = census_result::decode_verified(valid_census_result_bcs(), NOW_MS);

    // event_uid = [0x11; 32]
    assert!(
        census_result::event_uid(&result) ==
            x"1111111111111111111111111111111111111111111111111111111111111111",
    );
    // event_revision = 1
    assert!(census_result::event_revision(&result) == 1);
    // affected_cells_root = [0xaa; 32]
    assert!(
        census_result::affected_cells_root(&result) ==
            x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    // registered_members_by_band = [100, 200, 300]
    let bands = census_result::registered_members_by_band(&result);
    assert!(bands.length() == 3);
    assert!(*bands.borrow(0) == 100);
    assert!(*bands.borrow(1) == 200);
    assert!(*bands.borrow(2) == 300);
    // issued_at_ms = 1_800_000_000_000
    assert!(census_result::issued_at_ms(&result) == NOW_MS);
}

// offset 1 = first byte of intent string content ('S' = 0x53), change to 0x00
#[test, expected_failure(abort_code = census_result::EInvalidIntent)]
fun wrong_intent_is_rejected() {
    census_result::decode_verified(mutated_bcs(1, 0x00), NOW_MS);
}

// offset 24 = first byte of "census" content ('c' = 0x63), change to 0x78
#[test, expected_failure(abort_code = census_result::EInvalidVerifierFamily)]
fun wrong_verifier_family_is_rejected() {
    census_result::decode_verified(mutated_bcs(24, 0x78), NOW_MS);
}

// offset 30 = first byte of verifier_version u64 LE (value 1), change to 2
#[test, expected_failure(abort_code = census_result::EUnsupportedVersion)]
fun wrong_verifier_version_is_rejected() {
    census_result::decode_verified(mutated_bcs(30, 2), NOW_MS);
}

// 4-element band vector triggers EInvalidBandCount
#[test, expected_failure(abort_code = census_result::EInvalidBandCount)]
fun wrong_band_count_is_rejected() {
    census_result::decode_verified(four_band_census_result_bcs(), NOW_MS);
}

// Append an extra byte to trigger ETrailingBytes
#[test, expected_failure(abort_code = census_result::ETrailingBytes)]
fun trailing_bytes_are_rejected() {
    let mut bytes = valid_census_result_bcs();
    bytes.push_back(0);
    census_result::decode_verified(bytes, NOW_MS);
}
