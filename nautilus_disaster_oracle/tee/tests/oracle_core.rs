use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use std::fs;
use std::path::Path;
use tee::{
    CELL_AGGREGATION_GRID_POINT_P90, CELL_METRIC_USGS_MMI,
    CELLS_GENERATION_METHOD_SHAKEMAP_GRIDXML_H3_GRID_POINT_P90_V1, GEO_RESOLUTION,
    HAZARD_TYPE_EARTHQUAKE, INTENSITY_SCALE_MMI_X100, INTENT_SONARI_EARTHQUAKE_ORACLE,
    MIN_CLAIM_BAND, ONCHAIN_STATUS_FINALIZED, ORACLE_VERSION, OracleStatus, PRIMARY_SOURCE_USGS,
    UsgsOracleInput, cell_band, merkle_root_from_leaf_hashes, mmi_decimal_to_x100, p90_x100,
    process_usgs, sha3_256_bytes,
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
