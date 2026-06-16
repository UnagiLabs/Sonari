//! Earthquake-specific [`ProcessDataHandler`] and result assembly.
//!
//! The handler owns the earthquake domain logic only: it parses the Worker to
//! TEE request, fetches USGS detail / ShakeMap grid, builds the canonical
//! payload, and produces the unsigned BCS payload bytes plus the result
//! envelope. It never signs, attests, performs registration injection, or
//! touches VSOCK/HTTP transport; those concerns belong to the shared server in
//! `sonari_tee_core::enclave` and the orchestration in `main.rs`.

use crate::core::artifacts::{
    AffectedCellsArtifact, EvidenceManifest, RawDataManifest, StoredSourceRef, UnsignedPayload,
};
use crate::{
    OracleOutput, OracleStatus, UsgsOracleInput, WalrusCliSourceArchive,
    WalrusCliSourceArchiveConfig, WorkerToTeeRequest, grid_xml_from_artifact,
    process_usgs_archived_with_event_revision, process_usgs_from_worker_request,
};
use serde::Serialize;
use sonari_tee_core::{HandlerError, ProcessDataHandler, ProcessOutput, TeeContext};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Egress proxy URL configuration key resolved by the shared server.
pub const EGRESS_PROXY_URL_KEY: &str = "SONARI_EARTHQUAKE_EGRESS_PROXY_URL";

/// Maximum time spent on a single upstream USGS / ShakeMap fetch.
///
/// 大規模地震の grid.xml は最大約 29MiB に達する。30 秒では大容量取得が途中で
/// 打ち切られる恐れがあるため、余裕をもって 90 秒に設定する。
const PRODUCTION_FETCH_TIMEOUT_MS: u64 = 90_000;

/// Placeholder string the handler writes into `signature` / `public_key`.
///
/// The shared server signs `payload_bcs` and overwrites these placeholders in
/// place; because `serde_json` preserves key order, overwriting an existing key
/// keeps the field at its canonical position so the response stays byte-stable.
pub const UNSIGNED_PLACEHOLDER: &str = "";

/// Result envelope returned by the enclave `process_data` route.
///
/// This mirrors the historical wire shape exactly. For finalized results the
/// `signature` / `public_key` fields carry [`UNSIGNED_PLACEHOLDER`] until the
/// server signs `payload_bcs`.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum TeeJsonResult {
    PendingSource {
        source_event_id: String,
        error_code: &'static str,
    },
    PendingMmi {
        source_event_id: String,
        error_code: String,
    },
    Rejected {
        source_event_id: String,
        error_code: String,
    },
    Finalized {
        payload: Box<UnsignedPayload>,
        payload_bcs_hex: String,
        signature: String,
        public_key: String,
        raw_data_manifest: RawDataManifest,
        affected_cells: Box<AffectedCellsArtifact>,
        evidence_manifest: Box<EvidenceManifest>,
        #[serde(skip_serializing_if = "Option::is_none")]
        affected_cells_ref: Option<Box<StoredSourceRef>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        evidence_manifest_ref: Option<Box<StoredSourceRef>>,
    },
}

/// Earthquake verifier request handler.
///
/// Implements the shared [`ProcessDataHandler`] contract by running the USGS /
/// ShakeMap verification pipeline and emitting the unsigned BCS payload. It
/// carries no signing key, attestation logic, or transport state.
///
/// The Walrus source-archive configuration is resolved once in the orchestration
/// layer (`main.rs`) and injected at construction; the handler never reads the
/// process environment during `process` (the egress proxy still arrives through
/// [`TeeContext`]). This keeps env access confined to bootstrap/orchestration.
#[derive(Debug, Clone, Default)]
pub struct EarthquakeProcessHandler {
    archive_config: Option<WalrusCliSourceArchiveConfig>,
}

impl EarthquakeProcessHandler {
    /// Builds a handler without an injected Walrus archive configuration.
    ///
    /// Finalized requests require an archive configuration; use
    /// [`EarthquakeProcessHandler::with_archive_config`] for the server path.
    pub fn new() -> Self {
        Self {
            archive_config: None,
        }
    }

