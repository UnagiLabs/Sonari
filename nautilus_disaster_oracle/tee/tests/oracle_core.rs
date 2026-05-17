use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use std::cell::Cell;
use std::fs;
use std::io::Write;
use std::path::Path;
use tee::{
    CELL_AGGREGATION_GRID_POINT_P90, CELL_METRIC_USGS_MMI,
    CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1, GEO_RESOLUTION,
    HAZARD_TYPE_EARTHQUAKE, INTENSITY_SCALE_MMI_X100, INTENT_SONARI_EARTHQUAKE_ORACLE,
    LocalEd25519Signer, MIN_CLAIM_BAND, ONCHAIN_STATUS_FINALIZED, ORACLE_VERSION, OracleStatus,
    PRIMARY_SOURCE_USGS, PayloadSigner, SignatureArtifact, UsgsOracleInput, cell_band,
    grid_xml_from_artifact, merkle_root_from_leaf_hashes, mmi_decimal_to_x100, p90_x100,
    process_usgs, process_usgs_with_signer, sha3_256_bytes,
};

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
        affected_cells_uri: "ipfs://sonari/examples/us7000sonari/affected_cells.json".to_owned(),
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
        serde_json::to_value(output.unsigned_payload).unwrap(),
        read_expected("unsigned_payload_v1.json")
    );
    assert_eq!(
        serde_json::to_value(output.expected_hashes).unwrap(),
        read_expected("expected_hashes.json")
    );
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
fn selects_shakemap_products_deterministically_by_preferred_version_update_and_key() {
    let detail_json = br#"{
        "id": "us7000multi",
        "properties": {
            "time": 1704067200000,
            "updated": 1704151200000,
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
        raw_detail_uri: "detail.json".to_owned(),
        raw_grid_uri: Some("grid.xml".to_owned()),
        raw_data_uri: "raw.json".to_owned(),
        affected_cells_uri: "cells.json".to_owned(),
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

fn non_finalized_input(case_id: &str) -> UsgsOracleInput {
    let dir = format!("../fixtures/{case_id}");
    let grid_path = format!("{dir}/input/usgs_grid.xml");
    UsgsOracleInput {
        case_id: case_id.to_owned(),
        detail_json: read_fixture(format!("{dir}/input/usgs_detail.json")),
        grid_xml: Path::new(&grid_path)
            .exists()
            .then(|| read_fixture(&grid_path)),
        raw_detail_uri: format!(
            "nautilus_disaster_oracle/fixtures/{case_id}/input/usgs_detail.json"
        ),
        raw_grid_uri: Path::new(&grid_path)
            .exists()
            .then(|| format!("nautilus_disaster_oracle/fixtures/{case_id}/input/usgs_grid.xml")),
        raw_data_uri: String::new(),
        affected_cells_uri: String::new(),
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
