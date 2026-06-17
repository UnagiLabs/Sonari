use crate::{
    AffectedCellsArtifact, CensusError, FloorCensusResult, INTENT, VERIFIER_FAMILY,
    VERIFIER_VERSION, validate_affected_cells_root,
};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct CensusInputBundle {
    pub event_uid: String,
    pub event_revision: u32,
    pub cutoff_ms: u64,
    pub affected_cells_root: String,
    pub issued_at_ms: u64,
    pub affected_cells: AffectedCellsArtifact,
    pub home_cell_events: Vec<HomeCellRegisteredEvent>,
    pub active_lineages: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct HomeCellRegisteredEvent {
    pub lineage: String,
    pub home_cell: String,
    pub registered_at_ms: u64,
}

pub fn compute_floor_census_counts(bundle: &CensusInputBundle) -> Result<[u64; 3], CensusError> {
    validate_affected_cells_root(
        &bundle.event_uid,
        bundle.event_revision,
        &bundle.affected_cells_root,
        &bundle.affected_cells,
    )?;

    let active_lineages = active_lineage_set(&bundle.active_lineages)?;
    let affected_cells = affected_cells_by_h3(&bundle.affected_cells)?;
    let latest_events = latest_pre_cutoff_events(&bundle.home_cell_events, bundle.cutoff_ms)?;

    let mut counts = [0_u64; 3];
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
    }

    Ok(counts)
}

pub fn process_floor_census_bundle(
    bundle: &CensusInputBundle,
) -> Result<FloorCensusResult, CensusError> {
    let counts = compute_floor_census_counts(bundle)?;

    Ok(FloorCensusResult {
        intent: INTENT.to_owned(),
        verifier_family: VERIFIER_FAMILY.to_owned(),
        verifier_version: VERIFIER_VERSION,
        event_uid: bundle.event_uid.clone(),
        event_revision: bundle.event_revision,
        affected_cells_root: bundle.affected_cells_root.clone(),
        registered_members_by_band: counts.to_vec(),
        issued_at_ms: bundle.issued_at_ms,
    })
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
        AffectedCell, AffectedCellsArtifact, INTENT, VERIFIER_FAMILY, VERIFIER_VERSION,
        compute_affected_cells_root, compute_floor_census_counts, process_floor_census_bundle,
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
        CensusInputBundle {
            event_uid: EVENT_UID.to_owned(),
            event_revision: 7,
            cutoff_ms: 1_000,
            affected_cells_root,
            issued_at_ms: 1_234,
            affected_cells,
            home_cell_events: Vec::new(),
            active_lineages: vec![
                ACTIVE_1.to_owned(),
                ACTIVE_2.to_owned(),
                ACTIVE_3.to_owned(),
            ],
        }
    }

    fn event(lineage: &str, home_cell: &str, registered_at_ms: u64) -> HomeCellRegisteredEvent {
        HomeCellRegisteredEvent {
            lineage: lineage.to_owned(),
            home_cell: home_cell.to_owned(),
            registered_at_ms,
        }
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

        let result = process_floor_census_bundle(&bundle).unwrap();

        assert_eq!(result.intent, INTENT);
        assert_eq!(result.verifier_family, VERIFIER_FAMILY);
        assert_eq!(result.verifier_version, VERIFIER_VERSION);
        assert_eq!(result.event_uid, EVENT_UID);
        assert_eq!(result.event_revision, 7);
        assert_eq!(result.affected_cells_root, bundle.affected_cells_root);
        assert_eq!(result.registered_members_by_band, vec![1, 1, 1]);
        assert_eq!(result.issued_at_ms, 1_234);
    }
}
