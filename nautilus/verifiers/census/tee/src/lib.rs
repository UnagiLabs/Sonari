use sonari_tee_core::registry::{
    CENSUS_ATTESTATION_PUBLIC_KEY_LABEL, CENSUS_VERIFIER_CONFIG_KEY, VERIFIER_REGISTRY,
};

pub mod affected_cells;
pub mod counts;
pub mod encoding;
pub mod error;
pub mod server;

pub use affected_cells::{
    AffectedCell, AffectedCellsArtifact, compute_affected_cells_root, validate_affected_cells_root,
};
pub use counts::{
    CensusInputBundle, HomeCellRegisteredEvent, compute_floor_census_counts,
    process_floor_census_bundle,
};
pub use error::CensusError;

pub const INTENT: &str = "SONARI_FLOOR_CENSUS_V1";
pub const VERIFIER_FAMILY: &str = "census";
pub const VERIFIER_VERSION: u64 = 1;
pub const VERIFIER_FAMILY_ID: u8 = 5;
pub const VERIFIER_CONFIG_KEY: u64 = CENSUS_VERIFIER_CONFIG_KEY;
pub const ATTESTATION_PUBLIC_KEY_LABEL: &[u8] = CENSUS_ATTESTATION_PUBLIC_KEY_LABEL;
pub const BAND_COUNT: usize = 3;
pub const H3_RESOLUTION: u8 = 7;
pub const SHARD_COUNT: u64 = 4_096;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FloorCensusResult {
    pub intent: String,
    pub verifier_family: String,
    pub verifier_version: u64,
    pub event_uid: String,
    pub event_revision: u32,
    pub affected_cells_root: String,
    pub membership_registry_id: String,
    pub cell_count_index_id: String,
    pub census_checkpoint: u64,
    pub h3_resolution: u8,
    pub shard_count: u64,
    pub registered_members_by_band: Vec<u64>,
    pub counted_cells_root: String,
    pub issued_at_ms: u64,
}

pub fn registry_entry_name() -> Option<&'static str> {
    VERIFIER_REGISTRY
        .iter()
        .find(|entry| entry.config_key == VERIFIER_CONFIG_KEY)
        .map(|entry| entry.name)
}

#[cfg(test)]
mod tests {
    use super::{
        ATTESTATION_PUBLIC_KEY_LABEL, INTENT, VERIFIER_CONFIG_KEY, VERIFIER_FAMILY,
        VERIFIER_FAMILY_ID, VERIFIER_VERSION, registry_entry_name,
    };

    #[test]
    fn exposes_census_contract_constants() {
        assert_eq!(INTENT, "SONARI_FLOOR_CENSUS_V1");
        assert_eq!(VERIFIER_FAMILY, "census");
        assert_eq!(VERIFIER_VERSION, 1);
        assert_eq!(VERIFIER_FAMILY_ID, 5);
        assert_eq!(VERIFIER_CONFIG_KEY, 3);
        assert_eq!(
            ATTESTATION_PUBLIC_KEY_LABEL,
            b"sonari-census-attestation-public-key",
        );
    }

    #[test]
    fn census_uses_shared_registry_numbering() {
        assert_eq!(registry_entry_name(), Some("census"));
    }
}
