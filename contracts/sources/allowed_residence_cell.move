module contracts::allowed_residence_cell;

use std::hash;
use sui::bcs;

const EInvalidHashLength: u64 = 0;

public struct ResidenceCellLeaf has copy, drop, store {
    h3_index: u64,
    geo_resolution: u8,
    allowlist_version: u64,
}

public struct ProofStep has copy, drop, store {
    sibling_hash: vector<u8>,
    sibling_on_left: bool,
}

public fun new_leaf(
    h3_index: u64,
    geo_resolution: u8,
    allowlist_version: u64,
): ResidenceCellLeaf {
    ResidenceCellLeaf {
        h3_index,
        geo_resolution,
        allowlist_version,
    }
}

public fun new_proof_step_left(sibling_hash: vector<u8>): ProofStep {
    assert_32_bytes(&sibling_hash);
    ProofStep { sibling_hash, sibling_on_left: true }
}

public fun new_proof_step_right(sibling_hash: vector<u8>): ProofStep {
    assert_32_bytes(&sibling_hash);
    ProofStep { sibling_hash, sibling_on_left: false }
}

public fun leaf_hash(leaf: &ResidenceCellLeaf): vector<u8> {
    let mut bytes = vector[0x00];
    bytes.append(bcs::to_bytes(leaf));
    hash::sha2_256(bytes)
}

public fun verify_proof(
    leaf: &ResidenceCellLeaf,
    proof: vector<ProofStep>,
    expected_root: vector<u8>,
): bool {
    assert_32_bytes(&expected_root);
    let mut current = leaf_hash(leaf);
    let mut i = 0;
    while (i < proof.length()) {
        let step = proof.borrow(i);
        assert_32_bytes(&step.sibling_hash);
        current = internal_hash(&current, &step.sibling_hash, step.sibling_on_left);
        i = i + 1;
    };
    current == expected_root
}

fun internal_hash(
    current: &vector<u8>,
    sibling_hash: &vector<u8>,
    sibling_on_left: bool,
): vector<u8> {
    let mut bytes = vector[0x01];
    if (sibling_on_left) {
        bytes.append(*sibling_hash);
        bytes.append(*current);
    } else {
        bytes.append(*current);
        bytes.append(*sibling_hash);
    };
    hash::sha2_256(bytes)
}

fun assert_32_bytes(bytes: &vector<u8>) {
    assert!(bytes.length() == 32, EInvalidHashLength);
}
