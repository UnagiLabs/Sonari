use std::io::Write;
use std::process::{Command, Stdio};

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use membership_tee::{
    INTENT, KYC_UNSUPPORTED, PROVIDER_WORLD_ID, VERIFIER_FAMILY, VERIFIER_VERSION,
    WORLD_ID_API_BASE_ENV, WORLD_ID_API_UNAVAILABLE, WORLD_ID_APP_ID_ENV,
    WORLD_ID_VERIFICATION_FAILED,
};
use serde::Deserialize;

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
fn fixture_command_returns_signed_verified_world_id_result() {
    let output = run_fixture(&[], &world_id_request());

    assert!(
        output.status.success(),
        "expected fixture command to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("fixture stdout should be JSON");

    assert_eq!(result["status"], "verified");
    assert_eq!(result["registry_id"], REGISTRY_ID);
    assert_eq!(result["membership_id"], MEMBERSHIP_ID);
    assert_eq!(result["owner"], OWNER);
    assert_eq!(result["provider"], "world_id");
    assert_eq!(result["verified"], true);
    assert_eq!(result["issued_at_ms"], ISSUED_AT_MS);
    assert_eq!(result["expires_at_ms"], ISSUED_AT_MS + VALIDITY_MS);
    assert_eq!(result["terms_version"], TERMS_VERSION);
    assert_eq!(result["signed_statement_hash"], SIGNED_STATEMENT_HASH);

    let payload_bytes = decode_hex_field(&result, "payload_bcs_hex");
    let payload = bcs::from_bytes::<IdentityPayloadBcs>(&payload_bytes)
        .expect("payload_bcs_hex should decode as identity payload BCS");

    assert_eq!(payload.intent, INTENT.as_bytes());
    assert_eq!(payload.verifier_family, VERIFIER_FAMILY.as_bytes());
    assert_eq!(payload.verifier_version, VERIFIER_VERSION);
    assert_eq!(hex_32(payload.registry_id), REGISTRY_ID);
    assert_eq!(hex_32(payload.membership_id), MEMBERSHIP_ID);
    assert_eq!(hex_32(payload.owner), OWNER);
    assert_eq!(payload.provider, PROVIDER_WORLD_ID);
    assert!(payload.verified);
    assert_eq!(
        hex_32(payload.duplicate_key_hash),
        result["duplicate_key_hash"]
            .as_str()
            .expect("duplicate_key_hash should be a string")
    );
    assert_eq!(
        hex_32(payload.evidence_hash),
        result["evidence_hash"]
            .as_str()
            .expect("evidence_hash should be a string")
    );
    assert_eq!(payload.issued_at_ms, ISSUED_AT_MS);
    assert_eq!(payload.expires_at_ms, ISSUED_AT_MS + VALIDITY_MS);
    assert!(payload.expires_at_ms > payload.issued_at_ms);
    assert_eq!(payload.terms_version, TERMS_VERSION);
    assert_eq!(hex_32(payload.signed_statement_hash), SIGNED_STATEMENT_HASH);

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
        .expect("signature should verify against payload bytes without intent prefix");
}

#[test]
fn fixture_command_returns_unsupported_for_kyc_without_signature_fields() {
    let output = run_fixture(&[], &kyc_request());

    assert_status_only(output, "unsupported", KYC_UNSUPPORTED);
}

#[test]
fn fixture_command_returns_rejected_world_id_without_signature_fields() {
    let output = run_fixture(&["--world-id-status", "rejected"], &world_id_request());

    assert_status_only(output, "rejected", WORLD_ID_VERIFICATION_FAILED);
}

#[test]
fn fixture_command_returns_pending_source_world_id_without_signature_fields() {
    let output = run_fixture(
        &["--world-id-status", "pending-source"],
        &world_id_request(),
    );

    assert_status_only(output, "pending_source", WORLD_ID_API_UNAVAILABLE);
}

#[test]
fn fixture_command_rejects_mismatched_world_app_id_without_signature_fields() {
    let mut request = world_id_request();
    request["world_id"]["world_app_id"] = serde_json::json!("app_attacker");
    let output = run_fixture(&[], &request);

    assert_status_only(output, "rejected", WORLD_ID_VERIFICATION_FAILED);
}

#[test]
fn fixture_command_rejects_zero_validity_before_signing() {
    let mut request = world_id_request();
    request["validity_ms"] = serde_json::json!(0);
    let output = run_fixture(&[], &request);

    assert!(
        !output.status.success(),
        "expected zero validity to fail, stdout: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("validity_ms"),
        "expected validity_ms error, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn fixture_command_rejects_top_level_unknown_request_field() {
    let mut request = world_id_request();
    request["raw_personal_data"] = serde_json::json!("do-not-accept");

    let output = run_fixture(&[], &request);

    assert!(
        !output.status.success(),
        "expected unknown top-level field to fail, stdout: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("unknown field"),
        "expected serde unknown field error, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn fixture_command_rejects_nested_world_id_unknown_request_field() {
    let mut request = world_id_request();
    request["world_id"]["raw_proof_context"] = serde_json::json!("do-not-accept");

    let output = run_fixture(&[], &request);

    assert!(
        !output.status.success(),
        "expected unknown nested field to fail, stdout: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("unknown field"),
        "expected serde unknown field error, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn encode_only_outputs_only_payload_bcs_hex_for_verified_result() {
    let vector = world_id_success_vector();
    let result = vector["result"].clone();
    let output = run_encode_only(&result);

    assert!(
        output.status.success(),
        "expected encode-only to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("encode-only stdout should be JSON");
    let fields = json
        .as_object()
        .expect("encode-only output should be an object");
    assert_eq!(
        fields.keys().map(String::as_str).collect::<Vec<_>>(),
        vec!["payload_bcs_hex"]
    );
    assert_eq!(json["payload_bcs_hex"], vector["payload_bcs_hex"]);
    let payload_bytes = decode_hex_field(&json, "payload_bcs_hex");
    let payload = bcs::from_bytes::<IdentityPayloadBcs>(&payload_bytes)
        .expect("payload_bcs_hex should decode as identity payload BCS");

    assert_eq!(payload.intent, INTENT.as_bytes());
    assert_eq!(payload.verifier_family, VERIFIER_FAMILY.as_bytes());
    assert_eq!(payload.verifier_version, VERIFIER_VERSION);
    assert_eq!(hex_32(payload.registry_id), REGISTRY_ID);
    assert_eq!(hex_32(payload.membership_id), MEMBERSHIP_ID);
    assert!(payload.verified);
}

#[test]
fn encode_only_rejects_unverified_result() {
    let mut result = verified_identity_result();
    result["verified"] = serde_json::json!(false);
    let output = run_encode_only(&result);

    assert!(
        !output.status.success(),
        "expected encode-only to reject verified=false, stdout: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("verified result"),
        "expected verified=false error, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn encode_only_rejects_unknown_result_field() {
    let mut result = verified_identity_result();
    result["raw_personal_data"] = serde_json::json!("do-not-accept");
    let output = run_encode_only(&result);

    assert!(
        !output.status.success(),
        "expected encode-only to reject unknown fields, stdout: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("unknown field"),
        "expected serde unknown field error, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn production_command_returns_rejected_before_http_for_mismatched_world_app_id() {
    let mut request = world_id_request();
    request["world_id"]["world_app_id"] = serde_json::json!("app_attacker");

    let output = run_production(
        &request,
        &[
            (WORLD_ID_API_BASE_ENV, "https://developer.world.org"),
            (WORLD_ID_APP_ID_ENV, "app_staging_123"),
            (PRODUCTION_SIGNING_KEY_SEED_ENV, TEST_SIGNING_KEY_SEED),
        ],
    );

    assert_status_only(output, "rejected", WORLD_ID_VERIFICATION_FAILED);
}

#[test]
fn production_command_returns_pending_source_when_world_id_api_is_unavailable() {
    let output = run_production(
        &world_id_request(),
        &[
            (WORLD_ID_API_BASE_ENV, "https://127.0.0.1:9"),
            (WORLD_ID_APP_ID_ENV, "app_staging_123"),
            (PRODUCTION_SIGNING_KEY_SEED_ENV, TEST_SIGNING_KEY_SEED),
        ],
    );

    assert_status_only(output, "pending_source", WORLD_ID_API_UNAVAILABLE);
}

#[test]
fn production_command_requires_issue_signing_key_env_without_dev_fallback() {
    let output = run_production(
        &world_id_request(),
        &[
            (WORLD_ID_API_BASE_ENV, "https://developer.world.org"),
            (WORLD_ID_APP_ID_ENV, "app_staging_123"),
            (
                "SONARI_IDENTITY_TEE_SIGNING_KEY_SEED",
                TEST_SIGNING_KEY_SEED,
            ),
        ],
    );

    assert!(
        !output.status.success(),
        "expected production to reject missing issue signing seed env, stdout: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains(PRODUCTION_SIGNING_KEY_SEED_ENV),
        "expected missing SONARI_TEE_SIGNING_KEY_SEED error, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

const REGISTRY_ID: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
const MEMBERSHIP_ID: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
const OWNER: &str = "0x3333333333333333333333333333333333333333333333333333333333333333";
const TERMS_VERSION: u64 = 1;
const SIGNED_STATEMENT_HASH: &str =
    "0x6666666666666666666666666666666666666666666666666666666666666666";
const ISSUED_AT_MS: u64 = 1_800_000_000_000;
const VALIDITY_MS: u64 = 86_400_000;
const PRODUCTION_SIGNING_KEY_SEED_ENV: &str = "SONARI_TEE_SIGNING_KEY_SEED";
const TEST_SIGNING_KEY_SEED: &str =
    "0x0707070707070707070707070707070707070707070707070707070707070707";

#[derive(Debug, Deserialize)]
struct IdentityPayloadBcs {
    intent: Vec<u8>,
    verifier_family: Vec<u8>,
    verifier_version: u64,
    registry_id: [u8; 32],
    membership_id: [u8; 32],
    owner: [u8; 32],
    provider: u8,
    verified: bool,
    duplicate_key_hash: [u8; 32],
    evidence_hash: [u8; 32],
    issued_at_ms: u64,
    expires_at_ms: u64,
    terms_version: u64,
    signed_statement_hash: [u8; 32],
}

fn decode_hex_field(result: &serde_json::Value, field: &str) -> Vec<u8> {
    let value = result[field]
        .as_str()
        .unwrap_or_else(|| panic!("{field} should be a string"));
    hex::decode(
        value
            .strip_prefix("0x")
            .unwrap_or_else(|| panic!("{field} should be 0x-prefixed")),
    )
    .unwrap_or_else(|error| panic!("{field} should be valid hex: {error}"))
}

fn hex_32(bytes: [u8; 32]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn run_fixture(args: &[&str], request: &serde_json::Value) -> std::process::Output {
    let mut child = membership_tee()
        .arg("fixture")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn membership-tee fixture");
    child
        .stdin
        .as_mut()
        .expect("fixture stdin should be writable")
        .write_all(serde_json::to_string(request).unwrap().as_bytes())
        .expect("failed to write fixture request");
    child
        .wait_with_output()
        .expect("failed to run membership-tee fixture")
}

fn assert_status_only(
    output: std::process::Output,
    expected_status: &str,
    expected_error_code: &str,
) {
    assert!(
        output.status.success(),
        "expected command to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout should be JSON");

    assert_eq!(result["status"], expected_status);
    assert_eq!(result["error_code"], expected_error_code);
    let fields = result.as_object().expect("result should be an object");
    assert_eq!(
        fields.len(),
        2,
        "non-verified result should only include status and error_code"
    );
    for field in ["payload", "payload_bcs_hex", "signature", "public_key"] {
        assert!(
            !fields.contains_key(field),
            "non-verified result must not include {field}"
        );
    }
}

fn run_encode_only(result: &serde_json::Value) -> std::process::Output {
    let mut child = membership_tee()
        .arg("--encode-only")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn membership-tee --encode-only");
    child
        .stdin
        .as_mut()
        .expect("encode-only stdin should be writable")
        .write_all(serde_json::to_string(result).unwrap().as_bytes())
        .expect("failed to write encode-only result");
    child
        .wait_with_output()
        .expect("failed to run membership-tee --encode-only")
}

fn world_id_success_vector() -> serde_json::Value {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../schemas/examples/identity_result_vectors.json"
    ))
    .expect("identity result vectors should parse");
    vectors["vectors"]
        .as_array()
        .expect("vectors should be an array")
        .iter()
        .find(|vector| vector["case_id"] == "world_id_success_v1")
        .expect("world_id_success_v1 vector should exist")
        .clone()
}

fn run_production(request: &serde_json::Value, envs: &[(&str, &str)]) -> std::process::Output {
    let mut command = membership_tee();
    command
        .arg("production")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove("SONARI_IDENTITY_TEE_SIGNING_KEY_SEED")
        .env_remove("SONARI_IDENTITY_TEE_SIGNING_KEY_SEED_FILE")
        .env_remove("SONARI_TEE_SIGNING_KEY_SEED")
        .env_remove("SONARI_TEE_SIGNING_KEY_SEED_FILE")
        .env_remove(WORLD_ID_API_BASE_ENV)
        .env_remove(WORLD_ID_APP_ID_ENV);
    for (name, value) in envs {
        command.env(name, value);
    }

    let mut child = command
        .spawn()
        .expect("failed to spawn membership-tee production");
    child
        .stdin
        .as_mut()
        .expect("production stdin should be writable")
        .write_all(serde_json::to_string(request).unwrap().as_bytes())
        .expect("failed to write production request");
    child
        .wait_with_output()
        .expect("failed to run membership-tee production")
}

fn world_id_request() -> serde_json::Value {
    serde_json::json!({
        "registry_id": REGISTRY_ID,
        "membership_id": MEMBERSHIP_ID,
        "owner": OWNER,
        "provider": "world_id",
        "issued_at_ms": ISSUED_AT_MS,
        "validity_ms": VALIDITY_MS,
        "terms_version": TERMS_VERSION,
        "signed_statement_hash": SIGNED_STATEMENT_HASH,
        "world_id": {
            "world_app_id": "app_staging_123",
            "nullifier_hash": "12345678901234567890",
            "merkle_root": "987654321",
            "proof": "0xproof",
            "verification_level": "orb",
            "action": "sonari_membership_register_v1",
            "signal_hash": "0x004c584cd5e136507a762e7bc3bdd3f2e2535f5d32a7c6f343e17377886cca47",
        },
    })
}

fn verified_identity_result() -> serde_json::Value {
    serde_json::json!({
        "intent": INTENT,
        "verifier_family": VERIFIER_FAMILY,
        "verifier_version": VERIFIER_VERSION,
        "registry_id": REGISTRY_ID,
        "membership_id": MEMBERSHIP_ID,
        "owner": OWNER,
        "provider": "world_id",
        "verified": true,
        "duplicate_key_hash": "0xb9dabcfc937c5422b28ddd2db18466a02c1f9fadb5637d120a3a455e23e88a74",
        "evidence_hash": "0x68893c4e14f913225e4883e1f2f6c2768a0f2673f5ef253386bec3ffda2ac84f",
        "issued_at_ms": ISSUED_AT_MS,
        "expires_at_ms": ISSUED_AT_MS + VALIDITY_MS,
        "terms_version": TERMS_VERSION,
        "signed_statement_hash": SIGNED_STATEMENT_HASH,
    })
}

fn kyc_request() -> serde_json::Value {
    serde_json::json!({
        "registry_id": REGISTRY_ID,
        "membership_id": MEMBERSHIP_ID,
        "owner": OWNER,
        "provider": "kyc",
        "terms_version": TERMS_VERSION,
        "signed_statement_hash": SIGNED_STATEMENT_HASH,
        "world_id": null,
    })
}
