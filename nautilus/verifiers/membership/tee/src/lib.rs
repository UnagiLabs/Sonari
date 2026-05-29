pub mod core;
pub mod encoding;
pub mod error;
pub mod verify;

pub use core::duplicate_key::{
    canonical_world_id_nullifier, compute_kyc_duplicate_key_hash,
    compute_world_id_duplicate_key_hash,
};
pub use core::processing::{
    IdentityProcessingOutput, IdentityProcessingStatus, compute_identity_evidence_hash,
    compute_world_id_signal_hash, process_identity_with_verifier,
};
pub use core::types::{
    IdentityProvider, IdentityTeeCliResult, IdentityTeeResult, IdentityVerifyRequest,
    WorldIdProofRequest,
};
pub use error::IdentityError;
pub use verify::kyc::{KYC_UNSUPPORTED, KycVerificationStatus, verify_kyc_unsupported};
pub use verify::world_id::{
    CloudWorldIdVerifier, WORLD_ID_ACTION, WORLD_ID_API_BASE_ENV, WORLD_ID_API_UNAVAILABLE,
    WORLD_ID_APP_ID_ENV, WORLD_ID_MAX_AGE_SECONDS, WORLD_ID_VERIFICATION_FAILED,
    WorldIdVerificationStatus, WorldIdVerifier,
};

pub const INTENT: &str = "SONARI_IDENTITY_VERIFICATION_V1";
pub const VERIFIER_FAMILY: &str = "identity";
pub const VERIFIER_VERSION: u64 = 1;
pub const PROVIDER_KYC: u8 = 1;
pub const PROVIDER_WORLD_ID: u8 = 2;

#[cfg(test)]
mod tests {
    use super::{
        INTENT, IdentityError, IdentityProvider, IdentityTeeResult, IdentityVerifyRequest,
        IdentityTeeCliResult, PROVIDER_KYC, PROVIDER_WORLD_ID, VERIFIER_FAMILY,
        VERIFIER_VERSION,
    };

    #[test]
    fn exposes_identity_contract_constants() {
        assert_eq!(INTENT, "SONARI_IDENTITY_VERIFICATION_V1");
        assert_eq!(VERIFIER_FAMILY, "identity");
        assert_eq!(VERIFIER_VERSION, 1);
        assert_eq!(PROVIDER_KYC, 1);
        assert_eq!(PROVIDER_WORLD_ID, 2);
    }

    #[test]
    fn identity_result_serializes_to_shared_typescript_shape() {
        let result = IdentityTeeResult {
            intent: INTENT.to_owned(),
            verifier_family: VERIFIER_FAMILY.to_owned(),
            verifier_version: VERIFIER_VERSION,
            registry_id: "0x1111111111111111111111111111111111111111111111111111111111111111"
                .to_owned(),
            membership_id: "0x2222222222222222222222222222222222222222222222222222222222222222"
                .to_owned(),
            owner: "0x3333333333333333333333333333333333333333333333333333333333333333".to_owned(),
            provider: IdentityProvider::Kyc,
            verified: true,
            duplicate_key_hash:
                "0x4444444444444444444444444444444444444444444444444444444444444444".to_owned(),
            evidence_hash: "0x5555555555555555555555555555555555555555555555555555555555555555"
                .to_owned(),
            issued_at_ms: 1_700_000_000_000,
            expires_at_ms: 1_800_000_000_000,
            terms_version: 1,
            signed_statement_hash:
                "0x6666666666666666666666666666666666666666666666666666666666666666".to_owned(),
        };

        let json = serde_json::to_value(result).unwrap();

        let object = json.as_object().unwrap();
        let mut fields = object.keys().map(String::as_str).collect::<Vec<_>>();
        fields.sort_unstable();
        let mut expected_fields = vec![
            "duplicate_key_hash",
            "evidence_hash",
            "expires_at_ms",
            "intent",
            "issued_at_ms",
            "membership_id",
            "owner",
            "provider",
            "registry_id",
            "signed_statement_hash",
            "terms_version",
            "verified",
            "verifier_family",
            "verifier_version",
        ];
        expected_fields.sort_unstable();

        assert_eq!(fields, expected_fields);
        assert_eq!(json["intent"], INTENT);
        assert_eq!(json["verifier_family"], "identity");
        assert_eq!(json["provider"], "kyc");
        assert_eq!(json["verified"], true);
    }

    #[test]
    fn identity_cli_result_serializes_verified_envelope_without_payload_fields() {
        let result = IdentityTeeCliResult::Verified {
            payload_bcs_hex: "0xaaaa".to_owned(),
            signature: "0xbbbb".to_owned(),
            public_key: "0xcccc".to_owned(),
            duplicate_key_hash:
                "0x4444444444444444444444444444444444444444444444444444444444444444"
                    .to_owned(),
            expires_at_ms: 1_800_000_000_000,
        };

        let json = serde_json::to_value(result).unwrap();

        assert_eq!(json["status"], "verified");
        assert_eq!(json["payload_bcs_hex"], "0xaaaa");
        assert_eq!(json["signature"], "0xbbbb");
        assert_eq!(json["public_key"], "0xcccc");
        assert_eq!(json["duplicate_key_hash"], identity_result_json()["duplicate_key_hash"]);
        assert_eq!(json["expires_at_ms"], 1_800_000_000_000_u64);
        assert!(json.get("intent").is_none());
        assert!(json.get("algorithm").is_none());
    }

