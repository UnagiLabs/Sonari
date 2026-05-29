use std::io::Write;
use std::process::{Command, Stdio};

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use membership_tee::{INTENT, PROVIDER_WORLD_ID, VERIFIER_FAMILY, VERIFIER_VERSION};
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
    let request = serde_json::json!({
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
            "signal_hash": "0x34b7cb40efe9b84ed3c26b036f2691f75c3bb1ecbfa695baf147a372aa2e3268",
        },
    });
    let mut child = membership_tee()
        .arg("fixture")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn membership-tee fixture");
    child
        .stdin
        .as_mut()
        .expect("fixture stdin should be writable")
        .write_all(serde_json::to_string(&request).unwrap().as_bytes())
        .expect("failed to write fixture request");
    let output = child
        .wait_with_output()
        .expect("failed to run membership-tee fixture");

    assert!(
        output.status.success(),
        "expected fixture command to succeed, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("fixture stdout should be JSON");

    assert_eq!(result["status"], "verified");
    assert_eq!(result["payload"]["registry_id"], REGISTRY_ID);
    assert_eq!(result["payload"]["membership_id"], MEMBERSHIP_ID);
    assert_eq!(result["payload"]["owner"], OWNER);
    assert_eq!(result["payload"]["provider"], "world_id");
    assert_eq!(result["payload"]["verified"], true);
    assert_eq!(result["payload"]["issued_at_ms"], ISSUED_AT_MS);
    assert_eq!(
        result["payload"]["expires_at_ms"],
        ISSUED_AT_MS + VALIDITY_MS
    );
    assert_eq!(result["payload"]["terms_version"], TERMS_VERSION);
    assert_eq!(
        result["payload"]["signed_statement_hash"],
        SIGNED_STATEMENT_HASH
    );

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
        result["payload"]["duplicate_key_hash"]
            .as_str()
            .expect("payload duplicate_key_hash should be a string")
    );
    assert_eq!(
        hex_32(payload.evidence_hash),
        result["payload"]["evidence_hash"]
            .as_str()
            .expect("payload evidence_hash should be a string")
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
fn production_command_fails_until_implemented() {
    let output = membership_tee()
        .arg("production")
        .output()
        .expect("failed to run membership-tee production");

    assert!(
        !output.status.success(),
        "expected production command to fail until implemented"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("not implemented yet"),
        "expected not implemented error, stderr: {}",
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