    /// Builds a handler with the orchestration-resolved Walrus archive config.
    pub fn with_archive_config(archive_config: WalrusCliSourceArchiveConfig) -> Self {
        Self {
            archive_config: Some(archive_config),
        }
    }
}

impl ProcessDataHandler for EarthquakeProcessHandler {
    fn process(&self, input: &[u8], ctx: &TeeContext) -> Result<ProcessOutput, HandlerError> {
        let payload: serde_json::Value =
            serde_json::from_slice(input).map_err(|error| process_failed(error.to_string()))?;
        let request = WorkerToTeeRequest::from_json_value(payload)
            .map_err(|error| process_failed(error.to_string()))?;
        let output = run_earthquake_pipeline(request, ctx, self.archive_config.as_ref())?;
        process_output_from_oracle(output)
    }
}

/// Converts an [`OracleOutput`] into the [`ProcessOutput`] returned to the server.
///
/// Finalized results become a [`ProcessOutput::Signable`] carrying the canonical
/// unsigned BCS payload the server must sign; a finalized output without those
/// bytes is rejected (fail-closed) so the server can never emit an unsigned 200
/// for a finalized result. Non-finalized results become a
/// [`ProcessOutput::Unsigned`] envelope that is returned verbatim.
pub fn process_output_from_oracle(output: OracleOutput) -> Result<ProcessOutput, HandlerError> {
    let is_finalized = output.result.status == OracleStatus::Finalized;
    let payload_bcs = output.unsigned_bcs_payload.clone();
    let result = output_to_tee_json(output)?;
    let result_json =
        serde_json::to_value(&result).map_err(|error| process_failed(error.to_string()))?;
    if is_finalized {
        let payload_bcs = payload_bcs
            .filter(|bytes| !bytes.is_empty())
            .ok_or_else(|| {
                process_failed("finalized output is missing the unsigned BCS payload to sign")
            })?;
        Ok(ProcessOutput::signable(payload_bcs, result_json))
    } else {
        Ok(ProcessOutput::unsigned(result_json))
    }
}

fn run_earthquake_pipeline(
    request: WorkerToTeeRequest,
    ctx: &TeeContext,
    archive_config: Option<&WalrusCliSourceArchiveConfig>,
) -> Result<OracleOutput, HandlerError> {
    let detail_url = usgs_detail_url(&request.source_event_id);
    let client = production_http_client(ctx).map_err(|error| process_failed(error.to_string()))?;
    let detail_json = match fetch_bytes(&client, &detail_url) {
        Ok(bytes) => bytes,
        Err(_) => return pending_source(&request.source_event_id, "USGS_DETAIL_UNAVAILABLE"),
    };
    let detail_value: serde_json::Value = match serde_json::from_slice(&detail_json) {
        Ok(value) => value,
        Err(_) => return pending_source(&request.source_event_id, "USGS_DETAIL_UNAVAILABLE"),
    };
    let Some(canonical_source_event_id) =
        canonical_usgs_detail_id_for_request(&detail_value, &request.source_event_id)
    else {
        return pending_source(&request.source_event_id, "USGS_DETAIL_UNAVAILABLE");
    };

    let grid = match preferred_grid_uri_from_detail(&detail_value) {
        Some(uri) => match fetch_grid(&client, &uri) {
            Ok(grid) => Some(grid),
            Err(_) => return pending_source(&request.source_event_id, "SHAKEMAP_GRID_UNAVAILABLE"),
        },
        None => None,
    };
    let source_event_id = canonical_source_event_id.to_owned();
    let observed_at_ms =
        current_unix_time_ms().map_err(|error| process_failed(error.to_string()))?;
    let parts = ProductionInputParts {
        source_event_id,
        detail_json,
        grid_xml: grid.as_ref().map(|item| item.grid_xml.clone()),
        raw_grid_bytes: grid.as_ref().map(|item| item.raw_grid_bytes.clone()),
        raw_grid_uri: grid.as_ref().map(|item| item.raw_grid_uri.clone()),
    };
    let input = build_production_input(parts, observed_at_ms);
    let event_revision = request.event_revision;
    let preliminary = process_usgs_from_worker_request(request, input.clone())
        .map_err(|error| process_failed(error.to_string()))?;
    if preliminary.result.status != OracleStatus::Finalized {
        return Ok(preliminary);
    }

    let archive_config = archive_config.cloned().ok_or_else(|| {
        process_failed("finalized request requires an injected Walrus archive configuration")
    })?;
    let archive = WalrusCliSourceArchive::new(archive_config)
        .map_err(|error| process_failed(error.to_string()))?;
    process_usgs_archived_with_event_revision(input, event_revision, &archive)
        .map_err(|error| process_failed(error.to_string()))
}

