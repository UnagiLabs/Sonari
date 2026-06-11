use crate::verify::kyc::{KYC_UNSUPPORTED, verify_kyc_unsupported};
use crate::verify::world_id::{
    WORLD_ID_VERIFICATION_FAILED, WorldIdVerificationStatus, WorldIdVerifiedEvidence,
    WorldIdVerifier,
};
use crate::{
    INTENT, IdentityError, IdentityProvider, IdentityTeeResult, IdentityVerifyRequest,
    VERIFIER_FAMILY, VERIFIER_VERSION, compute_world_id_duplicate_key_hash,
    encoding::identity_bcs::payload_bcs_bytes,
};
use sha3::{Digest, Keccak256};
use sonari_tee_core::{PayloadSigner, SignatureArtifact, hex_to_32, sha256_bytes, to_hex};

const IDENTITY_EVIDENCE_HASH_PREFIX: &str = "sonari:identity_evidence:v1";
const WORLD_ID_SIGNAL_HASH_PREFIX: &str = "sonari:world_id_signal:v1";
const IDENTITY_RESULT_TTL_MS: u64 = 31_536_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityProcessingStatus {
    Verified,
    Rejected,
    PendingSource,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityProcessingOutput {
    pub status: IdentityProcessingStatus,
    pub error_code: Option<String>,
    pub result: Option<IdentityTeeResult>,
    pub unsigned_bcs_payload: Option<Vec<u8>>,
    pub signature: Option<SignatureArtifact>,
}

pub fn process_identity_with_verifier(
    request: IdentityVerifyRequest,
    verifier: &impl WorldIdVerifier,
    signer: &impl PayloadSigner,
    now_ms: u64,
) -> Result<IdentityProcessingOutput, IdentityError> {
    match request.provider {
        IdentityProvider::WorldId => {
            let proof = request.world_id.clone().ok_or_else(|| {
                IdentityError::Request(
                    "world_id proof is required for World ID provider".to_owned(),
                )
            })?;
            if !world_id_request_matches_trusted_boundary(&request, &proof, verifier)? {
                return Ok(status_only(
                    IdentityProcessingStatus::Rejected,
                    Some(WORLD_ID_VERIFICATION_FAILED.to_owned()),
                ));
            }
            Ok(match verifier.verify_world_id(&proof) {
                WorldIdVerificationStatus::Verified { evidence } => {
                    let issued_at_ms = request.issued_at_ms.unwrap_or(now_ms);
                    verified_output(request, &evidence, signer, issued_at_ms)?
                }
                WorldIdVerificationStatus::Rejected { error_code } => {
                    status_only(IdentityProcessingStatus::Rejected, Some(error_code))
                }
                WorldIdVerificationStatus::PendingSource { error_code } => {
                    status_only(IdentityProcessingStatus::PendingSource, Some(error_code))
                }
            })
        }
        IdentityProvider::Kyc => {
            let error_code = match verify_kyc_unsupported() {
                crate::verify::kyc::KycVerificationStatus::Unsupported { error_code } => error_code,
            };
            debug_assert_eq!(error_code, KYC_UNSUPPORTED);
            Ok(status_only(
                IdentityProcessingStatus::Unsupported,
                Some(error_code),
            ))
        }
    }
}

pub fn compute_world_id_signal_hash(
    owner: &str,
    membership_id: &str,
    signed_statement_hash: &str,
) -> Result<String, IdentityError> {
    let owner = canonical_hex_32_lower("owner", owner)?;
    let membership_id = canonical_hex_32_lower("membership_id", membership_id)?;
    let signed_statement_hash =
        canonical_hex_32_lower("signed_statement_hash", signed_statement_hash)?;
    let parts = [
        WORLD_ID_SIGNAL_HASH_PREFIX,
        owner.as_str(),
        membership_id.as_str(),
        signed_statement_hash.as_str(),
    ];
    for part in parts {
        if part.is_empty() || part.contains('\0') {
            return Err(IdentityError::Request(
                "World ID signal hash inputs must be non-empty strings without NUL".to_owned(),
            ));
        }
    }

    Ok(hash_to_field_bytes(parts.join("\0").as_bytes()))
}

fn hash_to_field_bytes(input_bytes: &[u8]) -> String {
    let digest = Keccak256::digest(input_bytes);
    let mut field_bytes = [0u8; 32];
    field_bytes[1..].copy_from_slice(&digest[..31]);
    to_hex(&field_bytes)
}

pub fn compute_identity_evidence_hash(
    provider: IdentityProvider,
    duplicate_key_hash_hex: &str,
    verification_level: &str,
    issued_at_ms: u64,
) -> Result<String, IdentityError> {
    validate_lowercase_hex_32("duplicate_key_hash_hex", duplicate_key_hash_hex)?;

    let issued_at_ms_decimal = issued_at_ms.to_string();
    let provider = provider_name(provider);
    let parts = [
        IDENTITY_EVIDENCE_HASH_PREFIX,
        provider,
        duplicate_key_hash_hex,
        verification_level,
        &issued_at_ms_decimal,
    ];
    for part in parts {
        if part.is_empty() || part.contains('\0') {
            return Err(IdentityError::Request(
                "identity evidence hash inputs must be non-empty strings without NUL".to_owned(),
            ));
        }
    }

    Ok(to_hex(&sha256_bytes(parts.join("\0").as_bytes())))
}

pub fn compute_world_id_evidence_hash(
    evidence: &WorldIdVerifiedEvidence,
    duplicate_key_hash_hex: &str,
    issued_at_ms: u64,
) -> Result<String, IdentityError> {
    validate_lowercase_hex_32("duplicate_key_hash_hex", duplicate_key_hash_hex)?;
    let issued_at_ms_decimal = issued_at_ms.to_string();
    let parts = [
        IDENTITY_EVIDENCE_HASH_PREFIX,
        "world_id",
        duplicate_key_hash_hex,
        &evidence.rp_id,
        &evidence.environment,
        &evidence.action,
        &evidence.protocol_version,
        &evidence.identifier,
        &evidence.nullifier,
        &evidence.signal_hash,
        &issued_at_ms_decimal,
    ];
    for part in parts {
        if part.is_empty() || part.contains('\0') {
            return Err(IdentityError::Request(
                "World ID evidence hash inputs must be non-empty strings without NUL".to_owned(),
            ));
        }
    }

    Ok(to_hex(&sha256_bytes(parts.join("\0").as_bytes())))
}

fn world_id_request_matches_trusted_boundary(
    request: &IdentityVerifyRequest,
    proof: &crate::WorldIdProofRequest,
    verifier: &impl WorldIdVerifier,
) -> Result<bool, IdentityError> {
    let claims = match proof.uniqueness_proof() {
        Ok(claims) => claims,
        Err(IdentityError::Request(_)) => return Ok(false),
        Err(error) => return Err(error),
    };
    if claims.action != verifier.expected_action() {
        return Ok(false);
    }
    if claims.environment != verifier.expected_environment() {
        return Ok(false);
    }
    let expected_signal_hash = compute_world_id_signal_hash(
        &request.owner,
        &request.membership_id,
        &request.signed_statement_hash,
    )?;

    let Ok(actual_signal_hash) = canonical_hex_32_lower("signal_hash", &claims.signal_hash) else {
        return Ok(false);
    };

    Ok(actual_signal_hash == expected_signal_hash)
}

fn verified_output(
    request: IdentityVerifyRequest,
    evidence: &WorldIdVerifiedEvidence,
    signer: &impl PayloadSigner,
    issued_at_ms: u64,
) -> Result<IdentityProcessingOutput, IdentityError> {
    let duplicate_key_hash = compute_world_id_duplicate_key_hash(
        &evidence.rp_id,
        &evidence.action,
        &evidence.nullifier,
    )?;
    let evidence_hash =
        compute_world_id_evidence_hash(evidence, &duplicate_key_hash, issued_at_ms)?;
    let validity_ms = request.validity_ms.unwrap_or(IDENTITY_RESULT_TTL_MS);
    if validity_ms == 0 {
        return Err(IdentityError::Request(
            "identity result validity_ms must be greater than zero".to_owned(),
        ));
    }
    let expires_at_ms = issued_at_ms.checked_add(validity_ms).ok_or_else(|| {
        IdentityError::Request("identity result expires_at_ms exceeds u64 range".to_owned())
    })?;
    let result = IdentityTeeResult {
        intent: INTENT.to_owned(),
        verifier_family: VERIFIER_FAMILY.to_owned(),
        verifier_version: VERIFIER_VERSION,
        registry_id: request.registry_id,
        membership_id: request.membership_id,
        owner: request.owner,
        provider: IdentityProvider::WorldId,
        verified: true,
        duplicate_key_hash,
        evidence_hash,
        issued_at_ms,
        expires_at_ms,
        terms_version: request.terms_version,
        signed_statement_hash: request.signed_statement_hash,
    };
    let unsigned_bcs_payload = payload_bcs_bytes(&result)?;
    let signature = signer.sign_payload(&unsigned_bcs_payload);

    Ok(IdentityProcessingOutput {
        status: IdentityProcessingStatus::Verified,
        error_code: None,
        result: Some(result),
        unsigned_bcs_payload: Some(unsigned_bcs_payload),
        signature: Some(signature),
    })
}

fn status_only(
    status: IdentityProcessingStatus,
    error_code: Option<String>,
) -> IdentityProcessingOutput {
    IdentityProcessingOutput {
        status,
        error_code,
        result: None,
        unsigned_bcs_payload: None,
        signature: None,
    }
}

fn provider_name(provider: IdentityProvider) -> &'static str {
    match provider {
        IdentityProvider::Kyc => "kyc",
        IdentityProvider::WorldId => "world_id",
    }
}

