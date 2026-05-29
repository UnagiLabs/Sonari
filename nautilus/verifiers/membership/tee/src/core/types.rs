use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IdentityProvider {
    Kyc,
    WorldId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdentityVerifyRequest {
    pub registry_id: String,
    pub membership_id: String,
    pub owner: String,
    pub provider: IdentityProvider,
    pub evidence_hash: String,
    pub terms_version: u64,
    pub signed_statement_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdentityTeeResult {
    pub intent: String,
    pub verifier_family: String,
    pub verifier_version: u64,
    pub registry_id: String,
    pub membership_id: String,
    pub owner: String,
    pub provider: IdentityProvider,
    pub verified: bool,
    pub duplicate_key_hash: String,
    pub evidence_hash: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub terms_version: u64,
    pub signed_statement_hash: String,
}