fn pending_source(source_event_id: &str, error_code: &str) -> Result<OracleOutput, HandlerError> {
    // Use the existing OracleOutput pending mapping by constructing the pending
    // result directly; the JSON shape is produced by output_to_tee_json.
    Ok(OracleOutput {
        result: crate::ResultSummary {
            case_id: format!("usgs-live/{source_event_id}"),
            status: OracleStatus::PendingSource,
            source_event_id: source_event_id.to_owned(),
            hazard_type: "EARTHQUAKE".to_owned(),
            primary_source: "USGS".to_owned(),
            geo_resolution: crate::GEO_RESOLUTION,
            error_code: Some(error_code.to_owned()),
            expected_payload: None,
        },
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
    })
}

/// Maps an [`OracleOutput`] into the unsigned [`TeeJsonResult`] envelope.
pub fn output_to_tee_json(output: OracleOutput) -> Result<TeeJsonResult, HandlerError> {
    match output.result.status {
        OracleStatus::Finalized => {
            let payload = output
                .unsigned_payload
                .ok_or_else(|| process_failed("finalized output is missing unsigned payload"))?;
            let payload_bcs_hex = output
                .expected_hashes
                .ok_or_else(|| process_failed("finalized output is missing expected hashes"))?
                .unsigned_bcs_payload_hex;
            let raw_data_manifest = output
                .raw_data_manifest
                .ok_or_else(|| process_failed("finalized output is missing raw data manifest"))?;
            let affected_cells = output
                .affected_cells
                .ok_or_else(|| process_failed("finalized output is missing affected cells"))?;
            let evidence_manifest = output
                .evidence_manifest
                .ok_or_else(|| process_failed("finalized output is missing evidence manifest"))?;
            Ok(TeeJsonResult::Finalized {
                payload: Box::new(payload),
                payload_bcs_hex,
                signature: UNSIGNED_PLACEHOLDER.to_owned(),
                public_key: UNSIGNED_PLACEHOLDER.to_owned(),
                raw_data_manifest,
                affected_cells: Box::new(affected_cells),
                evidence_manifest: Box::new(evidence_manifest),
                affected_cells_ref: output.affected_cells_ref.map(Box::new),
                evidence_manifest_ref: output.evidence_manifest_ref.map(Box::new),
            })
        }
        OracleStatus::PendingSource => Ok(TeeJsonResult::PendingSource {
            source_event_id: output.result.source_event_id,
            error_code: static_error_code(output.result.error_code)?,
        }),
        OracleStatus::PendingMmi => Ok(TeeJsonResult::PendingMmi {
            source_event_id: output.result.source_event_id,
            error_code: output
                .result
                .error_code
                .ok_or_else(|| process_failed("pending_mmi requires error_code"))?,
        }),
        OracleStatus::Rejected => Ok(TeeJsonResult::Rejected {
            source_event_id: output.result.source_event_id,
            error_code: output
                .result
                .error_code
                .ok_or_else(|| process_failed("rejected requires error_code"))?,
        }),
    }
}

fn static_error_code(value: Option<String>) -> Result<&'static str, HandlerError> {
    match value.as_deref() {
        Some("SHAKEMAP_PRODUCT_MISSING") => Ok("SHAKEMAP_PRODUCT_MISSING"),
        Some("SHAKEMAP_GRID_UNAVAILABLE") => Ok("SHAKEMAP_GRID_UNAVAILABLE"),
        Some("USGS_DETAIL_UNAVAILABLE") => Ok("USGS_DETAIL_UNAVAILABLE"),
        _ => Err(process_failed(
            "pending_source requires a supported error_code",
        )),
    }
}

fn process_failed(message: impl Into<String>) -> HandlerError {
    HandlerError::new("AWS_RUNNER_PROCESS_FAILED", message)
}

