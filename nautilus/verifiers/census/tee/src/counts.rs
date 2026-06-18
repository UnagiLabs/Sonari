use crate::{
    AffectedCellsArtifact, CensusError, FloorCensusResult, H3_RESOLUTION, INTENT, SHARD_COUNT,
    VERIFIER_FAMILY, VERIFIER_VERSION, validate_affected_cells_root,
};
use serde::{Deserialize, Serialize};
use sonari_tee_core::{hex_to_32, sha256_bytes, to_hex};
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
    pub counted_cells_root: String,
    pub affected_cells: AffectedCellsArtifact,
    pub home_cell_events: Vec<HomeCellRegisteredEvent>,
    pub active_lineages: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct HomeCellRegisteredEvent {
    pub lineage: String,
    pub home_cell: String,
    pub registered_at_ms: u64,
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

    let active_lineages = active_lineage_set(&bundle.active_lineages)?;
    let affected_cells = affected_cells_by_h3(&bundle.affected_cells)?;
    let latest_events = latest_pre_cutoff_events(&bundle.home_cell_events, bundle.occurred_at_ms)?;

    let mut counts = [0_u64; 3];
    let mut counts_by_h3 = affected_cells
        .keys()
        .map(|h3| (*h3, 0_u64))
        .collect::<HashMap<u64, u64>>();
    for (lineage, event) in latest_events {
        if !active_lineages.contains(&lineage) {
            continue;
        }
        let home_cell = parse_canonical_u64_decimal(&event.home_cell, "home_cell")?;
        let Some(band) = affected_cells.get(&home_cell) else {
            continue;
        };
        let index = usize::from(*band - 1);
        counts[index] = counts[index]
            .checked_add(1)
            .ok_or_else(|| CensusError::InvalidPayload("census count overflow".to_owned()))?;
        let cell_count = counts_by_h3.get_mut(&home_cell).ok_or_else(|| {
            CensusError::InvalidPayload("affected cell count index missing".to_owned())
        })?;
        *cell_count = cell_count
            .checked_add(1)
            .ok_or_else(|| CensusError::InvalidPayload("census cell count overflow".to_owned()))?;
    }

    let mut counted_cells = affected_cells
        .iter()
        .map(|(h3_cell, cell_band)| CountedCellLeafBcs {
            h3_cell: *h3_cell,
            cell_band: *cell_band,
            shard_id: *h3_cell % SHARD_COUNT,
            count_at_census_checkpoint: *counts_by_h3.get(h3_cell).unwrap_or(&0),
        })
        .collect::<Vec<_>>();
    counted_cells.sort_by_key(|cell| cell.h3_cell);

    Ok(FloorCensusSnapshot {
        counts,
        counted_cells_root: counted_cells_root(&counted_cells)?,
    })
}

