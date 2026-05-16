use crate::compute::geo::affected_cells_from_points;
use crate::compute::merkle::{merkle_root_from_leaf_hashes, sample_proof};
use crate::core::artifacts::{
    AffectedCellsArtifact, ExpectedHashes, LeafHash, RawDataEntry, RawDataManifest,
    RawSourceContentHash, SourceEntry, SourceManifest, UnsignedPayloadV1,
};
use crate::core::types::{OracleError, OracleOutput, OracleStatus, ResultSummary, UsgsOracleInput};
use crate::crypto::{LocalEd25519Signer, PayloadSigner, sha3_256_bytes, to_hex};
use crate::encoding::bcs_payload::{event_uid_bytes, leaf_hashes, payload_bcs_bytes};
use crate::encoding::json::canonical_json_bytes;
use crate::source::usgs::{UsgsDetail, UsgsShakeMapProduct, parse_detail, parse_grid_points};
use crate::{
    CELL_AGGREGATION_GRID_POINT_P90, CELL_AGGREGATION_NAME, CELL_METRIC_NAME, CELL_METRIC_USGS_MMI,
    CELLS_GENERATION_METHOD_NAME, CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1,
    FRESHNESS_WINDOW_MS, GEO_RESOLUTION, HAZARD_TYPE_EARTHQUAKE, INTENSITY_SCALE_MMI_X100,
    INTENSITY_SCALE_NAME, INTENT_SONARI_EARTHQUAKE_ORACLE, MIN_CLAIM_BAND,
    ONCHAIN_STATUS_FINALIZED, ORACLE_VERSION, PRIMARY_SOURCE_USGS,
};

