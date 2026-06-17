use std::io::Write;
use std::process::{Command, Stdio};

use census_tee::{
    AffectedCell, AffectedCellsArtifact, INTENT, VERIFIER_FAMILY, VERIFIER_VERSION,
    compute_affected_cells_root,
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

fn census_tee() -> Command {
    Command::new(env!("CARGO_BIN_EXE_census-tee"))
}

#[test]
fn cli_top_level_help_exits_successfully() {
    let output = census_tee()
        .arg("--help")
        .output()
        .expect("failed to run census-tee --help");

    assert!(
        output.status.success(),
        "expected --help to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn cli_fixture_command_returns_signed_floor_census_result() {
    let output = run_fixture(&valid_bundle_json());

    assert!(
        output.status.success(),
        "expected fixture command to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("fixture stdout should be JSON");

    assert_eq!(result["status"], "finalized");
    assert_eq!(result["payload"]["intent"], INTENT);
    assert_eq!(result["payload"]["verifier_family"], VERIFIER_FAMILY);
    assert_eq!(result["payload"]["verifier_version"], VERIFIER_VERSION);
    assert_eq!(result["payload"]["event_revision"], 7);
    assert_eq!(
        result["payload"]["registered_members_by_band"],
        serde_json::json!([1, 1, 0])
    );
    assert_eq!(result["payload"]["issued_at_ms"], 1_234);

    let payload_bytes = decode_hex_field(&result, "payload_bcs_hex");
    let public_key_bytes: [u8; 32] = decode_hex_field(&result, "public_key")
        .try_into()
        .expect("public_key should be 32 bytes");
    let signature_bytes: [u8; 64] = decode_hex_field(&result, "signature")
        .try_into()
        .expect("signature should be 64 bytes");
    let verifying_key =
        VerifyingKey::from_bytes(&public_key_bytes).expect("public_key should be Ed25519");

    verifying_key
        .verify(&payload_bytes, &Signature::from_bytes(&signature_bytes))
        .expect("signature should verify against payload_bcs_hex bytes");
}

fn run_fixture(input: &serde_json::Value) -> std::process::Output {
    let mut child = census_tee()
        .args(["fixture", "--signing-key-seed", &"7b".repeat(32)])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn census-tee fixture");

    child
        .stdin
        .as_mut()
        .expect("stdin should be piped")
        .write_all(serde_json::to_string(input).unwrap().as_bytes())
        .expect("failed to write fixture input");

    child
        .wait_with_output()
        .expect("failed to wait for census-tee fixture")
}

fn valid_bundle_json() -> serde_json::Value {
    let event_uid = "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd";
    let affected_cells = AffectedCellsArtifact {
        event_uid: event_uid.to_owned(),
        event_revision: 7,
        oracle_version: 1,
        geo_resolution: 7,
        cells_generation_method: "shakemap_gridxml_h3_grid_point_p90_v1".to_owned(),
        cell_metric: "USGS_MMI".to_owned(),
        cell_aggregation: "GRID_POINT_P90".to_owned(),
        intensity_scale: "MMI_X100".to_owned(),
        affected_cells: vec![
            AffectedCell {
                h3_index: "10".to_owned(),
                intensity_value: 600,
                cell_band: 1,
            },
            AffectedCell {
                h3_index: "20".to_owned(),
                intensity_value: 700,
                cell_band: 2,
            },
        ],
    };
    let affected_cells_root = compute_affected_cells_root(event_uid, 7, &affected_cells).unwrap();

    serde_json::json!({
        "event_uid": event_uid,
        "event_revision": 7,
        "cutoff_ms": 1_000,
        "affected_cells_root": affected_cells_root,
        "issued_at_ms": 1_234,
        "affected_cells": affected_cells,
        "home_cell_events": [
            {
                "lineage": format!("0x{}", "11".repeat(32)),
                "home_cell": "10",
                "registered_at_ms": 900
            },
            {
                "lineage": format!("0x{}", "22".repeat(32)),
                "home_cell": "20",
                "registered_at_ms": 901
            },
            {
                "lineage": format!("0x{}", "33".repeat(32)),
                "home_cell": "10",
                "registered_at_ms": 1_000
            }
        ],
        "active_lineages": [
            format!("0x{}", "11".repeat(32)),
            format!("0x{}", "22".repeat(32)),
            format!("0x{}", "33".repeat(32))
        ]
    })
}

fn decode_hex_field(value: &serde_json::Value, field: &str) -> Vec<u8> {
    let hex = value[field]
        .as_str()
        .unwrap_or_else(|| panic!("{field} should be a string"));
    let hex = hex
        .strip_prefix("0x")
        .unwrap_or_else(|| panic!("{field} should be 0x-prefixed"));
    hex.chars()
        .collect::<Vec<_>>()
        .chunks(2)
        .map(|chunk| {
            u8::from_str_radix(&chunk.iter().collect::<String>(), 16)
                .unwrap_or_else(|_| panic!("{field} should contain valid hex"))
        })
        .collect()
}
