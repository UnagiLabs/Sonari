use crate::{IdentityError, WorldIdProofRequest};
use serde::Serialize;
use std::time::Duration;

pub const WORLD_ID_API_BASE_ENV: &str = "SONARI_WORLD_ID_API_BASE";
pub const WORLD_ID_VERIFICATION_FAILED: &str = "WORLD_ID_VERIFICATION_FAILED";
pub const WORLD_ID_API_UNAVAILABLE: &str = "WORLD_ID_API_UNAVAILABLE";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorldIdVerificationStatus {
    Verified,
    Rejected { error_code: String },
    PendingSource { error_code: String },
}

pub trait WorldIdVerifier {
    fn verify_world_id(&self, proof: &WorldIdProofRequest) -> WorldIdVerificationStatus;
}

#[derive(Debug, Clone)]
pub struct CloudWorldIdVerifier {
    base_url: String,
    client: reqwest::blocking::Client,
}

impl CloudWorldIdVerifier {
    pub fn from_env() -> Result<Self, IdentityError> {
        let base_url = std::env::var(WORLD_ID_API_BASE_ENV).map_err(|error| {
            IdentityError::Request(format!("{WORLD_ID_API_BASE_ENV} is required: {error}"))
        })?;

        Self::new(base_url)
    }

    pub fn new(base_url: impl Into<String>) -> Result<Self, IdentityError> {
        let base_url = normalize_base_url(base_url.into())?;
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|error| {
                IdentityError::Request(format!("World ID HTTP client build failed: {error}"))
            })?;

        Ok(Self { base_url, client })
    }

    pub fn verification_url(&self, app_id: &str) -> String {
        format!("{}/api/v2/verify/{}", self.base_url, app_id)
    }
}

impl WorldIdVerifier for CloudWorldIdVerifier {
    fn verify_world_id(&self, proof: &WorldIdProofRequest) -> WorldIdVerificationStatus {
        let request_body = match serde_json::to_vec(&WorldIdApiRequest::from(proof)) {
            Ok(body) => body,
            Err(_) => return rejected(),
        };
        let response = self
            .client
            .post(self.verification_url(&proof.app_id))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(request_body)
            .send();

        let Ok(response) = response else {
            return pending_source();
        };

        let status = response.status();
        if status.is_success() {
            return WorldIdVerificationStatus::Verified;
        }
        if status.is_server_error() {
            return pending_source();
        }
        if status.as_u16() == 400 {
            let body = response.text().unwrap_or_default();
            return classify_bad_request(&body);
        }

        WorldIdVerificationStatus::Rejected {
            error_code: WORLD_ID_VERIFICATION_FAILED.to_owned(),
        }
    }
}

#[derive(Debug, Serialize)]
struct WorldIdApiRequest<'a> {
    nullifier_hash: &'a str,
    merkle_root: &'a str,
    proof: &'a str,
    verification_level: &'a str,
    action: &'a str,
    signal_hash: &'a str,
}

impl<'a> From<&'a WorldIdProofRequest> for WorldIdApiRequest<'a> {
    fn from(value: &'a WorldIdProofRequest) -> Self {
        Self {
            nullifier_hash: &value.nullifier_hash,
            merkle_root: &value.merkle_root,
            proof: &value.proof,
            verification_level: &value.verification_level,
            action: &value.action,
            signal_hash: &value.signal_hash,
        }
    }
}

fn normalize_base_url(base_url: String) -> Result<String, IdentityError> {
    let trimmed = base_url.trim().trim_end_matches('/').to_owned();
    if trimmed.is_empty() {
        return Err(IdentityError::Request(format!(
            "{WORLD_ID_API_BASE_ENV} must be a non-empty URL"
        )));
    }
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err(IdentityError::Request(format!(
            "{WORLD_ID_API_BASE_ENV} must start with http:// or https://"
        )));
    }
    Ok(trimmed)
}

fn classify_bad_request(body: &str) -> WorldIdVerificationStatus {
    match world_id_error_code(body).as_deref() {
        Some("already_verified") => WorldIdVerificationStatus::Verified,
        Some("max_verifications_reached") => rejected(),
        _ => rejected(),
    }
}

