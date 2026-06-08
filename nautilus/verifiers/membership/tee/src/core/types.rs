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
    #[serde(deserialize_with = "deserialize_hex_32_string")]
    pub registry_id: String,
    #[serde(deserialize_with = "deserialize_hex_32_string")]
    pub membership_id: String,
    #[serde(deserialize_with = "deserialize_hex_32_string")]
    pub owner: String,
    pub provider: IdentityProvider,
    pub issued_at_ms: Option<u64>,
    pub validity_ms: Option<u64>,
    pub terms_version: u64,
    #[serde(deserialize_with = "deserialize_hex_32_string")]
    pub signed_statement_hash: String,
    pub world_id: Option<WorldIdProofRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorldIdProofRequest {
    pub idkit_response: serde_json::Value,
}

impl WorldIdProofRequest {
    pub fn action(&self) -> Option<&str> {
        self.idkit_response
            .get("action")
            .and_then(serde_json::Value::as_str)
    }

    pub fn signal_hash(&self) -> Option<&str> {
        self.first_response_field("signal_hash")
    }

    pub fn nullifier(&self) -> Option<&str> {
        self.first_response_field("nullifier")
    }

    pub fn merkle_root(&self) -> Option<&str> {
        self.first_response_field("merkle_root")
    }

    pub fn proof(&self) -> Option<&str> {
        self.first_response_field("proof")
    }

    pub fn identifier(&self) -> Option<&str> {
        self.first_response_field("identifier")
    }

    fn first_response_field(&self, field: &str) -> Option<&str> {
        self.idkit_response
            .get("responses")
            .and_then(serde_json::Value::as_array)
            .and_then(|responses| responses.first())
            .and_then(|response| response.get(field))
            .and_then(serde_json::Value::as_str)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IdentityTeeResult {
    #[serde(deserialize_with = "deserialize_intent")]
    pub intent: String,
    #[serde(deserialize_with = "deserialize_verifier_family")]
    pub verifier_family: String,
    pub verifier_version: u64,
    #[serde(deserialize_with = "deserialize_hex_32_string")]
    pub registry_id: String,
    #[serde(deserialize_with = "deserialize_hex_32_string")]
    pub membership_id: String,
    #[serde(deserialize_with = "deserialize_hex_32_string")]
    pub owner: String,
    pub provider: IdentityProvider,
    pub verified: bool,
    #[serde(deserialize_with = "deserialize_hex_32_string")]
    pub duplicate_key_hash: String,
    #[serde(deserialize_with = "deserialize_hex_32_string")]
    pub evidence_hash: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub terms_version: u64,
    #[serde(deserialize_with = "deserialize_hex_32_string")]
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

fn deserialize_hex_32_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    sonari_tee_core::hex_to_32(&value).map_err(<D::Error as serde::de::Error>::custom)?;
    Ok(value)
}