    #[test]
    fn identity_cli_result_serializes_non_verified_without_signature_fields() {
        for (result, status) in [
            (
                IdentityTeeCliResult::Rejected {
                    error_code: "WORLD_ID_VERIFICATION_FAILED".to_owned(),
                },
                "rejected",
            ),
            (
                IdentityTeeCliResult::PendingSource {
                    error_code: "WORLD_ID_API_UNAVAILABLE".to_owned(),
                },
                "pending_source",
            ),
            (
                IdentityTeeCliResult::Unsupported {
                    error_code: "KYC_NOT_IMPLEMENTED".to_owned(),
                },
                "unsupported",
            ),
        ] {
            let json = serde_json::to_value(result).unwrap();

            assert_eq!(json["status"], status);
            assert!(json.get("error_code").is_some());
            assert!(json.get("payload_bcs_hex").is_none());
            assert!(json.get("signature").is_none());
            assert!(json.get("public_key").is_none());
            assert!(json.get("duplicate_key_hash").is_none());
            assert!(json.get("expires_at_ms").is_none());
        }
    }

    #[test]
    fn identity_cli_result_rejects_unknown_fields() {
        let error = serde_json::from_value::<IdentityTeeCliResult>(serde_json::json!({
            "status": "rejected",
            "error_code": "WORLD_ID_VERIFICATION_FAILED",
            "signature": "0xshould-not-exist",
        }))
        .unwrap_err();

        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn identity_error_wraps_shared_tee_errors() {
        let hex_error = sonari_tee_core::HexError::InvalidLength {
            value: "0x12".to_owned(),
        };
        let identity_error = IdentityError::from(hex_error);
        assert!(
            identity_error
                .to_string()
                .contains("invalid identity hex input")
        );

        let seed_error = sonari_tee_core::SeedError::InvalidLength;
        let identity_error = IdentityError::from(seed_error);
        assert!(
            identity_error
                .to_string()
                .contains("invalid identity signing seed")
        );
    }

    #[test]
    fn identity_provider_serializes_world_id_variant() {
        let json = serde_json::to_value(IdentityProvider::WorldId).unwrap();

        assert_eq!(json, "world_id");
    }

    #[test]
    fn identity_result_rejects_unexpected_fields() {
        let mut json = identity_result_json();
        json["kyc_document_image"] = serde_json::json!("ipfs://raw-document");

        let error = serde_json::from_value::<IdentityTeeResult>(json).unwrap_err();

        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn identity_result_rejects_wrong_intent_or_family() {
        let mut wrong_intent = identity_result_json();
        wrong_intent["intent"] = serde_json::json!("SONARI_EARTHQUAKE_ORACLE");
        let error = serde_json::from_value::<IdentityTeeResult>(wrong_intent).unwrap_err();
        assert!(error.to_string().contains("intent must be"));

        let mut wrong_family = identity_result_json();
        wrong_family["verifier_family"] = serde_json::json!("earthquake");
        let error = serde_json::from_value::<IdentityTeeResult>(wrong_family).unwrap_err();
        assert!(error.to_string().contains("verifier_family must be"));
    }

    #[test]
    fn identity_result_rejects_malformed_hex_fields() {
        let mut json = identity_result_json();
        json["duplicate_key_hash"] = serde_json::json!("0x1234");

        let error = serde_json::from_value::<IdentityTeeResult>(json).unwrap_err();

        assert!(error.to_string().contains("expected 32-byte hex"));
    }

    #[test]
    fn identity_request_rejects_unknown_or_malformed_fields() {
        let mut unknown_field = identity_request_json();
        unknown_field["raw_personal_data"] = serde_json::json!("do-not-accept");
        let error = serde_json::from_value::<IdentityVerifyRequest>(unknown_field).unwrap_err();
        assert!(error.to_string().contains("unknown field"));

        let mut malformed_owner = identity_request_json();
        malformed_owner["owner"] = serde_json::json!("0x1234");
        let error = serde_json::from_value::<IdentityVerifyRequest>(malformed_owner).unwrap_err();
        assert!(error.to_string().contains("expected 32-byte hex"));
    }

    fn identity_result_json() -> serde_json::Value {
        serde_json::json!({
            "intent": INTENT,
            "verifier_family": VERIFIER_FAMILY,
            "verifier_version": VERIFIER_VERSION,
            "registry_id": "0x1111111111111111111111111111111111111111111111111111111111111111",
            "membership_id": "0x2222222222222222222222222222222222222222222222222222222222222222",
            "owner": "0x3333333333333333333333333333333333333333333333333333333333333333",
            "provider": "world_id",
            "verified": true,
            "duplicate_key_hash": "0x4444444444444444444444444444444444444444444444444444444444444444",
            "evidence_hash": "0x5555555555555555555555555555555555555555555555555555555555555555",
            "issued_at_ms": 1_700_000_000_000_u64,
            "expires_at_ms": 1_800_000_000_000_u64,
            "terms_version": 1_u64,
            "signed_statement_hash": "0x6666666666666666666666666666666666666666666666666666666666666666",
        })
    }

    fn identity_request_json() -> serde_json::Value {
        serde_json::json!({
            "registry_id": "0x1111111111111111111111111111111111111111111111111111111111111111",
            "membership_id": "0x2222222222222222222222222222222222222222222222222222222222222222",
            "owner": "0x3333333333333333333333333333333333333333333333333333333333333333",
            "provider": "kyc",
            "terms_version": 1_u64,
            "signed_statement_hash": "0x6666666666666666666666666666666666666666666666666666666666666666",
            "issued_at_ms": null,
            "validity_ms": null,
            "world_id": null,
        })
    }
}
