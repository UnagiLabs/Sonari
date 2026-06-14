#[test_only]
module contracts::disaster_tests;

use contracts::admin;
use contracts::affected_cell;
use contracts::accessor;
use contracts::disaster_event;
use contracts::metadata_verifier;
use contracts::payload;
use contracts::reader;
use sui::bcs;
use sui::clock;
use sui::event;
use sui::test_scenario;

const ADMIN: address = @0xA11CE;
const RELAYER: address = @0xB0B;

const NOW_BEFORE_FRESHNESS_DEADLINE_MS: u64 = 1_704_170_000_000;
const EVENT_REVISION: u32 = 1;
const H3_INDEX: u64 = 608_819_013_597_790_207;
const GEO_RESOLUTION: u8 = 7;
const CELL_METRIC_USGS_MMI: u8 = 1;
const INTENSITY_VALUE: u16 = 723;
const INTENSITY_SCALE_MMI_X100: u8 = 1;
const CELL_BAND: u8 = 1;
const CELLS_GENERATION_METHOD: u8 = 1;
const ORACLE_VERSION: u64 = 1;
const SEVERITY_BAND: u8 = 3;
const SIGNATURE_SCHEME_ED25519: u8 = 1;
const OCCURRED_AT_MS: u64 = 1_704_067_200_000;
const VERIFIED_AT_MS: u64 = 1_704_151_200_000;
const FRESHNESS_DEADLINE_MS: u64 = 1_704_172_800_000;
const ENCLAVE_EXPIRES_AFTER_FRESHNESS_DEADLINE_MS: u64 = 1_704_172_800_001;
const EARTHQUAKE_V1_CONFIG_KEY: u64 = 1;

#[test]
fun affected_cell_leaf_hash_and_merkle_proof_match_fixture_vectors() {
    let leaf = accessor::new_affected_cell_leaf(
        event_uid(),
        EVENT_REVISION,
        H3_INDEX,
        GEO_RESOLUTION,
        CELL_METRIC_USGS_MMI,
        INTENSITY_VALUE,
        INTENSITY_SCALE_MMI_X100,
        CELL_BAND,
        CELLS_GENERATION_METHOD,
        ORACLE_VERSION,
    );
    let hash = affected_cell::leaf_hash(&leaf);
    assert!(
        hash == x"bc6630b4dcc0a7aab256c84b90d30d6d8eefbf6b8712767917ccbe6c603a303f",
    );

    let proof = vector[
        accessor::new_affected_cell_proof_step_left(
            x"83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f",
        ),
    ];
    assert!(affected_cell::verify_proof(&leaf, proof, affected_cells_root()));
}

