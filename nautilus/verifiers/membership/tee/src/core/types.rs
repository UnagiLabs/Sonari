use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IdentityProvider {
    Kyc,
    WorldId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
pub struct IdentityTeeResult {
    #[serde(deserialize_with = "deserialize_intent")]
    pub intent: String,
    #[serde(deserialize_with = "deserialize_verifier_family")]
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

fn deserialize_intent<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_exact_string(deserializer, "intent", crate::INTENT)
}

fn deserialize_verifier_family<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_exact_string(deserializer, "verifier_family", crate::VERIFIER_FAMILY)
}

fn deserialize_exact_string<'de, D>(
    deserializer: D,
    field: &'static str,
    expected: &'static str,
) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value == expected {
        Ok(value)
    } else {
        Err(<D::Error as serde::de::Error>::custom(format!(
            "{field} must be {expected}"
        )))
    }
}
