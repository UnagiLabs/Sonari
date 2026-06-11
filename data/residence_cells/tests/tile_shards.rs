use residence_allowlist::{
    ResidenceCellLeaf, generate_proof_shards, generate_tiles, tile_object_key,
    write_tiles_from_leaves_atomic,
};
use sha2::{Digest, Sha256};
use std::fs;
use tempfile::tempdir;

// Fixture: 3 cells in parent4=842f5abffffffff, 2 cells in parent4=842f5a9ffffffff
// parent4_hex for first group: 842f5abffffffff (u64: 595308219849506815)
// parent4_hex for second group: 842f5a9ffffffff (u64: 595308219815952383)
fn fixture_leaves_two_parents() -> Vec<ResidenceCellLeaf> {
    vec![
        // Parent4 = 842f5abffffffff
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
        // Parent4 = 842f5a9ffffffff
        ResidenceCellLeaf {
            h3_index: 608_819_001_568_526_335,
            geo_resolution: 7,
            allowlist_version: 1,
        },
        ResidenceCellLeaf {
            h3_index: 608_819_001_585_303_551,
            geo_resolution: 7,
            allowlist_version: 1,
        },
    ]
}

fn fixture_leaves_single_parent() -> Vec<ResidenceCellLeaf> {
    vec![
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
    ]
}

#[test]
fn generates_correct_tile_count_and_cell_count() {
    let leaves = fixture_leaves_two_parents();
    let generated = generate_tiles(&leaves).expect("generate tiles");

    assert_eq!(generated.tiles.len(), 2, "two distinct res4 parents => two tiles");
    assert_eq!(
        generated.manifest.total_cell_count,
        leaves.len(),
        "total_cell_count must equal the number of input leaves"
    );
    assert_eq!(generated.manifest.tile_count, 2);
}

#[test]
fn tiles_cells_are_sorted_ascending_and_deduplicated() {
    let leaves = fixture_leaves_two_parents();
    let generated = generate_tiles(&leaves).expect("generate tiles");

    for tile in &generated.tiles {
        let cells_as_u64: Vec<u64> = tile
            .cells
            .iter()
            .map(|s| s.parse::<u64>().expect("cell decimal string"))
            .collect();
        for window in cells_as_u64.windows(2) {
            assert!(
                window[0] < window[1],
                "cells must be strictly ascending (no duplicates)"
            );
        }
    }
}

#[test]
fn tiles_cells_are_grouped_by_res4_parent() {
    let leaves = fixture_leaves_two_parents();
    let generated = generate_tiles(&leaves).expect("generate tiles");

    // parent4 842f5abffffffff => u64 595308219849506815
    let parent_a_u64 = 595_308_219_849_506_815u64;
    // parent4 842f5a9ffffffff => u64 595308211259572223
    let parent_b_u64 = 595_308_211_259_572_223u64;

    let tile_a = generated
        .tiles
        .iter()
        .find(|t| t.parent_h3_index == parent_a_u64.to_string())
        .expect("tile for parent_a");
    let tile_b = generated
        .tiles
        .iter()
        .find(|t| t.parent_h3_index == parent_b_u64.to_string())
        .expect("tile for parent_b");

    assert_eq!(tile_a.cells.len(), 3);
    assert_eq!(tile_b.cells.len(), 2);

    // Each cell in tile_a must be a res7 child of parent_a
    for cell_str in &tile_a.cells {
        let cell_u64: u64 = cell_str.parse().expect("decimal string");
        assert!(
            [
                608_819_013_513_904_127u64,
                608_819_013_597_790_207,
                608_819_013_681_676_287,
            ]
            .contains(&cell_u64),
            "unexpected cell {cell_u64} in tile_a"
        );
    }
}

#[test]
fn tile_manifest_merkle_root_matches_proof_shard_merkle_root() {
    let leaves = fixture_leaves_two_parents();

    let generated_tiles = generate_tiles(&leaves).expect("generate tiles");
    let generated_proofs = generate_proof_shards(&leaves, 5).expect("proof shards");

    assert_eq!(
        generated_tiles.manifest.merkle_root,
        generated_proofs.manifest.merkle_root,
        "tile manifest merkle_root must match proof shard manifest merkle_root"
    );
}

#[test]
fn tile_merkle_root_is_same_as_manifest_root() {
    let leaves = fixture_leaves_two_parents();
    let generated = generate_tiles(&leaves).expect("generate tiles");

    for tile in &generated.tiles {
        assert_eq!(
            tile.merkle_root, generated.manifest.merkle_root,
            "each tile's merkle_root must match the manifest's merkle_root"
        );
    }
}

