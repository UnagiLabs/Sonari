//! Identity (membership) [`ProcessDataHandler`] and result assembly.
//!
//! The handler owns the identity domain logic only: it parses the Worker to TEE
//! request, runs the existing World ID verification pipeline
//! ([`process_identity_with_verifier`]), encodes the canonical identity BCS
//! payload, and produces either an unsigned envelope (non-verified) or a signable
//! envelope carrying the BCS payload bytes plus placeholder signature fields.
//!
//! It never signs, generates ephemeral keys, calls NSM attestation, performs
//! registration-metadata injection, or touches VSOCK/HTTP transport. Those
//! concerns belong to the shared server in `sonari_tee_core::enclave` and the
//! orchestration in `main.rs`.
//!
//! ## Production server path vs. legacy fixed-seed CLI path
//!
//! This handler is the **production server path**. It carries no signing seed:
//! the canonical BCS payload it emits is signed by the shared server using the
//! enclave's ephemeral key, so a fixed/dev seed can never reach this path. The
//! legacy `Fixture` / `Production` / `--encode-only` CLI subcommands in
//! `main.rs` keep their fixed-seed signing route for local/legacy use and are
//! structurally separate from this handler.

use crate::{
    CloudWorldIdVerifier, IdentityProcessingOutput, IdentityProcessingStatus, IdentityTeeResult,
    IdentityVerifyRequest, WorldIdVerifier, process_identity_with_verifier,
};
use serde::Serialize;
use sonari_tee_core::{
    HandlerError, PayloadSigner, ProcessDataHandler, ProcessOutput, SignatureArtifact, TeeContext,
    to_hex,
};

/// Egress proxy URL configuration key resolved by the shared server and read
/// from the [`TeeContext`] (never from the process environment inside `process`).
pub const EGRESS_PROXY_URL_KEY: &str = "SONARI_WORLD_ID_EGRESS_PROXY_URL";

/// Placeholder string the handler writes into `signature` / `public_key`.
///
/// The shared server signs `payload_bcs` and overwrites these placeholders in
/// place; because `serde_json` preserves key order, overwriting an existing key
/// keeps the field at its canonical position so the response stays byte-stable.
pub const UNSIGNED_PLACEHOLDER: &str = "";

/// Result envelope returned by the enclave `process_data` route.
///
/// This mirrors the historical membership wire shape exactly (see
/// `main.rs::TeeJsonResult`). For verified results the `signature` / `public_key`
/// fields carry [`UNSIGNED_PLACEHOLDER`] until the server signs `payload_bcs`.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum TeeJsonResult {
    Verified {
        #[serde(flatten)]
        payload: Box<IdentityTeeResult>,
        payload_bcs_hex: String,
        signature: String,
        public_key: String,
    },
    Rejected {
        error_code: String,
    },
    PendingSource {
        error_code: String,
    },
    Unsupported {
        error_code: String,
    },
}

/// Identity verifier request handler.
///
/// Implements the shared [`ProcessDataHandler`] contract by running the World ID
/// verification pipeline and emitting the unsigned identity BCS payload. It
/// carries no signing key, attestation logic, or transport state.
///
/// The World ID base URL and app id are resolved once in the orchestration layer
/// (`main.rs`) and injected at construction; the handler never reads the process
/// environment during `process`. The egress proxy URL still arrives through the
/// [`TeeContext`] so the verifier's HTTPS client can be routed through the
/// host-side egress proxy. This keeps env access confined to bootstrap.
#[derive(Debug, Clone)]
pub struct IdentityProcessHandler {
    world_id_base_url: String,
    world_id_app_id: String,
}

impl IdentityProcessHandler {
    /// Builds a handler with the orchestration-resolved World ID configuration.
    pub fn new(world_id_base_url: impl Into<String>, world_id_app_id: impl Into<String>) -> Self {
        Self {
            world_id_base_url: world_id_base_url.into(),
            world_id_app_id: world_id_app_id.into(),
        }
    }
}

