use residence_allowlist::{
    ProofShard, ProofShardEntry, ResidenceCellLeaf, generate_proof_shards, proof_shard_gzip_bytes,
    replay_proof_shard_entry,
};

const SHARD_COUNT: usize = 5;

#[test]
fn generates_deterministic_manifest_and_shards() {
    let leaves = fixture_leaves();
    let shard_count = SHARD_COUNT;

    let generated = generate_proof_shards(&leaves, shard_count).expect("proof shards");

    assert_eq!(
        generated.manifest.schema,
        "sonari.residence.proof_manifest.v1"
    );
    assert_eq!(generated.manifest.schema_version, 1);
    assert_eq!(generated.manifest.allowlist_version, 1);
    assert_eq!(generated.manifest.geo_resolution, 7);
    assert_eq!(generated.manifest.shard_count, shard_count);
    assert_eq!(generated.manifest.total_proof_count, leaves.len());
    assert_eq!(
        generated.manifest.object_key_rule,
        "residence-cells/v{allowlist_version}/res{geo_resolution}/proofs/shards/{shard_id:05}.json.gz"
    );
    assert_eq!(generated.manifest.shards.len(), shard_count);
    assert_eq!(generated.shards.len(), shard_count);

    let shard_ids = generated
        .manifest
        .shards
        .iter()
        .map(|shard| shard.shard_id)
        .collect::<Vec<_>>();
    assert_eq!(shard_ids, vec![0, 1, 2, 3, 4]);

    let empty_shards = generated
        .shards
        .iter()
        .filter(|shard| shard.proofs.is_empty())
        .map(|shard| shard.shard_id)
        .collect::<Vec<_>>();
    assert_eq!(empty_shards, vec![0, 1, 3, 4]);

    for shard in &generated.shards {
        assert_shard_metadata(shard);
        let inventory = generated
            .manifest
            .shards
            .iter()
            .find(|inventory| inventory.shard_id == shard.shard_id)
            .expect("inventory");
        let bytes = proof_shard_gzip_bytes(shard).expect("shard gzip");
        assert_eq!(inventory.object_key, expected_object_key(shard.shard_id));
        assert_eq!(inventory.proof_count, shard.proofs.len());
        assert_eq!(inventory.sha256, prefixed_sha256(&bytes));
        assert_eq!(inventory.byte_size, bytes.len() as u64);
    }

    for leaf in &leaves {
        let shard_id = (leaf.h3_index % shard_count as u64) as usize;
        let entry = find_entry(&generated.shards, leaf.h3_index);
        assert_eq!(entry.h3_index, leaf.h3_index.to_string());
        assert_eq!(entry.leaf_hash.len(), 66);
        assert!(entry.leaf_hash.starts_with("0x"));
        assert!(
            generated.shards[shard_id]
                .proofs
                .iter()
                .any(|candidate| candidate.h3_index == entry.h3_index),
            "h3_index {} must be assigned by modulo",
            leaf.h3_index
        );
    }
}

#[test]
fn every_generated_proof_replays_to_manifest_root() {
    let generated = generate_proof_shards(&fixture_leaves(), SHARD_COUNT).expect("proof shards");

    for shard in &generated.shards {
        for entry in &shard.proofs {
            let root = replay_proof_shard_entry(entry).expect("proof replay");
            assert_eq!(root, generated.manifest.merkle_root);
        }
    }
}

fn fixture_leaves() -> Vec<ResidenceCellLeaf> {
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

fn assert_shard_metadata(shard: &ProofShard) {
    assert_eq!(shard.schema, "sonari.residence.proof_shard.v1");
    assert_eq!(shard.schema_version, 1);
    assert_eq!(shard.allowlist_version, 1);
    assert_eq!(shard.geo_resolution, 7);
    assert_eq!(shard.shard_count, SHARD_COUNT);
    assert_eq!(shard.merkle_root.len(), 66);
    assert!(shard.merkle_root.starts_with("0x"));
    for proof in &shard.proofs {
        for step in &proof.proof {
            assert_eq!(step.sibling_hash.len(), 66);
            assert!(step.sibling_hash.starts_with("0x"));
        }
    }
}

fn find_entry(shards: &[ProofShard], h3_index: u64) -> &ProofShardEntry {
    shards
        .iter()
        .flat_map(|shard| shard.proofs.iter())
        .find(|entry| entry.h3_index == h3_index.to_string())
        .expect("proof entry")
}

fn expected_object_key(shard_id: usize) -> String {
    format!("residence-cells/v1/res7/proofs/shards/{shard_id:05}.json.gz")
}

fn prefixed_sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(bytes);
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("0x{hex}")
}
