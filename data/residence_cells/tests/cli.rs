use std::{fs, process::Command};
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
    assert!(stdout.contains("verify-local"));
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
