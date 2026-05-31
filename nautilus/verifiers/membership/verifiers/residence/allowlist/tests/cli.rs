use residence_allowlist::{
    ResidenceCellLeaf, generate_candidate_h3_indexes_from_geojson, merkle_root_from_leaves,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};

const COMPACT_LAND_PATH: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/compact_land.geojson");
const COMMITTED_MANIFEST_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../../../data/residence_cells/allowed_residence_cells_manifest.v1.res7.json"
);
const PINNED_NATURAL_EARTH_SHA256: &str =
    "1ac90796408bc6ad6911d69448485d3c4dbf2190370080368a09976e1c9f7416";

fn binary() -> Command {
    if let Some(path) = std::env::var_os("CARGO_BIN_EXE_residence-allowlist") {
        return Command::new(path);
    }

    let mut path = std::env::current_exe().expect("current test binary path is available");
    path.pop();
    if path.file_name().and_then(|name| name.to_str()) == Some("deps") {
        path.pop();
    }
    path.push(format!(
        "residence-allowlist{}",
        std::env::consts::EXE_SUFFIX
    ));
    Command::new(path)
}

fn test_dir(name: &str) -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("../../../../../../target/tmp/residence-allowlist-cli");
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is after unix epoch")
        .as_nanos();
    path.push(format!("{name}-{}-{unique}", std::process::id()));
    fs::create_dir_all(&path).expect("test temp dir is created");
    path
}

fn run(args: &[&str]) -> Output {
    binary().args(args).output().expect("CLI runs")
}

fn generate_fails_for_source(source_path: &Path, output_path: &Path) -> Output {
    let output = run(&[
        "generate",
        "--source",
        source_path.to_str().expect("path is utf8"),
        "--output",
        output_path.to_str().expect("path is utf8"),
        "--allowlist-version",
        "42",
    ]);
    assert!(!output.status.success());
    output
}

fn fixture_allowlist(output_path: &Path) -> Value {
    let source = fs::read_to_string(COMPACT_LAND_PATH).expect("fixture source exists");
    let indexes = generate_candidate_h3_indexes_from_geojson(&source)
        .expect("fixture candidates are generated")
        .into_iter()
        .map(|index| index.to_string())
        .collect::<Vec<_>>();
    let allowlist = json!({
        "schema": "sonari.residence.allowlist.v1",
        "schema_version": 1,
        "source": {
            "kind": "local_geojson",
            "name": "Natural Earth ne_10m_land",
            "version": "v5.1.2",
            "url": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson",
            "sha256": format!("0x{PINNED_NATURAL_EARTH_SHA256}"),
            "byte_length": source.len()
        },
        "geo_resolution": 7,
        "allowlist_version": 42,
        "h3_indexes": indexes
    });
    write_json(output_path, &allowlist);
    allowlist
}

fn unpinned_fixture_allowlist(source_path: &Path, output_path: &Path) -> Value {
    let source = fs::read_to_string(source_path).expect("fixture source exists");
    let indexes = generate_candidate_h3_indexes_from_geojson(&source)
        .expect("fixture candidates are generated")
        .into_iter()
        .map(|index| index.to_string())
        .collect::<Vec<_>>();
    let allowlist = json!({
        "schema": "sonari.residence.allowlist.v1",
        "schema_version": 1,
        "source": {
            "kind": "local_geojson",
            "name": "test land source",
            "version": "fixture",
            "url": source_path.to_str().expect("source path is utf8"),
            "sha256": format!("0x{}", source_sha256(source_path)),
            "byte_length": source.len()
        },
        "geo_resolution": 7,
        "allowlist_version": 42,
        "h3_indexes": indexes
    });
    write_json(output_path, &allowlist);
    allowlist
}

fn h3_indexes(allowlist: &Value) -> Vec<String> {
    allowlist["h3_indexes"]
        .as_array()
        .expect("h3_indexes is array")
        .iter()
        .map(|value| value.as_str().expect("h3_index is string").to_owned())
        .collect()
}

