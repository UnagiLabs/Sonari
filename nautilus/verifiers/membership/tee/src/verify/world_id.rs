use crate::{IdentityError, WorldIdProofRequest, canonical_world_id_nullifier};
use reqwest::{StatusCode, Url};
use serde::Deserialize;
use std::time::Duration;

pub const WORLD_ID_API_BASE_ENV: &str = "SONARI_WORLD_ID_API_BASE";
/// Canonical World ID API base URL the production server path pins.
///
/// The production server (`Server` subcommand) signs results bound to the World
/// ID developer API, so the base URL must never be host/bootstrap-controlled:
/// only the egress proxy ([`WORLD_ID_EGRESS_PROXY_URL_ENV`]) is variable, exactly
/// like the earthquake egress model (canonical URL fixed, proxy steers TCP).
/// This value satisfies [`normalize_base_url`]'s `https` requirement.
pub const WORLD_ID_API_BASE_CANONICAL: &str = "https://developer.world.org";
pub const WORLD_ID_API_BASE_STAGING: &str = "https://staging-developer.worldcoin.org";
pub const WORLD_ID_RP_ID_ENV: &str = "SONARI_WORLD_ID_RP_ID";
pub const WORLD_ID_ENVIRONMENT_ENV: &str = "SONARI_WORLD_ID_ENVIRONMENT";
/// Optional egress proxy URL the enclave routes World ID HTTPS traffic through.
///
/// The canonical [`WORLD_ID_API_BASE_ENV`] stays `https://developer.world.org`
/// so TLS verification and the verify path are unchanged; this proxy only steers
/// where the TCP connection is forwarded so the host-side proxy enforces the
/// egress allowlist (mirrors the earthquake egress proxy approach).
pub const WORLD_ID_EGRESS_PROXY_URL_ENV: &str = "SONARI_WORLD_ID_EGRESS_PROXY_URL";
pub const WORLD_ID_ACTION: &str = "sonari_membership_register_v1";
pub const WORLD_ID_MAX_AGE_SECONDS: u64 = 604_800;
pub const WORLD_ID_USER_AGENT: &str = "sonari-membership-tee/0.1";
pub const WORLD_ID_VERIFICATION_FAILED: &str = "WORLD_ID_VERIFICATION_FAILED";
pub const WORLD_ID_API_UNAVAILABLE: &str = "WORLD_ID_API_UNAVAILABLE";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorldIdVerificationStatus {
    Verified { evidence: WorldIdVerifiedEvidence },
    Rejected { error_code: String },
    PendingSource { error_code: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorldIdVerifiedEvidence {
    pub rp_id: String,
    pub environment: String,
    pub action: String,
    pub protocol_version: String,
    pub identifier: String,
    pub nullifier: String,
    pub signal_hash: String,
    pub created_at: Option<String>,
    pub session_id: Option<String>,
}

pub trait WorldIdVerifier {
    fn expected_rp_id(&self) -> &str;

    fn expected_environment(&self) -> &str {
        "staging"
    }

    fn verify_world_id(&self, proof: &WorldIdProofRequest) -> WorldIdVerificationStatus;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorldIdEnvironment {
    Production,
    Staging,
}

impl WorldIdEnvironment {
    pub fn parse(value: &str) -> Result<Self, IdentityError> {
        match value.trim() {
            "production" => Ok(Self::Production),
            "staging" => Ok(Self::Staging),
            _ => Err(IdentityError::Request(format!(
                "{WORLD_ID_ENVIRONMENT_ENV} must be production or staging"
            ))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Production => "production",
            Self::Staging => "staging",
        }
    }

    fn api_base_url(self) -> &'static str {
        match self {
            Self::Production => WORLD_ID_API_BASE_CANONICAL,
            Self::Staging => WORLD_ID_API_BASE_STAGING,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CloudWorldIdVerifier {
    base_url: Url,
    rp_id: String,
    expected_environment: WorldIdEnvironment,
    client: reqwest::blocking::Client,
}

impl CloudWorldIdVerifier {
    pub fn from_env() -> Result<Self, IdentityError> {
        let rp_id = std::env::var(WORLD_ID_RP_ID_ENV).map_err(|error| {
            IdentityError::Request(format!("{WORLD_ID_RP_ID_ENV} is required: {error}"))
        })?;
        let environment = match std::env::var(WORLD_ID_ENVIRONMENT_ENV) {
            Ok(value) => WorldIdEnvironment::parse(&value)?,
            Err(_) => WorldIdEnvironment::Production,
        };
        let proxy = std::env::var(WORLD_ID_EGRESS_PROXY_URL_ENV).ok();

        Self::with_proxy(environment, rp_id, proxy.as_deref())
    }

    pub fn new(
        environment: WorldIdEnvironment,
        rp_id: impl Into<String>,
    ) -> Result<Self, IdentityError> {
        Self::with_proxy(environment, rp_id, None)
    }

    /// Builds a verifier that routes its HTTPS traffic through an optional egress
    /// proxy while keeping the canonical `base_url` for TLS and path building.
    ///
    /// A `None` or blank `egress_proxy_url` yields a direct client (identical to
    /// [`CloudWorldIdVerifier::new`]); a non-empty value installs an explicit
    /// reqwest proxy so the host-side proxy enforces the egress allowlist.
    pub fn with_proxy(
        environment: WorldIdEnvironment,
        rp_id: impl Into<String>,
        egress_proxy_url: Option<&str>,
    ) -> Result<Self, IdentityError> {
        let base_url = normalize_base_url(environment.api_base_url().to_owned())?;
        Self::with_base_url_for_test(base_url, environment, rp_id, egress_proxy_url)
    }

    fn with_base_url_for_test(
        base_url: Url,
        expected_environment: WorldIdEnvironment,
        rp_id: impl Into<String>,
        egress_proxy_url: Option<&str>,
    ) -> Result<Self, IdentityError> {
        let rp_id = normalize_rp_id(rp_id.into())?;
        let mut builder = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent(WORLD_ID_USER_AGENT)
            .redirect(reqwest::redirect::Policy::none());
        if let Some(proxy_url) = non_empty_proxy(egress_proxy_url) {
            let proxy = reqwest::Proxy::all(proxy_url).map_err(|error| {
                IdentityError::Request(format!(
                    "{WORLD_ID_EGRESS_PROXY_URL_ENV} is not a valid egress proxy URL: {error}"
                ))
            })?;
            builder = builder.proxy(proxy);
        }
        let client = builder.build().map_err(|error| {
            IdentityError::Request(format!("World ID HTTP client build failed: {error}"))
        })?;

        Ok(Self {
            base_url,
            rp_id,
            expected_environment,
            client,
        })
    }

    pub fn verification_url(&self) -> String {
        let mut url = self.base_url.clone();
        {
            let mut segments = url
                .path_segments_mut()
                .expect("HTTPS URL should support path segments");
            segments.extend(["api", "v4", "verify", &self.rp_id]);
        }
        url.to_string()
    }
}

impl WorldIdVerifier for CloudWorldIdVerifier {
    fn expected_rp_id(&self) -> &str {
        &self.rp_id
    }

    fn expected_environment(&self) -> &str {
        self.expected_environment.as_str()
    }

    fn verify_world_id(&self, proof: &WorldIdProofRequest) -> WorldIdVerificationStatus {
        let claims = match proof.uniqueness_proof() {
            Ok(claims) => claims,
            Err(_) => return rejected(),
        };
        if claims.action != WORLD_ID_ACTION {
            return rejected();
        }
        if claims.environment != self.expected_environment.as_str() {
            return rejected();
        }
        let request_body = match serde_json::to_vec(&proof.idkit_response) {
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
        if status == StatusCode::OK {
            let body = response.text().unwrap_or_default();
            return classify_success_response(&self.rp_id, self.expected_environment, proof, &body);
        }

        if status == StatusCode::BAD_REQUEST {
            let body = response.text().unwrap_or_default();
            return classify_bad_request(&self.rp_id, self.expected_environment, proof, &body);
        }

        classify_http_status(status)
    }
}

#[derive(Debug, Deserialize)]
struct WorldIdApiSuccessResponse {
    success: bool,
    action: String,
    nullifier: String,
    environment: String,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    results: Vec<WorldIdApiResult>,
}

#[derive(Debug, Deserialize)]
struct WorldIdApiResult {
    identifier: String,
    success: bool,
    #[serde(default)]
    nullifier: Option<String>,
}

fn normalize_base_url(base_url: String) -> Result<Url, IdentityError> {
    let trimmed = base_url.trim().trim_end_matches('/').to_owned();
    if trimmed.is_empty() {
        return Err(IdentityError::Request(format!(
            "{WORLD_ID_API_BASE_ENV} must be a non-empty URL"
        )));
    }
    let parsed = Url::parse(&trimmed).map_err(|error| {
        IdentityError::Request(format!(
            "{WORLD_ID_API_BASE_ENV} must be a valid URL: {error}"
        ))
    })?;
    if parsed.scheme() != "https" {
        return Err(IdentityError::Request(format!(
            "{WORLD_ID_API_BASE_ENV} must start with https://"
        )));
    }
    if parsed.host_str().is_none() {
        return Err(IdentityError::Request(format!(
            "{WORLD_ID_API_BASE_ENV} must include a host"
        )));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(IdentityError::Request(format!(
            "{WORLD_ID_API_BASE_ENV} must not include query or fragment"
        )));
    }
    Ok(parsed)
}

fn non_empty_proxy(proxy_url: Option<&str>) -> Option<&str> {
    proxy_url.map(str::trim).filter(|value| !value.is_empty())
}

fn normalize_rp_id(rp_id: String) -> Result<String, IdentityError> {
    let trimmed = rp_id.trim().to_owned();
    if trimmed.is_empty()
        || !trimmed.starts_with("rp_")
        || !trimmed
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(IdentityError::Request(format!(
            "{WORLD_ID_RP_ID_ENV} must be a non-empty URL-safe rp_id starting with rp_"
        )));
    }
    Ok(trimmed)
}

fn classify_bad_request(
    rp_id: &str,
    expected_environment: WorldIdEnvironment,
    proof: &WorldIdProofRequest,
    body: &str,
) -> WorldIdVerificationStatus {
    match world_id_error_code(body).as_deref() {
        Some("already_verified") | Some("nullifier_replayed") => {
            match classify_success_response(rp_id, expected_environment, proof, body) {
                verified @ WorldIdVerificationStatus::Verified { .. } => verified,
                _ => rejected(),
            }
        }
        Some("max_verifications_reached") => rejected(),
        _ => rejected(),
    }
}

fn classify_success_response(
    rp_id: &str,
    expected_environment: WorldIdEnvironment,
    proof: &WorldIdProofRequest,
    body: &str,
) -> WorldIdVerificationStatus {
    let Ok(claims) = proof.uniqueness_proof() else {
        return pending_source();
    };
    let Ok(response) = serde_json::from_str::<WorldIdApiSuccessResponse>(body) else {
        return pending_source();
    };
    if !response.success
        || response.action != claims.action
        || response.environment != expected_environment.as_str()
        || response.session_id.is_some()
    {
        return pending_source();
    }
    let Some(result) = response.results.iter().find(|result| result.success) else {
        return pending_source();
    };
    if result.identifier != claims.identifier {
        return pending_source();
    }
    let Ok(response_nullifier) = canonical_world_id_nullifier(&response.nullifier) else {
        return pending_source();
    };
    if let Some(result_nullifier) = &result.nullifier {
        let Ok(result_nullifier) = canonical_world_id_nullifier(result_nullifier) else {
            return pending_source();
        };
        if result_nullifier != response_nullifier {
            return pending_source();
        }
    }
    let Ok(request_nullifier) = canonical_world_id_nullifier(&claims.nullifier) else {
        return pending_source();
    };
    if response_nullifier != request_nullifier {
        return pending_source();
    }

    WorldIdVerificationStatus::Verified {
        evidence: WorldIdVerifiedEvidence {
            rp_id: rp_id.to_owned(),
            environment: response.environment,
            action: response.action,
            protocol_version: claims.protocol_version,
            identifier: result.identifier.clone(),
            nullifier: response_nullifier,
            signal_hash: claims.signal_hash,
            created_at: response.created_at,
            session_id: None,
        },
    }
}

fn classify_http_status(status: StatusCode) -> WorldIdVerificationStatus {
    if status.is_success() {
        return pending_source();
    }
    if status.is_redirection() || status.is_server_error() || status.is_client_error() {
        return pending_source();
    }

    rejected()
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

/// A dummy World ID verifier that skips the HTTP call to the World ID API and
/// returns [`WorldIdVerificationStatus::Verified`] directly when `rp_id` and
/// `action` match. All other validation (rp_id normalisation, action check)
/// follows the same path as [`CloudWorldIdVerifier`] so that request shape,
/// payload, and signature-target bytes are identical to the real verifier.
///
/// **Only for testnet / devnet.** The fail-closed gate in STEP 2 / STEP 4
/// ensures this verifier cannot be selected on mainnet.
#[derive(Debug, Clone)]
pub struct DummyWorldIdVerifier {
    rp_id: String,
    expected_environment: WorldIdEnvironment,
}

impl DummyWorldIdVerifier {
    pub fn new(rp_id: impl Into<String>) -> Result<Self, IdentityError> {
        Self::with_environment(rp_id, WorldIdEnvironment::Staging)
    }

    pub fn with_environment(
        rp_id: impl Into<String>,
        expected_environment: WorldIdEnvironment,
    ) -> Result<Self, IdentityError> {
        let rp_id = normalize_rp_id(rp_id.into())?;
        Ok(Self {
            rp_id,
            expected_environment,
        })
    }
}

impl WorldIdVerifier for DummyWorldIdVerifier {
    fn expected_rp_id(&self) -> &str {
        &self.rp_id
    }

    fn expected_environment(&self) -> &str {
        self.expected_environment.as_str()
    }

    fn verify_world_id(&self, proof: &WorldIdProofRequest) -> WorldIdVerificationStatus {
        let claims = match proof.uniqueness_proof() {
            Ok(claims) => claims,
            Err(_) => return rejected(),
        };
        if claims.action != WORLD_ID_ACTION {
            return rejected();
        }
        if claims.environment != self.expected_environment.as_str() {
            return rejected();
        }
        let claims = proof
            .uniqueness_proof()
            .expect("validated uniqueness proof should parse");
        WorldIdVerificationStatus::Verified {
            evidence: WorldIdVerifiedEvidence {
                rp_id: self.rp_id.clone(),
                environment: claims.environment,
                action: claims.action,
                protocol_version: claims.protocol_version,
                identifier: claims.identifier,
                nullifier: claims.nullifier,
                signal_hash: claims.signal_hash,
                created_at: None,
                session_id: None,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CloudWorldIdVerifier, DummyWorldIdVerifier, WORLD_ID_ACTION, WORLD_ID_API_UNAVAILABLE,
        WORLD_ID_RP_ID_ENV, WORLD_ID_USER_AGENT, WORLD_ID_VERIFICATION_FAILED, WorldIdEnvironment,
        WorldIdVerificationStatus, WorldIdVerifier, classify_bad_request, classify_http_status,
        classify_success_response, normalize_base_url,
    };
    use crate::WorldIdProofRequest;
    use reqwest::StatusCode;

    // ---- DummyWorldIdVerifier tests ----

    #[test]
    fn dummy_world_id_verifier_returns_verified_when_rp_id_and_action_match() {
        let verifier = DummyWorldIdVerifier::new("rp_staging_123").unwrap();
        let proof = world_id_proof();

        let WorldIdVerificationStatus::Verified { evidence } = verifier.verify_world_id(&proof)
        else {
            panic!("dummy verifier should return verified evidence");
        };
        assert_eq!(evidence.rp_id, "rp_staging_123");
        assert_eq!(evidence.environment, "staging");
        assert_eq!(evidence.identifier, "orb");
        assert_eq!(evidence.nullifier, "12345678901234567890");
    }

    #[test]
    fn dummy_world_id_verifier_rejects_mismatched_action() {
        let verifier = DummyWorldIdVerifier::new("rp_staging_123").unwrap();
        let mut proof = world_id_proof();
        proof.idkit_response["action"] = serde_json::json!("attacker_action");

        assert_eq!(
            verifier.verify_world_id(&proof),
            WorldIdVerificationStatus::Rejected {
                error_code: WORLD_ID_VERIFICATION_FAILED.to_owned()
            }
        );
    }

    #[test]
    fn dummy_world_id_verifier_rejects_mismatched_environment() {
        let verifier = DummyWorldIdVerifier::new("rp_staging_123").unwrap();
        let mut proof = world_id_proof();
        proof.idkit_response["environment"] = serde_json::json!("production");

        assert_eq!(
            verifier.verify_world_id(&proof),
            WorldIdVerificationStatus::Rejected {
                error_code: WORLD_ID_VERIFICATION_FAILED.to_owned()
            }
        );
    }

    #[test]
    fn dummy_and_cloud_rejected_error_codes_are_identical() {
        // request shape 同一の証拠: dummy の Rejected は Cloud の Rejected と同一の error_code を返す
        let dummy = DummyWorldIdVerifier::new("rp_staging_123").unwrap();
        let cloud =
            CloudWorldIdVerifier::new(WorldIdEnvironment::Staging, "rp_staging_123").unwrap();
        let mut proof = world_id_proof();
        proof.idkit_response["action"] = serde_json::json!("attacker_action");

        let dummy_result = dummy.verify_world_id(&proof);
        let cloud_result = cloud.verify_world_id(&proof);

        assert_eq!(dummy_result, cloud_result);
    }

    #[test]
    fn dummy_world_id_verifier_rejects_empty_rp_id() {
        let error = DummyWorldIdVerifier::new("").unwrap_err();
        assert!(error.to_string().contains("rp_id"));
    }

    #[test]
    fn world_id_request_serializes_raw_idkit_response_body() {
        let proof = world_id_proof();
        let body = serde_json::to_value(&proof.idkit_response).unwrap();

        assert_eq!(body, proof.idkit_response);
        assert_eq!(body["responses"][0]["nullifier"], "12345678901234567890");
        assert!(body.get("max_age").is_none());
    }

    #[test]
    fn world_id_verifier_keeps_canonical_url_when_routed_through_egress_proxy() {
        // The canonical World ID base URL must stay https://developer.world.org so
        // TLS verification and the verify path are unchanged; the egress proxy only
        // controls where the TCP connection is forwarded (host-side egress allowlist).
        let verifier = CloudWorldIdVerifier::with_proxy(
            WorldIdEnvironment::Production,
            "rp_production_123",
            Some("http://127.0.0.1:18080"),
        )
        .unwrap();

        assert_eq!(
            verifier.verification_url(),
            "https://developer.world.org/api/v4/verify/rp_production_123"
        );
    }

    #[test]
    fn world_id_verifier_rejects_invalid_egress_proxy_url() {
        let error = CloudWorldIdVerifier::with_proxy(
            WorldIdEnvironment::Production,
            "rp_production_123",
            Some("::not-a-url::"),
        )
        .unwrap_err();
        assert!(error.to_string().contains("egress proxy"));
    }

    #[test]
    fn world_id_verifier_treats_empty_proxy_as_no_proxy() {
        let verifier = CloudWorldIdVerifier::with_proxy(
            WorldIdEnvironment::Production,
            "rp_production_123",
            Some("   "),
        )
        .expect("blank proxy must be treated as no proxy");
        assert_eq!(
            verifier.verification_url(),
            "https://developer.world.org/api/v4/verify/rp_production_123"
        );
    }

    #[test]
    fn world_id_verifier_builds_required_verify_url() {
        let verifier =
            CloudWorldIdVerifier::new(WorldIdEnvironment::Production, "rp_production_123").unwrap();

        assert_eq!(
            verifier.verification_url(),
            "https://developer.world.org/api/v4/verify/rp_production_123"
        );

        let verifier =
            CloudWorldIdVerifier::new(WorldIdEnvironment::Staging, "rp_staging_123").unwrap();
        assert_eq!(
            verifier.verification_url(),
            "https://staging-developer.worldcoin.org/api/v4/verify/rp_staging_123"
        );
    }

    #[test]
    fn world_id_verifier_sets_required_user_agent_value() {
        assert_eq!(WORLD_ID_USER_AGENT, "sonari-membership-tee/0.1");
    }

    #[test]
    fn world_id_verifier_rejects_missing_or_invalid_base_url() {
        let error = normalize_base_url("https://".to_owned()).unwrap_err();
        assert!(error.to_string().contains("valid URL"));

        let error = normalize_base_url("http://localhost:8080".to_owned()).unwrap_err();
        assert!(error.to_string().contains("https://"));
    }

    #[test]
    fn world_id_verifier_rejects_missing_rp_id() {
        let error = CloudWorldIdVerifier::new(WorldIdEnvironment::Production, "").unwrap_err();

        assert!(error.to_string().contains(WORLD_ID_RP_ID_ENV));

        let error =
            CloudWorldIdVerifier::new(WorldIdEnvironment::Production, "app/evil?x=1").unwrap_err();
        assert!(error.to_string().contains("rp_id"));
    }

    #[test]
    fn world_id_verifier_rejects_noncanonical_rp_or_action_before_http() {
        let verifier =
            CloudWorldIdVerifier::new(WorldIdEnvironment::Staging, "rp_staging_123").unwrap();
        let mut proof = world_id_proof();
        proof.idkit_response["action"] = serde_json::json!("attacker_action");

        assert_eq!(
            verifier.verify_world_id(&proof),
            WorldIdVerificationStatus::Rejected {
                error_code: WORLD_ID_VERIFICATION_FAILED.to_owned()
            }
        );

        let mut proof = world_id_proof();
        proof.idkit_response["action"] = serde_json::json!("attacker_action");
        assert_eq!(
            verifier.verify_world_id(&proof),
            WorldIdVerificationStatus::Rejected {
                error_code: WORLD_ID_VERIFICATION_FAILED.to_owned()
            }
        );
    }

    #[test]
    fn world_id_400_invalid_proof_is_sanitized_rejection() {
        let proof = world_id_proof();
        let status = classify_bad_request(
            "rp_staging_123",
            WorldIdEnvironment::Staging,
            &proof,
            r#"{"code":"invalid_proof","detail":"raw proof"}"#,
        );

        assert_eq!(
            status,
            WorldIdVerificationStatus::Rejected {
                error_code: WORLD_ID_VERIFICATION_FAILED.to_owned()
            }
        );
        assert!(!format!("{status:?}").contains("raw proof"));
    }

    #[test]
    fn world_id_400_already_verified_without_evidence_is_rejected() {
        let proof = world_id_proof();
        let status = classify_bad_request(
            "rp_staging_123",
            WorldIdEnvironment::Staging,
            &proof,
            r#"{"code":"already_verified"}"#,
        );

        assert_eq!(
            status,
            WorldIdVerificationStatus::Rejected {
                error_code: WORLD_ID_VERIFICATION_FAILED.to_owned()
            }
        );
    }

    #[test]
    fn world_id_400_nullifier_replayed_with_verified_evidence_is_success() {
        let proof = world_id_proof();
        let status = classify_bad_request(
            "rp_staging_123",
            WorldIdEnvironment::Staging,
            &proof,
            r#"{"code":"nullifier_replayed","success":true,"results":[{"identifier":"orb","success":true,"nullifier":"12345678901234567890"}],"action":"sonari_membership_register_v1","nullifier":"12345678901234567890","created_at":"2023-02-18T11:20:39.530041+00:00","environment":"staging"}"#,
        );
        let WorldIdVerificationStatus::Verified { evidence } = status else {
            panic!("evidence-bearing replay should return verified evidence");
        };
        assert_eq!(evidence.rp_id, "rp_staging_123");
        assert_eq!(evidence.nullifier, "12345678901234567890");
        assert_eq!(evidence.identifier, "orb");
    }

    #[test]
    fn world_id_400_max_verifications_reached_is_rejection() {
        let proof = world_id_proof();
        let status = classify_bad_request(
            "rp_staging_123",
            WorldIdEnvironment::Staging,
            &proof,
            r#"{"code":"max_verifications_reached"}"#,
        );

        assert_eq!(
            status,
            WorldIdVerificationStatus::Rejected {
                error_code: WORLD_ID_VERIFICATION_FAILED.to_owned()
            }
        );
    }

    #[test]
    fn world_id_200_success_body_must_match_proof() {
        let proof = world_id_proof();
        let status = classify_success_response(
            "rp_staging_123",
            WorldIdEnvironment::Staging,
            &proof,
            r#"{"success":true,"results":[{"identifier":"orb","success":true,"nullifier":"12345678901234567890"}],"action":"sonari_membership_register_v1","nullifier":"12345678901234567890","created_at":"2023-02-18T11:20:39.530041+00:00","environment":"staging"}"#,
        );
        let WorldIdVerificationStatus::Verified { evidence } = status else {
            panic!("success response should return verified evidence");
        };
        assert_eq!(evidence.rp_id, "rp_staging_123");
        assert_eq!(evidence.environment, "staging");
        assert_eq!(evidence.action, WORLD_ID_ACTION);
        assert_eq!(evidence.protocol_version, "4.0");
        assert_eq!(evidence.identifier, "orb");
        assert_eq!(evidence.nullifier, "12345678901234567890");
        assert_eq!(
            evidence.signal_hash, "0xsignal",
            "response evidence should retain request-side signal_hash"
        );

        let mismatched_action = classify_success_response(
            "rp_staging_123",
            WorldIdEnvironment::Staging,
            &proof,
            r#"{"success":true,"results":[{"identifier":"orb","success":true,"nullifier":"12345678901234567890"}],"action":"attacker_action","nullifier":"12345678901234567890","environment":"staging"}"#,
        );
        assert_eq!(
            mismatched_action,
            WorldIdVerificationStatus::PendingSource {
                error_code: WORLD_ID_API_UNAVAILABLE.to_owned()
            }
        );

        let mismatched_nullifier = classify_success_response(
            "rp_staging_123",
            WorldIdEnvironment::Staging,
            &proof,
            r#"{"success":true,"results":[{"identifier":"orb","success":true,"nullifier":"123"}],"action":"sonari_membership_register_v1","nullifier":"123","environment":"staging"}"#,
        );
        assert_eq!(
            mismatched_nullifier,
            WorldIdVerificationStatus::PendingSource {
                error_code: WORLD_ID_API_UNAVAILABLE.to_owned()
            }
        );
    }

    #[test]
    fn world_id_non_ok_success_status_is_pending_source() {
        assert_eq!(
            classify_http_status(StatusCode::ACCEPTED),
            WorldIdVerificationStatus::PendingSource {
                error_code: WORLD_ID_API_UNAVAILABLE.to_owned()
            }
        );
    }

    #[test]
    fn world_id_retryable_http_statuses_are_pending_source() {
        for status in [
            StatusCode::TEMPORARY_REDIRECT,
            StatusCode::PERMANENT_REDIRECT,
            StatusCode::REQUEST_TIMEOUT,
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::NOT_FOUND,
            StatusCode::TOO_MANY_REQUESTS,
        ] {
            assert_eq!(
                classify_http_status(status),
                WorldIdVerificationStatus::PendingSource {
                    error_code: WORLD_ID_API_UNAVAILABLE.to_owned()
                }
            );
        }
    }

    #[test]
    fn world_id_unreachable_api_becomes_pending_source() {
        let base_url = normalize_base_url("https://127.0.0.1:9".to_owned()).unwrap();
        let verifier = CloudWorldIdVerifier::with_base_url_for_test(
            base_url,
            WorldIdEnvironment::Staging,
            "rp_staging_123",
            None,
        )
        .unwrap();

        assert_eq!(
            verifier.verify_world_id(&world_id_proof()),
            WorldIdVerificationStatus::PendingSource {
                error_code: WORLD_ID_API_UNAVAILABLE.to_owned()
            }
        );
    }

    fn world_id_proof() -> WorldIdProofRequest {
        WorldIdProofRequest {
            idkit_response: serde_json::json!({
                "protocol_version": "4.0",
                "nonce": "nonce-123",
                "action": WORLD_ID_ACTION,
                "environment": "staging",
                "responses": [
                    {
                        "identifier": "orb",
                        "signal_hash": "0xsignal",
                        "proof": "0xproof",
                        "merkle_root": "987654321",
                        "nullifier": "12345678901234567890"
                    }
                ]
            }),
        }
    }
}
