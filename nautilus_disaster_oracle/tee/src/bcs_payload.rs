use crate::artifacts::{AffectedCellsArtifact, UnsignedPayloadV1};
use crate::crypto::{hex_to_32, sha3_256_bytes};
use crate::types::OracleError;
use crate::{
    CELL_METRIC_USGS_MMI, CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1,
    INTENSITY_SCALE_MMI_X100,
};
use serde::Serialize;

#[derive(Serialize)]
struct PayloadBcs {
    intent: u8,
    oracle_version: u64,
    event_uid: [u8; 32],
    hazard_type: u8,
    status: u8,
    event_revision: u32,
    occurred_at_ms: u64,
    observed_at_ms: u64,
    source_updated_at_ms: u64,
    primary_source: u8,
    severity_band: u8,
    source_set_hash: [u8; 32],
    raw_data_hash: [u8; 32],
    raw_data_uri: Vec<u8>,
    affected_cells_root: [u8; 32],
    affected_cells_uri: Vec<u8>,
    affected_cells_data_hash: [u8; 32],
    geo_resolution: u8,
    cells_generation_method: u8,
    cell_metric: u8,
    cell_aggregation: u8,
    intensity_scale: u8,
    max_cell_band: u8,
    affected_cell_count: u64,
    min_claim_band: u8,
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

pub(crate) fn payload_bcs_bytes(payload: &UnsignedPayloadV1) -> Result<Vec<u8>, OracleError> {
    bcs::to_bytes(&PayloadBcs {
        intent: payload.intent,
        oracle_version: payload.oracle_version,
        event_uid: hex_to_32(&payload.event_uid)?,
        hazard_type: payload.hazard_type,
        status: payload.status,
        event_revision: payload.event_revision,
        occurred_at_ms: payload.occurred_at_ms,
        observed_at_ms: payload.observed_at_ms,
        source_updated_at_ms: payload.source_updated_at_ms,
        primary_source: payload.primary_source,
        severity_band: payload.severity_band,
        source_set_hash: hex_to_32(&payload.source_set_hash)?,
        raw_data_hash: hex_to_32(&payload.raw_data_hash)?,
        raw_data_uri: payload.raw_data_uri.as_bytes().to_vec(),
        affected_cells_root: hex_to_32(&payload.affected_cells_root)?,
        affected_cells_uri: payload.affected_cells_uri.as_bytes().to_vec(),
        affected_cells_data_hash: hex_to_32(&payload.affected_cells_data_hash)?,
        geo_resolution: payload.geo_resolution,
        cells_generation_method: payload.cells_generation_method,
        cell_metric: payload.cell_metric,
        cell_aggregation: payload.cell_aggregation,
        intensity_scale: payload.intensity_scale,
        max_cell_band: payload.max_cell_band,
        affected_cell_count: payload.affected_cell_count,
        min_claim_band: payload.min_claim_band,
        freshness_deadline_ms: payload.freshness_deadline_ms,
    })
    .map_err(OracleError::from)
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
    sha3_256_bytes(&data)
}

pub(crate) fn leaf_hashes(
    affected: &AffectedCellsArtifact,
    event_uid: [u8; 32],
) -> Result<Vec<(u64, [u8; 32])>, OracleError> {
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
                cells_generation_method:
                    CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1,
                oracle_version: affected.oracle_version,
            };
            let mut data = Vec::with_capacity(1);
            data.push(0x00);
            data.extend(bcs::to_bytes(&leaf)?);
            Ok((h3_index, sha3_256_bytes(&data)))
        })
        .collect()
}
