use crate::compute::geo::affected_cells_from_grid_centers;
use crate::compute::merkle::{merkle_root_from_leaf_hashes, sample_proof};
use crate::core::artifacts::{
    AffectedCellsArtifact, EarthquakeEvidence, EvidenceAffectedCells, EvidenceManifest,
    EvidenceSource, ExpectedHashes, LeafHash, RawDataEntry, RawDataManifest, RawSourceContentHash,
    SourceEntry, SourceManifest, StoredSourceRef, UnsignedPayload,
};
use crate::core::source_archive::{SourceArchive, SourceArchiveError};
use crate::core::types::{
    OracleError, OracleOutput, OracleStatus, ResultSummary, UsgsOracleInput, WorkerToTeeRequest,
};
use crate::crypto::{PayloadSigner, sha256_bytes, to_hex};
use crate::encoding::bcs_payload::{event_uid_bytes, leaf_hashes, payload_bcs_bytes};
use crate::encoding::json::canonical_json_bytes;
use crate::source::usgs::{
    UsgsDetail, UsgsShakeMapProduct, detail_matches_source_event_id, grid_xml_from_artifact,
    parse_detail, parse_grid_points, structured_grid_from_points,
};
use crate::{
    CELL_AGGREGATION_NAME, CELL_METRIC_NAME, CELLS_GENERATION_METHOD_NAME, FRESHNESS_WINDOW_MS,
    GEO_RESOLUTION, HAZARD_TYPE_EARTHQUAKE, INTENSITY_SCALE_NAME, INTENT_SONARI_EARTHQUAKE_ORACLE,
    ONCHAIN_STATUS_FINALIZED, ORACLE_VERSION, PRIMARY_SOURCE_USGS,
};

pub fn process_usgs(input: UsgsOracleInput) -> Result<OracleOutput, OracleError> {
    process_usgs_inner(input, None)
}

pub fn process_usgs_with_source_archive(
    input: UsgsOracleInput,
    archive: &impl SourceArchive,
    signer: &impl PayloadSigner,
) -> Result<OracleOutput, SourceArchiveError> {
    let mut output = process_usgs_archived(input, archive)?;
    if let Some(payload) = output.unsigned_bcs_payload.as_ref() {
        output.signature = Some(signer.sign_payload(payload));
    }
    Ok(output)
}