pub fn process_usgs(input: UsgsOracleInput) -> Result<OracleOutput, OracleError> {
    let detail = parse_detail(&input.detail_json)?;
    let base_result =
        |status, error_code: Option<&str>, expected_payload: Option<&str>| ResultSummary {
            case_id: input.case_id.clone(),
            status,
            source_event_id: detail.id.clone(),
            hazard_type: "EARTHQUAKE".to_owned(),
            primary_source: "USGS".to_owned(),
            geo_resolution: GEO_RESOLUTION,
            error_code: error_code.map(str::to_owned),
            next_retry_at_ms: None,
            expected_payload: expected_payload.map(str::to_owned),
        };

    let Some(shakemap) = detail
        .properties
        .products
        .shakemap
        .as_ref()
        .and_then(|products| products.first())
    else {
        return Ok(status_only(base_result(
            OracleStatus::PendingSource,
            Some("SHAKEMAP_PRODUCT_MISSING"),
            None,
        )));
    };

    if shakemap.properties.map_status == "CANCELLED" {
        return Ok(status_only(base_result(
            OracleStatus::Rejected,
            Some("SHAKEMAP_CANCELLED"),
            None,
        )));
    }

    let Some(grid_xml) = input.grid_xml.as_ref() else {
        return Ok(status_only(base_result(
            OracleStatus::PendingMmi,
            Some("MMI_NOT_AVAILABLE"),
            None,
        )));
    };
    let points = match parse_grid_points(grid_xml) {
        Ok(points) if !points.is_empty() => points,
        _ => {
            return Ok(status_only(base_result(
                OracleStatus::PendingMmi,
                Some("MMI_NOT_AVAILABLE"),
                None,
            )));
        }
    };

    let affected_cells = affected_cells_from_points(&points)?;
    if affected_cells.is_empty() {
        return Ok(status_only(base_result(
            OracleStatus::Rejected,
            Some("NO_AFFECTED_CELLS"),
            None,
        )));
    }

    let event_revision = 1;
    let observed_at_ms = detail.properties.updated;
    let source_updated_at_ms = detail.properties.updated;
    let event_uid_bytes = event_uid_bytes(
        HAZARD_TYPE_EARTHQUAKE,
        "USGS",
        &detail.id,
        detail.properties.time,
    );
    let event_uid = to_hex(&event_uid_bytes);

    let source_manifest = source_manifest(&detail, shakemap);
    let raw_grid_uri = input.raw_grid_uri.clone().ok_or_else(|| {
        OracleError::InvalidGridPoint("raw_grid_uri is required for finalized output".to_owned())
    })?;
    let raw_data_manifest = raw_data_manifest(
        &detail.id,
        &input.raw_detail_uri,
        &input.detail_json,
        &raw_grid_uri,
        grid_xml,
    );
    let affected_artifact = AffectedCellsArtifact {
        event_uid: event_uid.clone(),
        event_revision,
        oracle_version: ORACLE_VERSION,
        geo_resolution: GEO_RESOLUTION,
        cells_generation_method: CELLS_GENERATION_METHOD_NAME.to_owned(),
        cell_metric: CELL_METRIC_NAME.to_owned(),
        cell_aggregation: CELL_AGGREGATION_NAME.to_owned(),
        intensity_scale: INTENSITY_SCALE_NAME.to_owned(),
        affected_cells,
    };

    let source_bytes = canonical_json_bytes(&source_manifest)?;
    let raw_bytes = canonical_json_bytes(&raw_data_manifest)?;
    let affected_bytes = canonical_json_bytes(&affected_artifact)?;
    let source_set_hash = sha3_256_bytes(&source_bytes);
    let raw_data_hash = sha3_256_bytes(&raw_bytes);
    let affected_cells_data_hash = sha3_256_bytes(&affected_bytes);
    let leaf_hashes = leaf_hashes(&affected_artifact, event_uid_bytes)?;
    let affected_cells_root =
        merkle_root_from_leaf_hashes(&leaf_hashes.iter().map(|item| item.1).collect::<Vec<_>>())
            .ok_or_else(|| OracleError::InvalidGridPoint("empty Merkle tree".to_owned()))?;
    let max_cell_band = affected_artifact
        .affected_cells
        .iter()
        .map(|cell| cell.cell_band)
        .max()
        .unwrap_or(0);

    let unsigned_payload = UnsignedPayloadV1 {
        intent: INTENT_SONARI_EARTHQUAKE_ORACLE,
        oracle_version: ORACLE_VERSION,
        event_uid: event_uid.clone(),
        hazard_type: HAZARD_TYPE_EARTHQUAKE,
        status: ONCHAIN_STATUS_FINALIZED,
        event_revision,
        occurred_at_ms: detail.properties.time,
        observed_at_ms,
        source_updated_at_ms,
        primary_source: PRIMARY_SOURCE_USGS,
        severity_band: max_cell_band,
        source_set_hash: to_hex(&source_set_hash),
        raw_data_hash: to_hex(&raw_data_hash),
        raw_data_uri: input.raw_data_uri,
        affected_cells_root: to_hex(&affected_cells_root),
        affected_cells_uri: input.affected_cells_uri,
        affected_cells_data_hash: to_hex(&affected_cells_data_hash),
        geo_resolution: GEO_RESOLUTION,
        cells_generation_method: CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1,
        cell_metric: CELL_METRIC_USGS_MMI,
        cell_aggregation: CELL_AGGREGATION_GRID_POINT_P90,
        intensity_scale: INTENSITY_SCALE_MMI_X100,
        max_cell_band,
        affected_cell_count: affected_artifact.affected_cells.len() as u64,
        min_claim_band: MIN_CLAIM_BAND,
        freshness_deadline_ms: observed_at_ms + FRESHNESS_WINDOW_MS,
    };
    let unsigned_bcs_payload = payload_bcs_bytes(&unsigned_payload)?;
    let signature =
        LocalEd25519Signer::new(input.signing_key_seed).sign_payload(&unsigned_bcs_payload);
    let leaf_hashes_json = leaf_hashes
        .iter()
        .map(|(h3_index, hash)| LeafHash {
            h3_index: h3_index.to_string(),
            leaf_hash: to_hex(hash),
        })
        .collect::<Vec<_>>();
    let expected_hashes = ExpectedHashes {
        event_uid,
        source_set_hash: to_hex(&source_set_hash),
        raw_data_hash: to_hex(&raw_data_hash),
        raw_source_content_hashes: raw_data_manifest
            .entries
            .iter()
            .map(|entry| RawSourceContentHash {
                uri: entry.uri.clone(),
                content_hash: entry.content_hash.clone(),
            })
            .collect(),
        affected_cells_data_hash: to_hex(&affected_cells_data_hash),
        leaf_hashes: leaf_hashes_json.clone(),
        affected_cells_root: to_hex(&affected_cells_root),
        unsigned_bcs_payload_hex: to_hex(&unsigned_bcs_payload),
    };
    let sample_proof = sample_proof(&leaf_hashes_json, affected_cells_root);

    Ok(OracleOutput {
        result: base_result(
            OracleStatus::Finalized,
            None,
            Some("unsigned_payload_v1.json"),
        ),
        source_manifest: Some(source_manifest),
        raw_data_manifest: Some(raw_data_manifest),
        affected_cells: Some(affected_artifact),
        expected_hashes: Some(expected_hashes),
        sample_proof,
        unsigned_payload: Some(unsigned_payload),
        unsigned_bcs_payload: Some(unsigned_bcs_payload),
        signature: Some(signature),
    })
}

