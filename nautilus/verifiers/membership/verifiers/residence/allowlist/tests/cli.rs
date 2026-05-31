use residence_allowlist::{ResidenceCellLeaf, merkle_root_from_leaves};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};

const COMPACT_LAND_PATH: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/compact_land.geojson");

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