/// Archives the raw sources and produces the unsigned finalized output.
///
/// This is the signing-free core of [`process_usgs_with_source_archive`]: it
/// stores the raw detail / grid bytes through `archive` and rebuilds the
/// payload with the resulting references, but leaves `signature` empty so the
/// caller (e.g. the enclave server) owns key management and signing.
pub fn process_usgs_archived(
    input: UsgsOracleInput,
    archive: &impl SourceArchive,
) -> Result<OracleOutput, SourceArchiveError> {
    let output = process_usgs_inner(input.clone(), None)?;
    if output.result.status != OracleStatus::Finalized {
        return Ok(output);
    }

    let grid_xml = input.grid_xml.clone().ok_or_else(|| {
        SourceArchiveError::Oracle(OracleError::InvalidGridPoint(
            "grid_xml is required for archived finalized output".to_owned(),
        ))
    })?;
    let raw_grid_uri = input.raw_grid_uri.clone().ok_or_else(|| {
        SourceArchiveError::Oracle(OracleError::InvalidGridPoint(
            "raw_grid_uri is required for archived finalized output".to_owned(),
        ))
    })?;
    let raw_grid_bytes = raw_grid_bytes_for_source(&input, &grid_xml, &raw_grid_uri)
        .map_err(SourceArchiveError::Oracle)?;
    let detail_hash = to_hex(&sha256_bytes(&input.detail_json));
    let grid_hash = to_hex(&sha256_bytes(&raw_grid_bytes));
    let detail_ref =
        archive.store_and_verify(&input.raw_detail_uri, &detail_hash, &input.detail_json)?;
    let grid_ref = archive.store_and_verify(&raw_grid_uri, &grid_hash, &raw_grid_bytes)?;
    let raw_refs = UsgsRawArchiveRefs {
        detail_source_uri: input.raw_detail_uri.clone(),
        detail_ref,
        grid_source_uri: raw_grid_uri,
        grid_ref,
    };
    let event_uid = output
        .unsigned_payload
        .as_ref()
        .ok_or_else(|| {
            SourceArchiveError::Oracle(OracleError::InvalidGridPoint(
                "finalized output is missing unsigned payload".to_owned(),
            ))
        })?
        .event_uid
        .clone();
    let affected_cells = output.affected_cells.as_ref().ok_or_else(|| {
        SourceArchiveError::Oracle(OracleError::InvalidGridPoint(
            "finalized output is missing affected cells".to_owned(),
        ))
    })?;
    let affected_cells_bytes =
        canonical_json_bytes(affected_cells).map_err(SourceArchiveError::Oracle)?;
    let affected_cells_ref = archive_generated_artifact(
        archive,
        &event_uid,
        "affected_cells.json",
        &affected_cells_bytes,
    )?;
    let detail = parse_detail(&input.detail_json).map_err(SourceArchiveError::Oracle)?;
    let raw_data_manifest = raw_data_manifest(
        &detail.id,
        &input.raw_detail_uri,
        &input.detail_json,
        &raw_refs.grid_source_uri,
        &raw_grid_bytes,
        Some(&raw_refs),
    );
    let payload = output.unsigned_payload.as_ref().ok_or_else(|| {
        SourceArchiveError::Oracle(OracleError::InvalidGridPoint(
            "finalized output is missing unsigned payload".to_owned(),
        ))
    })?;
    let evidence_manifest = evidence_manifest(
        &detail,
        payload,
        &raw_data_manifest,
        &affected_cells_ref,
        &to_hex(&sha256_bytes(&affected_cells_bytes)),
        &payload.affected_cells_root,
        payload.affected_cell_count,
    )
    .map_err(SourceArchiveError::Oracle)?;
    let evidence_manifest_bytes =
        canonical_json_bytes(&evidence_manifest).map_err(SourceArchiveError::Oracle)?;
    let evidence_manifest_ref = archive_generated_artifact(
        archive,
        &event_uid,
        "evidence_manifest.json",
        &evidence_manifest_bytes,
    )?;
    let archive_refs = UsgsArchiveRefs {
        raw: raw_refs,
        affected_cells_ref,
        evidence_manifest_ref,
    };
    Ok(process_usgs_inner(input, Some(archive_refs))?)
}

