use residence_allowlist::{ResidenceCellLeaf, merkle_root_from_leaves};
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

fn generate(output_path: &Path) -> Value {
    let output = run(&[
        "generate",
        "--source",
        COMPACT_LAND_PATH,
        "--output",
        output_path.to_str().expect("path is utf8"),
        "--allowlist-version",
        "42",
    ]);
    assert!(
        output.status.success(),
        "generate stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&fs::read(output_path).expect("allowlist file exists"))
        .expect("allowlist file is JSON")
}

fn generate_from_source(source_path: &Path, output_path: &Path) -> Value {
    let output = run(&[
        "generate",
        "--source",
        source_path.to_str().expect("path is utf8"),
        "--output",
        output_path.to_str().expect("path is utf8"),
        "--allowlist-version",
        "42",
    ]);
    assert!(
        output.status.success(),
        "generate stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&fs::read(output_path).expect("allowlist file exists"))
        .expect("allowlist file is JSON")
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

fn write_json(path: &Path, value: &Value) {
    fs::write(
        path,
        serde_json::to_vec_pretty(value).expect("JSON serializes"),
    )
    .expect("JSON file is written");
}

fn write_pinned_source_allowlist(path: &Path, allowlist: &Value) -> Value {
    let mut pinned = allowlist.clone();
    pinned["source"]["sha256"] = Value::String(format!("0x{PINNED_NATURAL_EARTH_SHA256}"));
    write_json(path, &pinned);
    pinned
}

fn rewrite_allowlist_source(path: &Path, allowlist: &Value, source_path: &Path) -> Value {
    let mut value = allowlist.clone();
    value["source"]["sha256"] = Value::String(format!("0x{}", source_sha256(source_path)));
    value["source"]["byte_length"] =
        Value::from(fs::metadata(source_path).expect("source metadata").len());
    write_json(path, &value);
    value
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
fn generate_writes_deterministic_sorted_allowlist_json() {
    let dir = test_dir("generate");
    let first_path = dir.join("first.json");
    let second_path = dir.join("second.json");

    let first = generate(&first_path);
    let second = generate(&second_path);

    assert_eq!(
        fs::read(&first_path).expect("first output exists"),
        fs::read(&second_path).expect("second output exists")
    );
    assert_eq!(first, second);
    assert_eq!(first["schema"], "sonari.residence.allowlist.v1");
    assert_eq!(first["schema_version"], 1);
    assert_eq!(first["source"]["kind"], "local_geojson");
    assert!(
        first["source"]["sha256"]
            .as_str()
            .expect("sha256")
            .starts_with("0x")
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
fn root_output_matches_library_root() {
    let dir = test_dir("root");
    let allowlist_path = dir.join("allowlist.json");
    let allowlist = generate(&allowlist_path);

    let output = run(&[
        "root",
        "--allowlist",
        allowlist_path.to_str().expect("path is utf8"),
    ]);

    assert!(
        output.status.success(),
        "root stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let root: Value = serde_json::from_slice(&output.stdout).expect("root stdout is JSON");
    assert_eq!(root["merkle_root"], expected_root_hex(&allowlist));
    assert_eq!(root["count"], h3_indexes(&allowlist).len());
    assert_eq!(root["geo_resolution"], 7);
    assert_eq!(root["allowlist_version"], 42);
}

#[test]
fn proof_succeeds_for_allowed_h3_index_and_fails_for_non_allowed_index() {
    let dir = test_dir("proof");
    let allowlist_path = dir.join("allowlist.json");
    let allowlist = generate(&allowlist_path);
    let allowed_h3_index = h3_indexes(&allowlist)
        .first()
        .expect("fixture has at least one h3_index")
        .to_owned();

    let allowed = run(&[
        "proof",
        "--allowlist",
        allowlist_path.to_str().expect("path is utf8"),
        "--h3-index",
        &allowed_h3_index,
    ]);
    assert!(
        allowed.status.success(),
        "proof stderr: {}",
        String::from_utf8_lossy(&allowed.stderr)
    );
    let proof: Value = serde_json::from_slice(&allowed.stdout).expect("proof stdout is JSON");
    assert_eq!(proof["target_h3_index"], allowed_h3_index);
    assert_eq!(proof["expected_root"], expected_root_hex(&allowlist));
    assert!(
        proof["target_leaf_hash"]
            .as_str()
            .expect("target_leaf_hash")
            .starts_with("0x")
    );

    let non_allowed = run(&[
        "proof",
        "--allowlist",
        allowlist_path.to_str().expect("path is utf8"),
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
    let valid = generate(&valid_path);

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
        let output = run(&["root", "--allowlist", path.to_str().expect("path is utf8")]);

        assert!(!output.status.success(), "{name} should fail");
        assert!(output.stdout.is_empty(), "{name} should not emit JSON");
    }
}

#[test]
fn verify_local_accepts_matching_manifest_and_allowlist() {
    let dir = test_dir("verify-local");
    let allowlist_path = dir.join("allowlist.json");
    let manifest_path = dir.join("manifest.json");
    let generated = generate(&allowlist_path);
    let allowlist =
        rewrite_allowlist_source(&allowlist_path, &generated, Path::new(COMPACT_LAND_PATH));
    write_json(
        &manifest_path,
        &manifest_for(Path::new(COMPACT_LAND_PATH), &allowlist_path, &allowlist),
    );

    let output = run(&[
        "verify-local",
        "--manifest",
        manifest_path.to_str().expect("path is utf8"),
        "--allowlist",
        allowlist_path.to_str().expect("path is utf8"),
        "--source",
        COMPACT_LAND_PATH,
    ]);

    assert!(
        output.status.success(),
        "verify-local stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let verified: Value = serde_json::from_slice(&output.stdout).expect("verify output is JSON");
    assert_eq!(verified["status"], "verified");
    assert_eq!(verified["sha256"], file_sha256(&allowlist_path));
    assert_eq!(verified["merkle_root"], expected_root_hex(&allowlist));
}

#[test]
fn verify_local_rejects_mismatched_manifest_values() {
    let dir = test_dir("verify-local-mismatch");
    let allowlist_path = dir.join("allowlist.json");
    let generated = generate(&allowlist_path);
    let allowlist =
        rewrite_allowlist_source(&allowlist_path, &generated, Path::new(COMPACT_LAND_PATH));

    let cases = [
        ("bad-sha.json", {
            let mut manifest =
                manifest_for(Path::new(COMPACT_LAND_PATH), &allowlist_path, &allowlist);
            manifest["artifact"]["sha256"] = Value::String(format!("0x{}", "00".repeat(32)));
            manifest
        }),
        ("bad-root.json", {
            let mut manifest =
                manifest_for(Path::new(COMPACT_LAND_PATH), &allowlist_path, &allowlist);
            manifest["artifact"]["merkle_root"] = Value::String(format!("0x{}", "11".repeat(32)));
            manifest
        }),
        ("bad-count.json", {
            let mut manifest =
                manifest_for(Path::new(COMPACT_LAND_PATH), &allowlist_path, &allowlist);
            manifest["artifact"]["h3_count"] = Value::from(999_999);
            manifest
        }),
    ];

    for (name, manifest) in cases {
        let manifest_path = dir.join(name);
        write_json(&manifest_path, &manifest);
        let output = run(&[
            "verify-local",
            "--manifest",
            manifest_path.to_str().expect("path is utf8"),
            "--allowlist",
            allowlist_path.to_str().expect("path is utf8"),
            "--source",
            COMPACT_LAND_PATH,
        ]);

        assert!(!output.status.success(), "{name} should fail");
        assert!(output.stdout.is_empty(), "{name} should not emit JSON");
    }
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
    let generated = generate_from_source(&source_path, &allowlist_path);
    let allowlist = write_pinned_source_allowlist(&allowlist_path, &generated);
    let manifest = manifest_for(Path::new(COMPACT_LAND_PATH), &allowlist_path, &allowlist);
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