#[test]
fn no_tile_generated_for_parents_with_zero_allowed_cells() {
    // With only 5 leaves across 2 parents, no 3rd parent tile should exist
    let leaves = fixture_leaves_two_parents();
    let generated = generate_tiles(&leaves).expect("generate tiles");

    // No tile should have 0 cells
    for tile in &generated.tiles {
        assert!(
            !tile.cells.is_empty(),
            "tile for parent {} must have at least one cell",
            tile.parent_h3_index
        );
    }

    assert_eq!(generated.manifest.tiles.len(), 2);
}

#[test]
fn golden_tile_json_schema_fields_and_cell_order() {
    let leaves = fixture_leaves_single_parent();
    let generated = generate_tiles(&leaves).expect("generate tiles");

    assert_eq!(generated.tiles.len(), 1, "single parent => single tile");
    let tile = &generated.tiles[0];

    assert_eq!(tile.schema, "sonari.residence.tile.v1");
    assert_eq!(tile.schema_version, 1);
    assert_eq!(tile.allowlist_version, 1);
    assert_eq!(tile.geo_resolution, 7);
    assert_eq!(tile.tile_parent_resolution, 4);
    assert_eq!(tile.parent_h3_index, "595308219849506815");

    // cells must be sorted ascending
    let expected_cells: Vec<String> = vec![
        "608819013513904127".to_owned(),
        "608819013597790207".to_owned(),
        "608819013681676287".to_owned(),
    ];
    assert_eq!(tile.cells, expected_cells);

    // merkle_root must be 0x-prefixed 64-char lowercase hex
    assert_eq!(tile.merkle_root.len(), 66);
    assert!(tile.merkle_root.starts_with("0x"));
}

#[test]
fn tile_object_key_format_is_correct() {
    let parent_hex = "842f5abffffffff";
    let key = tile_object_key(1, 7, parent_hex);

    assert_eq!(
        key,
        "residence-cells/v1/res7/tiles/res4/842f5abffffffff.json"
    );
}

#[test]
fn manifest_tiles_sorted_by_parent_h3_index_ascending() {
    let leaves = fixture_leaves_two_parents();
    let generated = generate_tiles(&leaves).expect("generate tiles");

    let parent_indexes: Vec<u64> = generated
        .manifest
        .tiles
        .iter()
        .map(|entry| {
            entry
                .parent_h3_index
                .parse::<u64>()
                .expect("decimal string")
        })
        .collect();

    for window in parent_indexes.windows(2) {
        assert!(
            window[0] < window[1],
            "manifest tiles must be sorted ascending by parent_h3_index"
        );
    }
}

#[test]
fn write_tiles_creates_tile_files_and_manifest() {
    let directory = tempdir().expect("tempdir");
    let output_dir = directory.path().join("tiles");
    let leaves = fixture_leaves_two_parents();

    let manifest = write_tiles_from_leaves_atomic(&output_dir, &leaves).expect("write tiles");

    assert_eq!(manifest.tile_count, 2);
    assert!(output_dir.join("tile_manifest.json").is_file());

    let tiles_dir = output_dir.join("res4");
    assert!(tiles_dir.is_dir());

    for entry in &manifest.tiles {
        // object_key is the full S3 key; local path is the part after "tiles/"
        // e.g., "residence-cells/v1/res7/tiles/res4/842f5abffffffff.json"
        let file_name = std::path::Path::new(&entry.object_key)
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let tile_path = tiles_dir.join(&file_name);
        assert!(tile_path.is_file(), "tile file not found: {}", tile_path.display());

        let bytes = fs::read(&tile_path).expect("read tile");
        assert_eq!(bytes.len() as u64, entry.byte_size);
        let sha256 = format!("0x{}", hex_bytes(&Sha256::digest(&bytes)));
        assert_eq!(sha256, entry.sha256);
    }
}

#[test]
fn manifest_schema_fields_are_correct() {
    let leaves = fixture_leaves_two_parents();
    let generated = generate_tiles(&leaves).expect("generate tiles");
    let manifest = &generated.manifest;

    assert_eq!(manifest.schema, "sonari.residence.tile_manifest.v1");
    assert_eq!(manifest.schema_version, 1);
    assert_eq!(manifest.allowlist_version, 1);
    assert_eq!(manifest.geo_resolution, 7);
    assert_eq!(manifest.tile_parent_resolution, 4);
    assert_eq!(
        manifest.object_key_rule,
        "residence-cells/v{allowlist_version}/res{geo_resolution}/tiles/res4/{parent_hex}.json"
    );
    assert_eq!(manifest.merkle_root.len(), 66);
    assert!(manifest.merkle_root.starts_with("0x"));
}

fn hex_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