fn process_usgs_inner(
    input: UsgsOracleInput,
    archive_refs: Option<UsgsArchiveRefs>,
) -> Result<OracleOutput, OracleError> {
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
            expected_payload: expected_payload.map(str::to_owned),
        };

    let Some(shakemap) = detail
        .properties
        .products
        .shakemap
        .as_ref()
        .and_then(|products| crate::source::usgs::select_preferred_shakemap_product(products))
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
    let points = parse_grid_points(grid_xml)?;
    if points.is_empty() {
        return Ok(status_only(base_result(
            OracleStatus::Rejected,
            Some("SHAKEMAP_PARSE_FAILED"),
            None,
        )));
    }

    let structured_grid = structured_grid_from_points(&points)?;
    let affected_cells = affected_cells_from_grid_centers(&structured_grid)?;
    if affected_cells.is_empty() {
        return Ok(status_only(base_result(
            OracleStatus::Rejected,
            Some("NO_AFFECTED_CELLS"),
            None,
        )));
    }

    let event_revision = 1;
    let verified_at_ms = input.observed_at_ms;
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
    let raw_grid_bytes = raw_grid_bytes_for_source(&input, grid_xml, &raw_grid_uri)?;
    let raw_data_manifest = raw_data_manifest(
        &detail.id,
        &input.raw_detail_uri,
        &input.detail_json,
        &raw_grid_uri,
        &raw_grid_bytes,
        archive_refs.as_ref().map(|refs| &refs.raw),
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
    let source_set_hash = sha256_bytes(&source_bytes);
    let raw_data_hash = sha256_bytes(&raw_bytes);
    let affected_cells_data_hash = sha256_bytes(&affected_bytes);
    let leaf_hashes = leaf_hashes(&affected_artifact, event_uid_bytes)?;
    let affected_cells_root =
        merkle_root_from_leaf_hashes(&leaf_hashes.iter().map(|item| item.1).collect::<Vec<_>>())
            .ok_or_else(|| OracleError::InvalidGridPoint("empty Merkle tree".to_owned()))?;
    let severity_band = affected_artifact
        .affected_cells
        .iter()
        .map(|cell| cell.cell_band)
        .max()
        .unwrap_or(0);

    let freshness_deadline_ms =
        verified_at_ms
            .checked_add(FRESHNESS_WINDOW_MS)
            .ok_or_else(|| {
                OracleError::Overflow("freshness_deadline_ms exceeds u64 range".to_owned())
            })?;

    let title = detail.properties.title.clone().ok_or_else(|| {
        OracleError::InvalidGridPoint("title is required for finalized payload".to_owned())
    })?;
    let region = detail.properties.region.clone().ok_or_else(|| {
        OracleError::InvalidGridPoint("region is required for finalized payload".to_owned())
    })?;
    let affected_cells_ref = archive_refs
        .as_ref()
        .map(|refs| refs.affected_cells_ref.clone())
        .unwrap_or_else(|| StoredSourceRef {
            uri: example_artifact_uri(&detail.id, "affected_cells.json"),
            walrus_blob_id: String::new(),
            source_hash: to_hex(&affected_cells_data_hash),
            size_bytes: affected_bytes.len() as u64,
        });
    let evidence_manifest_uri = archive_refs
        .as_ref()
        .map(|refs| refs.evidence_manifest_ref.uri.clone())
        .unwrap_or_else(|| example_artifact_uri(&detail.id, "evidence_manifest.json"));

    let mut unsigned_payload = UnsignedPayload {
        intent: INTENT_SONARI_EARTHQUAKE_ORACLE,
        oracle_version: ORACLE_VERSION,
        event_uid: event_uid.clone(),
        event_revision,
        source_event_id: detail.id.clone(),
        title,
        region,
        occurred_at_ms: detail.properties.time,
        hazard_type: HAZARD_TYPE_EARTHQUAKE,
        status: ONCHAIN_STATUS_FINALIZED,
        severity_band,
        affected_cells_root: to_hex(&affected_cells_root),
        affected_cell_count: affected_artifact.affected_cells.len() as u64,
        evidence_manifest_uri,
        evidence_manifest_hash: String::new(),
        verified_at_ms,
        freshness_deadline_ms,
    };
    let evidence_manifest = evidence_manifest(
        &detail,
        &unsigned_payload,
        &raw_data_manifest,
        &affected_cells_ref,
        &to_hex(&affected_cells_data_hash),
        &to_hex(&affected_cells_root),
        affected_artifact.affected_cells.len() as u64,
    )?;
    let evidence_manifest_bytes = canonical_json_bytes(&evidence_manifest)?;
    let evidence_manifest_hash = sha256_bytes(&evidence_manifest_bytes);
    unsigned_payload.evidence_manifest_hash = to_hex(&evidence_manifest_hash);
    let unsigned_bcs_payload = payload_bcs_bytes(&unsigned_payload)?;
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
        evidence_manifest_hash: to_hex(&evidence_manifest_hash),
        unsigned_bcs_payload_hex: to_hex(&unsigned_bcs_payload),
    };
    let sample_proof = sample_proof(&leaf_hashes_json, affected_cells_root);

    Ok(OracleOutput {
        result: base_result(OracleStatus::Finalized, None, Some("unsigned_payload.json")),
        source_manifest: Some(source_manifest),
        raw_data_manifest: Some(raw_data_manifest),
        evidence_manifest: Some(evidence_manifest),
        affected_cells: Some(affected_artifact),
        affected_cells_ref: archive_refs
            .as_ref()
            .map(|refs| refs.affected_cells_ref.clone()),
        evidence_manifest_ref: archive_refs.map(|refs| refs.evidence_manifest_ref),
        expected_hashes: Some(expected_hashes),
        sample_proof,
        unsigned_payload: Some(unsigned_payload),
        unsigned_bcs_payload: Some(unsigned_bcs_payload),
        signature: None,
    })
}

pub fn process_usgs_from_worker_request(
    request: WorkerToTeeRequest,
    input: UsgsOracleInput,
) -> Result<OracleOutput, OracleError> {
    if request.hazard_type != HAZARD_TYPE_EARTHQUAKE
        || request.primary_source != PRIMARY_SOURCE_USGS
        || request.geo_resolution != GEO_RESOLUTION
    {
        return Err(OracleError::WorkerRequest(
            "request does not match the MVP oracle input contract".to_owned(),
        ));
    }

    let detail = parse_detail(&input.detail_json)?;
    if !detail_matches_source_event_id(&detail, &request.source_event_id) {
        return Err(OracleError::WorkerRequest(format!(
            "source_event_id {} does not match fetched USGS detail id {}",
            request.source_event_id, detail.id
        )));
    }

    process_usgs(input)
}