fn world_id_error_code(body: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(body).ok()?;
    value
        .get("code")
        .or_else(|| value.get("error"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

fn rejected() -> WorldIdVerificationStatus {
    WorldIdVerificationStatus::Rejected {
        error_code: WORLD_ID_VERIFICATION_FAILED.to_owned(),
    }
}

fn pending_source() -> WorldIdVerificationStatus {
    WorldIdVerificationStatus::PendingSource {
        error_code: WORLD_ID_API_UNAVAILABLE.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CloudWorldIdVerifier, WORLD_ID_API_BASE_ENV, WORLD_ID_API_UNAVAILABLE,
        WORLD_ID_VERIFICATION_FAILED, WorldIdApiRequest, WorldIdVerificationStatus,
        WorldIdVerifier, classify_bad_request,
    };
    use crate::WorldIdProofRequest;

    #[test]
    fn world_id_request_serializes_exact_api_body_fields() {
        let proof = world_id_proof();
        let json = serde_json::to_value(WorldIdApiRequest::from(&proof)).unwrap();
        let object = json.as_object().unwrap();
        let mut fields = object.keys().map(String::as_str).collect::<Vec<_>>();
        fields.sort_unstable();

        assert_eq!(
            fields,
            vec![
                "action",
                "merkle_root",
                "nullifier_hash",
                "proof",
                "signal_hash",
                "verification_level",
            ]
        );
        assert_eq!(json["nullifier_hash"], "12345678901234567890");
        assert!(json.get("app_id").is_none());
    }

    #[test]
    fn world_id_verifier_builds_required_verify_url() {
        let verifier = CloudWorldIdVerifier::new("http://127.0.0.1:8080/").unwrap();

        assert_eq!(
            verifier.verification_url("app_staging_123"),
            "http://127.0.0.1:8080/api/v2/verify/app_staging_123"
        );
    }

    #[test]
    fn world_id_verifier_rejects_missing_or_invalid_base_url() {
        let error = CloudWorldIdVerifier::new("").unwrap_err();
        assert!(error.to_string().contains(WORLD_ID_API_BASE_ENV));

        let error = CloudWorldIdVerifier::new("localhost:8080").unwrap_err();
        assert!(error.to_string().contains("http:// or https://"));
    }

    #[test]
    fn world_id_400_invalid_proof_is_sanitized_rejection() {
        let status = classify_bad_request(r#"{"code":"invalid_proof","detail":"raw proof"}"#);

        assert_eq!(
            status,
            WorldIdVerificationStatus::Rejected {
                error_code: WORLD_ID_VERIFICATION_FAILED.to_owned()
            }
        );
        assert!(!format!("{status:?}").contains("raw proof"));
    }

    #[test]
    fn world_id_400_already_verified_is_success_for_stateless_tee() {
        let status = classify_bad_request(r#"{"code":"already_verified"}"#);

        assert_eq!(status, WorldIdVerificationStatus::Verified);
    }

    #[test]
    fn world_id_400_max_verifications_reached_is_rejection() {
        let status = classify_bad_request(r#"{"code":"max_verifications_reached"}"#);

        assert_eq!(
            status,
            WorldIdVerificationStatus::Rejected {
                error_code: WORLD_ID_VERIFICATION_FAILED.to_owned()
            }
        );
    }

    #[test]
    fn world_id_unreachable_api_becomes_pending_source() {
        let verifier = CloudWorldIdVerifier::new("http://127.0.0.1:9").unwrap();

        assert_eq!(
            verifier.verify_world_id(&world_id_proof()),
            WorldIdVerificationStatus::PendingSource {
                error_code: WORLD_ID_API_UNAVAILABLE.to_owned()
            }
        );
    }

    fn world_id_proof() -> WorldIdProofRequest {
        WorldIdProofRequest {
            app_id: "app_staging_123".to_owned(),
            nullifier_hash: "12345678901234567890".to_owned(),
            merkle_root: "987654321".to_owned(),
            proof: "0xproof".to_owned(),
            verification_level: "orb".to_owned(),
            action: "sonari_membership_register_v1".to_owned(),
            signal_hash: "0xsignal".to_owned(),
        }
    }
}