pub fn process_floor_census_bundle(
    bundle: &CensusInputBundle,
) -> Result<FloorCensusResult, CensusError> {
    validate_census_context(bundle)?;
    let snapshot = compute_floor_census_snapshot(bundle)?;
    if hex_to_32(&bundle.counted_cells_root)? != hex_to_32(&snapshot.counted_cells_root)? {
        return Err(CensusError::InvalidPayload(
            "counted_cells_root does not match census snapshot".to_owned(),
        ));
    }

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
    validate_object_id(&bundle.counted_cells_root, "counted_cells_root")?;
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

fn active_lineage_set(lineages: &[String]) -> Result<HashSet<String>, CensusError> {
    let mut active = HashSet::with_capacity(lineages.len());
    for lineage in lineages {
        validate_lineage(lineage)?;
        active.insert(lineage.clone());
    }
    Ok(active)
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

fn latest_pre_cutoff_events(
    events: &[HomeCellRegisteredEvent],
    cutoff_ms: u64,
) -> Result<HashMap<String, HomeCellRegisteredEvent>, CensusError> {
    let mut latest = HashMap::new();
    for event in events {
        validate_lineage(&event.lineage)?;
        parse_canonical_u64_decimal(&event.home_cell, "home_cell")?;
        if event.registered_at_ms >= cutoff_ms {
            continue;
        }

        latest
            .entry(event.lineage.clone())
            .and_modify(|previous: &mut HomeCellRegisteredEvent| {
                if previous.registered_at_ms <= event.registered_at_ms {
                    *previous = event.clone();
                }
            })
            .or_insert_with(|| event.clone());
    }
    Ok(latest)
}

fn validate_lineage(value: &str) -> Result<(), CensusError> {
    if !value.starts_with("0x") {
        return Err(CensusError::InvalidPayload(
            "lineage must be 0x-prefixed 32-byte hex".to_owned(),
        ));
    }
    sonari_tee_core::hex_to_32(value)?;
    Ok(())
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
    use super::{CensusInputBundle, HomeCellRegisteredEvent};
    use crate::{
        AffectedCell, AffectedCellsArtifact, H3_RESOLUTION, INTENT, SHARD_COUNT, VERIFIER_FAMILY,
        VERIFIER_VERSION, compute_affected_cells_root, compute_floor_census_counts,
        compute_floor_census_snapshot, process_floor_census_bundle,
    };

    const EVENT_UID: &str = "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd";
    const ACTIVE_1: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const ACTIVE_2: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
    const ACTIVE_3: &str = "0x3333333333333333333333333333333333333333333333333333333333333333";
    const INACTIVE: &str = "0x4444444444444444444444444444444444444444444444444444444444444444";

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
        let mut bundle = CensusInputBundle {
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
            counted_cells_root: format!("0x{}", "cc".repeat(32)),
            affected_cells,
            home_cell_events: Vec::new(),
            active_lineages: vec![
                ACTIVE_1.to_owned(),
                ACTIVE_2.to_owned(),
                ACTIVE_3.to_owned(),
            ],
        };
        refresh_counted_cells_root(&mut bundle);
        bundle
    }

    fn event(lineage: &str, home_cell: &str, registered_at_ms: u64) -> HomeCellRegisteredEvent {
        HomeCellRegisteredEvent {
            lineage: lineage.to_owned(),
            home_cell: home_cell.to_owned(),
            registered_at_ms,
        }
    }

    fn refresh_counted_cells_root(bundle: &mut CensusInputBundle) {
        bundle.counted_cells_root = compute_floor_census_snapshot(bundle)
            .unwrap()
            .counted_cells_root;
    }

    #[test]
    fn counts_ignore_home_cell_registrations_at_or_after_cutoff() {
        let mut bundle = valid_bundle();
        bundle.home_cell_events = vec![
            event(ACTIVE_1, "10", 999),
            event(ACTIVE_2, "20", 1_000),
            event(ACTIVE_3, "30", 1_001),
        ];

        assert_eq!(compute_floor_census_counts(&bundle).unwrap(), [1, 0, 0]);
    }

    #[test]
    fn counts_use_latest_pre_cutoff_home_cell_per_lineage() {
        let mut bundle = valid_bundle();
        bundle.home_cell_events = vec![
            event(ACTIVE_1, "10", 800),
            event(ACTIVE_1, "20", 900),
            event(ACTIVE_2, "30", 700),
        ];

        assert_eq!(compute_floor_census_counts(&bundle).unwrap(), [0, 1, 1]);
    }

    #[test]
    fn counts_ignore_inactive_lineages() {
        let mut bundle = valid_bundle();
        bundle.home_cell_events = vec![event(ACTIVE_1, "10", 900), event(INACTIVE, "20", 900)];

        assert_eq!(compute_floor_census_counts(&bundle).unwrap(), [1, 0, 0]);
    }

    #[test]
    fn counts_use_later_event_when_registered_at_matches() {
        let mut bundle = valid_bundle();
        bundle.home_cell_events = vec![event(ACTIVE_1, "10", 900), event(ACTIVE_1, "30", 900)];

        assert_eq!(compute_floor_census_counts(&bundle).unwrap(), [0, 0, 1]);
    }

    #[test]
    fn counts_ignore_home_cells_outside_affected_cells() {
        let mut bundle = valid_bundle();
        bundle.home_cell_events = vec![event(ACTIVE_1, "40", 900), event(ACTIVE_2, "20", 900)];

        assert_eq!(compute_floor_census_counts(&bundle).unwrap(), [0, 1, 0]);
    }

    #[test]
    fn counts_reject_malformed_lineage_home_cell_and_root_mismatch() {
        let mut bundle = valid_bundle();
        bundle.active_lineages = vec!["0x1234".to_owned()];
        assert!(compute_floor_census_counts(&bundle).is_err());

        let mut bundle = valid_bundle();
        bundle.home_cell_events = vec![event("0x1234", "10", 900)];
        assert!(compute_floor_census_counts(&bundle).is_err());

        let mut bundle = valid_bundle();
        bundle.home_cell_events = vec![event(ACTIVE_1, "01", 900)];
        assert!(compute_floor_census_counts(&bundle).is_err());

        let mut bundle = valid_bundle();
        bundle.affected_cells_root =
            "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned();
        assert!(compute_floor_census_counts(&bundle).is_err());
    }

    #[test]
    fn process_floor_census_bundle_returns_floor_census_result() {
        let mut bundle = valid_bundle();
        bundle.home_cell_events = vec![
            event(ACTIVE_1, "10", 900),
            event(ACTIVE_2, "20", 900),
            event(ACTIVE_3, "30", 900),
        ];
        refresh_counted_cells_root(&mut bundle);

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
        assert_eq!(result.counted_cells_root, bundle.counted_cells_root);
        assert_eq!(result.issued_at_ms, 1_234);
    }

    #[test]
    fn process_rejects_counted_cells_root_mismatch() {
        let mut bundle = valid_bundle();
        bundle.home_cell_events = vec![event(ACTIVE_1, "10", 900)];
        bundle.counted_cells_root = format!("0x{}", "ff".repeat(32));

        let error = process_floor_census_bundle(&bundle).unwrap_err();
        assert!(error.to_string().contains("counted_cells_root"));
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

        let mut bundle = valid_bundle();
        bundle.counted_cells_root = "0x1234".to_owned();
        assert!(process_floor_census_bundle(&bundle).is_err());
    }
}
