use crate::CensusError;
use serde::{Deserialize, Serialize};
use sonari_tee_core::{hex_to_32, sha256_bytes, to_hex};

const GEO_RESOLUTION: u8 = 7;
const CELL_METRIC_USGS_MMI: u8 = 1;
const INTENSITY_SCALE_MMI_X100: u8 = 1;
const CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1: u8 = 1;
const CELLS_GENERATION_METHOD_SHAKEMAP_HDF_H3_AREA_WEIGHTED_P90_V1: u8 = 2;
const CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_CENTER_BILINEAR_V1: u8 = 3;

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct AffectedCellsArtifact {
    pub event_uid: String,
    pub event_revision: u32,
    pub oracle_version: u64,
    pub geo_resolution: u8,
    pub cells_generation_method: String,
    pub cell_metric: String,
    pub cell_aggregation: String,
    pub intensity_scale: String,
    pub affected_cells: Vec<AffectedCell>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct AffectedCell {
    pub h3_index: String,
    pub intensity_value: u64,
    pub cell_band: u64,
}

#[derive(Serialize)]
struct AffectedCellLeafBcs {
    event_uid: [u8; 32],
    event_revision: u32,
    h3_index: u64,
    geo_resolution: u8,
    cell_metric: u8,
    intensity_value: u16,
    intensity_scale: u8,
    cell_band: u8,
    cells_generation_method: u8,
    oracle_version: u64,
}

pub fn compute_affected_cells_root(
    event_uid: &str,
    event_revision: u32,
    artifact: &AffectedCellsArtifact,
) -> Result<String, CensusError> {
    let leaf_hashes = affected_cells_leaf_hashes(event_uid, event_revision, artifact)?;
    merkle_root_from_leaf_hashes(&leaf_hashes)
        .map(|root| to_hex(&root))
        .ok_or_else(|| CensusError::InvalidPayload("affected_cells must not be empty".to_owned()))
}

pub fn validate_affected_cells_root(
    event_uid: &str,
    event_revision: u32,
    affected_cells_root: &str,
    artifact: &AffectedCellsArtifact,
) -> Result<(), CensusError> {
    let expected_root = hex_to_32(affected_cells_root)?;
    let computed_root = hex_to_32(&compute_affected_cells_root(
        event_uid,
        event_revision,
        artifact,
    )?)?;
    if computed_root != expected_root {
        return invalid_artifact("affected_cells_root does not match affected cells artifact");
    }
    Ok(())
}

fn affected_cells_leaf_hashes(
    event_uid: &str,
    event_revision: u32,
    artifact: &AffectedCellsArtifact,
) -> Result<Vec<[u8; 32]>, CensusError> {
    validate_artifact_binding(event_uid, event_revision, artifact)?;
    let event_uid_bytes = hex_to_32(&artifact.event_uid)?;
    let cells_generation_method = cells_generation_method_id(&artifact.cells_generation_method)?;
    validate_known_artifact_enums(artifact)?;

    if artifact.affected_cells.is_empty() {
        return invalid_artifact("affected_cells must contain at least 1 entry");
    }

    let mut previous_h3_index = None;
    let mut leaf_hashes = Vec::with_capacity(artifact.affected_cells.len());
    for (index, cell) in artifact.affected_cells.iter().enumerate() {
        let h3_index = parse_canonical_h3_index(&cell.h3_index)?;
        if let Some(previous) = previous_h3_index {
            if h3_index == previous {
                return invalid_artifact(&format!(
                    "affected_cells contains duplicate h3_index {}",
                    cell.h3_index
                ));
            }
            if h3_index < previous {
                return invalid_artifact(&format!(
                    "affected_cells must be sorted by numeric h3_index at index {index}"
                ));
            }
        }
        previous_h3_index = Some(h3_index);

        let intensity_value = u16::try_from(cell.intensity_value).map_err(|_| {
            CensusError::InvalidPayload(format!(
                "intensity_value must be a u16, got {}",
                cell.intensity_value
            ))
        })?;
        let cell_band = u8::try_from(cell.cell_band).map_err(|_| {
            CensusError::InvalidPayload(format!(
                "cell_band must be in 1..=3, got {}",
                cell.cell_band
            ))
        })?;
        if !(1..=3).contains(&cell_band) {
            return invalid_artifact(&format!("cell_band must be in 1..=3, got {cell_band}"));
        }

        let leaf = AffectedCellLeafBcs {
            event_uid: event_uid_bytes,
            event_revision: artifact.event_revision,
            h3_index,
            geo_resolution: artifact.geo_resolution,
            cell_metric: CELL_METRIC_USGS_MMI,
            intensity_value,
            intensity_scale: INTENSITY_SCALE_MMI_X100,
            cell_band,
            cells_generation_method,
            oracle_version: artifact.oracle_version,
        };
        leaf_hashes.push(affected_cell_leaf_hash(&leaf)?);
    }
    Ok(leaf_hashes)
}

fn validate_artifact_binding(
    event_uid: &str,
    event_revision: u32,
    artifact: &AffectedCellsArtifact,
) -> Result<(), CensusError> {
    if artifact.event_uid != event_uid {
        return invalid_artifact("artifact event_uid must match top-level event_uid");
    }
    if artifact.event_revision != event_revision {
        return invalid_artifact("artifact event_revision must match top-level event_revision");
    }
    if artifact.geo_resolution != GEO_RESOLUTION {
        return invalid_artifact("geo_resolution must be 7");
    }
    Ok(())
}

fn validate_known_artifact_enums(artifact: &AffectedCellsArtifact) -> Result<(), CensusError> {
    if artifact.cell_metric != "USGS_MMI" {
        return invalid_artifact("cell_metric must be USGS_MMI");
    }
    if artifact.intensity_scale != "MMI_X100" {
        return invalid_artifact("intensity_scale must be MMI_X100");
    }
    match artifact.cell_aggregation.as_str() {
        "GRID_POINT_P90" | "H3_CENTER_BILINEAR" => Ok(()),
        _ => invalid_artifact("unknown cell_aggregation"),
    }
}

fn cells_generation_method_id(value: &str) -> Result<u8, CensusError> {
    match value {
        "shakemap_gridxml_h3_grid_point_p90_v1" => {
            Ok(CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1)
        }
        "shakemap_hdf_h3_area_weighted_p90_v1" => {
            Ok(CELLS_GENERATION_METHOD_SHAKEMAP_HDF_H3_AREA_WEIGHTED_P90_V1)
        }
        "shakemap_gridxml_h3_center_bilinear_v1" => {
            Ok(CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_CENTER_BILINEAR_V1)
        }
        _ => invalid_artifact("unknown cells_generation_method"),
    }
}

fn parse_canonical_h3_index(value: &str) -> Result<u64, CensusError> {
    if value.is_empty() {
        return invalid_artifact("h3_index must not be empty");
    }
    if value != "0" && value.starts_with('0') {
        return invalid_artifact("h3_index must be canonical decimal without leading zeros");
    }
    if !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return invalid_artifact("h3_index must be a decimal u64 string");
    }
    value.parse::<u64>().map_err(|_| {
        CensusError::InvalidPayload("h3_index must be a decimal u64 string".to_owned())
    })
}