#[test]
fun finalized_disaster_payload_decodes_and_creates_certificate_object() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_BEFORE_FRESHNESS_DEADLINE_MS);

    let payload = payload::decode_finalized(
        finalized_payload_bcs(),
        NOW_BEFORE_FRESHNESS_DEADLINE_MS,
    );
    let (
        intent,
        oracle_version,
        event_uid,
        event_revision,
        source_event_id,
        title,
        region,
        occurred_at_ms,
        hazard_type,
        status,
        severity_band,
        affected_cells_root,
        affected_cell_count,
        decoded_evidence_manifest_uri,
        decoded_evidence_manifest_hash,
        verified_at_ms,
        freshness_deadline_ms,
    ) = payload::payload_summary(&payload);

    assert!(intent == payload::intent_earthquake_oracle_payload());
    assert!(oracle_version == ORACLE_VERSION);
    assert!(event_uid == event_uid());
    assert!(hazard_type == payload::hazard_type_earthquake());
    assert!(status == payload::status_finalized());
    assert!(event_revision == EVENT_REVISION);
    assert!(source_event_id == b"us7000sonari");
    assert!(title == b"M 7.1 - Sonari Fixture Earthquake");
    assert!(region == b"Sonari Fixture Region");
    assert!(occurred_at_ms == OCCURRED_AT_MS);
    assert!(severity_band == SEVERITY_BAND);
    assert!(affected_cells_root == affected_cells_root());
    assert!(affected_cell_count == 2);
    assert!(decoded_evidence_manifest_uri == evidence_manifest_uri());
    assert!(decoded_evidence_manifest_hash == evidence_manifest_hash());
    assert!(verified_at_ms == VERIFIED_AT_MS);
    assert!(freshness_deadline_ms == FRESHNESS_DEADLINE_MS);

    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        register_oracle_enclave_for_testing(
            &cap,
            &mut verifier_registry,
            ENCLAVE_EXPIRES_AFTER_FRESHNESS_DEADLINE_MS,
            scenario.ctx(),
        );
        accessor::create_disaster_event_from_signed_payload(
            &mut registry,
            &verifier_registry,
            &clock,
            finalized_payload_bcs(),
            oracle_signature(),
            oracle_public_key(),
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(verifier_registry);
    };

    let events = event::events_by_type<disaster_event::DisasterEventCreated>();
    assert!(events.length() == 1);
    let (
        created_event_uid,
        revision,
        created_source_event_id,
        created_title,
        created_region,
        created_payload_hash,
        affected_root,
        affected_count,
        created_evidence_manifest_uri,
        created_evidence_manifest_hash,
        actor,
    ) =
        disaster_event::disaster_event_created_event_fields(*events.borrow(0));
    assert!(created_event_uid == event_uid());
    assert!(revision == EVENT_REVISION);
    assert!(created_source_event_id == b"us7000sonari".to_string());
    assert!(created_title == b"M 7.1 - Sonari Fixture Earthquake".to_string());
    assert!(created_region == b"Sonari Fixture Region".to_string());
    assert!(created_payload_hash == payload_bcs_hash());
    assert!(affected_root == affected_cells_root());
    assert!(affected_count == 2);
    assert!(created_evidence_manifest_uri == evidence_manifest_uri().to_string());
    assert!(created_evidence_manifest_hash == evidence_manifest_hash());
    assert!(actor == ADMIN);

    scenario.next_tx(ADMIN);
    {
        let disaster_event = scenario.take_shared<disaster_event::DisasterEvent>();
        let verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        let (
            object_event_uid,
            object_event_revision,
            object_source_event_id,
            object_title,
            object_region,
            object_occurred_at_ms,
            object_hazard_type,
            object_hazard_label,
            object_severity_band,
            object_oracle_version,
        ) = disaster_event::certificate_identity_for_testing(&disaster_event);
        assert!(object_event_uid == event_uid());
        assert!(object_event_revision == EVENT_REVISION);
        assert!(object_source_event_id == b"us7000sonari".to_string());
        assert!(object_title == b"M 7.1 - Sonari Fixture Earthquake".to_string());
        assert!(object_region == b"Sonari Fixture Region".to_string());
        assert!(object_occurred_at_ms == OCCURRED_AT_MS);
        assert!(object_hazard_type == payload::hazard_type_earthquake());
        assert!(object_hazard_label == b"Earthquake".to_string());
        assert!(object_severity_band == SEVERITY_BAND);
        assert!(object_oracle_version == ORACLE_VERSION);

        let (
            signature_scheme,
            verifier_public_key,
            signature,
            verifier_registry_id,
            verifier_config_key,
            verifier_config_version,
            enclave_instance_public_key,
        ) = disaster_event::certificate_verifier_for_testing(&disaster_event);
        assert!(signature_scheme == SIGNATURE_SCHEME_ED25519);
        assert!(verifier_public_key == oracle_public_key());
        assert!(signature == oracle_signature());
        assert!(verifier_registry_id == metadata_verifier::registry_id(&verifier_registry));
        assert!(verifier_config_key == EARTHQUAKE_V1_CONFIG_KEY);
        assert!(verifier_config_version == 1);
        assert!(enclave_instance_public_key == oracle_public_key());

        let (
            object_payload_bcs_hash,
            object_payload_bcs,
            object_verified_at_ms,
            object_freshness_deadline_ms,
            object_affected_cells_root,
            object_affected_cell_count,
            object_evidence_manifest_uri,
            object_evidence_manifest_hash,
        ) = disaster_event::certificate_evidence_for_testing(&disaster_event);
        assert!(object_payload_bcs_hash == payload_bcs_hash());
        assert!(object_payload_bcs == finalized_payload_bcs());
        assert!(object_verified_at_ms == VERIFIED_AT_MS);
        assert!(object_freshness_deadline_ms == FRESHNESS_DEADLINE_MS);
        assert!(object_affected_cells_root == affected_cells_root());
        assert!(object_affected_cell_count == 2);
        assert!(object_evidence_manifest_uri == evidence_manifest_uri().to_string());
        assert!(object_evidence_manifest_hash == evidence_manifest_hash());

        test_scenario::return_shared(disaster_event);
        test_scenario::return_shared(verifier_registry);
    };

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = metadata_verifier::EEnclaveInstanceNotRegistered)]
fun raw_earthquake_verifier_key_without_enclave_instance_is_rejected() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_BEFORE_FRESHNESS_DEADLINE_MS);
    let mut scenario = initialized_disaster_registry();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        admin::add_verifier_key(
            &cap,
            &mut verifier_registry,
            reader::verifier_family_earthquake_oracle(),
            reader::verifier_version_v1(),
            oracle_public_key(),
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(verifier_registry);
    };

    scenario.next_tx(RELAYER);
    {
        let mut disaster_registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        accessor::create_disaster_event_from_signed_payload(
            &mut disaster_registry,
            &verifier_registry,
            &clock,
            finalized_payload_bcs(),
            oracle_signature(),
            oracle_public_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(disaster_registry);
        test_scenario::return_shared(verifier_registry);
    };

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = metadata_verifier::EEnclaveInstanceDisabled)]
fun disabled_enclave_instance_is_rejected() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_BEFORE_FRESHNESS_DEADLINE_MS);
    let mut scenario = initialized_disaster_registry();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        register_oracle_enclave_for_testing(
            &cap,
            &mut verifier_registry,
            ENCLAVE_EXPIRES_AFTER_FRESHNESS_DEADLINE_MS,
            scenario.ctx(),
        );
        metadata_verifier::disable_enclave_instance_for_testing(
            &mut verifier_registry,
            oracle_public_key(),
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(verifier_registry);
    };

    scenario.next_tx(RELAYER);
    {
        let mut disaster_registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        accessor::create_disaster_event_from_signed_payload(
            &mut disaster_registry,
            &verifier_registry,
            &clock,
            finalized_payload_bcs(),
            oracle_signature(),
            oracle_public_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(disaster_registry);
        test_scenario::return_shared(verifier_registry);
    };

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = metadata_verifier::EEnclaveInstanceExpired)]
fun expired_enclave_instance_is_rejected_using_clock_timestamp() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_BEFORE_FRESHNESS_DEADLINE_MS);
    let mut scenario = initialized_disaster_registry();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        register_oracle_enclave_for_testing(
            &cap,
            &mut verifier_registry,
            NOW_BEFORE_FRESHNESS_DEADLINE_MS,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(verifier_registry);
    };

    scenario.next_tx(RELAYER);
    {
        let mut disaster_registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        accessor::create_disaster_event_from_signed_payload(
            &mut disaster_registry,
            &verifier_registry,
            &clock,
            finalized_payload_bcs(),
            oracle_signature(),
            oracle_public_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(disaster_registry);
        test_scenario::return_shared(verifier_registry);
    };

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = metadata_verifier::EEnclaveInstanceConfigMismatch)]
fun stale_enclave_instance_config_version_is_rejected_after_config_pcr_update() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_BEFORE_FRESHNESS_DEADLINE_MS);
    let mut scenario = initialized_disaster_registry();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        register_oracle_enclave_for_testing(
            &cap,
            &mut verifier_registry,
            ENCLAVE_EXPIRES_AFTER_FRESHNESS_DEADLINE_MS,
            scenario.ctx(),
        );
        admin::update_earthquake_verifier_config_pcrs(
            &cap,
            &mut verifier_registry,
            updated_pcr0(),
            updated_pcr1(),
            updated_pcr2(),
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(verifier_registry);
    };

    scenario.next_tx(RELAYER);
    {
        let mut disaster_registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        accessor::create_disaster_event_from_signed_payload(
            &mut disaster_registry,
            &verifier_registry,
            &clock,
            finalized_payload_bcs(),
            oracle_signature(),
            oracle_public_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(disaster_registry);
        test_scenario::return_shared(verifier_registry);
    };

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = payload::EExpiredFreshness)]
fun stale_disaster_payload_is_rejected() {
    payload::decode_finalized(
        finalized_payload_bcs(),
        FRESHNESS_DEADLINE_MS,
    );
}