pub fn process_usgs_with_signer(
    input: UsgsOracleInput,
    signer: &impl PayloadSigner,
) -> Result<OracleOutput, OracleError> {
    let mut output = process_usgs(input)?;
    if let Some(payload) = output.unsigned_bcs_payload.as_ref() {
        output.signature = Some(signer.sign_payload(payload));
    }
    Ok(output)
}

fn status_only(result: ResultSummary) -> OracleOutput {
    OracleOutput {
        result,
        source_manifest: None,
        raw_data_manifest: None,
        evidence_manifest: None,
        affected_cells: None,
        affected_cells_ref: None,
        evidence_manifest_ref: None,
        expected_hashes: None,
        sample_proof: None,
        unsigned_payload: None,
        unsigned_bcs_payload: None,
        signature: None,
    }
}

#[derive(Debug, Clone)]
struct UsgsArchiveRefs {
    raw: UsgsRawArchiveRefs,
    affected_cells_ref: StoredSourceRef,
    evidence_manifest_ref: StoredSourceRef,
}

#[derive(Debug, Clone)]
struct UsgsRawArchiveRefs {
    detail_source_uri: String,
    detail_ref: StoredSourceRef,
    grid_source_uri: String,
    grid_ref: StoredSourceRef,
}

fn archive_generated_artifact(
    archive: &impl SourceArchive,
    event_uid: &str,
    file_name: &str,
    bytes: &[u8],
) -> Result<StoredSourceRef, SourceArchiveError> {
    let source_hash = to_hex(&sha256_bytes(bytes));
    archive.store_and_verify(
        &format!("sonari://earthquake/{event_uid}/{file_name}"),
        &source_hash,
        bytes,
    )
}

fn example_artifact_uri(source_event_id: &str, file_name: &str) -> String {
    format!("ipfs://sonari/examples/{source_event_id}/{file_name}")
}

fn evidence_manifest(
    detail: &UsgsDetail,
    payload: &UnsignedPayload,
    raw_data_manifest: &RawDataManifest,
    affected_cells_ref: &StoredSourceRef,
    affected_cells_hash: &str,
    affected_cells_root: &str,
    affected_cell_count: u64,
) -> Result<EvidenceManifest, OracleError> {
    let title = detail.properties.title.clone().ok_or_else(|| {
        OracleError::InvalidGridPoint("title is required for evidence manifest".to_owned())
    })?;
    let region = detail.properties.region.clone().ok_or_else(|| {
        OracleError::InvalidGridPoint("region is required for evidence manifest".to_owned())
    })?;
    let magnitude_x100 = detail.properties.magnitude_x100.ok_or_else(|| {
        OracleError::InvalidGridPoint("magnitude_x100 is required for evidence manifest".to_owned())
    })?;
    if !(1..=2000).contains(&magnitude_x100) {
        return Err(OracleError::InvalidGridPoint(
            "magnitude_x100 must be in 1..=2000".to_owned(),
        ));
    }
    let mut sources = raw_data_manifest
        .entries
        .iter()
        .map(|entry| EvidenceSource {
            source: entry.name.clone(),
            product: entry.product.clone(),
            source_uri: entry.source_uri.clone(),
            artifact_uri: entry.uri.clone(),
            content_hash: entry.content_hash.clone(),
            size_bytes: entry.size_bytes,
            source_updated_at_ms: detail.properties.updated,
        })
        .collect::<Vec<_>>();
    sources.sort_by(|left, right| {
        (
            &left.source,
            &left.product,
            &left.source_uri,
            &left.artifact_uri,
        )
            .cmp(&(
                &right.source,
                &right.product,
                &right.source_uri,
                &right.artifact_uri,
            ))
    });
    Ok(EvidenceManifest {
        schema_version: 1,
        oracle_version: ORACLE_VERSION,
        event_uid: payload.event_uid.clone(),
        event_revision: payload.event_revision,
        hazard_type: "EARTHQUAKE".to_owned(),
        source_event_id: payload.source_event_id.clone(),
        sources,
        earthquake: EarthquakeEvidence {
            title,
            region,
            occurred_at_ms: detail.properties.time,
            magnitude_x100,
            source_updated_at_ms: detail.properties.updated,
        },
        affected_cells: EvidenceAffectedCells {
            uri: affected_cells_ref.uri.clone(),
            hash: affected_cells_hash.to_owned(),
            root: affected_cells_root.to_owned(),
            count: affected_cell_count,
            geo_resolution: GEO_RESOLUTION,
        },
    })
}

