use crate::{IdentityError, WorldIdProofRequest};
use reqwest::StatusCode;
use serde::Serialize;
use std::time::Duration;

pub const WORLD_ID_API_BASE_ENV: &str = "SONARI_WORLD_ID_API_BASE";
pub const WORLD_ID_APP_ID_ENV: &str = "SONARI_WORLD_ID_APP_ID";
pub const WORLD_ID_ACTION: &str = "sonari_membership_register_v1";
pub const WORLD_ID_MAX_AGE_SECONDS: u64 = 604_800;
pub const WORLD_ID_USER_AGENT: &str = "sonari-membership-tee/0.1";
pub const WORLD_ID_VERIFICATION_FAILED: &str = "WORLD_ID_VERIFICATION_FAILED";
pub const WORLD_ID_API_UNAVAILABLE: &str = "WORLD_ID_API_UNAVAILABLE";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorldIdVerificationStatus {
    Verified,
    Rejected { error_code: String },
    PendingSource { error_code: String },
}

pub trait WorldIdVerifier {
    fn expected_app_id(&self) -> &str;

    fn verify_world_id(&self, proof: &WorldIdProofRequest) -> WorldIdVerificationStatus;
}

#[derive(Debug, Clone)]
pub struct CloudWorldIdVerifier {
    base_url: String,
    app_id: String,
    client: reqwest::blocking::Client,
}

impl CloudWorldIdVerifier {
    pub fn from_env() -> Result<Self, IdentityError> {
        let base_url = std::env::var(WORLD_ID_API_BASE_ENV).map_err(|error| {
            IdentityError::Request(format!("{WORLD_ID_API_BASE_ENV} is required: {error}"))
        })?;
        let app_id = std::env::var(WORLD_ID_APP_ID_ENV).map_err(|error| {
            IdentityError::Request(format!("{WORLD_ID_APP_ID_ENV} is required: {error}"))
        })?;

        Self::new(base_url, app_id)
    }

    pub fn new(
        base_url: impl Into<String>,
        app_id: impl Into<String>,
    ) -> Result<Self, IdentityError> {
        let base_url = normalize_base_url(base_url.into())?;
        let app_id = normalize_app_id(app_id.into())?;
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent(WORLD_ID_USER_AGENT)
            .build()
            .map_err(|error| {
                IdentityError::Request(format!("World ID HTTP client build failed: {error}"))
            })?;

        Ok(Self {
            base_url,
            app_id,
            client,
        })
    }

    pub fn verification_url(&self) -> String {
        format!("{}/api/v2/verify/{}", self.base_url, self.app_id)
    }
}

impl WorldIdVerifier for CloudWorldIdVerifier {
    fn expected_app_id(&self) -> &str {
        &self.app_id
    }

