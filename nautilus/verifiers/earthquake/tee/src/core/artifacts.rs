use serde::Serialize;
pub use sonari_tee_core::SignatureArtifact;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SourceManifest {
    pub sources: Vec<SourceEntry>,
    pub cells_generation_method: String,
    pub oracle_version: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SourceEntry {
    pub name: String,
    pub event_id: String,
    pub product: String,
    pub product_version: String,
    pub map_status: String,
    pub updated_at_ms: u64,
    pub url_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RawDataManifest {
    pub entries: Vec<RawDataEntry>,
    pub oracle_version: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RawDataEntry {
    pub name: String,
    pub event_id: String,
    pub product: String,
    pub uri: String,
    pub content_hash: String,
    pub source_uri: String,
    pub walrus_blob_id: String,
    pub source_hash: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StoredSourceRef {
    pub uri: String,
    pub walrus_blob_id: String,
    pub source_hash: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EvidenceManifest {
    pub schema_version: u32,
    pub oracle_version: u64,
    pub event_uid: String,
    pub event_revision: u32,
    pub hazard_type: String,
    pub source_event_id: String,
    pub sources: Vec<EvidenceSource>,
    pub earthquake: EarthquakeEvidence,
    pub affected_cells: EvidenceAffectedCells,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EvidenceSource {
    pub source: String,
    pub product: String,
    pub source_uri: String,
    pub artifact_uri: String,
    pub content_hash: String,
    pub size_bytes: u64,
    pub source_updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EarthquakeEvidence {
    pub title: String,
    pub region: String,
    pub occurred_at_ms: u64,
    pub magnitude_x100: u64,
    pub source_updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EvidenceAffectedCells {
    pub uri: String,
    pub hash: String,
    pub root: String,
    pub count: u64,
    pub geo_resolution: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AffectedCellsArtifact {
    pub event_uid: String,
    pub event_revision: u32,
    pub oracle_version: u64,
    pub geo_resolution: u8,
    pub cells_generation_method: String,
    pub cell_metric: String,
    pub cell_aggregation: String,
    pub intensity_scale: String,
    pub affected_cells: Vec<AffectedCellJson>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AffectedCellJson {
    pub h3_index: String,
    pub intensity_value: u16,
    pub cell_band: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UnsignedPayload {
    pub intent: u8,
    pub oracle_version: u64,
    pub event_uid: String,
    pub event_revision: u32,
    pub source_event_id: String,
    pub title: String,
    pub region: String,
    pub occurred_at_ms: u64,
    pub hazard_type: u8,
    pub status: u8,
    pub severity_band: u8,
    pub affected_cells_root: String,
    pub affected_cell_count: u64,
    pub evidence_manifest_uri: String,
    pub evidence_manifest_hash: String,
    pub verified_at_ms: u64,
    pub freshness_deadline_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExpectedHashes {
    pub event_uid: String,
    pub source_set_hash: String,
    pub raw_data_hash: String,
    pub raw_source_content_hashes: Vec<RawSourceContentHash>,
    pub affected_cells_data_hash: String,
    pub leaf_hashes: Vec<LeafHash>,
    pub affected_cells_root: String,
    pub evidence_manifest_hash: String,
    pub unsigned_bcs_payload_hex: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RawSourceContentHash {
    pub uri: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LeafHash {
    pub h3_index: String,
    pub leaf_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SampleProof {
    pub target_leaf: LeafHash,
    pub proof: Vec<ProofStep>,
    pub expected_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProofStep {
    pub direction: String,
    pub sibling_hash: String,
}