#[test, expected_failure(abort_code = disaster_event::EPayloadTooLarge)]
fun oversized_signed_payload_bcs_is_rejected_before_signature_verification() {
    let mut payload = finalized_payload_bcs();
    let mut i = payload.length();
    while (i <= 4096) {
        payload.push_back(0);
        i = i + 1;
    };
    create_signed_event_with_payload(payload, oracle_signature());
}

#[test, expected_failure(abort_code = payload::EInvalidSourceEventIdLength)]
fun empty_source_event_id_is_rejected() {
    payload::decode_finalized(
        current_payload_bcs(
            b"",
            b"M 7.1 - Sonari Fixture Earthquake",
            b"Sonari Fixture Region",
            evidence_manifest_uri(),
            EVENT_REVISION,
            2,
            FRESHNESS_DEADLINE_MS,
        ),
        NOW_BEFORE_FRESHNESS_DEADLINE_MS,
    );
}

#[test, expected_failure(abort_code = payload::EInvalidEvidenceManifestUriLength)]
fun oversized_evidence_manifest_uri_is_rejected() {
    payload::decode_finalized(
        current_payload_bcs(
            b"us7000sonari",
            b"M 7.1 - Sonari Fixture Earthquake",
            b"Sonari Fixture Region",
            repeat_byte(513, 0x61),
            EVENT_REVISION,
            2,
            FRESHNESS_DEADLINE_MS,
        ),
        NOW_BEFORE_FRESHNESS_DEADLINE_MS,
    );
}

