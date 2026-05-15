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
    pub signing_key_seed: [u8; 32],
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
    pub next_retry_at_ms: Option<u64>,
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
