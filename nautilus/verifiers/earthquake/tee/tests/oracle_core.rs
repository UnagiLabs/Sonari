use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use std::cell::{Cell, RefCell};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use tee::{
    CELL_AGGREGATION_GRID_POINT_P90, CELL_METRIC_USGS_MMI,
    CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1, GEO_RESOLUTION,
    HAZARD_TYPE_EARTHQUAKE, INTENSITY_SCALE_MMI_X100, INTENT_SONARI_EARTHQUAKE_ORACLE,
    LocalEd25519Signer, ONCHAIN_STATUS_FINALIZED, ORACLE_VERSION, OracleStatus,
    PRIMARY_SOURCE_USGS, PayloadSigner, SignatureArtifact, SourceArchive, SourceArchiveError,
    StoredSourceRef, UsgsOracleInput, WorkerToTeeRequest, canonical_json_bytes, cell_band,
    grid_xml_from_artifact, merkle_root_from_leaf_hashes, mmi_decimal_to_x100, p90_x100,
    process_usgs, process_usgs_from_worker_request, process_usgs_with_signer,
    process_usgs_with_source_archive, sha256_bytes,
};

const FIXTURE_DIR: &str = "../fixtures/usgs/finalized_minimal";
const SIGNING_KEY_SEED: [u8; 32] = [7; 32];

