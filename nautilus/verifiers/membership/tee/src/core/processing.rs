use crate::verify::kyc::{KYC_UNSUPPORTED, verify_kyc_unsupported};
use crate::verify::world_id::{WorldIdVerificationStatus, WorldIdVerifier};
use crate::{IdentityError, IdentityProvider, IdentityTeeResult, IdentityVerifyRequest};
use sonari_tee_core::{PayloadSigner, SignatureArtifact};

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
    _signer: &impl PayloadSigner,
    _now_ms: u64,
) -> Result<IdentityProcessingOutput, IdentityError> {
    match request.provider {
        IdentityProvider::WorldId => {
            let proof = request.world_id.as_ref().ok_or_else(|| {
                IdentityError::Request(
                    "world_id proof is required for World ID provider".to_owned(),
                )
            })?;
            Ok(match verifier.verify_world_id(proof) {
                WorldIdVerificationStatus::Verified => {
                    status_only(IdentityProcessingStatus::Verified, None)
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

#[cfg(test)]
mod tests {
    use super::{IdentityProcessingStatus, process_identity_with_verifier};
    use crate::{
        IdentityProvider, IdentityVerifyRequest, KYC_UNSUPPORTED, WORLD_ID_API_UNAVAILABLE,
        WORLD_ID_VERIFICATION_FAILED, WorldIdProofRequest, WorldIdVerificationStatus,
        WorldIdVerifier,
    };
    use sonari_tee_core::{PayloadSigner, SignatureArtifact, to_hex};
    use std::cell::Cell;

    struct MockWorldIdVerifier {
        status: WorldIdVerificationStatus,
    }

    impl WorldIdVerifier for MockWorldIdVerifier {
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
        let output = process_identity_with_verifier(
            world_id_request(),
            &MockWorldIdVerifier {
                status: WorldIdVerificationStatus::Verified,
            },
            &signer,
            1_800_000_000_000,
        )
        .unwrap();

        assert_eq!(output.status, IdentityProcessingStatus::Verified);
        assert_eq!(output.error_code, None);
        assert_eq!(output.result, None);
        assert_eq!(output.unsigned_bcs_payload, None);
        assert_eq!(output.signature, None);
        assert_eq!(signer.calls.get(), 0);
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
                status: WorldIdVerificationStatus::Verified,
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

    fn assert_non_verified_output(output: &super::IdentityProcessingOutput) {
        assert_eq!(output.result, None);
        assert_eq!(output.unsigned_bcs_payload, None);
        assert_eq!(output.signature, None);
    }

    fn world_id_request() -> IdentityVerifyRequest {
        IdentityVerifyRequest {
            provider: IdentityProvider::WorldId,
            world_id: Some(WorldIdProofRequest {
                app_id: "app_staging_123".to_owned(),
                nullifier_hash: "12345678901234567890".to_owned(),
                merkle_root: "987654321".to_owned(),
                proof: "0xproof".to_owned(),
                verification_level: "orb".to_owned(),
                action: "sonari_membership_register_v1".to_owned(),
                signal_hash: "0xsignal".to_owned(),
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
            terms_version: 1,
            signed_statement_hash:
                "0x6666666666666666666666666666666666666666666666666666666666666666".to_owned(),
            world_id: None,
        }
    }
}
