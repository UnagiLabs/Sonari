use ed25519_dalek::{Signer, SigningKey};
use h3o::{LatLng, Resolution};
use quick_xml::Reader;
use quick_xml::events::Event;
use serde::{Deserialize, Serialize};
use sha3::{Digest, Sha3_256};
use std::collections::{BTreeMap, HashMap};
use thiserror::Error;

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

const CELLS_GENERATION_METHOD_NAME: &str = "shakemap_gridxml_h3_grid_point_p90_v1";
const CELL_METRIC_NAME: &str = "USGS_MMI";
const CELL_AGGREGATION_NAME: &str = "GRID_POINT_P90";
const INTENSITY_SCALE_NAME: &str = "MMI_X100";

#[derive(Debug, Error)]
pub enum OracleError {
    #[error("invalid USGS detail JSON: {0}")]
    DetailJson(#[from] serde_json::Error),
    #[error("invalid ShakeMap grid XML: {0}")]
    GridXml(#[from] quick_xml::Error),
    #[error("invalid UTF-8 in ShakeMap grid XML: {0}")]
    GridUtf8(#[from] std::str::Utf8Error),
    #[error("invalid grid point: {0}")]
    InvalidGridPoint(String),
    #[error("invalid MMI decimal: {0}")]
    InvalidMmi(String),
    #[error("invalid coordinate")]
    InvalidCoordinate,
    #[error("BCS serialization failed: {0}")]
    Bcs(#[from] bcs::Error),
}

#[derive(Debug, Clone)]
pub struct UsgsOracleInput {
    pub case_id: String,
    pub detail_json: Vec<u8>,
    pub grid_xml: Option<Vec<u8>>,
    pub raw_detail_uri: String,
    pub raw_grid_uri: Option<String>,
    pub raw_data_uri: String,
    pub affected_cells_uri: String,
    pub signing_key_seed: [u8; 32],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OracleStatus {
    Finalized,
    PendingSource,
    PendingMmi,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResultSummary {
    pub case_id: String,
    pub status: OracleStatus,
    pub source_event_id: String,
    pub hazard_type: String,
    pub primary_source: String,
    pub geo_resolution: u8,
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_retry_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_payload: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SourceManifest {
    pub sources: Vec<SourceEntry>,
    pub cells_generation_method: String,
    pub oracle_version: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SourceEntry {
    pub name: String,
    pub event_id: String,
    pub product: String,
    pub product_version: String,
    pub map_status: String,
    pub updated_at_ms: u64,
    pub url_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RawDataManifest {
    pub entries: Vec<RawDataEntry>,
    pub oracle_version: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RawDataEntry {
    pub name: String,
    pub event_id: String,
    pub product: String,
    pub uri: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AffectedCellsArtifact {
    pub event_uid: String,
    pub event_revision: u32,
    pub oracle_version: u64,
    pub geo_resolution: u8,
    pub cells_generation_method: String,
    pub cell_metric: String,
    pub cell_aggregation: String,
    pub intensity_scale: String,
    pub affected_cells: Vec<AffectedCellJson>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AffectedCellJson {
    pub h3_index: String,
    pub intensity_value: u16,
    pub cell_band: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UnsignedPayloadV1 {
    pub intent: u8,
    pub oracle_version: u64,
    pub event_uid: String,
    pub hazard_type: u8,
    pub status: u8,
    pub event_revision: u32,
    pub occurred_at_ms: u64,
    pub observed_at_ms: u64,
    pub source_updated_at_ms: u64,
    pub primary_source: u8,
    pub severity_band: u8,
    pub source_set_hash: String,
    pub raw_data_hash: String,
    pub raw_data_uri: String,
    pub affected_cells_root: String,
    pub affected_cells_uri: String,
    pub affected_cells_data_hash: String,
    pub geo_resolution: u8,
    pub cells_generation_method: u8,
    pub cell_metric: u8,
    pub cell_aggregation: u8,
    pub intensity_scale: u8,
    pub max_cell_band: u8,
    pub affected_cell_count: u64,
    pub min_claim_band: u8,
    pub freshness_deadline_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExpectedHashes {
    pub event_uid: String,
    pub source_set_hash: String,
    pub raw_data_hash: String,
    pub raw_source_content_hashes: Vec<RawSourceContentHash>,
    pub affected_cells_data_hash: String,
    pub leaf_hashes: Vec<LeafHash>,
    pub affected_cells_root: String,
    pub unsigned_bcs_payload_hex: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RawSourceContentHash {
    pub uri: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LeafHash {
    pub h3_index: String,
    pub leaf_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SignatureArtifact {
    pub algorithm: String,
    pub public_key: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SampleProof {
    pub target_leaf: LeafHash,
    pub proof: Vec<ProofStep>,
    pub expected_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProofStep {
    pub direction: String,
    pub sibling_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OracleOutput {
    pub result: ResultSummary,
    pub source_manifest: Option<SourceManifest>,
    pub raw_data_manifest: Option<RawDataManifest>,
    pub affected_cells: Option<AffectedCellsArtifact>,
    pub expected_hashes: Option<ExpectedHashes>,
    pub sample_proof: Option<SampleProof>,
    pub unsigned_payload: Option<UnsignedPayloadV1>,
    pub unsigned_bcs_payload: Option<Vec<u8>>,
    pub signature: Option<SignatureArtifact>,
}

#[derive(Debug, Deserialize)]
struct UsgsDetail {
    id: String,
    properties: UsgsProperties,
}

#[derive(Debug, Deserialize)]
struct UsgsProperties {
    time: u64,
    updated: u64,
    products: UsgsProducts,
}

#[derive(Debug, Deserialize)]
struct UsgsProducts {
    shakemap: Option<Vec<UsgsShakeMapProduct>>,
}

#[derive(Debug, Deserialize)]
struct UsgsShakeMapProduct {
    properties: UsgsShakeMapProperties,
    #[serde(default)]
    contents: HashMap<String, UsgsContent>,
}

#[derive(Debug, Deserialize)]
struct UsgsShakeMapProperties {
    #[serde(rename = "map-status")]
    map_status: String,
    version: String,
}

#[derive(Debug, Deserialize)]
struct UsgsContent {
    url: String,
}

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

pub fn process_usgs(input: UsgsOracleInput) -> Result<OracleOutput, OracleError> {
    let detail: UsgsDetail = serde_json::from_slice(&input.detail_json)?;
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
    let signature = sign_payload(&unsigned_bcs_payload, input.signing_key_seed);
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct GridPoint {
    lon: String,
    lat: String,
    mmi_x100: u16,
}

fn parse_grid_points(grid_xml: &[u8]) -> Result<Vec<GridPoint>, OracleError> {
    let mut reader = Reader::from_reader(grid_xml);
    reader.config_mut().trim_text(true);
    let mut inside_grid_data = false;
    let mut grid_text = String::new();
    loop {
        match reader.read_event()? {
            Event::Start(event) if event.name().as_ref() == b"grid_data" => {
                inside_grid_data = true;
            }
            Event::End(event) if event.name().as_ref() == b"grid_data" => {
                inside_grid_data = false;
            }
            Event::Text(text) if inside_grid_data => {
                let decoded = text
                    .decode()
                    .map_err(|err| OracleError::InvalidGridPoint(err.to_string()))?;
                grid_text.push_str(decoded.as_ref());
            }
            Event::Eof => break,
            _ => {}
        }
    }

    let tokens = grid_text.split_whitespace().collect::<Vec<_>>();
    if tokens.is_empty() {
        return Ok(Vec::new());
    }
    if tokens.len() % 3 != 0 {
        return Err(OracleError::InvalidGridPoint(
            "grid_data must contain lon lat mmi triples".to_owned(),
        ));
    }
    tokens
        .chunks_exact(3)
        .map(|chunk| {
            let lon = chunk[0].parse::<f64>().map_err(|_| {
                OracleError::InvalidGridPoint(format!("invalid longitude {}", chunk[0]))
            })?;
            let lat = chunk[1].parse::<f64>().map_err(|_| {
                OracleError::InvalidGridPoint(format!("invalid latitude {}", chunk[1]))
            })?;
            if !lon.is_finite() || !lat.is_finite() {
                return Err(OracleError::InvalidGridPoint(
                    "coordinates must be finite".to_owned(),
                ));
            }
            Ok(GridPoint {
                lon: chunk[0].to_owned(),
                lat: chunk[1].to_owned(),
                mmi_x100: mmi_decimal_to_x100(chunk[2])?,
            })
        })
        .collect()
}

pub fn mmi_decimal_to_x100(input: &str) -> Result<u16, OracleError> {
    let value = input.trim();
    if value.is_empty() {
        return Err(OracleError::InvalidMmi(input.to_owned()));
    }
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(OracleError::InvalidMmi(input.to_owned()));
    }
    let whole = whole
        .parse::<u32>()
        .map_err(|_| OracleError::InvalidMmi(input.to_owned()))?;
    let mut digits = fraction.bytes().map(|byte| byte - b'0');
    let first = digits.next().unwrap_or(0) as u32;
    let second = digits.next().unwrap_or(0) as u32;
    let third = digits.next().unwrap_or(0);
    let rounded = whole
        .checked_mul(100)
        .and_then(|base| base.checked_add(first * 10 + second))
        .and_then(|base| base.checked_add(u32::from(third >= 5)))
        .ok_or_else(|| OracleError::InvalidMmi(input.to_owned()))?;
    u16::try_from(rounded).map_err(|_| OracleError::InvalidMmi(input.to_owned()))
}

fn affected_cells_from_points(points: &[GridPoint]) -> Result<Vec<AffectedCellJson>, OracleError> {
    let mut grouped = BTreeMap::<u64, Vec<u16>>::new();
    for point in points {
        let lon = point.lon.parse::<f64>().map_err(|_| {
            OracleError::InvalidGridPoint(format!("invalid longitude {}", point.lon))
        })?;
        let lat = point.lat.parse::<f64>().map_err(|_| {
            OracleError::InvalidGridPoint(format!("invalid latitude {}", point.lat))
        })?;
        let cell = LatLng::new(lat, lon)
            .map_err(|_| OracleError::InvalidCoordinate)?
            .to_cell(Resolution::Seven);
        grouped
            .entry(u64::from(cell))
            .or_default()
            .push(point.mmi_x100);
    }

    let mut affected = Vec::new();
    for (h3_index, values) in grouped {
        let Some(intensity_value) = p90_x100(&values) else {
            continue;
        };
        let band = cell_band(intensity_value);
        if band >= MIN_CLAIM_BAND {
            affected.push(AffectedCellJson {
                h3_index: h3_index.to_string(),
                intensity_value,
                cell_band: band,
            });
        }
    }
    Ok(affected)
}

pub fn p90_x100(values: &[u16]) -> Option<u16> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let rank = (sorted.len() * 90).div_ceil(100) - 1;
    sorted.get(rank).copied()
}

pub const fn cell_band(mmi_x100: u16) -> u8 {
    match mmi_x100 {
        0..=699 => 0,
        700..=799 => 1,
        800..=899 => 2,
        _ => 3,
    }
}

fn leaf_hashes(
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

pub fn merkle_root_from_leaf_hashes(leaf_hashes: &[[u8; 32]]) -> Option<[u8; 32]> {
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
                next.push(sha3_256_bytes(&data));
            }
        }
        level = next;
    }
    level.first().copied()
}

fn sample_proof(leaf_hashes: &[LeafHash], expected_root: [u8; 32]) -> Option<SampleProof> {
    if leaf_hashes.is_empty() {
        return None;
    }
    let target_index = usize::from(leaf_hashes.len() > 1);
    let mut proof = Vec::new();
    if leaf_hashes.len() > 1 {
        let sibling_index = if target_index == 0 { 1 } else { 0 };
        proof.push(ProofStep {
            direction: if sibling_index < target_index {
                "LEFT".to_owned()
            } else {
                "RIGHT".to_owned()
            },
            sibling_hash: leaf_hashes[sibling_index].leaf_hash.clone(),
        });
    }
    Some(SampleProof {
        target_leaf: leaf_hashes[target_index].clone(),
        proof,
        expected_root: to_hex(&expected_root),
    })
}

fn payload_bcs_bytes(payload: &UnsignedPayloadV1) -> Result<Vec<u8>, OracleError> {
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

fn sign_payload(payload: &[u8], seed: [u8; 32]) -> SignatureArtifact {
    let signing_key = SigningKey::from_bytes(&seed);
    let verifying_key = signing_key.verifying_key();
    let signature = signing_key.sign(payload);
    SignatureArtifact {
        algorithm: "Ed25519".to_owned(),
        public_key: to_hex(&verifying_key.to_bytes()),
        signature: to_hex(&signature.to_bytes()),
    }
}

fn event_uid_bytes(
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

pub fn sha3_256_bytes(data: &[u8]) -> [u8; 32] {
    Sha3_256::digest(data).into()
}

pub fn canonical_json_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, OracleError> {
    serde_json::to_vec(value).map_err(OracleError::from)
}

fn to_hex(data: &[u8]) -> String {
    format!("0x{}", hex::encode(data))
}

fn hex_to_32(value: &str) -> Result<[u8; 32], OracleError> {
    let hex_value = value.strip_prefix("0x").ok_or_else(|| {
        OracleError::InvalidGridPoint(format!("expected 0x-prefixed hex: {value}"))
    })?;
    let bytes = hex::decode(hex_value)
        .map_err(|_| OracleError::InvalidGridPoint(format!("invalid hex: {value}")))?;
    bytes
        .try_into()
        .map_err(|_| OracleError::InvalidGridPoint(format!("expected 32-byte hex: {value}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    use std::fs;
    use std::path::Path;

    const FIXTURE_DIR: &str = "../fixtures/usgs/finalized_minimal";
    const SIGNING_KEY_SEED: [u8; 32] = [7; 32];

    fn read_fixture(path: impl AsRef<Path>) -> Vec<u8> {
        fs::read(path).expect("fixture should be readable")
    }

    fn finalized_input() -> UsgsOracleInput {
        UsgsOracleInput {
            case_id: "usgs/finalized_minimal".to_owned(),
            detail_json: read_fixture(format!("{FIXTURE_DIR}/input/usgs_detail.json")),
            grid_xml: Some(read_fixture(format!("{FIXTURE_DIR}/input/usgs_grid.xml"))),
            raw_detail_uri:
                "nautilus_disaster_oracle/fixtures/usgs/finalized_minimal/input/usgs_detail.json"
                    .to_owned(),
            raw_grid_uri: Some(
                "nautilus_disaster_oracle/fixtures/usgs/finalized_minimal/input/usgs_grid.xml"
                    .to_owned(),
            ),
            raw_data_uri: "ipfs://sonari/examples/us7000sonari/raw_data_manifest.json".to_owned(),
            affected_cells_uri: "ipfs://sonari/examples/us7000sonari/affected_cells.json"
                .to_owned(),
            signing_key_seed: SIGNING_KEY_SEED,
        }
    }

    fn read_expected(name: &str) -> serde_json::Value {
        serde_json::from_slice(&read_fixture(format!("{FIXTURE_DIR}/expected/{name}")))
            .expect("expected fixture should be valid JSON")
    }

    #[test]
    fn pins_bcs_numeric_enums_to_typescript_contract() {
        assert_eq!(INTENT_SONARI_EARTHQUAKE_ORACLE, 1);
        assert_eq!(HAZARD_TYPE_EARTHQUAKE, 1);
        assert_eq!(ONCHAIN_STATUS_FINALIZED, 3);
        assert_eq!(PRIMARY_SOURCE_USGS, 1);
        assert_eq!(
            CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1,
            1
        );
        assert_eq!(CELL_METRIC_USGS_MMI, 1);
        assert_eq!(CELL_AGGREGATION_GRID_POINT_P90, 1);
        assert_eq!(INTENSITY_SCALE_MMI_X100, 1);
    }

    #[test]
    fn pins_mvp_default_contract_values() {
        assert_eq!(ORACLE_VERSION, 1);
        assert_eq!(GEO_RESOLUTION, 7);
        assert_eq!(MIN_CLAIM_BAND, 1);
    }

    #[test]
    fn converts_mmi_decimal_strings_to_x100_deterministically() {
        assert_eq!(mmi_decimal_to_x100("7").unwrap(), 700);
        assert_eq!(mmi_decimal_to_x100("7.2").unwrap(), 720);
        assert_eq!(mmi_decimal_to_x100("7.234").unwrap(), 723);
        assert_eq!(mmi_decimal_to_x100("7.235").unwrap(), 724);
        assert_eq!(mmi_decimal_to_x100("0.005").unwrap(), 1);
    }

    #[test]
    fn computes_p90_band_and_merkle_with_odd_leaf_promotion() {
        assert_eq!(p90_x100(&[700]), Some(700));
        assert_eq!(
            p90_x100(&[700, 710, 720, 730, 740, 750, 760, 770, 780, 790]),
            Some(780)
        );
        assert_eq!(cell_band(699), 0);
        assert_eq!(cell_band(700), 1);
        assert_eq!(cell_band(800), 2);
        assert_eq!(cell_band(900), 3);

        let leaves = vec![[1_u8; 32], [2_u8; 32], [3_u8; 32]];
        let promoted_root = merkle_root_from_leaf_hashes(&leaves).expect("non-empty tree");
        let mut left_data = Vec::new();
        left_data.push(0x01);
        left_data.extend_from_slice(&leaves[0]);
        left_data.extend_from_slice(&leaves[1]);
        let left = sha3_256_bytes(&left_data);
        let mut root_data = Vec::new();
        root_data.push(0x01);
        root_data.extend_from_slice(&left);
        root_data.extend_from_slice(&leaves[2]);
        let expected = sha3_256_bytes(&root_data);
        assert_eq!(promoted_root, expected);
    }

    #[test]
    fn finalized_fixture_matches_expected_hashes_payload_and_signature() {
        let output = process_usgs(finalized_input()).expect("fixture should finalize");

        assert_eq!(output.result.status, OracleStatus::Finalized);
        assert_eq!(output.result.error_code, None);
        assert!(output.unsigned_bcs_payload.is_some());
        assert!(output.signature.is_some());

        assert_eq!(
            serde_json::to_value(output.raw_data_manifest).unwrap(),
            read_expected("raw_data_manifest.json")
        );
        assert_eq!(
            serde_json::to_value(output.affected_cells).unwrap(),
            read_expected("affected_cells.json")
        );
        assert_eq!(
            serde_json::to_value(output.unsigned_payload).unwrap(),
            read_expected("unsigned_payload_v1.json")
        );
        assert_eq!(
            serde_json::to_value(output.expected_hashes).unwrap(),
            read_expected("expected_hashes.json")
        );

        let signature_artifact = output.signature.expect("signature should exist");
        let public_key: [u8; 32] =
            hex::decode(signature_artifact.public_key.trim_start_matches("0x"))
                .unwrap()
                .try_into()
                .unwrap();
        let signature: [u8; 64] =
            hex::decode(signature_artifact.signature.trim_start_matches("0x"))
                .unwrap()
                .try_into()
                .unwrap();
        VerifyingKey::from_bytes(&public_key)
            .unwrap()
            .verify(
                output.unsigned_bcs_payload.as_ref().unwrap(),
                &Signature::from_bytes(&signature),
            )
            .unwrap();
    }

    #[test]
    fn non_finalized_fixtures_do_not_emit_payloads_or_signatures() {
        for (case_id, expected_status, expected_error) in [
            (
                "usgs/pending_source_no_shakemap",
                OracleStatus::PendingSource,
                Some("SHAKEMAP_PRODUCT_MISSING"),
            ),
            (
                "usgs/pending_mmi_empty_grid",
                OracleStatus::PendingMmi,
                Some("MMI_NOT_AVAILABLE"),
            ),
            (
                "usgs/rejected_cancelled_shakemap",
                OracleStatus::Rejected,
                Some("SHAKEMAP_CANCELLED"),
            ),
            (
                "usgs/rejected_no_affected_cells",
                OracleStatus::Rejected,
                Some("NO_AFFECTED_CELLS"),
            ),
        ] {
            let dir = format!("../fixtures/{case_id}");
            let grid_path = format!("{dir}/input/usgs_grid.xml");
            let output = process_usgs(UsgsOracleInput {
                case_id: case_id.to_owned(),
                detail_json: read_fixture(format!("{dir}/input/usgs_detail.json")),
                grid_xml: Path::new(&grid_path)
                    .exists()
                    .then(|| read_fixture(&grid_path)),
                raw_detail_uri: format!(
                    "nautilus_disaster_oracle/fixtures/{case_id}/input/usgs_detail.json"
                ),
                raw_grid_uri: Path::new(&grid_path).exists().then(|| {
                    format!("nautilus_disaster_oracle/fixtures/{case_id}/input/usgs_grid.xml")
                }),
                raw_data_uri: String::new(),
                affected_cells_uri: String::new(),
                signing_key_seed: SIGNING_KEY_SEED,
            })
            .expect("non-finalized cases should return status output");

            assert_eq!(output.result.status, expected_status);
            assert_eq!(output.result.error_code.as_deref(), expected_error);
            assert_eq!(output.result.next_retry_at_ms, None);
            assert!(output.unsigned_payload.is_none());
            assert!(output.unsigned_bcs_payload.is_none());
            assert!(output.signature.is_none());
            assert!(output.raw_data_manifest.is_none());
            assert!(output.affected_cells.is_none());
        }
    }
}