    fn verify_world_id(&self, proof: &WorldIdProofRequest) -> WorldIdVerificationStatus {
        if proof.app_id != self.app_id || proof.action != WORLD_ID_ACTION {
            return rejected();
        }
        let request_body = match serde_json::to_vec(&WorldIdApiRequest::from(proof)) {
            Ok(body) => body,
            Err(_) => return rejected(),
        };
        let response = self
            .client
            .post(self.verification_url())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(request_body)
            .send();

        let Ok(response) = response else {
            return pending_source();
        };

        let status = response.status();
        let body = if status == StatusCode::BAD_REQUEST {
            Some(response.text().unwrap_or_default())
        } else {
            None
        };

        classify_http_status(status, body.as_deref())
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
    max_age: u64,
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
            max_age: WORLD_ID_MAX_AGE_SECONDS,
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
    if !trimmed.starts_with("https://") {
        return Err(IdentityError::Request(format!(
            "{WORLD_ID_API_BASE_ENV} must start with https://"
        )));
    }
    Ok(trimmed)
}

fn normalize_app_id(app_id: String) -> Result<String, IdentityError> {
    let trimmed = app_id.trim().to_owned();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err(IdentityError::Request(format!(
            "{WORLD_ID_APP_ID_ENV} must be a non-empty string without NUL"
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

fn classify_http_status(
    status: StatusCode,
    bad_request_body: Option<&str>,
) -> WorldIdVerificationStatus {
    if status.is_success() {
        return WorldIdVerificationStatus::Verified;
    }
    if status == StatusCode::BAD_REQUEST {
        return classify_bad_request(bad_request_body.unwrap_or(""));
    }
    if status.is_server_error() || is_retryable_client_status(status) {
        return pending_source();
    }

    rejected()
}

fn is_retryable_client_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::REQUEST_TIMEOUT | StatusCode::TOO_MANY_REQUESTS
    )
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
        CloudWorldIdVerifier, WORLD_ID_ACTION, WORLD_ID_API_BASE_ENV, WORLD_ID_API_UNAVAILABLE,
        WORLD_ID_APP_ID_ENV, WORLD_ID_MAX_AGE_SECONDS, WORLD_ID_USER_AGENT,
        WORLD_ID_VERIFICATION_FAILED, WorldIdApiRequest, WorldIdVerificationStatus,
        WorldIdVerifier, classify_bad_request, classify_http_status,
    };
    use crate::WorldIdProofRequest;
    use reqwest::StatusCode;

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
                "max_age",
                "merkle_root",
                "nullifier_hash",
                "proof",
                "signal_hash",
                "verification_level",
            ]
        );
        assert_eq!(json["nullifier_hash"], "12345678901234567890");
        assert_eq!(json["max_age"], WORLD_ID_MAX_AGE_SECONDS);
        assert!(json.get("app_id").is_none());
    }

    #[test]
    fn world_id_verifier_builds_required_verify_url() {
        let verifier =
            CloudWorldIdVerifier::new("https://developer.world.org/", "app_staging_123").unwrap();

        assert_eq!(
            verifier.verification_url(),
            "https://developer.world.org/api/v2/verify/app_staging_123"
        );
    }

    #[test]
    fn world_id_verifier_sets_required_user_agent_value() {
        assert_eq!(WORLD_ID_USER_AGENT, "sonari-membership-tee/0.1");
    }

    #[test]
    fn world_id_verifier_rejects_missing_or_invalid_base_url() {
        let error = CloudWorldIdVerifier::new("", "app_staging_123").unwrap_err();
        assert!(error.to_string().contains(WORLD_ID_API_BASE_ENV));

        let error =
            CloudWorldIdVerifier::new("http://localhost:8080", "app_staging_123").unwrap_err();
        assert!(error.to_string().contains("https://"));
    }

    #[test]
    fn world_id_verifier_rejects_missing_app_id() {
        let error = CloudWorldIdVerifier::new("https://developer.world.org", "").unwrap_err();

        assert!(error.to_string().contains(WORLD_ID_APP_ID_ENV));
    }

    #[test]
    fn world_id_verifier_rejects_noncanonical_app_or_action_before_http() {
        let verifier =
            CloudWorldIdVerifier::new("https://developer.world.org", "app_staging_123").unwrap();
        let mut proof = world_id_proof();
        proof.app_id = "app_attacker".to_owned();

        assert_eq!(
            verifier.verify_world_id(&proof),
            WorldIdVerificationStatus::Rejected {
                error_code: WORLD_ID_VERIFICATION_FAILED.to_owned()
            }
        );

        let mut proof = world_id_proof();
        proof.action = "attacker_action".to_owned();
        assert_eq!(
            verifier.verify_world_id(&proof),
            WorldIdVerificationStatus::Rejected {
                error_code: WORLD_ID_VERIFICATION_FAILED.to_owned()
            }
        );
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
    fn world_id_retryable_http_statuses_are_pending_source() {
        for status in [StatusCode::REQUEST_TIMEOUT, StatusCode::TOO_MANY_REQUESTS] {
            assert_eq!(
                classify_http_status(status, None),
                WorldIdVerificationStatus::PendingSource {
                    error_code: WORLD_ID_API_UNAVAILABLE.to_owned()
                }
            );
        }
    }

    #[test]
    fn world_id_unreachable_api_becomes_pending_source() {
        let verifier = CloudWorldIdVerifier::new("https://127.0.0.1:9", "app_staging_123").unwrap();

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
            action: WORLD_ID_ACTION.to_owned(),
            signal_hash: "0xsignal".to_owned(),
        }
    }
}