fn source_manifest(detail: &UsgsDetail, shakemap: &UsgsShakeMapProduct) -> SourceManifest {
    let detail_url = format!(
        "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/{}.geojson",
        detail.id
    );
    let grid_url = crate::source::usgs::preferred_grid_uri(shakemap).unwrap_or("");
    let mut sources = vec![
        SourceEntry {
            name: "USGS".to_owned(),
            event_id: detail.id.clone(),
            product: "detail_geojson".to_owned(),
            product_version: "1".to_owned(),
            map_status: shakemap.properties.map_status.clone(),
            updated_at_ms: detail.properties.updated,
            url_hash: to_hex(&sha256_bytes(detail_url.as_bytes())),
        },
        SourceEntry {
            name: "USGS".to_owned(),
            event_id: detail.id.clone(),
            product: "shakemap_grid_xml".to_owned(),
            product_version: shakemap.properties.version.clone(),
            map_status: shakemap.properties.map_status.clone(),
            updated_at_ms: detail.properties.updated,
            url_hash: to_hex(&sha256_bytes(grid_url.as_bytes())),
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
    archive_refs: Option<&UsgsRawArchiveRefs>,
) -> RawDataManifest {
    let detail_hash = to_hex(&sha256_bytes(detail_bytes));
    let grid_hash = to_hex(&sha256_bytes(grid_bytes));
    let mut entries = vec![
        raw_data_entry(
            event_id,
            "detail_geojson",
            detail_uri,
            &detail_hash,
            archive_refs.map(|refs| (&refs.detail_source_uri, &refs.detail_ref)),
            detail_bytes.len() as u64,
        ),
        raw_data_entry(
            event_id,
            "shakemap_grid_xml",
            grid_uri,
            &grid_hash,
            archive_refs.map(|refs| (&refs.grid_source_uri, &refs.grid_ref)),
            grid_bytes.len() as u64,
        ),
    ];
    entries.sort_by(|a, b| {
        (&a.name, &a.event_id, &a.product, &a.uri).cmp(&(&b.name, &b.event_id, &b.product, &b.uri))
    });
    RawDataManifest {
        entries,
        oracle_version: ORACLE_VERSION,
    }
}

fn raw_grid_bytes_for_source(
    input: &UsgsOracleInput,
    grid_xml: &[u8],
    raw_grid_uri: &str,
) -> Result<Vec<u8>, OracleError> {
    if let Some(raw_grid_bytes) = input.raw_grid_bytes.as_ref() {
        let derived_grid_xml = grid_xml_from_artifact(raw_grid_uri, raw_grid_bytes)?;
        if derived_grid_xml != grid_xml {
            return Err(OracleError::InvalidGridPoint(
                "raw_grid_bytes does not match grid_xml".to_owned(),
            ));
        }
        return Ok(raw_grid_bytes.clone());
    }
    if raw_grid_uri.ends_with(".zip") {
        return Err(OracleError::InvalidGridPoint(
            "raw_grid_bytes is required when raw_grid_uri points to a zip artifact".to_owned(),
        ));
    }
    Ok(grid_xml.to_vec())
}

fn raw_data_entry(
    event_id: &str,
    product: &str,
    uri: &str,
    content_hash: &str,
    archived: Option<(&String, &StoredSourceRef)>,
    size_bytes: u64,
) -> RawDataEntry {
    if let Some((source_uri, stored)) = archived {
        return RawDataEntry {
            name: "USGS".to_owned(),
            event_id: event_id.to_owned(),
            product: product.to_owned(),
            uri: stored.uri.clone(),
            content_hash: content_hash.to_owned(),
            source_uri: source_uri.clone(),
            walrus_blob_id: stored.walrus_blob_id.clone(),
            source_hash: stored.source_hash.clone(),
            size_bytes: stored.size_bytes,
        };
    }
    RawDataEntry {
        name: "USGS".to_owned(),
        event_id: event_id.to_owned(),
        product: product.to_owned(),
        uri: uri.to_owned(),
        content_hash: content_hash.to_owned(),
        source_uri: uri.to_owned(),
        walrus_blob_id: String::new(),
        source_hash: content_hash.to_owned(),
        size_bytes,
    }
}
