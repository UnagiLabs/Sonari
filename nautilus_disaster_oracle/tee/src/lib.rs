mod compute;
mod core;
mod crypto;
mod encoding;
mod source;

pub use compute::intensity::{cell_band, mmi_decimal_to_x100, p90_x100};
pub use compute::merkle::merkle_root_from_leaf_hashes;
pub use core::artifacts::{
    AffectedCellJson, AffectedCellsArtifact, ExpectedHashes, LeafHash, ProofStep, RawDataEntry,
    RawDataManifest, RawSourceContentHash, SampleProof, SignatureArtifact, SourceEntry,
    SourceManifest, UnsignedPayloadV1,
};
pub use core::processing::{process_usgs, process_usgs_with_signer};
pub use core::types::{OracleError, OracleOutput, OracleStatus, ResultSummary, UsgsOracleInput};
pub use crypto::{LocalEd25519Signer, PayloadSigner, sha3_256_bytes};
pub use encoding::json::canonical_json_bytes;
pub use source::usgs::grid_xml_from_artifact;

pub const INTENT_SONARI_EARTHQUAKE_ORACLE: u8 = 1;
pub const HAZARD_TYPE_EARTHQUAKE: u8 = 1;
pub const ONCHAIN_STATUS_FINALIZED: u8 = 3;
pub const PRIMARY_SOURCE_USGS: u8 = 1;
pub const CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1: u8 = 1;
pub const CELLS_GENERATION_METHOD_SHAKEMAP_HDF_H3_WEIGHTED_P90_V1: u8 = 2;
pub const CELLS_GENERATION_METHOD_JMA_250M_H3_P90_V1: u8 = 3;
pub const CELL_METRIC_USGS_MMI: u8 = 1;
pub const CELL_METRIC_JMA_SHINDO: u8 = 2;
pub const CELL_AGGREGATION_GRID_POINT_P90: u8 = 1;
pub const INTENSITY_SCALE_MMI_X100: u8 = 1;
pub const INTENSITY_SCALE_JMA_SHINDO_X10: u8 = 2;

pub const ORACLE_VERSION: u64 = 1;
pub const GEO_RESOLUTION: u8 = 7;
pub const MIN_CLAIM_BAND: u8 = 1;
pub const FRESHNESS_WINDOW_MS: u64 = 21_600_000;

pub(crate) const CELLS_GENERATION_METHOD_NAME: &str = "shakemap_gridxml_h3_grid_point_p90_v1";
pub(crate) const CELL_METRIC_NAME: &str = "USGS_MMI";
pub(crate) const CELL_AGGREGATION_NAME: &str = "GRID_POINT_P90";
pub(crate) const INTENSITY_SCALE_NAME: &str = "MMI_X100";