fn expected_root_hex(allowlist: &Value) -> String {
    let geo_resolution = allowlist["geo_resolution"]
        .as_u64()
        .expect("geo_resolution is u64") as u8;
    let allowlist_version = allowlist["allowlist_version"]
        .as_u64()
        .expect("allowlist_version is u64");
    let leaves = h3_indexes(allowlist)
        .into_iter()
        .map(|index| ResidenceCellLeaf {
            h3_index: index.parse::<u64>().expect("fixture h3_index is decimal"),
            geo_resolution,
            allowlist_version,
        })
        .collect::<Vec<_>>();
    let root = merkle_root_from_leaves(&leaves)
        .expect("generated allowlist is valid")
        .expect("generated allowlist is non-empty");
    format!("0x{}", hex::encode(root))
}

fn file_sha256(path: &Path) -> String {
    let bytes = fs::read(path).expect("file exists");
    format!("0x{}", hex::encode(Sha256::digest(bytes)))
}

fn source_sha256(path: &Path) -> String {
    hex::encode(Sha256::digest(fs::read(path).expect("source exists")))
}

fn manifest_for(source_path: &Path, allowlist_path: &Path, allowlist: &Value) -> Value {
    json!({
        "schema": "sonari.residence.allowlist.manifest.v1",
        "schema_version": 1,
        "allowlist_version": allowlist["allowlist_version"],
        "geo_resolution": allowlist["geo_resolution"],
        "source": {
            "name": "test land source",
            "version": "fixture",
            "url": source_path.to_str().expect("source path is utf8"),
            "sha256": source_sha256(source_path)
        },
        "generation_command": [
            "cargo",
            "run",
            "-p",
            "residence-allowlist",
            "--",
            "generate"
        ],
        "local_artifact_path": ".build/residence-cells/allowed_residence_cells.v1.res7.json",
        "s3": {
            "bucket_env": "SONARI_RESIDENCE_CELLS_BUCKET",
            "object_key": "residence-cells/v1/res7/allowed_residence_cells.v1.res7.json.gz",
            "version_id": null
        },
        "artifact": {
            "status": "local_test_fixture",
            "generated_at": null,
            "sha256": file_sha256(allowlist_path),
            "byte_size": fs::metadata(allowlist_path).expect("metadata").len(),
            "h3_count": h3_indexes(allowlist).len(),
            "merkle_root": expected_root_hex(allowlist)
        }
    })
}

fn pinned_manifest_for(allowlist_path: &Path, allowlist: &Value) -> Value {
    let mut manifest = manifest_for(Path::new(COMPACT_LAND_PATH), allowlist_path, allowlist);
    manifest["source"]["name"] = Value::String("Natural Earth ne_10m_land".to_owned());
    manifest["source"]["version"] = Value::String("v5.1.2".to_owned());
    manifest["source"]["url"] = Value::String(
        "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson"
            .to_owned(),
    );
    manifest["source"]["sha256"] = Value::String(PINNED_NATURAL_EARTH_SHA256.to_owned());
    manifest
}

fn write_json(path: &Path, value: &Value) {
    fs::write(
        path,
        serde_json::to_vec_pretty(value).expect("JSON serializes"),
    )
    .expect("JSON file is written");
}

#[test]
fn help_succeeds() {
    let output = run(&["--help"]);

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("generate"));
    assert!(stdout.contains("root"));
    assert!(stdout.contains("proof"));
}

#[test]
fn generate_rejects_unpinned_fixture_source() {
    let dir = test_dir("generate");
    let output_path = dir.join("allowlist.json");

    let output = generate_fails_for_source(Path::new(COMPACT_LAND_PATH), &output_path);

    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("source file does not match pinned Natural Earth source")
    );
    assert!(!output_path.exists());
}

