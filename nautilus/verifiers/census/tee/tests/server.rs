use census_tee::server::{
    CensusProcessHandler, finalize_process_output, parse_process_data_envelope,
};
use census_tee::{AffectedCell, AffectedCellsArtifact, compute_affected_cells_root};
use sonari_tee_core::{
    EnclaveRegistrationMetadata, LocalEd25519Signer, ProcessDataHandler, ProcessOutput, TeeContext,
};

#[test]
fn server_handler_returns_non_empty_signable_output() {
    let handler = CensusProcessHandler;

    let output = handler
        .process(
            serde_json::to_vec(&valid_bundle_json()).unwrap().as_slice(),
            &TeeContext::new(),
        )
        .expect("census handler should process a valid bundle");

    let ProcessOutput::Signable {
        payload_bcs,
        result_json,
    } = output
    else {
        panic!("census handler must emit a signable output");
    };
    assert!(!payload_bcs.is_empty());
    assert_eq!(result_json["status"], "finalized");
    assert_eq!(
        result_json["payload"]["registered_members_by_band"],
        serde_json::json!([1, 1, 0])
    );
    assert_eq!(result_json["signature"], "");
    assert_eq!(result_json["public_key"], "");
}

#[test]
fn server_process_data_envelope_rejects_wrong_verifier_config_key() {
    let envelope = serde_json::json!({
        "action": "process_data",
        "payload": valid_bundle_json(),
        "registration_metadata": {
            "verifier_config_key": 999,
            "verifier_config_version": 12,
            "enclave_instance_public_key": format!("0x{}", "44".repeat(32))
        }
    });

    let error = parse_process_data_envelope(serde_json::to_vec(&envelope).unwrap().as_slice())
        .expect_err("wrong verifier_config_key should be rejected");

    assert!(error.to_string().contains("verifier_config_key"));
}

#[test]
fn server_handler_rejects_missing_authenticated_event_proof_bundle() {
    let handler = CensusProcessHandler;
    let mut bundle = valid_bundle_json();
    bundle
        .as_object_mut()
        .expect("fixture should be an object")
        .remove("authenticated_event_proof");

    let error = handler
        .process(
            serde_json::to_vec(&bundle).unwrap().as_slice(),
            &TeeContext::new(),
        )
        .expect_err("authenticated_event_proof is required");

    assert!(
        error
            .to_string()
            .contains("missing field `authenticated_event_proof`")
    );
}

#[test]
fn server_handler_rejects_malformed_authenticated_event_proof_bundle() {
    let handler = CensusProcessHandler;
    let mut bundle = valid_bundle_json();
    bundle["authenticated_event_proof"]["event_stream_head"]["unexpected"] =
        serde_json::json!(true);

    let error = handler
        .process(
            serde_json::to_vec(&bundle).unwrap().as_slice(),
            &TeeContext::new(),
        )
        .expect_err("nested authenticated_event_proof fields should be strict");

    assert!(error.to_string().contains("unknown field `unexpected`"));
}

#[test]
fn server_finalization_injects_signature_public_key_and_registration_metadata() {
    let handler = CensusProcessHandler;
    let output = handler
        .process(
            serde_json::to_vec(&valid_bundle_json()).unwrap().as_slice(),
            &TeeContext::new(),
        )
        .expect("census handler should process a valid bundle");
    let metadata = EnclaveRegistrationMetadata {
        verifier_config_key: census_tee::VERIFIER_CONFIG_KEY,
        verifier_config_version: 12,
        enclave_instance_public_key: format!("0x{}", "44".repeat(32)),
    };
    let signer = LocalEd25519Signer::new([8; 32]);

    let finalized = finalize_process_output(output, &signer, Some(metadata.clone()))
        .expect("finalization should sign and inject metadata");

    assert_ne!(finalized["signature"], "");
    assert_ne!(finalized["public_key"], "");
    assert_eq!(
        finalized["verifier_config_key"],
        metadata.verifier_config_key
    );
    assert_eq!(
        finalized["verifier_config_version"],
        metadata.verifier_config_version
    );
    assert_eq!(
        finalized["enclave_instance_public_key"],
        metadata.enclave_instance_public_key
    );
}

fn valid_bundle_json() -> serde_json::Value {
    let event_uid = "0xab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd";
    let affected_cells = AffectedCellsArtifact {
        event_uid: event_uid.to_owned(),
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
        ],
    };
    let affected_cells_root = compute_affected_cells_root(event_uid, 7, &affected_cells).unwrap();

    serde_json::json!({
        "event_uid": event_uid,
        "event_revision": 7,
        "occurred_at_ms": 1_000,
        "affected_cells_root": affected_cells_root,
        "issued_at_ms": 1_234,
        "campaign_id": format!("0x{}", "44".repeat(32)),
        "disaster_event_id": format!("0x{}", "55".repeat(32)),
        "census_checkpoint": 345,
        "affected_cells": affected_cells,
        "home_cell_events": [
            {
                "lineage": format!("0x{}", "11".repeat(32)),
                "home_cell": "10",
                "registered_at_ms": 900
            },
            {
                "lineage": format!("0x{}", "22".repeat(32)),
                "home_cell": "20",
                "registered_at_ms": 901
            }
        ],
        "active_lineages": [
            format!("0x{}", "11".repeat(32)),
            format!("0x{}", "22".repeat(32))
        ],
        "authenticated_event_proof": authenticated_event_proof_json()
    })
}

fn authenticated_event_proof_json() -> serde_json::Value {
    serde_json::json!({
        "protocol": "sui-authenticated-events-v1",
        "stream_id": format!("0x{}", "12".repeat(32)),
        "event_stream_head_object_id": format!("0x{}", "34".repeat(32)),
        "start_checkpoint": 0,
        "end_checkpoint": 345,
        "highest_indexed_checkpoint": 345,
        "checkpoint_summary_bcs": "c3VtbWFyeQ==",
        "checkpoint_signature_bcs": "c2lnbmF0dXJl",
        "event_stream_head": {
            "object_id": format!("0x{}", "34".repeat(32)),
            "version": "7",
            "digest": format!("0x{}", "56".repeat(32)),
            "object_bcs": "aGVhZA=="
        },
        "ocs_proof": {
            "leaf_index": 3,
            "tree_root": format!("0x{}", "78".repeat(32)),
            "merkle_proof": ["cHJvb2YtMQ=="]
        },
        "events": [
            {
                "checkpoint": 100,
                "transaction_index": 0,
                "event_index": 0,
                "type": format!("0x{}::membership::MembershipPassIssued", "12".repeat(32)),
                "event_bcs": "ZXZlbnQtMQ=="
            },
            {
                "checkpoint": 101,
                "transaction_index": 0,
                "event_index": 1,
                "type": format!("0x{}::membership::HomeCellRegistered", "12".repeat(32)),
                "event_bcs": "ZXZlbnQtMg=="
            }
        ]
    })
}
