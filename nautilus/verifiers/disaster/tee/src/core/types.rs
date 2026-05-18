use crate::core::artifacts::{
    AffectedCellsArtifact, ExpectedHashes, RawDataManifest, SampleProof, SignatureArtifact,
    SourceManifest, UnsignedPayloadV1,
};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum OracleError {
    #[error("invalid USGS detail JSON: {0}")]
    DetailJson(#[from] serde_json::Error),
    #[error("invalid ShakeMap grid XML: {0}")]
    GridXml(#[from] quick_xml::Error),
    #[error("invalid UTF-8 in ShakeMap grid XML: {0}")]
    GridUtf8(#[from] std::str::Utf8Error),
    #[error("invalid grid point: {0}")]
    InvalidGridPoint(String),
    #[error("invalid MMI decimal: {0}")]
    InvalidMmi(String),
    #[error("invalid coordinate")]
    InvalidCoordinate,
    #[error("BCS serialization failed: {0}")]
    Bcs(#[from] bcs::Error),
    #[error("invalid ShakeMap zip archive: {0}")]
    Zip(String),
    #[error("invalid Worker to TEE request: {0}")]
    WorkerRequest(String),
}

#[derive(Debug, Clone)]
pub struct UsgsOracleInput {
    pub case_id: String,
    pub detail_json: Vec<u8>,
    pub grid_xml: Option<Vec<u8>>,
    pub raw_detail_uri: String,
    pub raw_grid_uri: Option<String>,
    pub raw_data_uri: String,
    pub affected_cells_uri: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerToTeeRequest {
    pub source_event_id: String,
    pub hazard_type: u8,
    pub primary_source: u8,
    pub geo_resolution: u8,
}

impl WorkerToTeeRequest {
    pub fn from_json_value(value: serde_json::Value) -> Result<Self, OracleError> {
        let object = value
            .as_object()
            .ok_or_else(|| OracleError::WorkerRequest("request must be an object".to_owned()))?;
        let allowed = [
            "source_event_id",
            "hazard_type",
            "primary_source",
            "geo_resolution",
        ];
        if let Some(unexpected) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
            return Err(OracleError::WorkerRequest(format!(
                "unexpected Worker to TEE field: {unexpected}"
            )));
        }

        let source_event_id = object
            .get("source_event_id")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                OracleError::WorkerRequest("source_event_id must be a non-empty string".to_owned())
            })?;
        let hazard_type = read_u8_field(object, "hazard_type")?;
        let primary_source = read_u8_field(object, "primary_source")?;
        let geo_resolution = read_u8_field(object, "geo_resolution")?;

        Ok(Self {
            source_event_id: source_event_id.to_owned(),
            hazard_type,
            primary_source,
            geo_resolution,
        })
    }
}

fn read_u8_field(
    object: &serde_json::Map<String, serde_json::Value>,
    name: &str,
) -> Result<u8, OracleError> {
    let value = object
        .get(name)
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| OracleError::WorkerRequest(format!("{name} must be an integer")))?;
    u8::try_from(value)
        .map_err(|_| OracleError::WorkerRequest(format!("{name} is outside u8 range")))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OracleStatus {
    Finalized,
    PendingSource,
    PendingMmi,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResultSummary {
    pub case_id: String,
    pub status: OracleStatus,
    pub source_event_id: String,
    pub hazard_type: String,
    pub primary_source: String,
    pub geo_resolution: u8,
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_payload: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OracleOutput {
    pub result: ResultSummary,
    pub source_manifest: Option<SourceManifest>,
    pub raw_data_manifest: Option<RawDataManifest>,
    pub affected_cells: Option<AffectedCellsArtifact>,
    pub expected_hashes: Option<ExpectedHashes>,
    pub sample_proof: Option<SampleProof>,
    pub unsigned_payload: Option<UnsignedPayloadV1>,
    pub unsigned_bcs_payload: Option<Vec<u8>>,
    pub signature: Option<SignatureArtifact>,
}
