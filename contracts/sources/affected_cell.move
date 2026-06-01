module contracts::affected_cell;

use std::hash;
use sui::bcs;

const EInvalidHashLength: u64 = 0;

public struct AffectedCellLeaf has copy, drop, store {
    event_uid: vector<u8>,
    event_revision: u32,
    h3_index: u64,
    geo_resolution: u8,
    cell_metric: u8,
    intensity_value: u16,
    intensity_scale: u8,
    cell_band: u8,
    cells_generation_method: u8,
    oracle_version: u64,
}

public struct ProofStep has copy, drop, store {
    sibling_hash: vector<u8>,
    sibling_on_left: bool,
}

public(package) fun new_leaf(
    event_uid: vector<u8>,
    event_revision: u32,
    h3_index: u64,
    geo_resolution: u8,
    cell_metric: u8,
    intensity_value: u16,
    intensity_scale: u8,
    cell_band: u8,
    cells_generation_method: u8,
    oracle_version: u64,
): AffectedCellLeaf {
    assert_32_bytes(&event_uid);
    AffectedCellLeaf {
        event_uid,
        event_revision,
        h3_index,
        geo_resolution,
        cell_metric,
        intensity_value,
        intensity_scale,
        cell_band,
        cells_generation_method,
        oracle_version,
    }
}

public(package) fun new_proof_step_left(sibling_hash: vector<u8>): ProofStep {
    assert_32_bytes(&sibling_hash);
    ProofStep { sibling_hash, sibling_on_left: true }
}

public(package) fun new_proof_step_right(sibling_hash: vector<u8>): ProofStep {
    assert_32_bytes(&sibling_hash);
    ProofStep { sibling_hash, sibling_on_left: false }
}

public(package) fun leaf_hash(leaf: &AffectedCellLeaf): vector<u8> {
    let mut bytes = vector[0x00];
    bytes.append(leaf.event_uid);
    bytes.append(bcs::to_bytes(&leaf.event_revision));
    bytes.append(bcs::to_bytes(&leaf.h3_index));
    bytes.push_back(leaf.geo_resolution);
    bytes.push_back(leaf.cell_metric);
    bytes.append(bcs::to_bytes(&leaf.intensity_value));
    bytes.push_back(leaf.intensity_scale);
    bytes.push_back(leaf.cell_band);
    bytes.push_back(leaf.cells_generation_method);
    bytes.append(bcs::to_bytes(&leaf.oracle_version));
    hash::sha2_256(bytes)
}

public(package) fun verify_proof(
    leaf: &AffectedCellLeaf,
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

public(package) fun h3_index(leaf: &AffectedCellLeaf): u64 {
    leaf.h3_index
}

public(package) fun cell_band(leaf: &AffectedCellLeaf): u8 {
    leaf.cell_band
}

public(package) fun event_uid(leaf: &AffectedCellLeaf): vector<u8> {
    leaf.event_uid
}

public(package) fun event_revision(leaf: &AffectedCellLeaf): u32 {
    leaf.event_revision
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
