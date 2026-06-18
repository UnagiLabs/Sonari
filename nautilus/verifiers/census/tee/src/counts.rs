use crate::{
    AffectedCellsArtifact, CensusError, FloorCensusResult, H3_RESOLUTION, INTENT, SHARD_COUNT,
    VERIFIER_FAMILY, VERIFIER_VERSION, validate_affected_cells_root,
};
use serde::{Deserialize, Serialize};
use sonari_tee_core::{sha256_bytes, to_hex};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct CensusInputBundle {
    pub event_uid: String,
    pub event_revision: u32,
    pub occurred_at_ms: u64,
    pub affected_cells_root: String,
    pub issued_at_ms: u64,
    pub campaign_id: String,
    pub disaster_event_id: String,
    pub membership_registry_id: String,
    pub cell_count_index_id: String,
    pub census_checkpoint: u64,
    pub affected_cells: AffectedCellsArtifact,
    pub counted_cells: Vec<CountedCell>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct CountedCell {
    pub h3_cell: String,
    pub cell_band: u64,
    pub shard_id: u64,
    pub active_count: String,
}

pub struct FloorCensusSnapshot {
    pub counts: [u64; 3],
    pub counted_cells_root: String,
}

#[derive(Serialize)]
struct CountedCellLeafBcs {
    h3_cell: u64,
    cell_band: u8,
    shard_id: u64,
    count_at_census_checkpoint: u64,
}

pub fn compute_floor_census_counts(bundle: &CensusInputBundle) -> Result<[u64; 3], CensusError> {
    Ok(compute_floor_census_snapshot(bundle)?.counts)
}

pub fn compute_floor_census_snapshot(
    bundle: &CensusInputBundle,
) -> Result<FloorCensusSnapshot, CensusError> {
    validate_affected_cells_root(
        &bundle.event_uid,
        bundle.event_revision,
        &bundle.affected_cells_root,
        &bundle.affected_cells,
    )?;

    let affected_cells = affected_cells_by_h3(&bundle.affected_cells)?;
    let counted_cells = validate_counted_cells(&affected_cells, &bundle.counted_cells)?;

    let mut counts = [0_u64; 3];
    for cell in &counted_cells {
        let index = usize::from(cell.cell_band - 1);
        counts[index] = counts[index]
            .checked_add(cell.active_count)
            .ok_or_else(|| CensusError::InvalidPayload("census count overflow".to_owned()))?;
    }

    let leaves = counted_cells
        .into_iter()
        .map(|cell| CountedCellLeafBcs {
            h3_cell: cell.h3_cell,
            cell_band: cell.cell_band,
            shard_id: cell.shard_id,
            count_at_census_checkpoint: cell.active_count,
        })
        .collect::<Vec<_>>();

    Ok(FloorCensusSnapshot {
        counts,
        counted_cells_root: counted_cells_root(&leaves)?,
    })
}

pub fn process_floor_census_bundle(
    bundle: &CensusInputBundle,
) -> Result<FloorCensusResult, CensusError> {
    validate_census_context(bundle)?;
    let snapshot = compute_floor_census_snapshot(bundle)?;

    Ok(FloorCensusResult {
        intent: INTENT.to_owned(),
        verifier_family: VERIFIER_FAMILY.to_owned(),
        verifier_version: VERIFIER_VERSION,
        event_uid: bundle.event_uid.clone(),
        event_revision: bundle.event_revision,
        affected_cells_root: bundle.affected_cells_root.clone(),
        membership_registry_id: bundle.membership_registry_id.clone(),
        cell_count_index_id: bundle.cell_count_index_id.clone(),
        census_checkpoint: bundle.census_checkpoint,
        h3_resolution: H3_RESOLUTION,
        shard_count: SHARD_COUNT,
        registered_members_by_band: snapshot.counts.to_vec(),
        counted_cells_root: snapshot.counted_cells_root,
        issued_at_ms: bundle.issued_at_ms,
    })
}

fn validate_census_context(bundle: &CensusInputBundle) -> Result<(), CensusError> {
    validate_object_id(&bundle.campaign_id, "campaign_id")?;
    validate_object_id(&bundle.disaster_event_id, "disaster_event_id")?;
    validate_object_id(&bundle.membership_registry_id, "membership_registry_id")?;
    validate_object_id(&bundle.cell_count_index_id, "cell_count_index_id")?;
    Ok(())
}

fn counted_cells_root(cells: &[CountedCellLeafBcs]) -> Result<String, CensusError> {
    let mut leaf_hashes = Vec::with_capacity(cells.len());
    for cell in cells {
        let leaf_bytes = bcs::to_bytes(cell)?;
        let mut data = Vec::with_capacity(1 + leaf_bytes.len());
        data.push(0x00);
        data.extend_from_slice(&leaf_bytes);
        leaf_hashes.push(sha256_bytes(&data));
    }
    merkle_root_from_leaf_hashes(&leaf_hashes)
        .map(|root| to_hex(&root))
        .ok_or_else(|| {
            CensusError::InvalidPayload(
                "counted_cells_root requires at least one affected cell".to_owned(),
            )
        })
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

fn affected_cells_by_h3(artifact: &AffectedCellsArtifact) -> Result<HashMap<u64, u8>, CensusError> {
    let mut cells = HashMap::with_capacity(artifact.affected_cells.len());
    for cell in &artifact.affected_cells {
        let h3_index = parse_canonical_u64_decimal(&cell.h3_index, "h3_index")?;
        let band = u8::try_from(cell.cell_band).map_err(|_| {
            CensusError::InvalidPayload(format!(
                "cell_band must be in 1..=3, got {}",
                cell.cell_band
            ))
        })?;
        if !(1..=3).contains(&band) {
            return Err(CensusError::InvalidPayload(format!(
                "cell_band must be in 1..=3, got {band}"
            )));
        }
        cells.insert(h3_index, band);
    }
    Ok(cells)
}

#[derive(Clone)]
struct ValidCountedCell {
    h3_cell: u64,
    cell_band: u8,
    shard_id: u64,
    active_count: u64,
}

fn validate_counted_cells(
    affected_cells: &HashMap<u64, u8>,
    counted_cells: &[CountedCell],
) -> Result<Vec<ValidCountedCell>, CensusError> {
    let mut seen = HashSet::with_capacity(counted_cells.len());
    let mut valid = Vec::with_capacity(counted_cells.len());
    for cell in counted_cells {
        let h3_cell = parse_canonical_u64_decimal(&cell.h3_cell, "h3_cell")?;
        if !seen.insert(h3_cell) {
            return Err(CensusError::InvalidPayload(format!(
                "counted_cells contains duplicate h3_cell {h3_cell}"
            )));
        }
        let expected_band = affected_cells.get(&h3_cell).ok_or_else(|| {
            CensusError::InvalidPayload(format!(
                "counted_cells contains h3_cell {h3_cell} outside affected_cells"
            ))
        })?;
        let cell_band = u8::try_from(cell.cell_band).map_err(|_| {
            CensusError::InvalidPayload(format!(
                "cell_band must be in 1..=3, got {}",
                cell.cell_band
            ))
        })?;
        if cell_band != *expected_band {
            return Err(CensusError::InvalidPayload(format!(
                "counted_cells band for h3_cell {h3_cell} does not match affected_cells"
            )));
        }
        let expected_shard = h3_cell % SHARD_COUNT;
        if cell.shard_id != expected_shard {
            return Err(CensusError::InvalidPayload(format!(
                "counted_cells shard_id for h3_cell {h3_cell} must be {expected_shard}"
            )));
        }
        let active_count = parse_canonical_u64_decimal(&cell.active_count, "active_count")?;
        valid.push(ValidCountedCell {
            h3_cell,
            cell_band,
            shard_id: cell.shard_id,
            active_count,
        });
    }
    for h3_cell in affected_cells.keys() {
        if !seen.contains(h3_cell) {
            return Err(CensusError::InvalidPayload(format!(
                "counted_cells is missing affected h3_cell {h3_cell}"
            )));
        }
    }
    valid.sort_by_key(|cell| cell.h3_cell);
    Ok(valid)
}

fn validate_object_id(value: &str, field: &str) -> Result<(), CensusError> {
    if !value.starts_with("0x") {
        return Err(CensusError::InvalidPayload(format!(
            "{field} must be 0x-prefixed 32-byte hex"
        )));
    }
    sonari_tee_core::hex_to_32(value)?;
    Ok(())
}

fn parse_canonical_u64_decimal(value: &str, field: &str) -> Result<u64, CensusError> {
    if value.is_empty() {
        return Err(CensusError::InvalidPayload(format!(
            "{field} must not be empty"
        )));
    }
    if value != "0" && value.starts_with('0') {
        return Err(CensusError::InvalidPayload(format!(
            "{field} must be canonical decimal without leading zeros"
        )));
    }
    if !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(CensusError::InvalidPayload(format!(
            "{field} must be a decimal u64 string"
        )));
    }
    value
        .parse::<u64>()
        .map_err(|_| CensusError::InvalidPayload(format!("{field} must be a decimal u64 string")))
}

#[cfg(test)]
mod tests {
    use super::{CensusInputBundle, CountedCell};
    use crate::{
        AffectedCell, AffectedCellsArtifact, H3_RESOLUTION, INTENT, SHARD_COUNT, VERIFIER_FAMILY,
        VERIFIER_VERSION, compute_affected_cells_root, compute_floor_census_counts,
        compute_floor_census_snapshot, process_floor_census_bundle,
    };

    const EVENT_UID: &str = "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd";

    fn affected_cells() -> AffectedCellsArtifact {
        AffectedCellsArtifact {
            event_uid: EVENT_UID.to_owned(),
            event_revision: 7,
            oracle_version: 1,
            geo_resolution: 7,
            cells_generation_method: "shakemap_gridxml_h3_grid_point_p90_v1".to_owned(),
            cell_metric: "USGS_MMI".to_owned(),
            cell_aggregation: "GRID_POINT_P90".to_owned(),
            intensity_scale: "MMI_X100".to_owned(),
            affected_cells: vec![
                AffectedCell {
                    h3_index: "10".to_owned(),
                    intensity_value: 600,
                    cell_band: 1,
                },
                AffectedCell {
                    h3_index: "20".to_owned(),
                    intensity_value: 700,
                    cell_band: 2,
                },
                AffectedCell {
                    h3_index: "30".to_owned(),
                    intensity_value: 800,
                    cell_band: 3,
                },
            ],
        }
    }

    fn valid_bundle() -> CensusInputBundle {
        let affected_cells = affected_cells();
        let affected_cells_root =
            compute_affected_cells_root(EVENT_UID, 7, &affected_cells).unwrap();
        CensusInputBundle {
            event_uid: EVENT_UID.to_owned(),
            event_revision: 7,
            occurred_at_ms: 1_000,
            affected_cells_root,
            issued_at_ms: 1_234,
            campaign_id: format!("0x{}", "55".repeat(32)),
            disaster_event_id: format!("0x{}", "66".repeat(32)),
            membership_registry_id: format!("0x{}", "22".repeat(32)),
            cell_count_index_id: format!("0x{}", "33".repeat(32)),
            census_checkpoint: 345,
            affected_cells,
            counted_cells: vec![
                counted_cell("10", 1, 10, "1"),
                counted_cell("20", 2, 20, "2"),
                counted_cell("30", 3, 30, "3"),
            ],
        }
    }

    fn counted_cell(
        h3_cell: &str,
        cell_band: u64,
        shard_id: u64,
        active_count: &str,
    ) -> CountedCell {
        CountedCell {
            h3_cell: h3_cell.to_owned(),
            cell_band,
            shard_id,
            active_count: active_count.to_owned(),
        }
    }

    #[test]
    fn counts_sum_counted_cells_by_band_and_root() {
        let mut bundle = valid_bundle();
        bundle.counted_cells = vec![
            counted_cell("10", 1, 10, "5"),
            counted_cell("20", 2, 20, "7"),
            counted_cell("30", 3, 30, "11"),
        ];

        let snapshot = compute_floor_census_snapshot(&bundle).unwrap();

        assert_eq!(snapshot.counts, [5, 7, 11]);
        assert_eq!(compute_floor_census_counts(&bundle).unwrap(), [5, 7, 11]);
        assert!(snapshot.counted_cells_root.starts_with("0x"));
        assert_eq!(snapshot.counted_cells_root.len(), 66);
    }

    #[test]
    fn counts_treat_missing_dynamic_field_as_zero_when_reader_supplies_zero_cell() {
        let mut bundle = valid_bundle();
        bundle.counted_cells = vec![
            counted_cell("10", 1, 10, "0"),
            counted_cell("20", 2, 20, "9"),
            counted_cell("30", 3, 30, "0"),
        ];

        assert_eq!(compute_floor_census_counts(&bundle).unwrap(), [0, 9, 0]);
    }

    #[test]
    fn counts_reject_malformed_counted_cells_and_root_mismatch() {
        let mut bundle = valid_bundle();
        bundle.counted_cells = vec![
            counted_cell("10", 1, 10, "1"),
            counted_cell("20", 2, 20, "1"),
            counted_cell("20", 2, 20, "1"),
        ];
        assert!(compute_floor_census_counts(&bundle).is_err());

        let mut bundle = valid_bundle();
        bundle.counted_cells = vec![
            counted_cell("10", 1, 10, "1"),
            counted_cell("20", 2, 20, "1"),
            counted_cell("40", 2, 40, "1"),
        ];
        assert!(compute_floor_census_counts(&bundle).is_err());

        let mut bundle = valid_bundle();
        bundle.counted_cells = vec![
            counted_cell("10", 1, 11, "1"),
            counted_cell("20", 2, 20, "1"),
            counted_cell("30", 3, 30, "1"),
        ];
        assert!(compute_floor_census_counts(&bundle).is_err());

        let mut bundle = valid_bundle();
        bundle.counted_cells = vec![
            counted_cell("10", 2, 10, "1"),
            counted_cell("20", 2, 20, "1"),
            counted_cell("30", 3, 30, "1"),
        ];
        assert!(compute_floor_census_counts(&bundle).is_err());

        let mut bundle = valid_bundle();
        bundle.counted_cells = vec![
            counted_cell("10", 1, 10, "1"),
            counted_cell("20", 2, 20, "1"),
        ];
        assert!(compute_floor_census_counts(&bundle).is_err());

        let mut bundle = valid_bundle();
        bundle.counted_cells = vec![
            counted_cell("01", 1, 1, "1"),
            counted_cell("20", 2, 20, "1"),
            counted_cell("30", 3, 30, "1"),
        ];
        assert!(compute_floor_census_counts(&bundle).is_err());

        let mut bundle = valid_bundle();
        bundle.counted_cells = vec![
            counted_cell("10", 1, 10, "01"),
            counted_cell("20", 2, 20, "1"),
            counted_cell("30", 3, 30, "1"),
        ];
        assert!(compute_floor_census_counts(&bundle).is_err());

        let mut bundle = valid_bundle();
        bundle.affected_cells_root =
            "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned();
        assert!(compute_floor_census_counts(&bundle).is_err());
    }

    #[test]
    fn process_floor_census_bundle_returns_floor_census_result() {
        let mut bundle = valid_bundle();
        bundle.counted_cells = vec![
            counted_cell("10", 1, 10, "1"),
            counted_cell("20", 2, 20, "1"),
            counted_cell("30", 3, 30, "1"),
        ];
        let expected_root = compute_floor_census_snapshot(&bundle)
            .unwrap()
            .counted_cells_root;

        let result = process_floor_census_bundle(&bundle).unwrap();

        assert_eq!(result.intent, INTENT);
        assert_eq!(result.verifier_family, VERIFIER_FAMILY);
        assert_eq!(result.verifier_version, VERIFIER_VERSION);
        assert_eq!(result.event_uid, EVENT_UID);
        assert_eq!(result.event_revision, 7);
        assert_eq!(result.affected_cells_root, bundle.affected_cells_root);
        assert_eq!(result.membership_registry_id, bundle.membership_registry_id);
        assert_eq!(result.cell_count_index_id, bundle.cell_count_index_id);
        assert_eq!(result.census_checkpoint, 345);
        assert_eq!(result.h3_resolution, H3_RESOLUTION);
        assert_eq!(result.shard_count, SHARD_COUNT);
        assert_eq!(result.registered_members_by_band, vec![1, 1, 1]);
        assert_eq!(result.counted_cells_root, expected_root);
        assert_eq!(result.issued_at_ms, 1_234);
    }

    #[test]
    fn process_rejects_count_overflow() {
        let mut bundle = valid_bundle();
        bundle.affected_cells.affected_cells[1].cell_band = 1;
        bundle.affected_cells_root =
            compute_affected_cells_root(EVENT_UID, 7, &bundle.affected_cells).unwrap();
        bundle.counted_cells = vec![
            counted_cell("10", 1, 10, &u64::MAX.to_string()),
            counted_cell("20", 1, 20, "1"),
            counted_cell("30", 3, 30, "1"),
        ];

        let error = process_floor_census_bundle(&bundle).unwrap_err();
        assert!(error.to_string().contains("overflow"));
    }

    #[test]
    fn process_rejects_malformed_campaign_and_disaster_ids() {
        let mut bundle = valid_bundle();
        bundle.campaign_id = "0x1234".to_owned();
        assert!(process_floor_census_bundle(&bundle).is_err());

        let mut bundle = valid_bundle();
        bundle.disaster_event_id = "0x1234".to_owned();
        assert!(process_floor_census_bundle(&bundle).is_err());

        let mut bundle = valid_bundle();
        bundle.membership_registry_id = "0x1234".to_owned();
        assert!(process_floor_census_bundle(&bundle).is_err());

        let mut bundle = valid_bundle();
        bundle.cell_count_index_id = "0x1234".to_owned();
        assert!(process_floor_census_bundle(&bundle).is_err());
    }
}