impl ProcessDataHandler for IdentityProcessHandler {
    fn process(&self, input: &[u8], ctx: &TeeContext) -> Result<ProcessOutput, HandlerError> {
        let mut request: IdentityVerifyRequest =
            serde_json::from_slice(input).map_err(|error| process_failed(error.to_string()))?;
        // Production server path: the TEE owns issuance time, so the request can
        // never pin its own issued_at / validity (mirrors the legacy production
        // CLI route that also strips these before processing).
        request.issued_at_ms = None;
        request.validity_ms = None;

        let verifier = CloudWorldIdVerifier::with_proxy(
            self.world_id_base_url.clone(),
            self.world_id_app_id.clone(),
            ctx.get(EGRESS_PROXY_URL_KEY),
        )
        .map_err(|error| process_failed(error.to_string()))?;

        let issued_at_ms = current_unix_ms().map_err(|error| process_failed(error.to_string()))?;
        process_with_verifier(request, &verifier, issued_at_ms)
    }
}

/// Runs the identity pipeline with an injected verifier and issuance time.
///
/// The handler signs nothing: it passes a [`PlaceholderSigner`] so
/// [`process_identity_with_verifier`] fills the embedded signature with empty
/// placeholders. The shared server later signs the emitted `payload_bcs` with the
/// enclave's ephemeral key and overwrites those placeholders.
pub fn process_with_verifier(
    request: IdentityVerifyRequest,
    verifier: &impl WorldIdVerifier,
    issued_at_ms: u64,
) -> Result<ProcessOutput, HandlerError> {
    let output =
        process_identity_with_verifier(request, verifier, &PlaceholderSigner, issued_at_ms)
            .map_err(|error| process_failed(error.to_string()))?;
    process_output_from_identity(output)
}

/// Converts an [`IdentityProcessingOutput`] into the [`ProcessOutput`] returned
/// to the server.
///
/// A verified result becomes a [`ProcessOutput::Signable`] carrying the canonical
/// unsigned BCS payload the server must sign; a verified output without those
/// bytes is rejected (fail-closed) so the server can never emit an unsigned 200
/// for a verified result. Non-verified results become a
/// [`ProcessOutput::Unsigned`] envelope returned verbatim.
pub fn process_output_from_identity(
    output: IdentityProcessingOutput,
) -> Result<ProcessOutput, HandlerError> {
    match output.status {
        IdentityProcessingStatus::Verified => {
            let payload = output
                .result
                .ok_or_else(|| process_failed("verified output is missing payload"))?;
            let payload_bcs = output
                .unsigned_bcs_payload
                .filter(|bytes| !bytes.is_empty())
                .ok_or_else(|| {
                    process_failed("verified output is missing the unsigned BCS payload to sign")
                })?;
            let result = TeeJsonResult::Verified {
                payload_bcs_hex: to_hex(&payload_bcs),
                payload: Box::new(payload),
                signature: UNSIGNED_PLACEHOLDER.to_owned(),
                public_key: UNSIGNED_PLACEHOLDER.to_owned(),
            };
            let result_json =
                serde_json::to_value(&result).map_err(|error| process_failed(error.to_string()))?;
            Ok(ProcessOutput::signable(payload_bcs, result_json))
        }
        IdentityProcessingStatus::Rejected => unsigned_status(TeeJsonResult::Rejected {
            error_code: require_error_code(output.error_code, "rejected")?,
        }),
        IdentityProcessingStatus::PendingSource => unsigned_status(TeeJsonResult::PendingSource {
            error_code: require_error_code(output.error_code, "pending_source")?,
        }),
        IdentityProcessingStatus::Unsupported => unsigned_status(TeeJsonResult::Unsupported {
            error_code: require_error_code(output.error_code, "unsupported")?,
        }),
    }
}

fn unsigned_status(result: TeeJsonResult) -> Result<ProcessOutput, HandlerError> {
    let result_json =
        serde_json::to_value(&result).map_err(|error| process_failed(error.to_string()))?;
    Ok(ProcessOutput::unsigned(result_json))
}

fn require_error_code(error_code: Option<String>, status: &str) -> Result<String, HandlerError> {
    error_code.ok_or_else(|| process_failed(format!("{status} output is missing error code")))
}