#[test, expected_failure(abort_code = payload::EInvalidFreshnessDeadline)]
fun freshness_deadline_must_be_after_verified_at() {
    payload::decode_finalized(
        current_payload_bcs(
            b"us7000sonari",
            b"M 7.1 - Sonari Fixture Earthquake",
            b"Sonari Fixture Region",
            evidence_manifest_uri(),
            EVENT_REVISION,
            2,
            VERIFIED_AT_MS,
        ),
        1_704_000_000_000,
    );
}

#[test, expected_failure(abort_code = payload::EInvalidFreshnessDeadline)]
fun freshness_deadline_must_match_current_window() {
    payload::decode_finalized(
        current_payload_bcs(
            b"us7000sonari",
            b"M 7.1 - Sonari Fixture Earthquake",
            b"Sonari Fixture Region",
            evidence_manifest_uri(),
            EVENT_REVISION,
            2,
            FRESHNESS_DEADLINE_MS + 1,
        ),
        NOW_BEFORE_FRESHNESS_DEADLINE_MS,
    );
}

#[test, expected_failure(abort_code = payload::ETrailingBytes)]
fun trailing_payload_bytes_are_rejected() {
    let mut payload = finalized_payload_bcs();
    payload.push_back(0);
    payload::decode_finalized(payload, NOW_BEFORE_FRESHNESS_DEADLINE_MS);
}

