use residence_allowlist::{
    AllowlistManifest, GenerateOptions, GenerationStrategy, LandSourceManifest, ManifestArtifact,
    ManifestS3, ManifestSource, ResidenceCellLeaf, build_allowlist_artifact_with_manifest,
    generate_candidate_h3_indexes_from_geojson, merkle_root_from_leaves, prefixed_hex, root_output,
    sha256_hex, verify_local, write_allowlist_artifact_atomic,
};
use std::{fs, time::Duration};
use tempfile::tempdir;

const FIXTURE_SOURCE: &str = include_str!("fixtures/compact_land.geojson");

#[test]
fn hierarchical_matches_tiler_on_compact_fixture() {
    let hierarchical = generate_candidate_h3_indexes_from_geojson(
        FIXTURE_SOURCE,
        GenerateOptions {
            strategy: GenerationStrategy::Hierarchical,
            start_resolution: 5,
            target_resolution: 7,
            progress_interval: Duration::ZERO,
            ..GenerateOptions::default()
        },
    )
    .expect("hierarchical cells");
    let tiler = generate_candidate_h3_indexes_from_geojson(
        FIXTURE_SOURCE,
        GenerateOptions {
            strategy: GenerationStrategy::Tiler,
            target_resolution: 7,
            progress_interval: Duration::ZERO,
            ..GenerateOptions::default()
        },
    )
    .expect("tiler cells");

    assert!(!hierarchical.is_empty());
    assert_eq!(hierarchical, tiler);
}

#[test]
fn generated_h3_indexes_are_sorted_unique_and_overlap_based() {
    let candidates = generate_candidate_h3_indexes_from_geojson(
        FIXTURE_SOURCE,
        GenerateOptions {
            strategy: GenerationStrategy::Hierarchical,
            start_resolution: 5,
            target_resolution: 7,
            progress_interval: Duration::ZERO,
            ..GenerateOptions::default()
        },
    )
    .expect("candidate cells");

    let mut sorted = candidates.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(candidates, sorted);

    let reference = generate_candidate_h3_indexes_from_geojson(
        FIXTURE_SOURCE,
        GenerateOptions {
            strategy: GenerationStrategy::Tiler,
            target_resolution: 7,
            progress_interval: Duration::ZERO,
            ..GenerateOptions::default()
        },
    )
    .expect("overlap cells");
    assert_eq!(candidates, reference);
}

#[test]
fn malformed_geojson_source_fails_closed() {
    let result = generate_candidate_h3_indexes_from_geojson("{", GenerateOptions::default());
    assert!(result.is_err());

    let result = generate_candidate_h3_indexes_from_geojson(
        r#"{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[0,0]}}]}"#,
        GenerateOptions::default(),
    );
    assert!(result.is_err());
}

#[test]
fn generate_root_and_verify_local_with_fixture_pin() {
    let directory = tempdir().expect("tempdir");
    let source_path = directory.path().join("compact_land.geojson");
    let allowlist_path = directory.path().join("allowlist.json");
    let manifest_path = directory.path().join("manifest.json");
    fs::write(&source_path, FIXTURE_SOURCE).expect("write source");

    let source_bytes = fs::read(&source_path).expect("read source");
    let source_hash = sha256_hex(&source_bytes);
    let fixture_manifest = LandSourceManifest {
        source_name: "Natural Earth ne_10m_land",
        version: "v5.1.2",
        url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson",
        sha256: Box::leak(source_hash.clone().into_boxed_str()),
        resolution: 7,
        containment_mode: "h3o::geom::ContainmentMode::Covers",
    };
    let options = GenerateOptions {
        allowlist_version: 42,
        strategy: GenerationStrategy::Hierarchical,
        start_resolution: 5,
        target_resolution: 7,
        progress_interval: Duration::ZERO,
        ..GenerateOptions::default()
    };
    let artifact = build_allowlist_artifact_with_manifest(
        FIXTURE_SOURCE,
        &source_bytes,
        options,
        fixture_manifest,
    )
    .expect("artifact");
    write_allowlist_artifact_atomic(&allowlist_path, &artifact).expect("write artifact");

    let root = expected_root_hex(&artifact);
    let manifest = AllowlistManifest {
        schema: "sonari.residence.allowlist.manifest.v1".to_owned(),
        schema_version: 1,
        allowlist_version: artifact.allowlist_version,
        geo_resolution: artifact.geo_resolution,
        source: ManifestSource {
            name: "Natural Earth ne_10m_land".to_owned(),
            version: "v5.1.2".to_owned(),
            url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson".to_owned(),
            sha256: source_hash,
        },
        generation_command: vec![
            "cargo".to_owned(),
            "run".to_owned(),
            "--release".to_owned(),
            "--manifest-path".to_owned(),
            "data/residence_cells/Cargo.toml".to_owned(),
            "--".to_owned(),
            "generate".to_owned(),
        ],
        local_artifact_path: ".build/residence-cells/allowed_residence_cells.v1.res7.json".to_owned(),
        s3: ManifestS3 {
            bucket_env: "SONARI_RESIDENCE_CELLS_BUCKET".to_owned(),
            object_key: "residence-cells/v1/res7/allowed_residence_cells.v1.res7.json.gz".to_owned(),
            version_id: None,
        },
        artifact: ManifestArtifact {
            status: "local_test_fixture".to_owned(),
            generated_at: None,
            sha256: Some(prefixed_sha256(&fs::read(&allowlist_path).expect("read allowlist"))),
            byte_size: Some(fs::metadata(&allowlist_path).expect("metadata").len()),
            h3_count: Some(artifact.h3_indexes.len()),
            merkle_root: Some(root.clone()),
        },
    };
    fs::write(
        &manifest_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&manifest).expect("manifest json")
        ),
    )
    .expect("write manifest");

    let parsed_root = root_output(&allowlist_path, &source_path, options);
    assert!(
        parsed_root.is_err(),
        "unpinned fixture must fail normal root"
    );

    let verified = verify_local(&manifest_path, &allowlist_path, &source_path, options);
    assert!(
        verified.is_err(),
        "unpinned fixture must fail normal verify"
    );
}

fn expected_root_hex(artifact: &residence_allowlist::AllowlistArtifact) -> String {
    let leaves = artifact
        .h3_indexes
        .iter()
        .map(|index| ResidenceCellLeaf {
            h3_index: index.parse().expect("u64 h3"),
            geo_resolution: artifact.geo_resolution,
            allowlist_version: artifact.allowlist_version,
        })
        .collect::<Vec<_>>();
    prefixed_hex(
        &merkle_root_from_leaves(&leaves)
            .expect("root result")
            .expect("root"),
    )
}

fn prefixed_sha256(bytes: &[u8]) -> String {
    format!("0x{}", sha256_hex(bytes))
}