fn process_failed(message: impl Into<String>) -> HandlerError {
    HandlerError::new("AWS_RUNNER_PROCESS_FAILED", message)
}

fn current_unix_ms() -> Result<u64, Box<dyn std::error::Error>> {
    let duration = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?;
    Ok(duration.as_millis().try_into()?)
}

/// Signer that emits only empty placeholders, never a real signature.
///
/// The production server path must sign with the enclave's ephemeral key in the
/// shared server, so the handler must not hold or use any signing seed. Feeding
/// this placeholder into [`process_identity_with_verifier`] keeps the pipeline's
/// shape (it still computes the BCS payload) while guaranteeing no fixed/dev seed
/// signature is ever produced here.
#[derive(Debug, Clone, Copy)]
struct PlaceholderSigner;

impl PayloadSigner for PlaceholderSigner {
    fn sign_payload(&self, _payload: &[u8]) -> SignatureArtifact {
        SignatureArtifact {
            algorithm: UNSIGNED_PLACEHOLDER.to_owned(),
            public_key: UNSIGNED_PLACEHOLDER.to_owned(),
            signature: UNSIGNED_PLACEHOLDER.to_owned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        EGRESS_PROXY_URL_KEY, IdentityProcessHandler, PlaceholderSigner, UNSIGNED_PLACEHOLDER,
        process_output_from_identity, process_with_verifier,
    };
    use crate::{
        INTENT, IdentityProvider, IdentityVerifyRequest, VERIFIER_FAMILY, VERIFIER_VERSION,
        WORLD_ID_ACTION, WORLD_ID_API_UNAVAILABLE, WORLD_ID_VERIFICATION_FAILED,
        WorldIdProofRequest, WorldIdVerificationStatus, WorldIdVerifier,
    };
    use sonari_tee_core::{PayloadSigner, ProcessDataHandler, ProcessOutput, TeeContext};

    struct MockWorldIdVerifier {
        status: WorldIdVerificationStatus,
    }

    impl WorldIdVerifier for MockWorldIdVerifier {
        fn expected_app_id(&self) -> &str {
            "app_staging_123"
        }

        fn verify_world_id(&self, _proof: &WorldIdProofRequest) -> WorldIdVerificationStatus {
            self.status.clone()
        }
    }

    fn world_id_request() -> IdentityVerifyRequest {
        IdentityVerifyRequest {
            registry_id: "0x1111111111111111111111111111111111111111111111111111111111111111"
                .to_owned(),
            membership_id: "0x2222222222222222222222222222222222222222222222222222222222222222"
                .to_owned(),
            owner: "0x3333333333333333333333333333333333333333333333333333333333333333".to_owned(),
            provider: IdentityProvider::WorldId,
            issued_at_ms: None,
            validity_ms: None,
            terms_version: 1,
            signed_statement_hash:
                "0x6666666666666666666666666666666666666666666666666666666666666666".to_owned(),
            world_id: Some(WorldIdProofRequest {
                world_app_id: "app_staging_123".to_owned(),
                nullifier_hash: "12345678901234567890".to_owned(),
                merkle_root: "987654321".to_owned(),
                proof: "0xproof".to_owned(),
                verification_level: "orb".to_owned(),
                action: WORLD_ID_ACTION.to_owned(),
                signal_hash: "0x34b7cb40efe9b84ed3c26b036f2691f75c3bb1ecbfa695baf147a372aa2e3268"
                    .to_owned(),
            }),
        }
    }

    fn request_json() -> serde_json::Value {
        serde_json::json!({
            "registry_id": "0x1111111111111111111111111111111111111111111111111111111111111111",
            "membership_id": "0x2222222222222222222222222222222222222222222222222222222222222222",
            "owner": "0x3333333333333333333333333333333333333333333333333333333333333333",
            "provider": "world_id",
            "issued_at_ms": null,
            "validity_ms": null,
            "terms_version": 1,
            "signed_statement_hash": "0x6666666666666666666666666666666666666666666666666666666666666666",
            "world_id": {
                "world_app_id": "app_staging_123",
                "nullifier_hash": "12345678901234567890",
                "merkle_root": "987654321",
                "proof": "0xproof",
                "verification_level": "orb",
                "action": WORLD_ID_ACTION,
                "signal_hash": "0x34b7cb40efe9b84ed3c26b036f2691f75c3bb1ecbfa695baf147a372aa2e3268",
            },
        })
    }

    #[test]
    fn placeholder_signer_never_produces_a_real_signature() {
        // The production server path must sign with the enclave ephemeral key in
        // the shared server; the handler-side signer must only ever emit blanks.
        let artifact = PlaceholderSigner.sign_payload(b"anything");
        assert_eq!(artifact.algorithm, UNSIGNED_PLACEHOLDER);
        assert_eq!(artifact.public_key, UNSIGNED_PLACEHOLDER);
        assert_eq!(artifact.signature, UNSIGNED_PLACEHOLDER);
    }

    #[test]
    fn verified_result_is_signable_with_placeholder_signature_and_canonical_order() {
        let output = process_with_verifier(
            world_id_request(),
            &MockWorldIdVerifier {
                status: WorldIdVerificationStatus::Verified,
            },
            1_900_000_000_000,
        )
        .expect("verified output should produce a signable result");

        let ProcessOutput::Signable {
            payload_bcs,
            result_json,
        } = output
        else {
            panic!("verified output must be signable");
        };
        assert!(!payload_bcs.is_empty(), "signable payload must carry bytes");
        assert_eq!(result_json["status"], "verified");
        assert_eq!(result_json["verifier_family"], VERIFIER_FAMILY);
        assert_eq!(result_json["verifier_version"], VERIFIER_VERSION);
        assert_eq!(result_json["intent"], INTENT);
        // TEE owns issuance time: request had no issued_at_ms, so now_ms is used.
        assert_eq!(result_json["issued_at_ms"], 1_900_000_000_000_u64);
        // signature / public_key are placeholders until the shared server signs.
        assert_eq!(result_json["signature"], UNSIGNED_PLACEHOLDER);
        assert_eq!(result_json["public_key"], UNSIGNED_PLACEHOLDER);
        let bcs_hex = result_json["payload_bcs_hex"].as_str().unwrap();
        assert!(bcs_hex.starts_with("0x") && bcs_hex.len() > 2);
    }

    #[test]
    fn rejected_result_is_unsigned_status_only() {
        let output = process_with_verifier(
            world_id_request(),
            &MockWorldIdVerifier {
                status: WorldIdVerificationStatus::Rejected {
                    error_code: WORLD_ID_VERIFICATION_FAILED.to_owned(),
                },
            },
            1_900_000_000_000,
        )
        .unwrap();

        assert!(matches!(output, ProcessOutput::Unsigned { .. }));
        let result = output.result_json();
        assert_eq!(result["status"], "rejected");
        assert_eq!(result["error_code"], WORLD_ID_VERIFICATION_FAILED);
        assert!(result.get("signature").is_none());
        assert!(result.get("payload_bcs_hex").is_none());
    }

    #[test]
    fn pending_source_result_is_unsigned_status_only() {
        let output = process_with_verifier(
            world_id_request(),
            &MockWorldIdVerifier {
                status: WorldIdVerificationStatus::PendingSource {
                    error_code: WORLD_ID_API_UNAVAILABLE.to_owned(),
                },
            },
            1_900_000_000_000,
        )
        .unwrap();

        assert!(matches!(output, ProcessOutput::Unsigned { .. }));
        assert_eq!(output.result_json()["status"], "pending_source");
        assert_eq!(output.result_json()["error_code"], WORLD_ID_API_UNAVAILABLE);
    }

    #[test]
    fn kyc_request_is_unsupported_unsigned_status() {
        let mut request = world_id_request();
        request.provider = IdentityProvider::Kyc;
        request.world_id = None;
        let output = process_with_verifier(
            request,
            &MockWorldIdVerifier {
                status: WorldIdVerificationStatus::Verified,
            },
            1_900_000_000_000,
        )
        .unwrap();

        assert!(matches!(output, ProcessOutput::Unsigned { .. }));
        assert_eq!(output.result_json()["status"], "unsupported");
    }

    #[test]
    fn process_output_rejects_verified_result_missing_bcs_payload() {
        let mut output = crate::process_identity_with_verifier(
            world_id_request(),
            &MockWorldIdVerifier {
                status: WorldIdVerificationStatus::Verified,
            },
            &PlaceholderSigner,
            1_900_000_000_000,
        )
        .unwrap();
        assert_eq!(output.status, crate::IdentityProcessingStatus::Verified);
        // Simulate a verified result whose signable bytes went missing: the server
        // must fail closed rather than return an unsigned 200.
        output.unsigned_bcs_payload = None;

        let error = process_output_from_identity(output)
            .expect_err("verified output without BCS payload must fail closed");
        assert_eq!(error.error_code, "AWS_RUNNER_PROCESS_FAILED");
        assert!(
            error.message.contains("unsigned BCS payload"),
            "msg: {}",
            error.message
        );
    }

    #[test]
    fn handler_rejects_malformed_request_input() {
        let handler = IdentityProcessHandler::new("https://developer.world.org", "app_staging_123");
        let error = handler
            .process(b"not json", &TeeContext::new())
            .expect_err("malformed input must produce a handler error");
        assert_eq!(error.error_code, "AWS_RUNNER_PROCESS_FAILED");
    }

    #[test]
    fn handler_rejects_request_with_unknown_field() {
        let handler = IdentityProcessHandler::new("https://developer.world.org", "app_staging_123");
        let mut body = request_json();
        body["raw_personal_data"] = serde_json::json!("do-not-accept");
        let error = handler
            .process(&serde_json::to_vec(&body).unwrap(), &TeeContext::new())
            .expect_err("unknown field must produce a handler error");
        assert_eq!(error.error_code, "AWS_RUNNER_PROCESS_FAILED");
        assert!(
            error.message.contains("unknown field"),
            "msg: {}",
            error.message
        );
    }

    #[test]
    fn handler_routes_world_id_through_injected_egress_proxy_to_unreachable_proxy() {
        // With an unreachable egress proxy injected via TeeContext, the World ID
        // request cannot reach the API, so a verified-mock-independent live call
        // resolves to pending_source. This proves the proxy is wired through the
        // context (a direct client would instead reach DNS/the real host).
        let handler = IdentityProcessHandler::new("https://developer.world.org", "app_staging_123");
        let ctx = TeeContext::with_env([(EGRESS_PROXY_URL_KEY, "http://127.0.0.1:9")]);

        let output = handler
            .process(&serde_json::to_vec(&request_json()).unwrap(), &ctx)
            .expect("handler should map an unreachable proxy to pending_source");

        assert!(matches!(output, ProcessOutput::Unsigned { .. }));
        assert_eq!(output.result_json()["status"], "pending_source");
        assert_eq!(output.result_json()["error_code"], WORLD_ID_API_UNAVAILABLE);
    }

    #[test]
    fn verified_result_keeps_membership_wire_field_order() {
        let output = process_with_verifier(
            world_id_request(),
            &MockWorldIdVerifier {
                status: WorldIdVerificationStatus::Verified,
            },
            1_900_000_000_000,
        )
        .unwrap();
        let value = output.result_json();
        let object = value.as_object().expect("verified result is an object");
        let keys = object.keys().map(String::as_str).collect::<Vec<_>>();
        // The verified envelope flattens IdentityTeeResult plus the status tag and
        // the payload_bcs_hex / signature / public_key tail (identical to the
        // historical membership wire shape in main.rs::TeeJsonResult).
        assert!(keys.contains(&"status"));
        assert!(keys.contains(&"payload_bcs_hex"));
        assert!(keys.contains(&"signature"));
        assert!(keys.contains(&"public_key"));
        assert!(keys.contains(&"verifier_family"));
        assert!(keys.contains(&"intent"));
    }
}