#[test]
fn fixture_allowlist_is_deterministic_sorted_allowlist_json() {
    let dir = test_dir("fixture-allowlist");
    let first_path = dir.join("first.json");
    let second_path = dir.join("second.json");

    let first = fixture_allowlist(&first_path);
    let second = fixture_allowlist(&second_path);

    assert_eq!(
        fs::read(&first_path).expect("first output exists"),
        fs::read(&second_path).expect("second output exists")
    );
    assert_eq!(first, second);
    assert_eq!(first["schema"], "sonari.residence.allowlist.v1");
    assert_eq!(first["schema_version"], 1);
    assert_eq!(first["source"]["kind"], "local_geojson");
    assert_eq!(first["source"]["name"], "Natural Earth ne_10m_land");
    assert_eq!(first["source"]["version"], "v5.1.2");
    assert_eq!(
        first["source"]["sha256"],
        format!("0x{PINNED_NATURAL_EARTH_SHA256}")
    );
    assert_eq!(first["geo_resolution"], 7);
    assert_eq!(first["allowlist_version"], 42);

    let indexes = h3_indexes(&first);
    assert!(!indexes.is_empty());
    let mut sorted = indexes.clone();
    sorted.sort_by_key(|index| index.parse::<u64>().expect("decimal h3_index"));
    sorted.dedup();
    assert_eq!(indexes, sorted);
}

#[test]
fn root_rejects_unpinned_source_file_before_emitting_root() {
    let dir = test_dir("root");
    let allowlist_path = dir.join("allowlist.json");
    fixture_allowlist(&allowlist_path);

    let output = run(&[
        "root",
        "--allowlist",
        allowlist_path.to_str().expect("path is utf8"),
        "--source",
        COMPACT_LAND_PATH,
    ]);

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("local source file does not match pinned Natural Earth source")
    );
}

#[test]
fn root_rejects_unpinned_source_metadata() {
    let dir = test_dir("root-source-pin");
    let allowlist_path = dir.join("allowlist.json");
    let allowlist = unpinned_fixture_allowlist(Path::new(COMPACT_LAND_PATH), &allowlist_path);

    let output = run(&[
        "root",
        "--allowlist",
        allowlist_path.to_str().expect("path is utf8"),
        "--source",
        COMPACT_LAND_PATH,
    ]);

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(allowlist["source"]["name"], "test land source");
}

#[test]
fn proof_rejects_unpinned_source_file_before_emitting_proof() {
    let dir = test_dir("proof");
    let allowlist_path = dir.join("allowlist.json");
    let allowlist = fixture_allowlist(&allowlist_path);
    let allowed_h3_index = h3_indexes(&allowlist)
        .first()
        .expect("fixture has at least one h3_index")
        .to_owned();

    let allowed = run(&[
        "proof",
        "--allowlist",
        allowlist_path.to_str().expect("path is utf8"),
        "--source",
        COMPACT_LAND_PATH,
        "--h3-index",
        &allowed_h3_index,
    ]);

    assert!(!allowed.status.success());
    assert!(allowed.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&allowed.stderr)
            .contains("local source file does not match pinned Natural Earth source")
    );

    let non_allowed = run(&[
        "proof",
        "--allowlist",
        allowlist_path.to_str().expect("path is utf8"),
        "--source",
        COMPACT_LAND_PATH,
        "--h3-index",
        "1",
    ]);
    assert!(!non_allowed.status.success());
    assert!(non_allowed.stdout.is_empty());
}

#[test]
fn malformed_allowlists_are_rejected() {
    let dir = test_dir("malformed");
    let valid_path = dir.join("valid.json");
    let valid = fixture_allowlist(&valid_path);

    let cases = [
        ("bad-decimal.json", {
            let mut value = valid.clone();
            value["h3_indexes"][0] = Value::String("not-decimal".to_owned());
            value
        }),
        ("leading-zero.json", {
            let mut value = valid.clone();
            value["h3_indexes"][0] = Value::String(format!(
                "0{}",
                value["h3_indexes"][0].as_str().expect("h3_index")
            ));
            value
        }),
        ("duplicate.json", {
            let mut value = valid.clone();
            value["h3_indexes"][1] = value["h3_indexes"][0].clone();
            value
        }),
        ("wrong-resolution.json", {
            let mut value = valid.clone();
            value["geo_resolution"] = Value::from(6);
            value
        }),
        ("wrong-schema-version.json", {
            let mut value = valid.clone();
            value["schema_version"] = Value::from(2);
            value
        }),
    ];

    for (name, malformed) in cases {
        let path = dir.join(name);
        fs::write(
            &path,
            serde_json::to_vec_pretty(&malformed).expect("malformed JSON serializes"),
        )
        .expect("malformed allowlist is written");
        let output = run(&[
            "root",
            "--allowlist",
            path.to_str().expect("path is utf8"),
            "--source",
            COMPACT_LAND_PATH,
        ]);

        assert!(!output.status.success(), "{name} should fail");
        assert!(output.stdout.is_empty(), "{name} should not emit JSON");
    }
}

