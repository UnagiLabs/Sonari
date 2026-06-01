use flate2::read::GzDecoder;
use residence_allowlist::{
    LandSourceManifest, ProofShard, ProofShardManifest, ResidenceCellLeaf,
    build_allowlist_artifact_with_manifest, generate_proof_shards, prefixed_hex,
    write_allowlist_artifact_atomic, write_generated_proof_shards_atomic,
};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, process::Command, time::Duration};
use tempfile::tempdir;

const FIXTURE_SOURCE: &str = include_str!("fixtures/compact_land.geojson");

#[test]
fn help_succeeds() {
    let output = Command::new(env!("CARGO_BIN_EXE_residence-allowlist"))
        .arg("--help")
        .output()
        .expect("run help");

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    assert!(stdout.contains("generate"));
    assert!(stdout.contains("proof-shards"));
    assert!(stdout.contains("verify-proof-shards"));
    assert!(stdout.contains("verify-local"));
}

#[test]
fn proof_shards_rejects_zero_shard_count() {
    let directory = tempdir().expect("tempdir");
    let output_dir = directory.path().join("proofs");

    let output = Command::new(env!("CARGO_BIN_EXE_residence-allowlist"))
        .args([
            "proof-shards",
            "--allowlist",
            "missing-allowlist.json",
            "--source",
            "missing-source.geojson",
            "--output-dir",
            output_dir.to_str().expect("output dir"),
            "--shard-count",
            "0",
        ])
        .output()
        .expect("run proof-shards");

    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).expect("utf8 stderr");
    assert!(stderr.contains("shard_count must be greater than zero"));
    assert!(!output_dir.exists());
}

#[test]
fn proof_shards_rejects_unpinned_fixture_source() {
    let directory = tempdir().expect("tempdir");
    let source_path = directory.path().join("compact_land.geojson");
    let allowlist_path = directory.path().join("allowlist.json");
    let output_dir = directory.path().join("proofs");
    fs::write(&source_path, FIXTURE_SOURCE).expect("write source");

    let source_bytes = fs::read(&source_path).expect("source bytes");
    let source_hash = residence_allowlist::sha256_hex(&source_bytes);
    let fixture_manifest = LandSourceManifest {
        source_name: "Natural Earth ne_10m_land",
        version: "v5.1.2",
        url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson",
        sha256: Box::leak(source_hash.into_boxed_str()),
        resolution: 7,
        containment_mode: "h3o::geom::ContainmentMode::Covers",
    };
    let options = residence_allowlist::GenerateOptions {
        allowlist_version: 42,
        strategy: residence_allowlist::GenerationStrategy::Hierarchical,
        start_resolution: 5,
        target_resolution: 7,
        progress_interval: Duration::ZERO,
        ..residence_allowlist::GenerateOptions::default()
    };
    let artifact = build_allowlist_artifact_with_manifest(
        FIXTURE_SOURCE,
        &source_bytes,
        options,
        fixture_manifest,
    )
    .expect("allowlist artifact");
    write_allowlist_artifact_atomic(&allowlist_path, &artifact).expect("write allowlist");

    let output = Command::new(env!("CARGO_BIN_EXE_residence-allowlist"))
        .args([
            "proof-shards",
            "--allowlist",
            allowlist_path.to_str().expect("allowlist path"),
            "--source",
            source_path.to_str().expect("source path"),
            "--output-dir",
            output_dir.to_str().expect("output dir"),
            "--shard-count",
            "4",
        ])
        .output()
        .expect("run proof-shards");

    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).expect("utf8 stderr");
    assert!(stderr.contains("pinned Natural Earth source"));
    assert!(!output_dir.exists());
}

#[test]
fn verify_proof_shards_cli_accepts_generated_fixture_artifact() {
    let directory = tempdir().expect("tempdir");
    let output_dir = directory.path().join("proofs");
    let generated = generate_proof_shards(&fixture_leaves(), 4).expect("proof shards");
    write_generated_proof_shards_atomic(&output_dir, &generated).expect("write proof shards");

    let manifest_path = output_dir.join("proof_manifest.json");
    let manifest: ProofShardManifest =
        serde_json::from_slice(&fs::read(&manifest_path).expect("read proof_manifest.json"))
            .expect("parse proof manifest");
    assert_eq!(manifest.schema, "sonari.residence.proof_manifest.v1");
    assert_eq!(manifest.allowlist_version, 1);
    assert_eq!(manifest.shard_count, 4);
    assert_eq!(manifest.total_proof_count, fixture_leaves().len());
    assert_eq!(manifest.shards.len(), 4);

    for inventory in &manifest.shards {
        let shard_path = output_dir
            .join("shards")
            .join(format!("{:05}.json.gz", inventory.shard_id));
        let compressed = fs::read(&shard_path).expect("read shard gzip");
        assert_eq!(inventory.byte_size, compressed.len() as u64);
        assert_eq!(inventory.sha256, prefixed_hex(&Sha256::digest(&compressed)));

        let shard = decode_shard(&compressed);
        assert_eq!(shard.schema, "sonari.residence.proof_shard.v1");
        assert_eq!(shard.allowlist_version, 1);
        assert_eq!(shard.shard_id, inventory.shard_id);
        assert_eq!(shard.shard_count, 4);
        assert_eq!(shard.proofs.len(), inventory.proof_count);
    }

    let shards_dir = output_dir.join("shards");
    let verify_output = Command::new(env!("CARGO_BIN_EXE_residence-allowlist"))
        .args([
            "verify-proof-shards",
            "--manifest",
            manifest_path.to_str().expect("manifest path"),
            "--shards-dir",
            shards_dir.to_str().expect("shards dir"),
        ])
        .output()
        .expect("run verify-proof-shards");

    assert!(
        verify_output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&verify_output.stderr)
    );
    let summary: serde_json::Value =
        serde_json::from_slice(&verify_output.stdout).expect("verify summary");
    assert_eq!(summary["status"], "verified");
    assert_eq!(summary["shard_count"], 4);
    assert_eq!(summary["total_proof_count"], fixture_leaves().len());
}

#[test]
fn generate_rejects_unpinned_fixture_source() {
    let directory = tempdir().expect("tempdir");
    let source_path = directory.path().join("compact_land.geojson");
    let output_path = directory.path().join("allowlist.json");
    fs::write(&source_path, FIXTURE_SOURCE).expect("write source");

    let output = Command::new(env!("CARGO_BIN_EXE_residence-allowlist"))
        .args([
            "generate",
            "--source",
            source_path.to_str().expect("source path"),
            "--output",
            output_path.to_str().expect("output path"),
            "--allowlist-version",
            "42",
            "--progress-interval-seconds",
            "0",
        ])
        .output()
        .expect("run generate");

    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).expect("utf8 stderr");
    assert!(stderr.contains("source file does not match pinned Natural Earth source"));
    assert!(!output_path.exists());
}

fn decode_shard(compressed: &[u8]) -> ProofShard {
    let mut decoder = GzDecoder::new(compressed);
    let mut json = Vec::new();
    decoder.read_to_end(&mut json).expect("gzip decode");
    serde_json::from_slice(&json).expect("parse proof shard")
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
