use crate::core::artifacts::{AffectedCellsArtifact, UnsignedPayload};
use crate::core::types::OracleError;
use crate::crypto::{hex_to_32, sha256_bytes};
use crate::{
    CELL_METRIC_USGS_MMI, CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_CENTER_BILINEAR_V1,
    CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1,
    CELLS_GENERATION_METHOD_SHAKEMAP_HDF_H3_WEIGHTED_P90_V1, FRESHNESS_WINDOW_MS,
    HAZARD_TYPE_EARTHQUAKE, INTENSITY_SCALE_MMI_X100, INTENT_SONARI_EARTHQUAKE_ORACLE,
    ONCHAIN_STATUS_FINALIZED, ORACLE_VERSION,
};
use serde::Serialize;

#[derive(Serialize)]
struct PayloadBcs {
    intent: u8,
    oracle_version: u64,
    event_uid: [u8; 32],
    event_revision: u32,
    source_event_id: Vec<u8>,
    title: Vec<u8>,
    region: Vec<u8>,
    occurred_at_ms: u64,
    hazard_type: u8,
    status: u8,
    severity_band: u8,
    affected_cells_root: [u8; 32],
    affected_cell_count: u64,
    evidence_manifest_uri: Vec<u8>,
    evidence_manifest_hash: [u8; 32],
    verified_at_ms: u64,
    freshness_deadline_ms: u64,
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

pub(crate) fn payload_bcs_bytes(payload: &UnsignedPayload) -> Result<Vec<u8>, OracleError> {
    validate_payload(payload)?;
    bcs::to_bytes(&PayloadBcs {
        intent: payload.intent,
        oracle_version: payload.oracle_version,
        event_uid: hex_to_32(&payload.event_uid)?,
        event_revision: payload.event_revision,
        source_event_id: payload.source_event_id.as_bytes().to_vec(),
        title: payload.title.as_bytes().to_vec(),
        region: payload.region.as_bytes().to_vec(),
        occurred_at_ms: payload.occurred_at_ms,
        hazard_type: payload.hazard_type,
        status: payload.status,
        severity_band: payload.severity_band,
        affected_cells_root: hex_to_32(&payload.affected_cells_root)?,
        affected_cell_count: payload.affected_cell_count,
        evidence_manifest_uri: payload.evidence_manifest_uri.as_bytes().to_vec(),
        evidence_manifest_hash: hex_to_32(&payload.evidence_manifest_hash)?,
        verified_at_ms: payload.verified_at_ms,
        freshness_deadline_ms: payload.freshness_deadline_ms,
    })
    .map_err(OracleError::from)
}

fn validate_payload(payload: &UnsignedPayload) -> Result<(), OracleError> {
    if payload.intent != INTENT_SONARI_EARTHQUAKE_ORACLE
        || payload.oracle_version != ORACLE_VERSION
        || payload.hazard_type != HAZARD_TYPE_EARTHQUAKE
        || payload.status != ONCHAIN_STATUS_FINALIZED
    {
        return invalid_payload("enum or default value does not match current contract");
    }
    if payload.event_revision == 0 {
        return invalid_payload("event_revision must be at least 1");
    }
    validate_utf8_len("source_event_id", &payload.source_event_id, 1, 96)?;
    validate_utf8_len("title", &payload.title, 1, 160)?;
    validate_utf8_len("region", &payload.region, 1, 160)?;
    if !(1..=3).contains(&payload.severity_band) {
        return invalid_payload("severity_band must be in 1..=3");
    }
    validate_utf8_len(
        "evidence_manifest_uri",
        &payload.evidence_manifest_uri,
        1,
        512,
    )?;
    if !(1..=1_000_000).contains(&payload.affected_cell_count) {
        return invalid_payload("affected_cell_count must be in 1..=1000000");
    }
    let expected_deadline = payload
        .verified_at_ms
        .checked_add(FRESHNESS_WINDOW_MS)
        .ok_or_else(|| {
            OracleError::Overflow("freshness_deadline_ms exceeds u64 range".to_owned())
        })?;
    if payload.freshness_deadline_ms != expected_deadline
        || payload.freshness_deadline_ms <= payload.verified_at_ms
    {
        return invalid_payload(
            "freshness_deadline_ms must equal verified_at_ms + freshness window",
        );
    }
    Ok(())
}

fn validate_utf8_len(field: &str, value: &str, min: usize, max: usize) -> Result<(), OracleError> {
    let len = value.len();
    if len < min || len > max {
        return invalid_payload(&format!("{field} length must be in {min}..={max} bytes"));
    }
    Ok(())
}

fn invalid_payload<T>(message: &str) -> Result<T, OracleError> {
    Err(OracleError::InvalidGridPoint(format!(
        "invalid current payload: {message}"
    )))
}

pub(crate) fn event_uid_bytes(
    hazard_type: u8,
    primary_source: &str,
    source_event_id: &str,
    occurred_at_ms: u64,
) -> [u8; 32] {
    let mut data = Vec::new();
    data.extend_from_slice(b"sonari:event_uid:v1");
    data.push(hazard_type);
    data.extend_from_slice(&(primary_source.len() as u32).to_le_bytes());
    data.extend_from_slice(primary_source.as_bytes());
    data.extend_from_slice(&(source_event_id.len() as u32).to_le_bytes());
    data.extend_from_slice(source_event_id.as_bytes());
    data.extend_from_slice(&occurred_at_ms.to_le_bytes());
    sha256_bytes(&data)
}

pub(crate) fn leaf_hashes(
    affected: &AffectedCellsArtifact,
    event_uid: [u8; 32],
) -> Result<Vec<(u64, [u8; 32])>, OracleError> {
    let cells_generation_method = cells_generation_method_id(&affected.cells_generation_method)?;
    affected
        .affected_cells
        .iter()
        .map(|cell| {
            let h3_index = cell.h3_index.parse::<u64>().map_err(|_| {
                OracleError::InvalidGridPoint(format!("invalid h3_index {}", cell.h3_index))
            })?;
            let leaf = AffectedCellLeafBcs {
                event_uid,
                event_revision: affected.event_revision,
                h3_index,
                geo_resolution: affected.geo_resolution,
                cell_metric: CELL_METRIC_USGS_MMI,
                intensity_value: cell.intensity_value,
                intensity_scale: INTENSITY_SCALE_MMI_X100,
                cell_band: cell.cell_band,
                cells_generation_method,
                oracle_version: affected.oracle_version,
            };
            let mut data = Vec::with_capacity(1);
            data.push(0x00);
            data.extend(bcs::to_bytes(&leaf)?);
            Ok((h3_index, sha256_bytes(&data)))
        })
        .collect()
}

fn cells_generation_method_id(value: &str) -> Result<u8, OracleError> {
    match value {
        "shakemap_gridxml_h3_grid_point_p90_v1" => {
            Ok(CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1)
        }
        "shakemap_hdf_h3_area_weighted_p90_v1" => {
            Ok(CELLS_GENERATION_METHOD_SHAKEMAP_HDF_H3_WEIGHTED_P90_V1)
        }
        "shakemap_gridxml_h3_center_bilinear_v1" => {
            Ok(CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_CENTER_BILINEAR_V1)
        }
        _ => Err(OracleError::InvalidGridPoint(format!(
            "unknown cells_generation_method {value}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::artifacts::AffectedCellJson;

    fn affected(method: &str) -> AffectedCellsArtifact {
        AffectedCellsArtifact {
            event_uid: "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd"
                .to_owned(),
            event_revision: 1,
            oracle_version: 1,
            geo_resolution: 7,
            cells_generation_method: method.to_owned(),
            cell_metric: "USGS_MMI".to_owned(),
            cell_aggregation: "GRID_POINT_P90".to_owned(),
            intensity_scale: "MMI_X100".to_owned(),
            affected_cells: vec![AffectedCellJson {
                h3_index: "608819013513904127".to_owned(),
                intensity_value: 831,
                cell_band: 3,
            }],
        }
    }

    #[test]
    fn leaf_hashes_uses_artifact_cells_generation_method() {
        let event_uid =
            hex_to_32("0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd")
                .unwrap();
        let old_hash = leaf_hashes(
            &affected("shakemap_gridxml_h3_grid_point_p90_v1"),
            event_uid,
        )
        .unwrap();
        let new_hash = leaf_hashes(
            &affected("shakemap_gridxml_h3_center_bilinear_v1"),
            event_uid,
        )
        .unwrap();

        assert_ne!(old_hash, new_hash);
    }

    #[test]
    fn leaf_hashes_rejects_unknown_cells_generation_method() {
        let event_uid =
            hex_to_32("0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd")
                .unwrap();

        assert!(leaf_hashes(&affected("unknown_method"), event_uid).is_err());
    }
}