struct ProductionInputParts {
    source_event_id: String,
    detail_json: Vec<u8>,
    grid_xml: Option<Vec<u8>>,
    raw_grid_bytes: Option<Vec<u8>>,
    raw_grid_uri: Option<String>,
}

fn build_production_input(parts: ProductionInputParts, observed_at_ms: u64) -> UsgsOracleInput {
    let id = &parts.source_event_id;
    UsgsOracleInput {
        case_id: format!("usgs-live/{id}"),
        detail_json: parts.detail_json,
        grid_xml: parts.grid_xml,
        raw_grid_bytes: parts.raw_grid_bytes,
        observed_at_ms,
        raw_detail_uri: usgs_detail_url(id),
        raw_grid_uri: parts.raw_grid_uri,
    }
}

fn canonical_usgs_detail_id_for_request<'a>(
    detail: &'a serde_json::Value,
    request_source_event_id: &str,
) -> Option<&'a str> {
    let canonical_id = detail.get("id").and_then(serde_json::Value::as_str)?;
    if canonical_id == request_source_event_id {
        return Some(canonical_id);
    }
    let ids = detail
        .get("properties")
        .and_then(|properties| properties.get("ids"))
        .and_then(serde_json::Value::as_str)?;
    if ids
        .split(',')
        .map(str::trim)
        .any(|alias| alias == request_source_event_id)
    {
        return Some(canonical_id);
    }
    None
}

fn usgs_detail_url(source_event_id: &str) -> String {
    format!(
        "https://earthquake.usgs.gov/fdsnws/event/1/query?eventid={source_event_id}&format=geojson"
    )
}

fn current_unix_time_ms() -> Result<u64, Box<dyn std::error::Error>> {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH)?;
    Ok(elapsed
        .as_secs()
        .checked_mul(1_000)
        .and_then(|millis| millis.checked_add(u64::from(elapsed.subsec_millis())))
        .ok_or("current time is outside u64 millisecond range")?)
}

struct FetchedGrid {
    grid_xml: Vec<u8>,
    raw_grid_bytes: Vec<u8>,
    raw_grid_uri: String,
}

fn production_http_client(ctx: &TeeContext) -> Result<reqwest::blocking::Client, reqwest::Error> {
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(PRODUCTION_FETCH_TIMEOUT_MS));
    if let Some(proxy_url) = non_empty(ctx.get(EGRESS_PROXY_URL_KEY)) {
        builder = builder.proxy(reqwest::Proxy::all(proxy_url)?);
    }
    builder.build()
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn fetch_bytes(
    client: &reqwest::blocking::Client,
    url: &str,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let bytes = client.get(url).send().and_then(|response| {
        if response.status().is_success() {
            response.bytes()
        } else {
            Err(response.error_for_status().unwrap_err())
        }
    })?;
    Ok(bytes.to_vec())
}

fn fetch_grid(
    client: &reqwest::blocking::Client,
    uri: &str,
) -> Result<FetchedGrid, Box<dyn std::error::Error>> {
    let bytes = match fetch_bytes(client, uri) {
        Ok(bytes) => bytes,
        Err(_) => return Err("SHAKEMAP_GRID_UNAVAILABLE".into()),
    };
    let grid_xml = grid_xml_from_artifact(uri, &bytes)?;
    Ok(FetchedGrid {
        grid_xml,
        raw_grid_bytes: bytes,
        raw_grid_uri: uri.to_owned(),
    })
}