fn status_only(result: ResultSummary) -> OracleOutput {
    OracleOutput {
        result,
        source_manifest: None,
        raw_data_manifest: None,
        affected_cells: None,
        expected_hashes: None,
        sample_proof: None,
        unsigned_payload: None,
        unsigned_bcs_payload: None,
        signature: None,
    }
}

fn source_manifest(detail: &UsgsDetail, shakemap: &UsgsShakeMapProduct) -> SourceManifest {
    let detail_url = format!(
        "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/{}.geojson",
        detail.id
    );
    let grid_url = shakemap
        .contents
        .get("download/grid.xml")
        .map(|content| content.url.as_str())
        .unwrap_or("");
    let mut sources = vec![
        SourceEntry {
            name: "USGS".to_owned(),
            event_id: detail.id.clone(),
            product: "detail_geojson".to_owned(),
            product_version: "1".to_owned(),
            map_status: shakemap.properties.map_status.clone(),
            updated_at_ms: detail.properties.updated,
            url_hash: to_hex(&sha3_256_bytes(detail_url.as_bytes())),
        },
        SourceEntry {
            name: "USGS".to_owned(),
            event_id: detail.id.clone(),
            product: "shakemap_grid_xml".to_owned(),
            product_version: shakemap.properties.version.clone(),
            map_status: shakemap.properties.map_status.clone(),
            updated_at_ms: detail.properties.updated,
            url_hash: to_hex(&sha3_256_bytes(grid_url.as_bytes())),
        },
    ];
    sources.sort_by(|a, b| {
        (
            &a.name,
            &a.event_id,
            &a.product,
            &a.product_version,
            a.updated_at_ms,
        )
            .cmp(&(
                &b.name,
                &b.event_id,
                &b.product,
                &b.product_version,
                b.updated_at_ms,
            ))
    });
    SourceManifest {
        sources,
        cells_generation_method: CELLS_GENERATION_METHOD_NAME.to_owned(),
        oracle_version: ORACLE_VERSION,
    }
}

fn raw_data_manifest(
    event_id: &str,
    detail_uri: &str,
    detail_bytes: &[u8],
    grid_uri: &str,
    grid_bytes: &[u8],
) -> RawDataManifest {
    let mut entries = vec![
        RawDataEntry {
            name: "USGS".to_owned(),
            event_id: event_id.to_owned(),
            product: "detail_geojson".to_owned(),
            uri: detail_uri.to_owned(),
            content_hash: to_hex(&sha3_256_bytes(detail_bytes)),
        },
        RawDataEntry {
            name: "USGS".to_owned(),
            event_id: event_id.to_owned(),
            product: "shakemap_grid_xml".to_owned(),
            uri: grid_uri.to_owned(),
            content_hash: to_hex(&sha3_256_bytes(grid_bytes)),
        },
    ];
    entries.sort_by(|a, b| {
        (&a.name, &a.event_id, &a.product, &a.uri).cmp(&(&b.name, &b.event_id, &b.product, &b.uri))
    });
    RawDataManifest {
        entries,
        oracle_version: ORACLE_VERSION,
    }
}