#[test, expected_failure(abort_code = payload::EInvalidSeverityBand)]
fun severity_band_zero_is_rejected() {
    assert_mutated_payload_is_rejected(124, 0);
}

#[test, expected_failure(abort_code = payload::EUnsupportedHazardType)]
fun non_earthquake_disaster_payload_is_rejected() {
    let mut bytes = finalized_payload_bcs();
    *bytes.borrow_mut(122) = 2;
    payload::decode_finalized(
        bytes,
        NOW_BEFORE_FRESHNESS_DEADLINE_MS,
    );
}

#[test, expected_failure(abort_code = payload::EInvalidEventRevision)]
fun zero_event_revision_is_rejected() {
    let mut bytes = finalized_payload_bcs();
    *bytes.borrow_mut(41) = 0;
    payload::decode_finalized(
        bytes,
        NOW_BEFORE_FRESHNESS_DEADLINE_MS,
    );
}

#[test, expected_failure(abort_code = payload::EInvalidAffectedCellCount)]
fun zero_affected_cell_count_is_rejected() {
    payload::decode_finalized(
        current_payload_bcs(
            b"us7000sonari",
            b"M 7.1 - Sonari Fixture Earthquake",
            b"Sonari Fixture Region",
            evidence_manifest_uri(),
            EVENT_REVISION,
            0,
            FRESHNESS_DEADLINE_MS,
        ),
        NOW_BEFORE_FRESHNESS_DEADLINE_MS,
    );
}

#[test, expected_failure]
fun short_evidence_manifest_hash_payload_is_rejected() {
    payload::decode_finalized(
        current_payload_bcs_with_evidence_hash(
            b"us7000sonari",
            b"M 7.1 - Sonari Fixture Earthquake",
            b"Sonari Fixture Region",
            evidence_manifest_uri(),
            repeat_byte(31, 0x11),
            EVENT_REVISION,
            2,
            FRESHNESS_DEADLINE_MS,
        ),
        NOW_BEFORE_FRESHNESS_DEADLINE_MS,
    );
}