fn validate_lowercase_hex_32(field: &str, value: &str) -> Result<(), IdentityError> {
    hex_to_32(value)?;
    if value != value.to_ascii_lowercase() {
        return Err(IdentityError::Request(format!(
            "{field} must be lowercase 0x-prefixed hex"
        )));
    }
    Ok(())
}

fn canonical_hex_32_lower(field: &str, value: &str) -> Result<String, IdentityError> {
    let Some(hex) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    else {
        return Err(IdentityError::Request(format!(
            "{field} must be a 0x-prefixed 32-byte hex string"
        )));
    };
    let normalized = format!("0x{hex}");
    hex_to_32(&normalized).map_err(IdentityError::from)?;

    Ok(format!("0x{}", hex.to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::{
        IDENTITY_RESULT_TTL_MS, IdentityProcessingStatus, compute_identity_evidence_hash,
        compute_world_id_signal_hash, hash_to_field_bytes, process_identity_with_verifier,
    };
    use crate::{
        IdentityProvider, IdentityVerifyRequest, KYC_UNSUPPORTED, WORLD_ID_ACTION,
        WORLD_ID_API_UNAVAILABLE, WORLD_ID_VERIFICATION_FAILED, WorldIdProofRequest,
        WorldIdVerificationStatus, WorldIdVerifiedEvidence, WorldIdVerifier,
    };
    use sonari_tee_core::{PayloadSigner, SignatureArtifact, to_hex};
    use std::cell::Cell;

    struct MockWorldIdVerifier {
        status: WorldIdVerificationStatus,
    }

    impl WorldIdVerifier for MockWorldIdVerifier {
        fn expected_rp_id(&self) -> &str {
            "rp_staging_123"
        }

        fn verify_world_id(&self, _proof: &WorldIdProofRequest) -> WorldIdVerificationStatus {
            self.status.clone()
        }
    }

    struct CountingSigner {
        calls: Cell<u32>,
    }

    impl CountingSigner {
        fn new() -> Self {
            Self {
                calls: Cell::new(0),
            }
        }
    }

    impl PayloadSigner for CountingSigner {
        fn sign_payload(&self, payload: &[u8]) -> SignatureArtifact {
            self.calls.set(self.calls.get() + 1);
            SignatureArtifact {
                algorithm: "test".to_owned(),
                public_key: to_hex(&[1; 32]),
                signature: to_hex(payload),
            }
        }
    }

    #[test]
    fn process_identity_with_verifier_returns_verified_for_success_mock() {
        let signer = CountingSigner::new();
        let now_ms = 1_800_000_000_000;
        let output = process_identity_with_verifier(
            world_id_request(),
            &MockWorldIdVerifier {
                status: verified_status(),
            },
            &signer,
            now_ms,
        )
        .unwrap();

        assert_eq!(output.status, IdentityProcessingStatus::Verified);
        assert_eq!(output.error_code, None);
        let result = output.result.as_ref().unwrap();
        let payload = output.unsigned_bcs_payload.as_ref().unwrap();
        let signature = output.signature.as_ref().unwrap();
        assert_eq!(
            result.duplicate_key_hash,
            "0x2495bdd8628419cba45dda015074a8637f7158616b76d53bac08e7dfe14ca250"
        );
        assert_eq!(
            result.evidence_hash,
            "0x3a163204e93663fcb6062045a93b1a145a7686997c15105b75c6ca4432f6c764"
        );
        assert_eq!(result.issued_at_ms, now_ms);
        assert_eq!(result.expires_at_ms, now_ms + IDENTITY_RESULT_TTL_MS);
        assert_eq!(signature.signature, to_hex(payload));
        assert_eq!(signer.calls.get(), 1);
    }

    #[test]
    fn process_identity_uses_verified_evidence_nullifier_for_duplicate_key() {
        let signer = CountingSigner::new();
        let mut request = world_id_request();
        request.world_id.as_mut().unwrap().idkit_response["responses"][0]["nullifier"] =
            serde_json::json!("99999999999999999999");
        let output = process_identity_with_verifier(
            request,
            &MockWorldIdVerifier {
                status: verified_status(),
            },
            &signer,
            1_800_000_000_000,
        )
        .unwrap();

        assert_eq!(output.status, IdentityProcessingStatus::Verified);
        assert_eq!(
            output.result.unwrap().duplicate_key_hash,
            "0x2495bdd8628419cba45dda015074a8637f7158616b76d53bac08e7dfe14ca250"
        );
    }

    #[test]
    fn process_identity_with_verifier_returns_rejected_for_invalid_proof_mock() {
        let signer = CountingSigner::new();
        let output = process_identity_with_verifier(
            world_id_request(),
            &MockWorldIdVerifier {
                status: WorldIdVerificationStatus::Rejected {
                    error_code: WORLD_ID_VERIFICATION_FAILED.to_owned(),
                },
            },
            &signer,
            1_800_000_000_000,
        )
        .unwrap();

        assert_eq!(output.status, IdentityProcessingStatus::Rejected);
        assert_eq!(
            output.error_code,
            Some(WORLD_ID_VERIFICATION_FAILED.to_owned())
        );
        assert_non_verified_output(&output);
        assert_eq!(signer.calls.get(), 0);
    }

    #[test]
    fn process_identity_with_verifier_returns_rejected_for_max_verifications_mock() {
        let signer = CountingSigner::new();
        let output = process_identity_with_verifier(
            world_id_request(),
            &MockWorldIdVerifier {
                status: WorldIdVerificationStatus::Rejected {
                    error_code: WORLD_ID_VERIFICATION_FAILED.to_owned(),
                },
            },
            &signer,
            1_800_000_000_000,
        )
        .unwrap();

        assert_eq!(output.status, IdentityProcessingStatus::Rejected);
        assert_non_verified_output(&output);
        assert_eq!(signer.calls.get(), 0);
    }

    #[test]
    fn process_identity_with_verifier_returns_pending_source_for_network_mock() {
        let signer = CountingSigner::new();
        let output = process_identity_with_verifier(
            world_id_request(),
            &MockWorldIdVerifier {
                status: WorldIdVerificationStatus::PendingSource {
                    error_code: WORLD_ID_API_UNAVAILABLE.to_owned(),
                },
            },
            &signer,
            1_800_000_000_000,
        )
        .unwrap();

        assert_eq!(output.status, IdentityProcessingStatus::PendingSource);
        assert_eq!(output.error_code, Some(WORLD_ID_API_UNAVAILABLE.to_owned()));
        assert_non_verified_output(&output);
        assert_eq!(signer.calls.get(), 0);
    }

    #[test]
    fn process_identity_with_verifier_returns_unsupported_for_kyc_request() {
        let signer = CountingSigner::new();
        let output = process_identity_with_verifier(
            IdentityVerifyRequest {
                provider: IdentityProvider::Kyc,
                world_id: None,
                ..base_request()
            },
            &MockWorldIdVerifier {
                status: verified_status(),
            },
            &signer,
            1_800_000_000_000,
        )
        .unwrap();

        assert_eq!(output.status, IdentityProcessingStatus::Unsupported);
        assert_eq!(output.error_code, Some(KYC_UNSUPPORTED.to_owned()));
        assert_non_verified_output(&output);
        assert_eq!(signer.calls.get(), 0);
    }

    #[test]
    fn process_identity_rejects_noncanonical_action_before_signing() {
        let signer = CountingSigner::new();
        let mut request = world_id_request();
        request.world_id.as_mut().unwrap().idkit_response["action"] =
            serde_json::json!("attacker_action");
        let output = process_identity_with_verifier(
            request,
            &MockWorldIdVerifier {
                status: verified_status(),
            },
            &signer,
            1_800_000_000_000,
        )
        .unwrap();

        assert_eq!(output.status, IdentityProcessingStatus::Rejected);
        assert_non_verified_output(&output);
        assert_eq!(signer.calls.get(), 0);
    }

    #[test]
    fn process_identity_rejects_mismatched_signal_hash_before_signing() {
        let signer = CountingSigner::new();
        let mut request = world_id_request();
        request.world_id.as_mut().unwrap().idkit_response["responses"][0]["signal_hash"] =
            serde_json::json!("0x4444444444444444444444444444444444444444444444444444444444444444");
        let output = process_identity_with_verifier(
            request,
            &MockWorldIdVerifier {
                status: verified_status(),
            },
            &signer,
            1_800_000_000_000,
        )
        .unwrap();

        assert_eq!(output.status, IdentityProcessingStatus::Rejected);
        assert_non_verified_output(&output);
        assert_eq!(signer.calls.get(), 0);
    }

    #[test]
    fn process_identity_rejects_mismatched_environment_before_signing() {
        let signer = CountingSigner::new();
        let mut request = world_id_request();
        request.world_id.as_mut().unwrap().idkit_response["environment"] =
            serde_json::json!("production");
        let output = process_identity_with_verifier(
            request,
            &MockWorldIdVerifier {
                status: verified_status(),
            },
            &signer,
            1_800_000_000_000,
        )
        .unwrap();

        assert_eq!(output.status, IdentityProcessingStatus::Rejected);
        assert_non_verified_output(&output);
        assert_eq!(signer.calls.get(), 0);
    }

    #[test]
    fn process_identity_rejects_session_proof_before_signing() {
        let signer = CountingSigner::new();
        let mut request = world_id_request();
        request.world_id.as_mut().unwrap().idkit_response["session_id"] =
            serde_json::json!("session-123");
        let output = process_identity_with_verifier(
            request,
            &MockWorldIdVerifier {
                status: verified_status(),
            },
            &signer,
            1_800_000_000_000,
        )
        .unwrap();

        assert_eq!(output.status, IdentityProcessingStatus::Rejected);
        assert_non_verified_output(&output);
        assert_eq!(signer.calls.get(), 0);
    }

    #[test]
    fn process_identity_rejects_multiple_world_id_responses_before_signing() {
        let signer = CountingSigner::new();
        let mut request = world_id_request();
        let extra_response =
            request.world_id.as_ref().unwrap().idkit_response["responses"][0].clone();
        request.world_id.as_mut().unwrap().idkit_response["responses"]
            .as_array_mut()
            .unwrap()
            .push(extra_response);
        let output = process_identity_with_verifier(
            request,
            &MockWorldIdVerifier {
                status: verified_status(),
            },
            &signer,
            1_800_000_000_000,
        )
        .unwrap();

        assert_eq!(output.status, IdentityProcessingStatus::Rejected);
        assert_non_verified_output(&output);
        assert_eq!(signer.calls.get(), 0);
    }

    #[test]
    fn process_identity_rejects_unallowed_identifier_before_signing() {
        let signer = CountingSigner::new();
        let mut request = world_id_request();
        request.world_id.as_mut().unwrap().idkit_response["responses"][0]["identifier"] =
            serde_json::json!("session");
        let output = process_identity_with_verifier(
            request,
            &MockWorldIdVerifier {
                status: verified_status(),
            },
            &signer,
            1_800_000_000_000,
        )
        .unwrap();

        assert_eq!(output.status, IdentityProcessingStatus::Rejected);
        assert_non_verified_output(&output);
        assert_eq!(signer.calls.get(), 0);
    }

    #[test]
    fn process_identity_accepts_uppercase_hex_digits_in_signal_inputs() {
        let signer = CountingSigner::new();
        let mut request = world_id_request();
        request.owner = upper_hex_digits(&request.owner);
        request.membership_id = upper_hex_digits(&request.membership_id);
        request.signed_statement_hash = upper_hex_digits(&request.signed_statement_hash);
        request.world_id.as_mut().unwrap().idkit_response["responses"][0]["signal_hash"] =
            serde_json::json!(upper_hex_digits(
                &compute_world_id_signal_hash(
                    &request.owner,
                    &request.membership_id,
                    &request.signed_statement_hash,
                )
                .unwrap(),
            ));

        let output = process_identity_with_verifier(
            request,
            &MockWorldIdVerifier {
                status: verified_status(),
            },
            &signer,
            1_800_000_000_000,
        )
        .unwrap();

        assert_eq!(output.status, IdentityProcessingStatus::Verified);
        assert!(output.result.is_some());
        assert_eq!(signer.calls.get(), 1);
    }

    #[test]
    fn process_identity_allows_idkit_response_extra_fields_before_forwarding() {
        let signer = CountingSigner::new();
        let mut request = world_id_request();
        request.world_id.as_mut().unwrap().idkit_response["responses"][0]["max_age"] =
            serde_json::json!(604800);
        request.world_id.as_mut().unwrap().idkit_response["verification_extra"] =
            serde_json::json!("preserved-for-world-api");

        let output = process_identity_with_verifier(
            request,
            &MockWorldIdVerifier {
                status: verified_status(),
            },
            &signer,
            1_800_000_000_000,
        )
        .unwrap();

        assert_eq!(output.status, IdentityProcessingStatus::Verified);
        assert!(output.result.is_some());
        assert_eq!(signer.calls.get(), 1);
    }

    #[test]
    fn world_id_hash_to_field_matches_official_vectors() {
        let vectors = golden_vectors();
        for vector in vectors.official_hash_to_field {
            assert_eq!(
                hash_to_field_bytes(&vector.input_bytes()),
                vector.expected_hash_to_field,
                "{}",
                vector.name
            );
        }
    }

    #[test]
    fn world_id_signal_hash_matches_fixed_formula() {
        let vector = golden_vectors().sonari_signal_hash;
        let signal_hash = compute_world_id_signal_hash(
            &vector.owner,
            &vector.membership_id,
            &vector.signed_statement_hash,
        )
        .unwrap();

        assert_eq!(signal_hash, vector.expected_signal_hash);
    }

    #[test]
    fn evidence_hash_matches_fixed_formula() {
        let evidence_hash = compute_identity_evidence_hash(
            IdentityProvider::WorldId,
            "0xb9dabcfc937c5422b28ddd2db18466a02c1f9fadb5637d120a3a455e23e88a74",
            "proof_of_human",
            1_800_000_000_000,
        )
        .unwrap();

        assert_eq!(
            evidence_hash,
            "0xcf572d6cf4b82b52799b745061946372af6106e0abf52fd7142a4b6c095e1634"
        );
    }

    #[test]
    fn evidence_hash_rejects_nul_inputs() {
        let error = compute_identity_evidence_hash(
            IdentityProvider::WorldId,
            "0xb9dabcfc937c5422b28ddd2db18466a02c1f9fadb5637d120a3a455e23e88a74",
            concat!("proof_of_hum", "\0", "an"),
            1_800_000_000_000,
        )
        .unwrap_err();

        assert!(error.to_string().contains("without NUL"));
    }

    #[test]
    fn evidence_hash_rejects_uppercase_duplicate_key_hex() {
        let error = compute_identity_evidence_hash(
            IdentityProvider::WorldId,
            "0xB9DABCFC937C5422B28DDD2DB18466A02C1F9FADB5637D120A3A455E23E88A74",
            "proof_of_human",
            1_800_000_000_000,
        )
        .unwrap_err();

        assert!(error.to_string().contains("lowercase"));
    }

    fn assert_non_verified_output(output: &super::IdentityProcessingOutput) {
        assert_eq!(output.result, None);
        assert_eq!(output.unsigned_bcs_payload, None);
        assert_eq!(output.signature, None);
    }

    fn verified_status() -> WorldIdVerificationStatus {
        WorldIdVerificationStatus::Verified {
            evidence: WorldIdVerifiedEvidence {
                rp_id: "rp_staging_123".to_owned(),
                environment: "staging".to_owned(),
                action: WORLD_ID_ACTION.to_owned(),
                protocol_version: "4.0".to_owned(),
                identifier: "proof_of_human".to_owned(),
                nullifier: "12345678901234567890".to_owned(),
                signal_hash: "0x004c584cd5e136507a762e7bc3bdd3f2e2535f5d32a7c6f343e17377886cca47"
                    .to_owned(),
                created_at: None,
                session_id: None,
            },
        }
    }

    fn world_id_request() -> IdentityVerifyRequest {
        IdentityVerifyRequest {
            provider: IdentityProvider::WorldId,
            world_id: Some(WorldIdProofRequest {
                idkit_response: serde_json::json!({
                    "protocol_version": "4.0",
                    "nonce": "nonce-123",
                    "action": WORLD_ID_ACTION,
                    "environment": "staging",
                    "responses": [
                        {
                            "identifier": "proof_of_human",
                            "issuer_schema_id": 1,
                            "signal_hash": "0x004c584cd5e136507a762e7bc3bdd3f2e2535f5d32a7c6f343e17377886cca47",
                            "proof": "0xproof",
                            "merkle_root": "987654321",
                            "nullifier": "12345678901234567890"
                        }
                    ]
                }),
            }),
            ..base_request()
        }
    }

    fn base_request() -> IdentityVerifyRequest {
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
            world_id: None,
        }
    }

    fn upper_hex_digits(value: &str) -> String {
        format!("0x{}", value.trim_start_matches("0x").to_ascii_uppercase())
    }

    #[derive(serde::Deserialize)]
    struct GoldenVectors {
        official_hash_to_field: Vec<OfficialHashToFieldVector>,
        sonari_signal_hash: SonariSignalHashVector,
    }

    #[derive(serde::Deserialize)]
    struct OfficialHashToFieldVector {
        name: String,
        input_bytes_hex: String,
        expected_hash_to_field: String,
    }

    impl OfficialHashToFieldVector {
        fn input_bytes(&self) -> Vec<u8> {
            let hex = self
                .input_bytes_hex
                .strip_prefix("0x")
                .expect("golden vector input_bytes_hex must be 0x-prefixed");
            hex::decode(hex).expect("golden vector input_bytes_hex must be valid hex")
        }
    }

    #[derive(serde::Deserialize)]
    struct SonariSignalHashVector {
        owner: String,
        membership_id: String,
        signed_statement_hash: String,
        expected_signal_hash: String,
    }

    fn golden_vectors() -> GoldenVectors {
        serde_json::from_str(include_str!(
            "../../../../../../packages/proof-core/src/fixtures/world-id-signal-hash-vectors.json"
        ))
        .expect("world-id signal hash golden vectors must be valid JSON")
    }
}
