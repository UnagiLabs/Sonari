use residence_allowlist::{
    ProofDirection, ResidenceCellLeaf, generate_proof_for_h3_index, internal_node_hash,
    leaf_bcs_bytes, leaf_hash, merkle_root_from_leaf_hashes,
};

#[test]
fn pins_residence_leaf_bcs_and_hashes() {
    let leaves = [
        ResidenceCellLeaf {
            h3_index: 608_819_013_513_904_127,
            geo_resolution: 7,
            allowlist_version: 1,
        },
        ResidenceCellLeaf {
            h3_index: 608_819_013_597_790_207,
            geo_resolution: 7,
            allowlist_version: 1,
        },
        ResidenceCellLeaf {
            h3_index: 608_819_013_681_676_287,
            geo_resolution: 7,
            allowlist_version: 1,
        },
    ];

    assert_eq!(
        leaf_bcs_bytes(&leaves[0]).expect("leaf bcs").as_slice(),
        hex_bytes("ffffffc8aaf57208070100000000000000").as_slice()
    );
    let leaf_hashes = leaves
        .iter()
        .map(|leaf| leaf_hash(leaf).expect("leaf hash"))
        .collect::<Vec<_>>();
    assert_eq!(
        hex_string(&leaf_hashes[0]),
        "07985a56b782bd13b8ec079d4c243c8c2399605872223fc86066f59f4ae37569"
    );
    assert_eq!(
        hex_string(&leaf_hashes[1]),
        "fa0172aedc1751590d58bd2c91d8e37aca3b9c4b4a330c7330440b5203806c4e"
    );
    assert_eq!(
        hex_string(&leaf_hashes[2]),
        "8f8a501ba455071229e715f5eccb4322190440fa2ecb6b72d123378648b60ec7"
    );
    assert_eq!(
        hex_string(&internal_node_hash(leaf_hashes[0], leaf_hashes[1])),
        "312e3863ccf00e446423342e1acebdab8e7119ee19dae854904de693225c2678"
    );
    assert_eq!(
        hex_string(&merkle_root_from_leaf_hashes(&leaf_hashes).expect("root")),
        "a26a12dc49754fde5b90e6bff69d1bc8b51fb8a3de07aa9122a9a2958bb75020"
    );
}

#[test]
fn generated_proof_replays_to_root() {
    let leaves = vec![
        ResidenceCellLeaf {
            h3_index: 608_819_013_513_904_127,
            geo_resolution: 7,
            allowlist_version: 1,
        },
        ResidenceCellLeaf {
            h3_index: 608_819_013_597_790_207,
            geo_resolution: 7,
            allowlist_version: 1,
        },
        ResidenceCellLeaf {
            h3_index: 608_819_013_681_676_287,
            geo_resolution: 7,
            allowlist_version: 1,
        },
    ];

    let proof = generate_proof_for_h3_index(&leaves, leaves[1].h3_index)
        .expect("proof")
        .expect("target exists");

    assert_eq!(proof.target_h3_index, leaves[1].h3_index);
    assert_eq!(proof.steps[0].direction, ProofDirection::Left);
    assert!(proof.steps[0].sibling_on_left);
    assert_eq!(proof.steps[1].direction, ProofDirection::Right);
    assert!(!proof.steps[1].sibling_on_left);
    assert_eq!(
        hex_string(&proof.expected_root),
        "a26a12dc49754fde5b90e6bff69d1bc8b51fb8a3de07aa9122a9a2958bb75020"
    );
}

fn hex_string(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hex_bytes(value: &str) -> Vec<u8> {
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).expect("hex byte"))
        .collect()
}