#[test, expected_failure(abort_code = disaster_event::EDuplicateDisasterEvent)]
fun duplicate_disaster_event_uid_and_revision_is_rejected() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_BEFORE_FRESHNESS_DEADLINE_MS);
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        register_oracle_enclave_for_testing(
            &cap,
            &mut verifier_registry,
            ENCLAVE_EXPIRES_AFTER_FRESHNESS_DEADLINE_MS,
            scenario.ctx(),
        );
        accessor::create_disaster_event_from_signed_payload(
            &mut registry,
            &verifier_registry,
            &clock,
            finalized_payload_bcs(),
            oracle_signature(),
            oracle_public_key(),
            scenario.ctx(),
        );
        accessor::create_disaster_event_from_signed_payload(
            &mut registry,
            &verifier_registry,
            &clock,
            finalized_payload_bcs(),
            oracle_signature(),
            oracle_public_key(),
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(verifier_registry);
    };

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = disaster_event::EStaleDisasterEventRevision)]
fun stale_disaster_event_revision_is_rejected_after_newer_revision() {
    let mut scenario = initialized_disaster_registry();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let revision_2_payload = payload::decode_finalized(
            revision_payload_bcs(2),
            NOW_BEFORE_FRESHNESS_DEADLINE_MS,
        );
        let revision_1_payload = payload::decode_finalized(
            revision_payload_bcs(1),
            NOW_BEFORE_FRESHNESS_DEADLINE_MS,
        );
        disaster_event::create_from_payload_for_testing(
            &mut registry,
            revision_2_payload,
            scenario.ctx(),
        );
        disaster_event::create_from_payload_for_testing(
            &mut registry,
            revision_1_payload,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

#[test]
fun relayer_without_admin_cap_can_submit_registered_signed_payload() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_BEFORE_FRESHNESS_DEADLINE_MS);
    let mut scenario = initialized_disaster_registry();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        register_oracle_enclave_for_testing(
            &cap,
            &mut verifier_registry,
            ENCLAVE_EXPIRES_AFTER_FRESHNESS_DEADLINE_MS,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(verifier_registry);
    };

    scenario.next_tx(RELAYER);
    {
        assert!(!scenario.has_most_recent_for_sender<admin::AdminCap>());
        let mut disaster_registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        accessor::create_disaster_event_from_signed_payload(
            &mut disaster_registry,
            &verifier_registry,
            &clock,
            finalized_payload_bcs(),
            oracle_signature(),
            oracle_public_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(disaster_registry);
        test_scenario::return_shared(verifier_registry);
    };

    let events = event::events_by_type<disaster_event::DisasterEventCreated>();
    let (_, _, _, _, _, _, _, _, _, _, actor) =
        disaster_event::disaster_event_created_event_fields(*events.borrow(0));
    assert!(actor == RELAYER);

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = payload::EExpiredFreshness)]
fun signed_payload_freshness_uses_clock_timestamp() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(1_704_172_800_000);
    let mut scenario = initialized_disaster_registry();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        register_oracle_enclave_for_testing(
            &cap,
            &mut verifier_registry,
            ENCLAVE_EXPIRES_AFTER_FRESHNESS_DEADLINE_MS,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(verifier_registry);
    };

    scenario.next_tx(RELAYER);
    {
        let mut disaster_registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        accessor::create_disaster_event_from_signed_payload(
            &mut disaster_registry,
            &verifier_registry,
            &clock,
            finalized_payload_bcs(),
            oracle_signature(),
            oracle_public_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(disaster_registry);
        test_scenario::return_shared(verifier_registry);
    };

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = metadata_verifier::EEnclaveInstanceNotRegistered)]
fun disabled_raw_earthquake_oracle_key_without_enclave_instance_is_rejected() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_BEFORE_FRESHNESS_DEADLINE_MS);
    let mut scenario = initialized_disaster_registry();
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut disaster_registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        admin::add_verifier_key(
            &cap,
            &mut verifier_registry,
            reader::verifier_family_earthquake_oracle(),
            reader::verifier_version_v1(),
            oracle_public_key(),
            scenario.ctx(),
        );
        admin::disable_verifier_key(
            &cap,
            &mut verifier_registry,
            oracle_public_key(),
            scenario.ctx(),
        );
        accessor::create_disaster_event_from_signed_payload(
            &mut disaster_registry,
            &verifier_registry,
            &clock,
            finalized_payload_bcs(),
            oracle_signature(),
            oracle_public_key(),
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(disaster_registry);
        test_scenario::return_shared(verifier_registry);
    };
    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = metadata_verifier::EEnclaveInstanceNotRegistered)]
fun wrong_raw_earthquake_oracle_key_family_without_enclave_instance_is_rejected() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_BEFORE_FRESHNESS_DEADLINE_MS);
    let mut scenario = initialized_disaster_registry();
    scenario.next_tx(ADMIN);
    {
        let mut disaster_registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        metadata_verifier::add_verifier_key_unchecked_for_testing(
            &mut verifier_registry,
            1,
            reader::verifier_version_v1(),
            oracle_public_key(),
            scenario.ctx(),
        );
        accessor::create_disaster_event_from_signed_payload(
            &mut disaster_registry,
            &verifier_registry,
            &clock,
            finalized_payload_bcs(),
            oracle_signature(),
            oracle_public_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(disaster_registry);
        test_scenario::return_shared(verifier_registry);
    };
    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = metadata_verifier::EEnclaveInstanceNotRegistered)]
