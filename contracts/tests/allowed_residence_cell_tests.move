#[test_only]
module contracts::allowed_residence_cell_tests;

use contracts::allowed_residence_cell;
use contracts::accessor;

const TARGET_H3_INDEX: u64 = 608_819_013_597_790_207;
const PROMOTED_H3_INDEX: u64 = 608_819_013_681_676_287;
const GEO_RESOLUTION: u8 = 7;
const ALLOWLIST_VERSION: u64 = 1;

#[test]
fun target_leaf_hash_and_merkle_proof_match_fixture_vectors() {
    let hash = allowed_residence_cell::leaf_hash_for_testing(
        TARGET_H3_INDEX,
        GEO_RESOLUTION,
        ALLOWLIST_VERSION,
    );
    assert!(
        hash == x"fa0172aedc1751590d58bd2c91d8e37aca3b9c4b4a330c7330440b5203806c4e",
    );

    let proof = vector[
        accessor::new_residence_proof_step_left(
            x"07985a56b782bd13b8ec079d4c243c8c2399605872223fc86066f59f4ae37569",
        ),
        accessor::new_residence_proof_step_right(
            x"8f8a501ba455071229e715f5eccb4322190440fa2ecb6b72d123378648b60ec7",
        ),
    ];
    assert!(allowed_residence_cell::verify_proof_for_testing(
        TARGET_H3_INDEX,
        GEO_RESOLUTION,
        ALLOWLIST_VERSION,
        proof,
        merkle_root(),
    ));
}

#[test]
fun promoted_leaf_proof_matches_fixture_vectors() {
    let hash = allowed_residence_cell::leaf_hash_for_testing(
        PROMOTED_H3_INDEX,
        GEO_RESOLUTION,
        ALLOWLIST_VERSION,
    );
    assert!(
        hash == x"8f8a501ba455071229e715f5eccb4322190440fa2ecb6b72d123378648b60ec7",
    );

    let proof = vector[
        accessor::new_residence_proof_step_left(
            x"312e3863ccf00e446423342e1acebdab8e7119ee19dae854904de693225c2678",
        ),
    ];
    assert!(allowed_residence_cell::verify_proof_for_testing(
        PROMOTED_H3_INDEX,
        GEO_RESOLUTION,
        ALLOWLIST_VERSION,
        proof,
        merkle_root(),
    ));
}

#[test, expected_failure(abort_code = allowed_residence_cell::EInvalidHashLength)]
fun expected_root_must_be_32_bytes() {
    allowed_residence_cell::verify_proof_for_testing(
        TARGET_H3_INDEX,
        GEO_RESOLUTION,
        ALLOWLIST_VERSION,
        vector[],
        vector[0],
    );
}

#[test, expected_failure(abort_code = allowed_residence_cell::EInvalidHashLength)]
fun sibling_hash_must_be_32_bytes() {
    accessor::new_residence_proof_step_right(vector[0]);
}

fun merkle_root(): vector<u8> {
    x"a26a12dc49754fde5b90e6bff69d1bc8b51fb8a3de07aa9122a9a2958bb75020"
}
