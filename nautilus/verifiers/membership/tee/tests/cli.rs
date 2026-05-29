use std::io::Write;
use std::process::{Command, Stdio};

fn membership_tee() -> Command {
    Command::new(env!("CARGO_BIN_EXE_membership-tee"))
}

#[test]
fn top_level_help_exits_successfully() {
    let output = membership_tee()
        .arg("--help")
        .output()
        .expect("failed to run membership-tee --help");

    assert!(
        output.status.success(),
        "expected --help to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn fixture_help_exits_successfully() {
    let output = membership_tee()
        .args(["fixture", "--help"])
        .output()
        .expect("failed to run membership-tee fixture --help");

    assert!(
        output.status.success(),
        "expected fixture --help to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn production_help_exits_successfully() {
    let output = membership_tee()
        .args(["production", "--help"])
        .output()
        .expect("failed to run membership-tee production --help");

    assert!(
        output.status.success(),
        "expected production --help to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn fixture_command_returns_verified_result_from_stdin() {
    let output = run_with_stdin(
        membership_tee().arg("fixture"),
        &world_id_request_json().to_string(),
    );

    assert!(
        output.status.success(),
        "expected fixture command to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json = stdout_json(&output.stdout);
    assert_eq!(json["status"], "verified");
    assert!(json["payload_bcs_hex"].as_str().unwrap().starts_with("0x"));
    assert!(json["signature"].as_str().unwrap().starts_with("0x"));
    assert!(json["public_key"].as_str().unwrap().starts_with("0x"));
    assert!(json["duplicate_key_hash"].as_str().unwrap().starts_with("0x"));
    assert_eq!(json["expires_at_ms"], 1_800_003_600_000_u64);
    assert!(json.get("algorithm").is_none());
}

#[test]
fn fixture_command_returns_rejected_without_signature() {
    let output = run_with_stdin(
        membership_tee().args(["fixture", "--world-id-status", "rejected"]),
        &world_id_request_json().to_string(),
    );

    assert!(
        output.status.success(),
        "expected fixture rejected command to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json = stdout_json(&output.stdout);
    assert_eq!(json["status"], "rejected");
    assert_eq!(json["error_code"], "WORLD_ID_VERIFICATION_FAILED");
    assert_non_verified_has_no_signature(&json);
}

#[test]
fn fixture_command_returns_pending_source_without_signature() {
    let output = run_with_stdin(
        membership_tee().args(["fixture", "--world-id-status", "pending-source"]),
        &world_id_request_json().to_string(),
    );

    assert!(
        output.status.success(),
        "expected fixture pending-source command to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json = stdout_json(&output.stdout);
    assert_eq!(json["status"], "pending_source");
    assert_eq!(json["error_code"], "WORLD_ID_API_UNAVAILABLE");
    assert_non_verified_has_no_signature(&json);
}

#[test]
fn fixture_command_returns_unsupported_for_kyc_without_signature() {
    let output = run_with_stdin(
        membership_tee().arg("fixture"),
        &kyc_request_json().to_string(),
    );

    assert!(
        output.status.success(),
        "expected fixture kyc command to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json = stdout_json(&output.stdout);
    assert_eq!(json["status"], "unsupported");
    assert_eq!(json["error_code"], "KYC_NOT_IMPLEMENTED");
    assert_non_verified_has_no_signature(&json);
}

#[test]
fn fixture_command_rejects_malformed_json_with_empty_stdout() {
    let output = run_with_stdin(membership_tee().arg("fixture"), "{not-json");

    assert!(
        !output.status.success(),
        "expected malformed JSON to fail"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("key must be a string"),
        "expected serde error, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout), "");
}

#[test]
fn production_command_fails_closed_without_signing_seed() {
    let output = run_with_stdin(
        membership_tee()
            .arg("production")
            .env_remove("SONARI_TEE_SIGNING_KEY_SEED")
            .env_remove("SONARI_TEE_SIGNING_KEY_SEED_FILE"),
        &world_id_request_json().to_string(),
    );

    assert!(
        !output.status.success(),
        "expected production without signing seed to fail"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("SONARI_TEE_SIGNING_KEY_SEED"),
        "expected missing seed error, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout), "");
}

#[test]
fn production_command_returns_pending_source_from_unreachable_world_id_api() {
    let output = run_with_stdin(
        membership_tee()
            .arg("production")
            .env(
                "SONARI_TEE_SIGNING_KEY_SEED",
                "0x0707070707070707070707070707070707070707070707070707070707070707",
            )
            .env("SONARI_WORLD_ID_API_BASE", "https://127.0.0.1:9")
            .env("SONARI_WORLD_ID_APP_ID", "app_staging_123"),
        &world_id_request_json().to_string(),
    );

    assert!(
        output.status.success(),
        "expected production pending_source to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json = stdout_json(&output.stdout);
    assert_eq!(json["status"], "pending_source");
    assert_eq!(json["error_code"], "WORLD_ID_API_UNAVAILABLE");
    assert_non_verified_has_no_signature(&json);
}

fn run_with_stdin(command: &mut Command, stdin: &str) -> std::process::Output {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn membership-tee");
    child
        .stdin
        .as_mut()
        .expect("stdin should be piped")
        .write_all(stdin.as_bytes())
        .expect("failed to write stdin");
    child
        .wait_with_output()
        .expect("failed to wait for membership-tee")
}

fn stdout_json(stdout: &[u8]) -> serde_json::Value {
    serde_json::from_slice(stdout).expect("stdout should be JSON")
}

fn assert_non_verified_has_no_signature(json: &serde_json::Value) {
    assert!(json.get("payload_bcs_hex").is_none());
    assert!(json.get("signature").is_none());
    assert!(json.get("public_key").is_none());
    assert!(json.get("duplicate_key_hash").is_none());
    assert!(json.get("expires_at_ms").is_none());
}

fn kyc_request_json() -> serde_json::Value {
    let mut json = base_request_json();
    json["provider"] = serde_json::json!("kyc");
    json["world_id"] = serde_json::Value::Null;
    json
}

fn world_id_request_json() -> serde_json::Value {
    let mut json = base_request_json();
    json["world_id"] = serde_json::json!({
        "world_app_id": "app_staging_123",
        "nullifier_hash": "12345678901234567890",
        "merkle_root": "987654321",
        "proof": "0xproof",
        "verification_level": "orb",
        "action": "sonari_membership_register_v1",
        "signal_hash": "0x34b7cb40efe9b84ed3c26b036f2691f75c3bb1ecbfa695baf147a372aa2e3268",
    });
    json
}

fn base_request_json() -> serde_json::Value {
    serde_json::json!({
        "registry_id": "0x1111111111111111111111111111111111111111111111111111111111111111",
        "membership_id": "0x2222222222222222222222222222222222222222222222222222222222222222",
        "owner": "0x3333333333333333333333333333333333333333333333333333333333333333",
        "provider": "world_id",
        "terms_version": 1_u64,
        "signed_statement_hash": "0x6666666666666666666666666666666666666666666666666666666666666666",
        "issued_at_ms": 1_800_000_000_000_u64,
        "validity_ms": 3_600_000_u64,
        "world_id": null,
    })
}