fn read_fixture(path: impl AsRef<Path>) -> Vec<u8> {
    fs::read(path).expect("fixture should be readable")
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

fn input_with_detail_id_and_aliases(canonical_id: &str, aliases: &str) -> UsgsOracleInput {
    let mut input = finalized_input();
    let mut detail: serde_json::Value =
        serde_json::from_slice(&input.detail_json).expect("fixture detail should be valid JSON");
    detail["id"] = serde_json::Value::String(canonical_id.to_owned());
    detail["properties"]["ids"] = serde_json::Value::String(aliases.to_owned());
    input.case_id = format!("usgs-live/{canonical_id}");
    input.detail_json = serde_json::to_vec(&detail).expect("detail JSON should serialize");
    input.observed_at_ms = detail_updated_at_ms(&input.detail_json);
    input.raw_detail_uri =
        format!("https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/{canonical_id}.geojson");
    input
}

fn input_with_usgs_payload_metadata(
    title: &str,
    region: &str,
    magnitude: serde_json::Value,
) -> UsgsOracleInput {
    let mut input = finalized_input();
    let mut detail: serde_json::Value =
        serde_json::from_slice(&input.detail_json).expect("fixture detail should be valid JSON");
    detail["properties"]["title"] = serde_json::Value::String(title.to_owned());
    detail["properties"]["place"] = serde_json::Value::String(region.to_owned());
    detail["properties"]["mag"] = magnitude;
    input.detail_json = serde_json::to_vec(&detail).expect("detail JSON should serialize");
    input.observed_at_ms = detail_updated_at_ms(&input.detail_json);
    input
}

fn detail_updated_at_ms(detail_json: &[u8]) -> u64 {
    serde_json::from_slice::<serde_json::Value>(detail_json)
        .expect("fixture detail should be valid JSON")
        .get("properties")
        .and_then(|properties| properties.get("updated"))
        .and_then(serde_json::Value::as_u64)
        .expect("fixture detail should include properties.updated")
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
fn finalized_payload_maps_usgs_detail_fields_and_rounds_magnitude() {
    for (magnitude, expected_x100) in [
        (serde_json::json!(7.234), 723),
        (serde_json::json!(7.235), 724),
        (serde_json::json!("7.995"), 800),
    ] {
        let input =
            input_with_usgs_payload_metadata("M 7.24 - Test Event", "Test Region", magnitude);
        let verified_at_ms = input.observed_at_ms;
        let output = process_usgs(input).expect("fixture should finalize");
        let payload = output
            .unsigned_payload
            .as_ref()
            .expect("payload should exist");

        assert_eq!(payload.source_event_id, "us7000sonari");
        assert_eq!(payload.title, "M 7.24 - Test Event");
        assert_eq!(payload.region, "Test Region");
        assert_eq!(payload.verified_at_ms, verified_at_ms);
        assert!(payload.freshness_deadline_ms > payload.verified_at_ms);
        let manifest = output
            .evidence_manifest
            .as_ref()
            .expect("evidence manifest should exist");
        assert_eq!(manifest.earthquake.magnitude_x100, expected_x100);
        assert_eq!(manifest.earthquake.title, "M 7.24 - Test Event");
        assert_eq!(manifest.earthquake.region, "Test Region");
    }
}

#[test]
fn finalized_payload_rejects_malformed_current_contract_fields() {
    for (title, region, magnitude, expected) in [
        ("", "Test Region", serde_json::json!(7.1), "title"),
        ("M 7.1 - Test Event", "", serde_json::json!(7.1), "region"),
        (
            "M 7.1 - Test Event",
            "Test Region",
            serde_json::json!(0.0),
            "magnitude",
        ),
        (
            "M 7.1 - Test Event",
            "Test Region",
            serde_json::json!(20.01),
            "magnitude",
        ),
    ] {
        let error = process_usgs(input_with_usgs_payload_metadata(title, region, magnitude))
            .expect_err("malformed current payload fields must fail closed");

        assert!(
            error.to_string().contains(expected),
            "expected {expected} error, got: {error}"
        );
    }
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
    assert_eq!(cell_band(749), 1);
    assert_eq!(cell_band(750), 2);
    assert_eq!(cell_band(799), 2);
    assert_eq!(cell_band(800), 3);

    let leaves = vec![[1_u8; 32], [2_u8; 32], [3_u8; 32]];
    let promoted_root = merkle_root_from_leaf_hashes(&leaves).expect("non-empty tree");
    let mut left_data = Vec::new();
    left_data.push(0x01);
    left_data.extend_from_slice(&leaves[0]);
    left_data.extend_from_slice(&leaves[1]);
    let left = sha256_bytes(&left_data);
    let mut root_data = Vec::new();
    root_data.push(0x01);
    root_data.extend_from_slice(&left);
    root_data.extend_from_slice(&leaves[2]);
    let expected = sha256_bytes(&root_data);
    assert_eq!(promoted_root, expected);
}

#[test]
fn finalized_fixture_core_matches_expected_hashes_without_signing() {
    let output = process_usgs(finalized_input()).expect("fixture should finalize");

    assert_eq!(output.result.status, OracleStatus::Finalized);
    assert_eq!(output.result.error_code, None);
    assert!(output.unsigned_bcs_payload.is_some());
    assert!(output.signature.is_none());

    assert_eq!(
        serde_json::to_value(output.raw_data_manifest).unwrap(),
        read_expected("raw_data_manifest.json")
    );
    assert_eq!(
        serde_json::to_value(output.affected_cells).unwrap(),
        read_expected("affected_cells.json")
    );
    assert_eq!(
        serde_json::to_value(output.evidence_manifest).unwrap(),
        read_expected("evidence_manifest.json")
    );
    assert_eq!(
        serde_json::to_value(output.unsigned_payload).unwrap(),
        read_expected("unsigned_payload.json")
    );
    assert_eq!(
        serde_json::to_value(output.expected_hashes).unwrap(),
        read_expected("expected_hashes.json")
    );
}

#[test]
fn finalized_payload_uses_current_17_field_contract_without_old_artifact_uris() {
    let output = process_usgs(finalized_input()).expect("fixture should finalize");
    let payload = serde_json::to_value(output.unsigned_payload.unwrap()).unwrap();
    let payload = payload.as_object().unwrap();

    assert_eq!(
        payload.keys().map(String::as_str).collect::<Vec<_>>(),
        [
            "intent",
            "oracle_version",
            "event_uid",
            "event_revision",
            "source_event_id",
            "title",
            "region",
            "occurred_at_ms",
            "hazard_type",
            "status",
            "severity_band",
            "affected_cells_root",
            "affected_cell_count",
            "evidence_manifest_uri",
            "evidence_manifest_hash",
            "verified_at_ms",
            "freshness_deadline_ms",
        ]
    );
    for removed in [
        "raw_data_uri",
        "affected_cells_uri",
        "raw_data_hash",
        "affected_cells_data_hash",
        "source_set_hash",
        "magnitude_x100",
        "source_updated_at_ms",
        "primary_source",
        "geo_resolution",
        "cells_generation_method",
        "cell_metric",
        "cell_aggregation",
        "intensity_scale",
    ] {
        assert!(
            !payload.contains_key(removed),
            "finalized payload must not contain removed field {removed}"
        );
    }
}

#[test]
fn evidence_manifest_hash_is_sha256_of_canonical_manifest_bytes() {
    let output = process_usgs(finalized_input()).expect("fixture should finalize");
    let manifest = output
        .evidence_manifest
        .as_ref()
        .expect("evidence manifest should exist");
    let manifest_bytes = canonical_json_bytes(manifest).expect("manifest should serialize");
    let payload = output.unsigned_payload.as_ref().unwrap();

    assert_eq!(
        payload.evidence_manifest_hash,
        format!("0x{}", hex::encode(sha256_bytes(&manifest_bytes)))
    );
    assert_eq!(manifest.schema_version, 1);
    assert_eq!(manifest.oracle_version, ORACLE_VERSION);
    assert_eq!(manifest.event_uid, payload.event_uid);
    assert_eq!(manifest.event_revision, payload.event_revision);
    assert_eq!(manifest.hazard_type, "EARTHQUAKE");
    assert_eq!(manifest.source_event_id, payload.source_event_id);
    assert_eq!(manifest.sources.len(), 2);
    assert_eq!(manifest.affected_cells.root, payload.affected_cells_root);
    assert_eq!(manifest.affected_cells.count, payload.affected_cell_count);
    assert_eq!(manifest.affected_cells.geo_resolution, GEO_RESOLUTION);
}

#[test]
fn finalized_fixture_rejects_observed_at_ms_that_overflows_freshness_deadline() {
    let mut input = finalized_input();
    input.observed_at_ms = u64::MAX;

    let error = process_usgs(input)
        .expect_err("observed_at_ms at u64::MAX must overflow freshness_deadline_ms");

    assert!(
        error.to_string().contains("overflow"),
        "expected an arithmetic overflow error, got: {error}"
    );
}

#[test]
fn pre_tee_worker_scaffold_matches_pure_core_output_for_fixture_sources() {
    let request = WorkerToTeeRequest {
        source_event_id: "us7000sonari".to_owned(),
        hazard_type: HAZARD_TYPE_EARTHQUAKE,
        primary_source: PRIMARY_SOURCE_USGS,
        geo_resolution: GEO_RESOLUTION,
    };

    let worker_output =
        process_usgs_from_worker_request(request, finalized_input()).expect("request should run");
    let pure_output = process_usgs(finalized_input()).expect("fixture should finalize");

    assert_eq!(worker_output.result, pure_output.result);
    assert_eq!(worker_output.unsigned_payload, pure_output.unsigned_payload);
    assert_eq!(worker_output.expected_hashes, pure_output.expected_hashes);
}

#[test]
fn worker_request_accepts_usgs_alias_when_detail_ids_list_contains_exact_alias() {
    let request = WorkerToTeeRequest {
        source_event_id: "usc0001xgp".to_owned(),
        hazard_type: HAZARD_TYPE_EARTHQUAKE,
        primary_source: PRIMARY_SOURCE_USGS,
        geo_resolution: GEO_RESOLUTION,
    };
    let input = input_with_detail_id_and_aliases(
        "official20110311054624120_30",
        ",usc0001xgp,official20110311054624120_30,",
    );

    let output = process_usgs_from_worker_request(request, input).expect("alias should verify");

    assert_eq!(output.result.status, OracleStatus::Finalized);
    assert_eq!(
        output.result.source_event_id,
        "official20110311054624120_30"
    );
    for source in &output.source_manifest.as_ref().unwrap().sources {
        assert_eq!(source.event_id, "official20110311054624120_30");
    }
    for entry in &output.raw_data_manifest.as_ref().unwrap().entries {
        assert_eq!(entry.event_id, "official20110311054624120_30");
        assert!(!entry.uri.contains("usc0001xgp"));
    }
}

#[test]
fn worker_request_rejects_alias_substrings_or_unlisted_ids() {
    for aliases in [
        ",usc0001xgp-extra,official20110311054624120_30,",
        ",official20110311054624120_30,",
    ] {
        let request = WorkerToTeeRequest {
            source_event_id: "usc0001xgp".to_owned(),
            hazard_type: HAZARD_TYPE_EARTHQUAKE,
            primary_source: PRIMARY_SOURCE_USGS,
            geo_resolution: GEO_RESOLUTION,
        };
        let input = input_with_detail_id_and_aliases("official20110311054624120_30", aliases);

        let error = process_usgs_from_worker_request(request, input)
            .expect_err("unlisted alias should fail closed");

        assert!(
            error
                .to_string()
                .contains("does not match fetched USGS detail id")
        );
    }
}

#[test]
fn pre_tee_worker_scaffold_rejects_untrusted_contract_fields() {
    let mut request = serde_json::json!({
        "source_event_id": "us7000sonari",
        "hazard_type": HAZARD_TYPE_EARTHQUAKE,
        "primary_source": PRIMARY_SOURCE_USGS,
        "geo_resolution": GEO_RESOLUTION,
        "affected_cells_root": "0xdeadbeef"
    });

    let parsed = WorkerToTeeRequest::from_json_value(request.clone());
    assert!(parsed.is_err());

    request
        .as_object_mut()
        .unwrap()
        .remove("affected_cells_root");
    assert!(WorkerToTeeRequest::from_json_value(request).is_ok());
}

#[test]
fn finalized_entrypoint_signs_core_payload_with_injected_signer() {
    let signer = LocalEd25519Signer::new(SIGNING_KEY_SEED);
    let output =
        process_usgs_with_signer(finalized_input(), &signer).expect("fixture should finalize");

    assert_eq!(output.result.status, OracleStatus::Finalized);
    let signature_artifact = output.signature.expect("signature should exist");
    let public_key: [u8; 32] = hex::decode(signature_artifact.public_key.trim_start_matches("0x"))
        .unwrap()
        .try_into()
        .unwrap();
    let signature: [u8; 64] = hex::decode(signature_artifact.signature.trim_start_matches("0x"))
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
fn finalized_usgs_references_raw_sources_before_signing_payload() {
    let signer = LocalEd25519Signer::new(SIGNING_KEY_SEED);
    let archive = RecordingSourceArchive::default();
    let output = process_usgs_with_source_archive(finalized_input(), &archive, &signer)
        .expect("fixture should finalize with archived raw sources");

    assert_eq!(output.result.status, OracleStatus::Finalized);
    assert!(output.signature.is_some());
    let raw_manifest = output
        .raw_data_manifest
        .expect("finalized output should include raw manifest");
    assert_eq!(raw_manifest.entries.len(), 2);
    assert_eq!(archive.stored.get(), 4);
    assert_eq!(archive.fetched.get(), 0);

    for entry in &raw_manifest.entries {
        assert!(entry.uri.starts_with("walrus://blob/"));
        assert!(entry.walrus_blob_id.starts_with("test-walrus-"));
        assert!(!entry.source_uri.is_empty());
        assert_eq!(entry.content_hash, entry.source_hash);
    }
}

#[test]
fn archived_finalized_output_exposes_expected_blob_ids_for_all_artifacts() {
    let signer = LocalEd25519Signer::new(SIGNING_KEY_SEED);
    let archive = RecordingSourceArchive::default();
    let output = process_usgs_with_source_archive(finalized_input(), &archive, &signer)
        .expect("fixture should finalize with archived artifacts");

    let payload = output.unsigned_payload.as_ref().unwrap();
    assert!(payload.evidence_manifest_uri.starts_with("walrus://blob/"));
    assert!(!payload.evidence_manifest_uri.contains("ipfs://sonari/live"));
    let manifest_ref = output
        .evidence_manifest_ref
        .as_ref()
        .expect("manifest expected artifact ref should exist");
    assert_eq!(payload.evidence_manifest_uri, manifest_ref.uri);
    assert_eq!(manifest_ref.walrus_blob_id, "test-walrus-3");

    let affected_ref = output
        .affected_cells_ref
        .as_ref()
        .expect("affected cells expected artifact ref should exist");
    assert_eq!(affected_ref.walrus_blob_id, "test-walrus-2");
    assert_eq!(
        output
            .evidence_manifest
            .as_ref()
            .unwrap()
            .affected_cells
            .uri,
        affected_ref.uri
    );
    assert_eq!(archive.stored.get(), 4);

    let stored = archive.records.borrow();
    assert_eq!(stored[0].artifact_kind, "raw_source");
    assert_eq!(stored[1].artifact_kind, "raw_source");
    assert_eq!(stored[2].artifact_kind, "affected_cells");
    assert_eq!(stored[3].artifact_kind, "evidence_manifest");
}

#[test]
fn finalized_usgs_archives_raw_grid_zip_artifact_bytes_not_expanded_xml() {
    let signer = LocalEd25519Signer::new(SIGNING_KEY_SEED);
    let archive = RecordingSourceArchive::default();
    let grid_xml = read_fixture(format!("{FIXTURE_DIR}/input/usgs_grid.xml"));
    let grid_zip = zip_with_entries(&[("grid.xml", grid_xml.as_slice())]);
    let mut input = finalized_input();
    input.grid_xml = Some(grid_xml);
    input.raw_grid_bytes = Some(grid_zip.clone());
    input.raw_grid_uri = Some("https://example.test/download/grid.xml.zip".to_owned());

    let output = process_usgs_with_source_archive(input, &archive, &signer)
        .expect("zip raw artifact should finalize with archived raw zip bytes");

    let raw_manifest = output.raw_data_manifest.expect("raw manifest should exist");
    let grid_entry = raw_manifest
        .entries
        .iter()
        .find(|entry| entry.product == "shakemap_grid_xml")
        .expect("grid entry should exist");
    let grid_zip_hash = format!("0x{}", hex::encode(sha256_bytes(&grid_zip)));
    assert_eq!(
        grid_entry.source_uri,
        "https://example.test/download/grid.xml.zip"
    );
    assert_eq!(grid_entry.content_hash, grid_zip_hash);
    assert_eq!(grid_entry.source_hash, grid_zip_hash);
    assert_eq!(grid_entry.size_bytes, grid_zip.len() as u64);

    let stored = archive.records.borrow();
    let grid_record = stored
        .iter()
        .find(|record| record.source_uri == "https://example.test/download/grid.xml.zip")
        .expect("zip source should be referenced");
    assert_eq!(grid_record.bytes, grid_zip);
    assert_eq!(grid_record.source_hash, grid_zip_hash);
}

#[test]
fn finalized_usgs_rejects_zip_grid_uri_without_raw_artifact_bytes() {
    let mut input = finalized_input();
    input.raw_grid_uri = Some("https://example.test/download/grid.xml.zip".to_owned());
    input.raw_grid_bytes = None;

    let error = process_usgs(input).expect_err("zip URI without raw artifact bytes must fail");

    assert!(format!("{error}").contains("raw_grid_bytes"));
}

#[test]
fn finalized_usgs_rejects_raw_grid_artifact_that_does_not_match_grid_xml() {
    let mismatched_grid_xml =
        b"<shakemap_grid><grid_data>139.7000 35.6000 7.23</grid_data></shakemap_grid>";
    let mismatched_grid_zip = zip_with_entries(&[("grid.xml", mismatched_grid_xml.as_slice())]);
    let mut input = finalized_input();
    input.raw_grid_uri = Some("https://example.test/download/grid.xml.zip".to_owned());
    input.raw_grid_bytes = Some(mismatched_grid_zip);

    let error = process_usgs(input)
        .expect_err("raw grid artifact must match the grid_xml used for affected cells");

    assert!(format!("{error}").contains("raw_grid_bytes"));
}

#[test]
fn source_archive_rejects_raw_grid_artifact_mismatch_before_archive_or_signature() {
    let signer = CountingSigner::default();
    let archive = RecordingSourceArchive::default();
    let mismatched_grid_xml =
        b"<shakemap_grid><grid_data>139.7000 35.6000 7.23</grid_data></shakemap_grid>";
    let mismatched_grid_zip = zip_with_entries(&[("grid.xml", mismatched_grid_xml.as_slice())]);
    let mut input = finalized_input();
    input.raw_grid_uri = Some("https://example.test/download/grid.xml.zip".to_owned());
    input.raw_grid_bytes = Some(mismatched_grid_zip);

    let error = process_usgs_with_source_archive(input, &archive, &signer)
        .expect_err("raw grid artifact mismatch must fail before archive and signing");

    assert!(format!("{error}").contains("raw_grid_bytes"));
    assert_eq!(archive.stored.get(), 0);
    assert_eq!(archive.fetched.get(), 0);
    assert_eq!(signer.calls.get(), 0);
}

#[test]
fn usgs_archive_failure_prevents_finalized_signature() {
    let signer = CountingSigner::default();
    let archive = FailingSourceArchive;
    let error = process_usgs_with_source_archive(finalized_input(), &archive, &signer)
        .expect_err("archive failures must fail closed before signing");

    assert!(matches!(error, SourceArchiveError::StoreFailed(_)));
    assert_eq!(signer.calls.get(), 0);
}

#[test]
fn usgs_archive_blob_mismatch_prevents_finalized_signature() {
    let signer = CountingSigner::default();
    let archive = MismatchingSourceArchive;
    let error = process_usgs_with_source_archive(finalized_input(), &archive, &signer)
        .expect_err("blob mismatches must fail closed before signing");

    assert!(matches!(error, SourceArchiveError::BlobMismatch { .. }));
    assert_eq!(signer.calls.get(), 0);
}

#[test]
fn source_archive_entrypoint_preserves_non_finalized_status_without_archive_or_signature() {
    let signer = CountingSigner::default();
    let archive = RecordingSourceArchive::default();

    for (case_id, expected_status) in [
        (
            "usgs/pending_source_no_shakemap",
            OracleStatus::PendingSource,
        ),
        ("usgs/pending_mmi_empty_grid", OracleStatus::PendingMmi),
        ("usgs/rejected_cancelled_shakemap", OracleStatus::Rejected),
        ("usgs/rejected_no_affected_cells", OracleStatus::Rejected),
    ] {
        let output =
            process_usgs_with_source_archive(non_finalized_input(case_id), &archive, &signer)
                .expect("non-finalized archive mode should return status output");

        assert_eq!(output.result.status, expected_status);
        assert!(output.signature.is_none());
        assert!(output.unsigned_payload.is_none());
        assert!(output.unsigned_bcs_payload.is_none());
        assert!(output.raw_data_manifest.is_none());
        assert!(output.affected_cells.is_none());
    }

    assert_eq!(archive.stored.get(), 0);
    assert_eq!(archive.fetched.get(), 0);
    assert_eq!(signer.calls.get(), 0);
}

#[test]
fn entrypoint_calls_signer_only_for_finalized_results() {
    let signer = CountingSigner::default();

    let finalized = process_usgs_with_signer(finalized_input(), &signer).unwrap();
    assert_eq!(finalized.result.status, OracleStatus::Finalized);
    assert_eq!(signer.calls.get(), 1);

    for case_id in [
        "usgs/pending_source_no_shakemap",
        "usgs/pending_mmi_empty_grid",
        "usgs/rejected_cancelled_shakemap",
    ] {
        let output = process_usgs_with_signer(non_finalized_input(case_id), &signer).unwrap();
        assert_ne!(output.result.status, OracleStatus::Finalized);
        assert!(output.signature.is_none());
    }
    assert_eq!(signer.calls.get(), 1);
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
        let detail_json = read_fixture(format!("{dir}/input/usgs_detail.json"));
        let output = process_usgs(UsgsOracleInput {
            case_id: case_id.to_owned(),
            observed_at_ms: detail_updated_at_ms(&detail_json),
            detail_json,
            grid_xml: Path::new(&grid_path)
                .exists()
                .then(|| read_fixture(&grid_path)),
            raw_grid_bytes: Path::new(&grid_path)
                .exists()
                .then(|| read_fixture(&grid_path)),
            raw_detail_uri: format!(
                "nautilus/verifiers/earthquake/fixtures/{case_id}/input/usgs_detail.json"
            ),
            raw_grid_uri: Path::new(&grid_path).exists().then(|| {
                format!("nautilus/verifiers/earthquake/fixtures/{case_id}/input/usgs_grid.xml")
            }),
        })
        .expect("non-finalized cases should return status output");

        assert_eq!(output.result.status, expected_status);
        assert_eq!(output.result.error_code.as_deref(), expected_error);
        assert!(output.unsigned_payload.is_none());
        assert!(output.unsigned_bcs_payload.is_none());
        assert!(output.signature.is_none());
        assert!(output.raw_data_manifest.is_none());
        assert!(output.affected_cells.is_none());
    }
}

#[test]
fn extracts_only_safe_grid_xml_from_zip_artifacts() {
    let xml = b"<shakemap_grid><grid_data>139.7000 35.6000 7.23</grid_data></shakemap_grid>";
    let zip_bytes = zip_with_entries(&[("grid.xml", xml.as_slice())]);

    let extracted =
        grid_xml_from_artifact("https://example.test/download/grid.xml.zip", &zip_bytes).unwrap();

    assert_eq!(extracted, xml);
    assert_eq!(
        grid_xml_from_artifact("https://example.test/download/grid.xml", xml).unwrap(),
        xml
    );
}

#[test]
fn rejects_grid_zip_path_traversal_and_missing_grid_xml() {
    let traversal = zip_with_entries(&[("../grid.xml", b"bad".as_slice())]);
    assert!(grid_xml_from_artifact("grid.xml.zip", &traversal).is_err());

    let missing = zip_with_entries(&[("not_grid.xml", b"bad".as_slice())]);
    assert!(grid_xml_from_artifact("grid.xml.zip", &missing).is_err());
}

#[test]
fn low_level_cli_normalizes_grid_zip_artifact_with_raw_grid_uri() {
    let workspace = cli_test_workspace("zip-with-raw-uri");
    let output_dir = workspace.join("output");
    let grid_zip_path = workspace.join("usgs_grid.xml.zip");
    fs::create_dir_all(&workspace).unwrap();
    fs::write(
        &grid_zip_path,
        zip_with_entries(&[(
            "grid.xml",
            read_fixture(format!("{FIXTURE_DIR}/input/usgs_grid.xml")).as_slice(),
        )]),
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_tee"))
        .args([
            "--case-id",
            "usgs/finalized_minimal_zip",
            "--detail",
            &format!("{FIXTURE_DIR}/input/usgs_detail.json"),
            "--grid",
        ])
        .arg(&grid_zip_path)
        .args([
            "--raw-detail-uri",
            "nautilus/verifiers/earthquake/fixtures/usgs/finalized_minimal/input/usgs_detail.json",
            "--raw-grid-uri",
            "https://example.test/download/grid.xml.zip",
            "--raw-data-uri",
            "ipfs://sonari/examples/us7000sonari/raw_data_manifest.json",
            "--affected-cells-uri",
            "ipfs://sonari/examples/us7000sonari/affected_cells.json",
            "--output-dir",
        ])
        .arg(&output_dir)
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result = serde_json::from_slice::<serde_json::Value>(
        &fs::read(output_dir.join("result.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(result["status"], "finalized");
    let raw_data_manifest = serde_json::from_slice::<serde_json::Value>(
        &fs::read(output_dir.join("raw_data_manifest.json")).unwrap(),
    )
    .unwrap();
    let expected_raw_data_manifest = read_expected("raw_data_manifest.json");
    let expected_grid_hash = format!(
        "0x{}",
        hex::encode(sha256_bytes(&fs::read(&grid_zip_path).unwrap()))
    );
    assert_eq!(
        raw_data_manifest["entries"][1]["uri"],
        "https://example.test/download/grid.xml.zip"
    );
    assert_eq!(
        raw_data_manifest["entries"][1]["content_hash"],
        expected_grid_hash
    );
    assert_ne!(
        raw_data_manifest["entries"][1]["content_hash"],
        expected_raw_data_manifest["entries"][1]["content_hash"]
    );

    fs::remove_dir_all(&workspace).unwrap();
}

#[test]
fn low_level_cli_infers_zip_grid_uri_from_file_path_when_raw_grid_uri_is_absent() {
    let workspace = cli_test_workspace("zip-without-raw-uri");
    let output_dir = workspace.join("output");
    let grid_zip_path = workspace.join("usgs_grid.xml.zip");
    fs::create_dir_all(&workspace).unwrap();
    fs::write(
        &grid_zip_path,
        zip_with_entries(&[(
            "grid.xml",
            read_fixture(format!("{FIXTURE_DIR}/input/usgs_grid.xml")).as_slice(),
        )]),
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_tee"))
        .args([
            "--case-id",
            "usgs/finalized_minimal_zip",
            "--detail",
            &format!("{FIXTURE_DIR}/input/usgs_detail.json"),
            "--grid",
        ])
        .arg(&grid_zip_path)
        .args([
            "--raw-detail-uri",
            "nautilus/verifiers/earthquake/fixtures/usgs/finalized_minimal/input/usgs_detail.json",
            "--raw-data-uri",
            "ipfs://sonari/examples/us7000sonari/raw_data_manifest.json",
            "--affected-cells-uri",
            "ipfs://sonari/examples/us7000sonari/affected_cells.json",
            "--output-dir",
        ])
        .arg(&output_dir)
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result = serde_json::from_slice::<serde_json::Value>(
        &fs::read(output_dir.join("result.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(result["status"], "finalized");
    let raw_data_manifest = serde_json::from_slice::<serde_json::Value>(
        &fs::read(output_dir.join("raw_data_manifest.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        raw_data_manifest["entries"][1]["uri"],
        grid_zip_path.to_string_lossy().as_ref()
    );

    fs::remove_dir_all(&workspace).unwrap();
}

#[test]
fn low_level_cli_rejects_zero_walrus_timeout() {
    let output = Command::new(env!("CARGO_BIN_EXE_tee"))
        .args([
            "--walrus-archive",
            "--walrus-n-shards",
            "1000",
            "--walrus-timeout-ms",
            "0",
        ])
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("Walrus CLI timeout"),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn low_level_cli_ignores_environment_signing_seed() {
    let workspace = cli_test_workspace("low-level-ignores-env-seed");
    let output_dir = workspace.join("output");
    fs::create_dir_all(&workspace).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_tee"))
        .args([
            "--case-id",
            "usgs/finalized_minimal",
            "--detail",
            &format!("{FIXTURE_DIR}/input/usgs_detail.json"),
            "--grid",
            &format!("{FIXTURE_DIR}/input/usgs_grid.xml"),
            "--raw-detail-uri",
            "nautilus/verifiers/earthquake/fixtures/usgs/finalized_minimal/input/usgs_detail.json",
            "--raw-grid-uri",
            "nautilus/verifiers/earthquake/fixtures/usgs/finalized_minimal/input/usgs_grid.xml",
            "--raw-data-uri",
            "ipfs://sonari/examples/us7000sonari/raw_data_manifest.json",
            "--affected-cells-uri",
            "ipfs://sonari/examples/us7000sonari/affected_cells.json",
            "--output-dir",
        ])
        .arg(&output_dir)
        .env(
            "SONARI_TEE_SIGNING_KEY_SEED",
            "0x0101010101010101010101010101010101010101010101010101010101010101",
        )
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let signature = serde_json::from_slice::<serde_json::Value>(
        &fs::read(output_dir.join("signature.json")).unwrap(),
    )
    .unwrap();

    assert_eq!(signature, read_expected("signature.json"));

    fs::remove_dir_all(&workspace).unwrap();
}

#[test]
fn production_cli_rejects_missing_signing_key_seed() {
    let workspace = cli_test_workspace("production-missing-signing-key");
    let input_path = workspace.join("worker_request.json");
    fs::create_dir_all(&workspace).unwrap();
    fs::write(
        &input_path,
        r#"{"source_event_id":"us7000sonari","hazard_type":1,"primary_source":1,"geo_resolution":7}"#,
    )
    .unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_tee"))
        .args(["production", "--input"])
        .arg(&input_path)
        .env_remove("SONARI_TEE_SIGNING_KEY_SEED")
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("SONARI_TEE_SIGNING_KEY_SEED"),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    fs::remove_dir_all(&workspace).unwrap();
}

#[test]
fn production_cli_reads_worker_request_from_stdin_when_input_is_omitted() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tee"))
        .arg("production")
        .env(
            "SONARI_TEE_SIGNING_KEY_SEED",
            "0x0707070707070707070707070707070707070707070707070707070707070707",
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(
            br#"{"source_event_id":"us7000sonari","hazard_type":1,"primary_source":1,"geo_resolution":7,"affected_cells_root":"0xdeadbeef"}"#,
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();

    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("unexpected Worker to TEE field"),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn production_cli_accepts_nautilus_health_check_action_without_seed() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tee"))
        .arg("production")
        .env_remove("SONARI_TEE_SIGNING_KEY_SEED")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(br#"{"action":"health_check"}"#)
        .unwrap();
    let output = child.wait_with_output().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["status"], "healthy");
    assert_eq!(result["external_sources_reachable"], true);
}

#[test]
fn production_cli_returns_configured_attestation_action() {
    let attestation_document_hex = format!("0x{}", "aa".repeat(96));
    let public_key = format!("0x{}", "22".repeat(32));
    let mut child = Command::new(env!("CARGO_BIN_EXE_tee"))
        .arg("production")
        .env(
            "SONARI_TEE_SIGNING_KEY_SEED",
            "0x0707070707070707070707070707070707070707070707070707070707070707",
        )
        .env(
            "SONARI_TEE_ATTESTATION_DOCUMENT_HEX",
            &attestation_document_hex,
        )
        .env("SONARI_TEE_ATTESTATION_PUBLIC_KEY", &public_key)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(br#"{"action":"get_attestation"}"#)
        .unwrap();
    let output = child.wait_with_output().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["attestation_document_hex"], attestation_document_hex);
    assert_eq!(result["public_key"], public_key);
}

#[test]
fn production_cli_get_attestation_output_is_byte_stable_for_fixed_seed_and_document() {
    // Fixed seed, fixed document, and no explicit public key: the public key is
    // derived from the seed so the route output is fully deterministic. Pinning
    // the exact JSON bytes catches any wire drift in the get_attestation route.
    let attestation_document_hex = format!("0x{}", "ab".repeat(96));
    let mut child = Command::new(env!("CARGO_BIN_EXE_tee"))
        .arg("production")
        .env(
            "SONARI_TEE_SIGNING_KEY_SEED",
            "0x0707070707070707070707070707070707070707070707070707070707070707",
        )
        .env(
            "SONARI_TEE_ATTESTATION_DOCUMENT_HEX",
            &attestation_document_hex,
        )
        .env_remove("SONARI_TEE_ATTESTATION_PUBLIC_KEY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(br#"{"action":"get_attestation"}"#)
        .unwrap();
    let output = child.wait_with_output().unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    // The dev seed [7u8; 32] derives this Ed25519 public key; it is the same key
    // pinned in the finalized fixture's signature.json, proving byte fidelity.
    let expected = serde_json::json!({
        "attestation_document_hex": attestation_document_hex,
        "public_key": "0xea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c",
    });
    assert_eq!(result, expected);
    let keys = result
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    assert_eq!(keys, ["attestation_document_hex", "public_key"]);
}

#[test]
fn production_cli_requires_registration_metadata_for_process_data_action() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tee"))
        .arg("production")
        .env(
            "SONARI_TEE_SIGNING_KEY_SEED",
            "0x0707070707070707070707070707070707070707070707070707070707070707",
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(
            br#"{"action":"process_data","payload":{"source_event_id":"us7000sonari","hazard_type":1,"primary_source":1,"geo_resolution":7}}"#,
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();

    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("registration_metadata"),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn selects_shakemap_products_deterministically_by_preferred_version_update_and_key() {
    let detail_json = br#"{
        "id": "us7000multi",
        "properties": {
            "time": 1704067200000,
            "updated": 1704151200000,
            "mag": 7.1,
            "title": "M 7.1 - Multi Product Fixture",
            "place": "Multi Product Fixture Region",
            "products": {
                "shakemap": [
                    {
                        "code": "older",
                        "source": "us",
                        "status": "UPDATE",
                        "preferredWeight": 10,
                        "updateTime": 1704151100000,
                        "properties": { "map-status": "REVIEWED", "version": "3" },
                        "contents": {
                            "download/grid.xml": { "url": "https://example.test/older/grid.xml" }
                        }
                    },
                    {
                        "code": "newer",
                        "source": "us",
                        "status": "UPDATE",
                        "preferredWeight": 10,
                        "updateTime": 1704151200000,
                        "properties": { "map-status": "REVIEWED", "version": "4" },
                        "contents": {
                            "download/grid.xml": { "url": "https://example.test/newer/grid.xml" }
                        }
                    }
                ]
            }
        }
    }"#;
    let input = UsgsOracleInput {
        case_id: "usgs/multi".to_owned(),
        detail_json: detail_json.to_vec(),
        grid_xml: Some(read_fixture(format!("{FIXTURE_DIR}/input/usgs_grid.xml"))),
        raw_grid_bytes: Some(read_fixture(format!("{FIXTURE_DIR}/input/usgs_grid.xml"))),
        observed_at_ms: detail_updated_at_ms(detail_json),
        raw_detail_uri: "detail.json".to_owned(),
        raw_grid_uri: Some("grid.xml".to_owned()),
    };

    let output = process_usgs(input).expect("multi product fixture should finalize");
    let source_manifest = output
        .source_manifest
        .expect("source manifest should exist");
    let grid_source = source_manifest
        .sources
        .iter()
        .find(|source| source.product == "shakemap_grid_xml")
        .expect("grid source should exist");

    assert_eq!(grid_source.product_version, "4");
}

#[derive(Default)]
struct CountingSigner {
    calls: Cell<usize>,
}

impl PayloadSigner for CountingSigner {
    fn sign_payload(&self, _payload: &[u8]) -> SignatureArtifact {
        self.calls.set(self.calls.get() + 1);
        SignatureArtifact {
            algorithm: "test".to_owned(),
            public_key: "0x01".to_owned(),
            signature: "0x02".to_owned(),
        }
    }
}

#[derive(Default)]
struct RecordingSourceArchive {
    stored: Cell<usize>,
    fetched: Cell<usize>,
    records: RefCell<Vec<ArchivedSourceRecord>>,
}

struct ArchivedSourceRecord {
    artifact_kind: String,
    source_uri: String,
    source_hash: String,
    bytes: Vec<u8>,
}

impl SourceArchive for RecordingSourceArchive {
    fn store_and_verify(
        &self,
        source_uri: &str,
        source_hash: &str,
        bytes: &[u8],
    ) -> Result<StoredSourceRef, SourceArchiveError> {
        let index = self.stored.get();
        self.stored.set(index + 1);
        let artifact_kind = if source_uri.ends_with("/affected_cells.json") {
            "affected_cells"
        } else if source_uri.ends_with("/evidence_manifest.json") {
            "evidence_manifest"
        } else {
            "raw_source"
        };
        self.records.borrow_mut().push(ArchivedSourceRecord {
            artifact_kind: artifact_kind.to_owned(),
            source_uri: source_uri.to_owned(),
            source_hash: source_hash.to_owned(),
            bytes: bytes.to_vec(),
        });
        Ok(StoredSourceRef {
            uri: format!("walrus://blob/test-walrus-{index}"),
            walrus_blob_id: format!("test-walrus-{index}"),
            source_hash: source_hash.to_owned(),
            size_bytes: bytes.len() as u64,
        })
    }
}

struct FailingSourceArchive;

impl SourceArchive for FailingSourceArchive {
    fn store_and_verify(
        &self,
        _source_uri: &str,
        _source_hash: &str,
        _bytes: &[u8],
    ) -> Result<StoredSourceRef, SourceArchiveError> {
        Err(SourceArchiveError::StoreFailed(
            "publisher unavailable".to_owned(),
        ))
    }
}

struct MismatchingSourceArchive;

impl SourceArchive for MismatchingSourceArchive {
    fn store_and_verify(
        &self,
        source_uri: &str,
        source_hash: &str,
        _bytes: &[u8],
    ) -> Result<StoredSourceRef, SourceArchiveError> {
        Err(SourceArchiveError::BlobMismatch {
            source_uri: source_uri.to_owned(),
            expected_hash: source_hash.to_owned(),
            actual_hash: "0xdeadbeef".to_owned(),
        })
    }
}

fn non_finalized_input(case_id: &str) -> UsgsOracleInput {
    let dir = format!("../fixtures/{case_id}");
    let grid_path = format!("{dir}/input/usgs_grid.xml");
    let detail_json = read_fixture(format!("{dir}/input/usgs_detail.json"));
    UsgsOracleInput {
        case_id: case_id.to_owned(),
        observed_at_ms: detail_updated_at_ms(&detail_json),
        detail_json,
        grid_xml: Path::new(&grid_path)
            .exists()
            .then(|| read_fixture(&grid_path)),
        raw_grid_bytes: Path::new(&grid_path)
            .exists()
            .then(|| read_fixture(&grid_path)),
        raw_detail_uri: format!(
            "nautilus/verifiers/earthquake/fixtures/{case_id}/input/usgs_detail.json"
        ),
        raw_grid_uri: Path::new(&grid_path).exists().then(|| {
            format!("nautilus/verifiers/earthquake/fixtures/{case_id}/input/usgs_grid.xml")
        }),
    }
}

fn zip_with_entries(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut bytes);
        let mut writer = zip::ZipWriter::new(cursor);
        let options = zip::write::FileOptions::<()>::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, content) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap();
    }
    bytes
}

fn cli_test_workspace(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("sonari-tee-cli-{name}-{}", std::process::id()))
}