fn affected_cell_leaf_hash(leaf: &AffectedCellLeafBcs) -> Result<[u8; 32], CensusError> {
    let leaf_bytes = bcs::to_bytes(leaf)?;
    let mut data = Vec::with_capacity(1 + leaf_bytes.len());
    data.push(0x00);
    data.extend_from_slice(&leaf_bytes);
    Ok(sha256_bytes(&data))
}

fn merkle_root_from_leaf_hashes(leaf_hashes: &[[u8; 32]]) -> Option<[u8; 32]> {
    let mut level = leaf_hashes.to_vec();
    if level.is_empty() {
        return None;
    }
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for chunk in level.chunks(2) {
            if chunk.len() == 1 {
                next.push(chunk[0]);
            } else {
                let mut data = Vec::with_capacity(65);
                data.push(0x01);
                data.extend_from_slice(&chunk[0]);
                data.extend_from_slice(&chunk[1]);
                next.push(sha256_bytes(&data));
            }
        }
        level = next;
    }
    level.first().copied()
}

fn invalid_artifact<T>(message: &str) -> Result<T, CensusError> {
    Err(CensusError::InvalidPayload(format!(
        "invalid affected cells artifact: {message}"
    )))
}

#[cfg(test)]
mod tests {
    use super::{
        AffectedCell, AffectedCellsArtifact, compute_affected_cells_root,
        validate_affected_cells_root,
    };

    const EVENT_UID: &str = "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd";

    fn valid_artifact() -> AffectedCellsArtifact {
        AffectedCellsArtifact {
            event_uid: EVENT_UID.to_owned(),
            event_revision: 1,
            oracle_version: 1,
            geo_resolution: 7,
            cells_generation_method: "shakemap_gridxml_h3_grid_point_p90_v1".to_owned(),
            cell_metric: "USGS_MMI".to_owned(),
            cell_aggregation: "GRID_POINT_P90".to_owned(),
            intensity_scale: "MMI_X100".to_owned(),
            affected_cells: vec![
                AffectedCell {
                    h3_index: "608819013513904127".to_owned(),
                    intensity_value: 723,
                    cell_band: 1,
                },
                AffectedCell {
                    h3_index: "608819013513904128".to_owned(),
                    intensity_value: 781,
                    cell_band: 2,
                },
                AffectedCell {
                    h3_index: "608819013513904129".to_owned(),
                    intensity_value: 831,
                    cell_band: 3,
                },
            ],
        }
    }