fn preferred_grid_uri_from_detail(detail: &serde_json::Value) -> Option<String> {
    let products = detail
        .get("properties")?
        .get("products")?
        .get("shakemap")?
        .as_array()?;
    let selected = products
        .iter()
        .max_by(|left, right| product_sort_key(left).cmp(&product_sort_key(right)))?;
    let contents = selected.get("contents")?.as_object()?;
    contents
        .get("download/grid.xml.zip")
        .or_else(|| contents.get("download/grid.xml"))
        .and_then(|content| content.get("url"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

fn product_sort_key(product: &serde_json::Value) -> (u64, u64, u64, String, String, String) {
    let properties = product
        .get("properties")
        .unwrap_or(&serde_json::Value::Null);
    (
        product
            .get("preferredWeight")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        properties
            .get("version")
            .and_then(serde_json::Value::as_str)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0),
        product
            .get("updateTime")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        product
            .get("source")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        product
            .get("code")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        product
            .get("status")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    )
}

#[cfg(test)]
mod tests {
    use super::{
        EarthquakeProcessHandler, ProductionInputParts, UNSIGNED_PLACEHOLDER,
        build_production_input, canonical_usgs_detail_id_for_request, output_to_tee_json,
        preferred_grid_uri_from_detail, process_output_from_oracle,
    };
    use crate::core::types::UsgsOracleInput;
    use crate::process_usgs;
    use sonari_tee_core::{ProcessDataHandler, ProcessOutput, TeeContext};
    use std::fs;
    use std::path::Path;

    const FIXTURE_DIR: &str = "../fixtures/usgs/finalized_minimal";

    fn read_fixture(path: impl AsRef<Path>) -> Vec<u8> {
        fs::read(path).expect("fixture should be readable")
    }

    fn detail_updated_at_ms(detail_json: &[u8]) -> u64 {
        serde_json::from_slice::<serde_json::Value>(detail_json)
            .unwrap()
            .get("properties")
            .and_then(|p| p.get("updated"))
            .and_then(serde_json::Value::as_u64)
            .unwrap()
    }

    fn finalized_input() -> UsgsOracleInput {
        let detail_json = read_fixture(format!("{FIXTURE_DIR}/input/usgs_detail.json"));
        let observed_at_ms = detail_updated_at_ms(&detail_json);
        UsgsOracleInput {
            case_id: "usgs/finalized_minimal".to_owned(),
            detail_json,
            grid_xml: Some(read_fixture(format!("{FIXTURE_DIR}/input/usgs_grid.xml"))),
            raw_grid_bytes: Some(read_fixture(format!("{FIXTURE_DIR}/input/usgs_grid.xml"))),
            observed_at_ms,
            raw_detail_uri:
                "nautilus/verifiers/earthquake/fixtures/usgs/finalized_minimal/input/usgs_detail.json"
                    .to_owned(),
            raw_grid_uri: Some(
                "nautilus/verifiers/earthquake/fixtures/usgs/finalized_minimal/input/usgs_grid.xml"
                    .to_owned(),
            ),
        }
    }

    #[test]
    fn finalized_output_to_tee_json_keeps_payload_unsigned_with_placeholder_signature() {
        let unsigned = process_usgs(finalized_input()).expect("fixture should finalize");
        let expected_bcs_hex = unsigned
            .expected_hashes
            .as_ref()
            .unwrap()
            .unsigned_bcs_payload_hex
            .clone();

        let result = output_to_tee_json(unsigned).expect("finalized output should map to JSON");
        let value = serde_json::to_value(&result).unwrap();

        assert_eq!(value["status"], "finalized");
        assert_eq!(value["payload_bcs_hex"], expected_bcs_hex);
        assert_eq!(value["signature"], UNSIGNED_PLACEHOLDER);
        assert_eq!(value["public_key"], UNSIGNED_PLACEHOLDER);
        let keys = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        assert_eq!(
            keys,
            [
                "status",
                "payload",
                "payload_bcs_hex",
                "signature",
                "public_key",
                "raw_data_manifest",
                "affected_cells",
                "evidence_manifest",
            ]
        );
    }

    #[test]
    fn process_output_carries_unsigned_bcs_payload_bytes_for_finalized() {
        let unsigned = process_usgs(finalized_input()).expect("fixture should finalize");
        let expected_bytes = unsigned.unsigned_bcs_payload.clone().unwrap();

        let output = process_output_from_oracle(unsigned).expect("conversion should succeed");

        let ProcessOutput::Signable {
            payload_bcs,
            result_json,
        } = output
        else {
            panic!("finalized output must be signable");
        };
        assert_eq!(payload_bcs, expected_bytes);
        assert_eq!(result_json["status"], "finalized");
        assert_eq!(result_json["signature"], UNSIGNED_PLACEHOLDER);
    }

    #[test]
    fn process_output_rejects_finalized_result_without_unsigned_bcs_payload() {
        let mut unsigned = process_usgs(finalized_input()).expect("fixture should finalize");
        assert_eq!(unsigned.result.status, crate::OracleStatus::Finalized);
        // Simulate a finalized result whose signable bytes went missing: the
        // server must fail closed rather than return an unsigned 200.
        unsigned.unsigned_bcs_payload = None;

        let error = process_output_from_oracle(unsigned)
            .expect_err("finalized output without BCS payload must fail closed");

        assert_eq!(error.error_code, "AWS_RUNNER_PROCESS_FAILED");
        assert!(
            error.message.contains("unsigned BCS payload"),
            "message: {}",
            error.message
        );
    }

    #[test]
    fn process_output_returns_unsigned_envelope_for_non_finalized_result() {
        let mut output = process_usgs(finalized_input()).expect("fixture should finalize");
        output.result.status = crate::OracleStatus::PendingSource;
        output.result.error_code = Some("USGS_DETAIL_UNAVAILABLE".to_owned());
        output.unsigned_bcs_payload = None;

        let process_output =
            process_output_from_oracle(output).expect("non-finalized conversion should succeed");

        assert!(matches!(process_output, ProcessOutput::Unsigned { .. }));
        assert_eq!(process_output.result_json()["status"], "pending_source");
    }

    #[test]
    fn handler_rejects_malformed_request_input() {
        let handler = EarthquakeProcessHandler::new();
        let error = handler
            .process(b"not json", &TeeContext::new())
            .expect_err("malformed input must produce a handler error");
        assert_eq!(error.error_code, "AWS_RUNNER_PROCESS_FAILED");
    }

    #[test]
    fn handler_rejects_request_with_unexpected_field() {
        let handler = EarthquakeProcessHandler::new();
        let error = handler
            .process(
                br#"{"source_event_id":"us7000sonari","hazard_type":1,"primary_source":1,"geo_resolution":7,"extra":1}"#,
                &TeeContext::new(),
            )
            .expect_err("unexpected field must produce a handler error");
        assert_eq!(error.error_code, "AWS_RUNNER_PROCESS_FAILED");
        assert!(error.message.contains("unexpected Worker to TEE field"));
    }

    #[test]
    fn output_to_tee_json_rejects_unsupported_pending_source_error_code() {
        let mut output = process_usgs(finalized_input()).expect("fixture should finalize");
        output.result.status = crate::OracleStatus::PendingSource;
        output.result.error_code = Some("UNSUPPORTED".to_owned());
        let error = output_to_tee_json(output).unwrap_err();
        assert_eq!(error.error_code, "AWS_RUNNER_PROCESS_FAILED");
    }

    #[test]
    fn build_production_input_uses_injected_observed_at_ms() {
        let properties_updated_ms = 1_700_000_000_000_u64;
        let injected_observed_at_ms = 1_800_000_000_000_u64;
        let detail_json =
            format!(r#"{{"id":"us7000abcd","properties":{{"updated":{properties_updated_ms}}}}}"#)
                .into_bytes();
        let parts = ProductionInputParts {
            source_event_id: "us7000abcd".to_owned(),
            detail_json,
            grid_xml: None,
            raw_grid_bytes: None,
            raw_grid_uri: None,
        };

        let input = build_production_input(parts, injected_observed_at_ms);

        assert_eq!(input.observed_at_ms, injected_observed_at_ms);
        assert_eq!(input.case_id, "usgs-live/us7000abcd");
        assert_eq!(
            input.raw_detail_uri,
            "https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=us7000abcd&format=geojson"
        );
    }

    #[test]
    fn canonical_detail_id_matches_alias_and_preferred_grid_uri() {
        let detail = serde_json::json!({
            "id": "us7000canon",
            "properties": {
                "ids": ",us7000alias,us7000canon,",
                "products": {
                    "shakemap": [
                        {
                            "preferredWeight": 10,
                            "contents": {
                                "download/grid.xml": {"url": "https://example.test/grid.xml"}
                            }
                        }
                    ]
                }
            }
        });
        assert_eq!(
            canonical_usgs_detail_id_for_request(&detail, "us7000alias"),
            Some("us7000canon")
        );
        assert_eq!(
            preferred_grid_uri_from_detail(&detail).as_deref(),
            Some("https://example.test/grid.xml")
        );
    }
}