fun wrong_raw_earthquake_oracle_key_version_without_enclave_instance_is_rejected() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_BEFORE_FRESHNESS_DEADLINE_MS);
    let mut scenario = initialized_disaster_registry();
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut disaster_registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        metadata_verifier::add_verifier_key_unchecked_for_testing(
            &mut verifier_registry,
            reader::verifier_family_earthquake_oracle(),
            2,
            oracle_public_key(),
            scenario.ctx(),
        );
        accessor::create_disaster_event_from_signed_payload(
            &mut disaster_registry,
            &verifier_registry,
            &clock,
            finalized_payload_bcs(),
            oracle_signature(),
            oracle_public_key(),
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(disaster_registry);
        test_scenario::return_shared(verifier_registry);
    };
    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = metadata_verifier::EInvalidSignature)]
fun tampered_disaster_payload_is_rejected() {
    let mut payload = finalized_payload_bcs();
    *payload.borrow_mut(41) = 2;
    create_signed_event_with_payload(payload, oracle_signature());
}

#[test, expected_failure(abort_code = metadata_verifier::EInvalidSignature)]
fun invalid_disaster_payload_signature_is_rejected() {
    let mut signature = oracle_signature();
    *signature.borrow_mut(0) = 0;
    create_signed_event_with_payload(finalized_payload_bcs(), signature);
}

fun initialized_disaster_registry(): test_scenario::Scenario {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    scenario
}

fun create_signed_event_with_payload(payload_bcs: vector<u8>, signature: vector<u8>) {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_BEFORE_FRESHNESS_DEADLINE_MS);
    let mut scenario = initialized_disaster_registry();
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut disaster_registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        register_oracle_enclave_for_testing(
            &cap,
            &mut verifier_registry,
            ENCLAVE_EXPIRES_AFTER_FRESHNESS_DEADLINE_MS,
            scenario.ctx(),
        );
        accessor::create_disaster_event_from_signed_payload(
            &mut disaster_registry,
            &verifier_registry,
            &clock,
            payload_bcs,
            signature,
            oracle_public_key(),
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(disaster_registry);
        test_scenario::return_shared(verifier_registry);
    };
    scenario.end();
    clock.destroy_for_testing();
}

fun register_oracle_enclave_for_testing(
    cap: &admin::AdminCap,
    verifier_registry: &mut metadata_verifier::VerifierRegistry,
    expires_at_ms: u64,
    ctx: &mut TxContext,
) {
    admin::create_earthquake_verifier_config(
        cap,
        verifier_registry,
        valid_pcr0(),
        valid_pcr1(),
        valid_pcr2(),
        ctx,
    );
    metadata_verifier::add_enclave_instance_for_testing(
        verifier_registry,
        oracle_public_key(),
        expires_at_ms,
        ctx,
    );
}

fun assert_mutated_payload_is_rejected(offset: u64, value: u8) {
    let mut bytes = finalized_payload_bcs();
    *bytes.borrow_mut(offset) = value;
    payload::decode_finalized(
        bytes,
        NOW_BEFORE_FRESHNESS_DEADLINE_MS,
    );
}

fun event_uid(): vector<u8> {
    x"ab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd"
}

fun affected_cells_root(): vector<u8> {
    x"526e982479c985a009227facabf22c6d7633110fb1a15a743b453218f7f1890f"
}

fun evidence_manifest_uri(): vector<u8> {
    b"ipfs://sonari/examples/us7000sonari/evidence_manifest.json"
}

fun evidence_manifest_hash(): vector<u8> {
    x"b2a52d7769fb2c83fc0f2be97eb52015d7108dbb703a94821152b045d802f28e"
}

fun payload_bcs_hash(): vector<u8> {
    x"f6ed29eebca36304d11a0952450290f40d7fac100e1e84e39b86c57852ba317a"
}

fun oracle_public_key(): vector<u8> {
    x"ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c"
}