#[test]
fn verify_local_help_does_not_expose_unpinned_source_escape_hatch() {
    let output = run(&["verify-local", "--help"]);

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("--source"));
    assert!(!stdout.contains("allow-unpinned-source"));
}

#[test]
fn verify_local_rejects_allowlist_from_unpinned_source_even_with_matching_artifact_fields() {
    let dir = test_dir("verify-local-source-pin");
    let source_path = dir.join("alternate-source.geojson");
    let allowlist_path = dir.join("allowlist.json");
    let manifest_path = dir.join("manifest.json");
    fs::write(
        &source_path,
        fs::read_to_string(COMPACT_LAND_PATH)
            .expect("fixture source exists")
            .replace("compact_land", "alternate_land"),
    )
    .expect("alternate source is written");
    let allowlist = fixture_allowlist(&allowlist_path);
    let manifest = pinned_manifest_for(&allowlist_path, &allowlist);
    write_json(&manifest_path, &manifest);

    let output = run(&[
        "verify-local",
        "--manifest",
        manifest_path.to_str().expect("path is utf8"),
        "--allowlist",
        allowlist_path.to_str().expect("path is utf8"),
        "--source",
        source_path.to_str().expect("path is utf8"),
    ]);

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}

#[test]
fn verify_local_rejects_self_consistent_unpinned_manifest_by_default() {
    let dir = test_dir("verify-local-strict-source-pin");
    let source_path = dir.join("alternate-source.geojson");
    let allowlist_path = dir.join("allowlist.json");
    let manifest_path = dir.join("manifest.json");
    fs::write(
        &source_path,
        fs::read_to_string(COMPACT_LAND_PATH)
            .expect("fixture source exists")
            .replace("compact_land", "self_consistent_alternate_land"),
    )
    .expect("alternate source is written");
    let allowlist = unpinned_fixture_allowlist(&source_path, &allowlist_path);
    let manifest = manifest_for(&source_path, &allowlist_path, &allowlist);
    write_json(&manifest_path, &manifest);

    let output = run(&[
        "verify-local",
        "--manifest",
        manifest_path.to_str().expect("path is utf8"),
        "--allowlist",
        allowlist_path.to_str().expect("path is utf8"),
        "--source",
        source_path.to_str().expect("path is utf8"),
    ]);

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}

#[test]
fn committed_manifest_keeps_pending_production_artifact_metadata() {
    let manifest: Value = serde_json::from_slice(
        &fs::read(COMMITTED_MANIFEST_PATH).expect("committed manifest exists"),
    )
    .expect("committed manifest is JSON");

    assert_eq!(manifest["schema"], "sonari.residence.allowlist.manifest.v1");
    assert_eq!(manifest["schema_version"], 1);
    assert_eq!(manifest["geo_resolution"], 7);
    assert_eq!(manifest["source"]["name"], "Natural Earth ne_10m_land");
    assert_eq!(manifest["source"]["version"], "v5.1.2");
    assert_eq!(manifest["source"]["sha256"], PINNED_NATURAL_EARTH_SHA256,);
    assert_eq!(
        manifest["s3"]["bucket_env"],
        "SONARI_RESIDENCE_CELLS_BUCKET"
    );
    assert_eq!(
        manifest["artifact"]["status"],
        "pending_full_generation_and_s3_upload"
    );
    assert!(manifest["artifact"]["sha256"].is_null());
    assert!(manifest["artifact"]["merkle_root"].is_null());
}
