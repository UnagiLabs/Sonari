use residence_allowlist::{
    ResidenceCellLeaf, internal_node_hash, leaf_bcs_bytes, leaf_hash, merkle_root_from_leaf_hashes,
};

fn decode_32(value: &str) -> [u8; 32] {
    hex::decode(value.strip_prefix("0x").expect("hash is 0x-prefixed"))
        .expect("hash is hex")
        .try_into()
        .expect("hash is 32 bytes")
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