fun oracle_signature(): vector<u8> {
    x"2871e8bd0bbb1bd466e90599291bc7e3a07585f7940102203b347363223ac15e44ada20d27acd0b87eb2c310a9778c916e86d49f24603706a436927c3edd1100"
}

fun valid_pcr0(): vector<u8> {
    x"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f30"
}

fun valid_pcr1(): vector<u8> {
    x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}

fun valid_pcr2(): vector<u8> {
    x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}

fun updated_pcr0(): vector<u8> {
    x"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
}

fun updated_pcr1(): vector<u8> {
    x"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
}

fun updated_pcr2(): vector<u8> {
    x"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
}

fun finalized_payload_bcs(): vector<u8> {
    x"010100000000000000ab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd010000000c757337303030736f6e617269214d20372e31202d20536f6e61726920466978747572652045617274687175616b6515536f6e617269204669787475726520526567696f6e00f451c28c010000010303526e982479c985a009227facabf22c6d7633110fb1a15a743b453218f7f1890f02000000000000003a697066733a2f2f736f6e6172692f6578616d706c65732f757337303030736f6e6172692f65766964656e63655f6d616e69666573742e6a736f6eb2a52d7769fb2c83fc0f2be97eb52015d7108dbb703a94821152b045d802f28e00b153c78c01000000489dc88c010000"
}

fun revision_payload_bcs(revision: u8): vector<u8> {
    let mut bytes = finalized_payload_bcs();
    *bytes.borrow_mut(41) = revision;
    bytes
}

fun repeat_byte(count: u64, byte: u8): vector<u8> {
    let mut bytes = vector[];
    let mut i = 0;
    while (i < count) {
        bytes.push_back(byte);
        i = i + 1;
    };
    bytes
}

fun current_payload_bcs(
    source_event_id: vector<u8>,
    title: vector<u8>,
    region: vector<u8>,
    evidence_manifest_uri: vector<u8>,
    event_revision: u32,
    affected_cell_count: u64,
    freshness_deadline_ms: u64,
): vector<u8> {
    current_payload_bcs_with_evidence_hash(
        source_event_id,
        title,
        region,
        evidence_manifest_uri,
        evidence_manifest_hash(),
        event_revision,
        affected_cell_count,
        freshness_deadline_ms,
    )
}

fun current_payload_bcs_with_evidence_hash(
    source_event_id: vector<u8>,
    title: vector<u8>,
    region: vector<u8>,
    evidence_manifest_uri: vector<u8>,
    evidence_manifest_hash: vector<u8>,
    event_revision: u32,
    affected_cell_count: u64,
    freshness_deadline_ms: u64,
): vector<u8> {
    let mut bytes = vector[];
    let oracle_version = ORACLE_VERSION;
    let occurred_at_ms = OCCURRED_AT_MS;
    let verified_at_ms = VERIFIED_AT_MS;
    bytes.push_back(payload::intent_earthquake_oracle_payload());
    bytes.append(bcs::to_bytes(&oracle_version));
    bytes.append(event_uid());
    bytes.append(bcs::to_bytes(&event_revision));
    bytes.append(bcs::to_bytes(&source_event_id));
    bytes.append(bcs::to_bytes(&title));
    bytes.append(bcs::to_bytes(&region));
    bytes.append(bcs::to_bytes(&occurred_at_ms));
    bytes.push_back(payload::hazard_type_earthquake());
    bytes.push_back(payload::status_finalized());
    bytes.push_back(SEVERITY_BAND);
    bytes.append(affected_cells_root());
    bytes.append(bcs::to_bytes(&affected_cell_count));
    bytes.append(bcs::to_bytes(&evidence_manifest_uri));
    bytes.append(evidence_manifest_hash);
    bytes.append(bcs::to_bytes(&verified_at_ms));
    bytes.append(bcs::to_bytes(&freshness_deadline_ms));
    bytes
}