    #[test]
    fn affected_cells_root_recomputes_from_valid_cells() {
        let root = compute_affected_cells_root(EVENT_UID, 1, &valid_artifact()).unwrap();

        assert_eq!(
            root,
            "0xbea35012882b0ce16e4796577e717ac077e4d608fd300d7894a39da03a67e180"
        );
    }

    #[test]
    fn validate_affected_cells_root_rejects_mismatch() {
        let error = validate_affected_cells_root(
            EVENT_UID,
            1,
            "0x1111111111111111111111111111111111111111111111111111111111111111",
            &valid_artifact(),
        )
        .unwrap_err();

        assert!(error.to_string().contains("affected_cells_root"));
    }

    #[test]
    fn validate_affected_cells_root_rejects_binding_mismatch() {
        let mut artifact = valid_artifact();
        artifact.event_revision = 2;

        assert!(compute_affected_cells_root(EVENT_UID, 1, &artifact).is_err());

        let mut artifact = valid_artifact();
        artifact.event_uid =
            "0x1111111111111111111111111111111111111111111111111111111111111111".to_owned();

        assert!(compute_affected_cells_root(EVENT_UID, 1, &artifact).is_err());
    }

    #[test]
    fn compute_affected_cells_root_rejects_unsorted_and_duplicate_h3() {
        let mut unsorted = valid_artifact();
        unsorted.affected_cells.swap(0, 1);
        assert!(compute_affected_cells_root(EVENT_UID, 1, &unsorted).is_err());

        let mut duplicate = valid_artifact();
        duplicate.affected_cells[1].h3_index = duplicate.affected_cells[0].h3_index.clone();
        assert!(compute_affected_cells_root(EVENT_UID, 1, &duplicate).is_err());
    }

    #[test]
    fn compute_affected_cells_root_rejects_unknown_enum_values() {
        let mut artifact = valid_artifact();
        artifact.cells_generation_method = "unknown".to_owned();
        assert!(compute_affected_cells_root(EVENT_UID, 1, &artifact).is_err());

        let mut artifact = valid_artifact();
        artifact.cell_metric = "UNKNOWN".to_owned();
        assert!(compute_affected_cells_root(EVENT_UID, 1, &artifact).is_err());

        let mut artifact = valid_artifact();
        artifact.intensity_scale = "UNKNOWN".to_owned();
        assert!(compute_affected_cells_root(EVENT_UID, 1, &artifact).is_err());

        let mut artifact = valid_artifact();
        artifact.cell_aggregation = "UNKNOWN".to_owned();
        assert!(compute_affected_cells_root(EVENT_UID, 1, &artifact).is_err());
    }

    #[test]
    fn compute_affected_cells_root_rejects_empty_cells_geo_resolution_band_u16_and_h3() {
        let mut artifact = valid_artifact();
        artifact.affected_cells = Vec::new();
        assert!(compute_affected_cells_root(EVENT_UID, 1, &artifact).is_err());

        let mut artifact = valid_artifact();
        artifact.geo_resolution = 8;
        assert!(compute_affected_cells_root(EVENT_UID, 1, &artifact).is_err());

        let mut artifact = valid_artifact();
        artifact.affected_cells[0].cell_band = 0;
        assert!(compute_affected_cells_root(EVENT_UID, 1, &artifact).is_err());

        let mut artifact = valid_artifact();
        artifact.affected_cells[0].cell_band = 4;
        assert!(compute_affected_cells_root(EVENT_UID, 1, &artifact).is_err());

        let mut artifact = valid_artifact();
        artifact.affected_cells[0].intensity_value = u64::from(u16::MAX) + 1;
        assert!(compute_affected_cells_root(EVENT_UID, 1, &artifact).is_err());

        let mut artifact = valid_artifact();
        artifact.affected_cells[0].h3_index = "0608819013513904127".to_owned();
        assert!(compute_affected_cells_root(EVENT_UID, 1, &artifact).is_err());

        let mut artifact = valid_artifact();
        artifact.affected_cells[0].h3_index = "not-decimal".to_owned();
        assert!(compute_affected_cells_root(EVENT_UID, 1, &artifact).is_err());
    }
}
