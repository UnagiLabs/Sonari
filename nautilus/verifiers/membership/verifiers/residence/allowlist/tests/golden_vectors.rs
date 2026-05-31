use residence_allowlist::{
    ProofDirection, ResidenceCellLeaf, ResidenceMerkleProof, ResidenceProofStep,
    generate_proof_for_h3_index, internal_node_hash, leaf_bcs_bytes, leaf_hash,
    merkle_root_from_leaf_hashes, merkle_root_from_leaves,
};

fn decode_32(value: &str) -> [u8; 32] {
    hex::decode(value.strip_prefix("0x").expect("hash is 0x-prefixed"))
        .expect("hash is hex")
        .try_into()
        .expect("hash is 32 bytes")
}

fn fixture_leaves(count: u64) -> Vec<ResidenceCellLeaf> {
    (0..count)
        .map(|index| ResidenceCellLeaf {
            h3_index: 608_819_013_513_904_127 + (index * 83_886_080),
            geo_resolution: 7,
            allowlist_version: 1,
        })
        .collect()
}

fn replay_proof(proof: &ResidenceMerkleProof) -> [u8; 32] {
    proof.steps.iter().fold(
        proof.target_leaf_hash,
        |current,
         ResidenceProofStep {
             direction,
             sibling_hash,
             sibling_on_left,
         }| {
            assert_eq!(*sibling_on_left, direction.sibling_on_left());
            match direction {
                ProofDirection::Left => internal_node_hash(*sibling_hash, current),
                ProofDirection::Right => internal_node_hash(current, *sibling_hash),
            }
        },
    )
}

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
        hex::encode(leaf_bcs_bytes(&leaves[0]).expect("leaf BCS encodes")),
        "ffffffc8aaf57208070100000000000000"
    );

    let leaf_hashes = leaves
        .iter()
        .map(|leaf| leaf_hash(leaf).expect("leaf hashes"))
        .collect::<Vec<_>>();
    assert_eq!(
        hex::encode(leaf_hashes[0]),
        "07985a56b782bd13b8ec079d4c243c8c2399605872223fc86066f59f4ae37569"
    );
    assert_eq!(
        hex::encode(leaf_hashes[1]),
        "fa0172aedc1751590d58bd2c91d8e37aca3b9c4b4a330c7330440b5203806c4e"
    );
    assert_eq!(
        hex::encode(leaf_hashes[2]),
        "8f8a501ba455071229e715f5eccb4322190440fa2ecb6b72d123378648b60ec7"
    );

    let parent = internal_node_hash(leaf_hashes[0], leaf_hashes[1]);
    assert_eq!(
        hex::encode(parent),
        "312e3863ccf00e446423342e1acebdab8e7119ee19dae854904de693225c2678"
    );
    assert_eq!(
        hex::encode(merkle_root_from_leaf_hashes(&leaf_hashes).expect("root exists")),
        "a26a12dc49754fde5b90e6bff69d1bc8b51fb8a3de07aa9122a9a2958bb75020"
    );
}

#[test]
fn proof_directions_replay_to_three_leaf_root() {
    let left_sibling =
        decode_32("0x07985a56b782bd13b8ec079d4c243c8c2399605872223fc86066f59f4ae37569");
    let current = decode_32("0xfa0172aedc1751590d58bd2c91d8e37aca3b9c4b4a330c7330440b5203806c4e");
    let right_sibling =
        decode_32("0x8f8a501ba455071229e715f5eccb4322190440fa2ecb6b72d123378648b60ec7");

    let after_left_step = internal_node_hash(left_sibling, current);
    let root = internal_node_hash(after_left_step, right_sibling);

    assert_eq!(
        hex::encode(root),
        "a26a12dc49754fde5b90e6bff69d1bc8b51fb8a3de07aa9122a9a2958bb75020"
    );
}

#[test]
fn generated_three_leaf_proof_replays_to_root() {
    let leaves = fixture_leaves(3);
    let target_h3_index = leaves[1].h3_index;
    let root = merkle_root_from_leaves(&leaves)
        .expect("valid allowlist")
        .expect("root exists");
    let proof = generate_proof_for_h3_index(&leaves, target_h3_index)
        .expect("valid allowlist")
        .expect("target is allowlisted");

    assert_eq!(proof.target_h3_index, target_h3_index);
    assert_eq!(proof.steps.len(), 2);
    assert_eq!(proof.steps[0].direction, ProofDirection::Left);
    assert!(proof.steps[0].sibling_on_left);
    assert_eq!(proof.steps[1].direction, ProofDirection::Right);
    assert!(!proof.steps[1].sibling_on_left);
    assert_eq!(proof.expected_root, root);
    assert_eq!(replay_proof(&proof), root);
}

#[test]
fn generated_five_leaf_proof_replays_to_root_with_odd_promotions() {
    let leaves = fixture_leaves(5);
    let target_h3_index = leaves[4].h3_index;
    let root = merkle_root_from_leaves(&leaves)
        .expect("valid allowlist")
        .expect("root exists");
    let proof = generate_proof_for_h3_index(&leaves, target_h3_index)
        .expect("valid allowlist")
        .expect("target is allowlisted");

    assert_eq!(proof.promoted_without_sibling_at_levels, vec![0, 1]);
    assert_eq!(proof.expected_root, root);
    assert_eq!(replay_proof(&proof), root);
}

#[test]
fn duplicate_h3_index_is_rejected_for_root_and_proof() {
    let mut leaves = fixture_leaves(3);
    leaves[2].h3_index = leaves[0].h3_index;

    assert!(merkle_root_from_leaves(&leaves).is_err());
    assert!(generate_proof_for_h3_index(&leaves, leaves[0].h3_index).is_err());
}

#[test]
fn unsorted_input_generates_deterministic_root() {
    let sorted = fixture_leaves(5);
    let mut unsorted = sorted.clone();
    unsorted.swap(0, 4);
    unsorted.swap(1, 3);

    let sorted_root = merkle_root_from_leaves(&sorted)
        .expect("valid sorted allowlist")
        .expect("root exists");
    let unsorted_root = merkle_root_from_leaves(&unsorted)
        .expect("valid unsorted allowlist")
        .expect("root exists");

    assert_eq!(unsorted_root, sorted_root);
}

#[test]
fn unsorted_input_generates_deterministic_proof() {
    let sorted = fixture_leaves(5);
    let mut unsorted = sorted.clone();
    unsorted.swap(0, 4);
    unsorted.swap(1, 3);
    let target_h3_index = sorted[2].h3_index;

    let sorted_proof = generate_proof_for_h3_index(&sorted, target_h3_index)
        .expect("valid sorted allowlist")
        .expect("target is allowlisted");
    let unsorted_proof = generate_proof_for_h3_index(&unsorted, target_h3_index)
        .expect("valid unsorted allowlist")
        .expect("target is allowlisted");

    assert_eq!(unsorted_proof, sorted_proof);
}

#[test]
fn proof_request_for_non_allowlisted_h3_index_fails_closed() {
    let leaves = fixture_leaves(3);
    let proof =
        generate_proof_for_h3_index(&leaves, leaves[2].h3_index + 1).expect("valid allowlist");

    assert!(proof.is_none());
}
