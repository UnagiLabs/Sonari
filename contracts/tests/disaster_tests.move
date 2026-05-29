#[test_only]
module contracts::disaster_tests;

use contracts::admin;
use contracts::affected_cell;
use contracts::disaster_event;
use contracts::metadata_verifier;
use contracts::payload_v1;
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
const PRIMARY_SOURCE_USGS: u8 = 1;
const SEVERITY_BAND: u8 = 3;
const SIGNATURE_SCHEME_ED25519: u8 = 1;
const MAGNITUDE_X100: u64 = 710;
const OCCURRED_AT_MS: u64 = 1_704_067_200_000;
const VERIFIED_AT_MS: u64 = 1_704_151_200_000;
const SOURCE_UPDATED_AT_MS: u64 = 1_704_151_200_000;
const FRESHNESS_DEADLINE_MS: u64 = 1_704_172_800_000;

#[test]
fun affected_cell_leaf_hash_and_merkle_proof_match_fixture_vectors() {
    let leaf = affected_cell::new_leaf(
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
        affected_cell::new_proof_step_left(
            x"83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f",
        ),
    ];
    assert!(affected_cell::verify_proof(&leaf, proof, affected_cells_root()));
}

#[test]
fun finalized_disaster_payload_decodes_and_creates_certificate_object() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_BEFORE_FRESHNESS_DEADLINE_MS);

    let payload = payload_v1::decode_finalized(
        finalized_payload_bcs(),
        NOW_BEFORE_FRESHNESS_DEADLINE_MS,
    );
    let (
        intent,
        oracle_version,
        event_uid,
        hazard_type,
        status,
        event_revision,
        source_event_id,
        title,
        region,
        magnitude_x100,
        verified_at_ms,
        source_updated_at_ms,
        primary_source,
        severity_band,
        affected_cells_root,
        affected_cell_count,
    ) = payload_v1::payload_summary(&payload);

    assert!(intent == payload_v1::intent_earthquake_oracle_payload_v1());
    assert!(oracle_version == ORACLE_VERSION);
    assert!(event_uid == event_uid());
    assert!(hazard_type == payload_v1::hazard_type_earthquake());
    assert!(status == payload_v1::status_finalized());
    assert!(event_revision == EVENT_REVISION);
    assert!(source_event_id == b"us7000sonari");
    assert!(title == b"M 7.1 - Sonari Fixture Earthquake");
    assert!(region == b"Sonari Fixture Region");
    assert!(magnitude_x100 == MAGNITUDE_X100);
    assert!(verified_at_ms == VERIFIED_AT_MS);
    assert!(source_updated_at_ms == SOURCE_UPDATED_AT_MS);
    assert!(primary_source == PRIMARY_SOURCE_USGS);
    assert!(severity_band == SEVERITY_BAND);
    assert!(affected_cells_root == affected_cells_root());
    assert!(affected_cell_count == 2);

    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    {
        disaster_event::create_disaster_registry(scenario.ctx());
    };

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        admin::add_verifier_key(
            &cap,
            &mut verifier_registry,
            metadata_verifier::verifier_family_earthquake_oracle(),
            metadata_verifier::verifier_version_v1(),
            oracle_public_key(),
            scenario.ctx(),
        );
        disaster_event::create_from_signed_payload(
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
        actor,
    ) =
        disaster_event::disaster_event_created_event_fields(*events.borrow(0));
    assert!(created_event_uid == event_uid());
    assert!(revision == EVENT_REVISION);
    assert!(created_source_event_id == b"us7000sonari");
    assert!(created_title == b"M 7.1 - Sonari Fixture Earthquake");
    assert!(created_region == b"Sonari Fixture Region");
    assert!(created_payload_hash == payload_bcs_hash());
    assert!(affected_root == affected_cells_root());
    assert!(affected_count == 2);
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
            object_magnitude_x100,
            object_primary_source,
            object_hazard_type,
            object_oracle_version,
        ) = disaster_event::certificate_identity_for_testing(&disaster_event);
        assert!(object_event_uid == event_uid());
        assert!(object_event_revision == EVENT_REVISION);
        assert!(object_source_event_id == b"us7000sonari");
        assert!(object_title == b"M 7.1 - Sonari Fixture Earthquake");
        assert!(object_region == b"Sonari Fixture Region");
        assert!(object_occurred_at_ms == OCCURRED_AT_MS);
        assert!(object_magnitude_x100 == MAGNITUDE_X100);
        assert!(object_primary_source == PRIMARY_SOURCE_USGS);
        assert!(object_hazard_type == payload_v1::hazard_type_earthquake());
        assert!(object_oracle_version == ORACLE_VERSION);

        let (
            signature_scheme,
            verifier_public_key,
            signature,
            verifier_registry_id,
        ) = disaster_event::certificate_verifier_for_testing(&disaster_event);
        assert!(signature_scheme == SIGNATURE_SCHEME_ED25519);
        assert!(verifier_public_key == oracle_public_key());
        assert!(signature == oracle_signature());
        assert!(verifier_registry_id == metadata_verifier::registry_id(&verifier_registry));

        let (
            object_payload_bcs_hash,
            object_payload_bcs,
            object_verified_at_ms,
            object_source_updated_at_ms,
            object_freshness_deadline_ms,
            object_source_set_hash,
            object_raw_data_hash,
            object_raw_data_uri,
            object_affected_cells_root,
            object_affected_cells_data_hash,
            object_affected_cells_uri,
            object_affected_cell_count,
        ) = disaster_event::certificate_evidence_for_testing(&disaster_event);
        assert!(object_payload_bcs_hash == payload_bcs_hash());
        assert!(object_payload_bcs == finalized_payload_bcs());
        assert!(object_verified_at_ms == VERIFIED_AT_MS);
        assert!(object_source_updated_at_ms == SOURCE_UPDATED_AT_MS);
        assert!(object_freshness_deadline_ms == FRESHNESS_DEADLINE_MS);
        assert!(object_source_set_hash == source_set_hash());
        assert!(object_raw_data_hash == raw_data_hash());
        assert!(object_raw_data_uri == raw_data_uri());
        assert!(object_affected_cells_root == affected_cells_root());
        assert!(object_affected_cells_data_hash == affected_cells_data_hash());
        assert!(object_affected_cells_uri == affected_cells_uri());
        assert!(object_affected_cell_count == 2);

        test_scenario::return_shared(disaster_event);
        test_scenario::return_shared(verifier_registry);
    };

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = payload_v1::EExpiredFreshness)]
fun stale_disaster_payload_is_rejected() {
    payload_v1::decode_finalized(
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

#[test, expected_failure(abort_code = payload_v1::EInvalidSourceEventIdLength)]
fun empty_source_event_id_is_rejected() {
    payload_v1::decode_finalized(
        current_payload_bcs(
            b"",
            b"M 7.1 - Sonari Fixture Earthquake",
            b"Sonari Fixture Region",
            raw_data_uri(),
            affected_cells_uri(),
            EVENT_REVISION,
            MAGNITUDE_X100,
            2,
            FRESHNESS_DEADLINE_MS,
        ),
        NOW_BEFORE_FRESHNESS_DEADLINE_MS,
    );
}

#[test, expected_failure(abort_code = payload_v1::EInvalidRawDataUriLength)]
fun oversized_raw_data_uri_is_rejected() {
    payload_v1::decode_finalized(
        current_payload_bcs(
            b"us7000sonari",
            b"M 7.1 - Sonari Fixture Earthquake",
            b"Sonari Fixture Region",
            repeat_byte(513, 0x61),
            affected_cells_uri(),
            EVENT_REVISION,
            MAGNITUDE_X100,
            2,
            FRESHNESS_DEADLINE_MS,
        ),
        NOW_BEFORE_FRESHNESS_DEADLINE_MS,
    );
}

#[test, expected_failure(abort_code = payload_v1::EInvalidFreshnessDeadline)]
fun freshness_deadline_must_be_after_verified_at() {
    payload_v1::decode_finalized(
        current_payload_bcs(
            b"us7000sonari",
            b"M 7.1 - Sonari Fixture Earthquake",
            b"Sonari Fixture Region",
            raw_data_uri(),
            affected_cells_uri(),
            EVENT_REVISION,
            MAGNITUDE_X100,
            2,
            VERIFIED_AT_MS,
        ),
        1_704_000_000_000,
    );
}

#[test, expected_failure(abort_code = payload_v1::ETrailingBytes)]
fun trailing_payload_bytes_are_rejected() {
    let mut payload = finalized_payload_bcs();
    payload.push_back(0);
    payload_v1::decode_finalized(payload, NOW_BEFORE_FRESHNESS_DEADLINE_MS);
}

#[test, expected_failure(abort_code = payload_v1::EUnsupportedPrimarySource)]
fun unsupported_primary_source_is_rejected() {
    assert_mutated_payload_is_rejected(148, 2);
}

#[test, expected_failure(abort_code = payload_v1::EInvalidSeverityBand)]
fun severity_band_zero_is_rejected() {
    assert_mutated_payload_is_rejected(149, 0);
}

#[test, expected_failure(abort_code = payload_v1::EUnsupportedCellsGenerationMethod)]
fun unsupported_cells_generation_method_is_rejected() {
    assert_mutated_payload_is_rejected(402, 3);
}

#[test, expected_failure(abort_code = payload_v1::EUnsupportedCellMetric)]
fun unsupported_cell_metric_is_rejected() {
    assert_mutated_payload_is_rejected(403, 2);
}

#[test, expected_failure(abort_code = payload_v1::EUnsupportedCellAggregation)]
fun unsupported_cell_aggregation_is_rejected() {
    assert_mutated_payload_is_rejected(404, 2);
}

#[test, expected_failure(abort_code = payload_v1::EUnsupportedIntensityScale)]
fun unsupported_intensity_scale_is_rejected() {
    assert_mutated_payload_is_rejected(405, 2);
}

#[test, expected_failure(abort_code = payload_v1::EUnsupportedHazardType)]
fun non_earthquake_disaster_payload_is_rejected() {
    let mut bytes = finalized_payload_bcs();
    *bytes.borrow_mut(41) = 2;
    payload_v1::decode_finalized(
        bytes,
        NOW_BEFORE_FRESHNESS_DEADLINE_MS,
    );
}

#[test, expected_failure(abort_code = payload_v1::EUnsupportedGeoResolution)]
fun wrong_geo_resolution_disaster_payload_is_rejected() {
    let mut bytes = finalized_payload_bcs();
    *bytes.borrow_mut(401) = 6;
    payload_v1::decode_finalized(
        bytes,
        NOW_BEFORE_FRESHNESS_DEADLINE_MS,
    );
}

#[test, expected_failure(abort_code = payload_v1::EInvalidEventRevision)]
fun zero_event_revision_is_rejected() {
    let mut bytes = finalized_payload_bcs();
    *bytes.borrow_mut(43) = 0;
    payload_v1::decode_finalized(
        bytes,
        NOW_BEFORE_FRESHNESS_DEADLINE_MS,
    );
}

#[test, expected_failure(abort_code = payload_v1::EInvalidMagnitude)]
fun zero_magnitude_is_rejected() {
    payload_v1::decode_finalized(
        current_payload_bcs(
            b"us7000sonari",
            b"M 7.1 - Sonari Fixture Earthquake",
            b"Sonari Fixture Region",
            raw_data_uri(),
            affected_cells_uri(),
            EVENT_REVISION,
            0,
            2,
            FRESHNESS_DEADLINE_MS,
        ),
        NOW_BEFORE_FRESHNESS_DEADLINE_MS,
    );
}

#[test, expected_failure(abort_code = payload_v1::EInvalidAffectedCellCount)]
fun zero_affected_cell_count_is_rejected() {
    payload_v1::decode_finalized(
        current_payload_bcs(
            b"us7000sonari",
            b"M 7.1 - Sonari Fixture Earthquake",
            b"Sonari Fixture Region",
            raw_data_uri(),
            affected_cells_uri(),
            EVENT_REVISION,
            MAGNITUDE_X100,
            0,
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
        disaster_event::create_disaster_registry(scenario.ctx());
    };

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        admin::add_verifier_key(
            &cap,
            &mut verifier_registry,
            metadata_verifier::verifier_family_earthquake_oracle(),
            metadata_verifier::verifier_version_v1(),
            oracle_public_key(),
            scenario.ctx(),
        );
        disaster_event::create_from_signed_payload(
            &mut registry,
            &verifier_registry,
            &clock,
            finalized_payload_bcs(),
            oracle_signature(),
            oracle_public_key(),
            scenario.ctx(),
        );
        disaster_event::create_from_signed_payload(
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
        let revision_2_payload = payload_v1::decode_finalized(
            revision_payload_bcs(2),
            NOW_BEFORE_FRESHNESS_DEADLINE_MS,
        );
        let revision_1_payload = payload_v1::decode_finalized(
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
        admin::add_verifier_key(
            &cap,
            &mut verifier_registry,
            metadata_verifier::verifier_family_earthquake_oracle(),
            metadata_verifier::verifier_version_v1(),
            oracle_public_key(),
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
        disaster_event::create_from_signed_payload(
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
    let (_, _, _, _, _, _, _, _, actor) =
        disaster_event::disaster_event_created_event_fields(*events.borrow(0));
    assert!(actor == RELAYER);

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = payload_v1::EExpiredFreshness)]
fun signed_payload_freshness_uses_clock_timestamp() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(1_704_172_800_000);
    let mut scenario = initialized_disaster_registry();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        admin::add_verifier_key(
            &cap,
            &mut verifier_registry,
            metadata_verifier::verifier_family_earthquake_oracle(),
            metadata_verifier::verifier_version_v1(),
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
        disaster_event::create_from_signed_payload(
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

#[test, expected_failure(abort_code = metadata_verifier::EVerifierKeyDisabled)]
fun disabled_earthquake_oracle_key_is_rejected() {
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
            metadata_verifier::verifier_family_earthquake_oracle(),
            metadata_verifier::verifier_version_v1(),
            oracle_public_key(),
            scenario.ctx(),
        );
        admin::disable_verifier_key(
            &cap,
            &mut verifier_registry,
            oracle_public_key(),
            scenario.ctx(),
        );
        disaster_event::create_from_signed_payload(
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

#[test, expected_failure(abort_code = metadata_verifier::EVerifierFamilyMismatch)]
fun wrong_earthquake_oracle_key_family_is_rejected() {
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
            metadata_verifier::verifier_version_v1(),
            oracle_public_key(),
            scenario.ctx(),
        );
        disaster_event::create_from_signed_payload(
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

#[test, expected_failure(abort_code = metadata_verifier::EVerifierVersionMismatch)]
fun wrong_earthquake_oracle_key_version_is_rejected() {
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
            metadata_verifier::verifier_family_earthquake_oracle(),
            2,
            oracle_public_key(),
            scenario.ctx(),
        );
        disaster_event::create_from_signed_payload(
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
    {
        disaster_event::create_disaster_registry(scenario.ctx());
    };

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
        admin::add_verifier_key(
            &cap,
            &mut verifier_registry,
            metadata_verifier::verifier_family_earthquake_oracle(),
            metadata_verifier::verifier_version_v1(),
            oracle_public_key(),
            scenario.ctx(),
        );
        disaster_event::create_from_signed_payload(
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

fun assert_mutated_payload_is_rejected(offset: u64, value: u8) {
    let mut bytes = finalized_payload_bcs();
    *bytes.borrow_mut(offset) = value;
    payload_v1::decode_finalized(
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

fun source_set_hash(): vector<u8> {
    x"06fc83f3519bc43798fb3e8a285445d3a2f267d79796d73cea1099e9de1333ad"
}

fun raw_data_hash(): vector<u8> {
    x"ecd638ae8aea66d2a8ee5b486c39dc8e71f9d342697549e66381397909a7b0a9"
}

fun raw_data_uri(): vector<u8> {
    b"ipfs://sonari/examples/us7000sonari/raw_data_manifest.json"
}

fun affected_cells_uri(): vector<u8> {
    b"ipfs://sonari/examples/us7000sonari/affected_cells.json"
}

fun affected_cells_data_hash(): vector<u8> {
    x"c3bb6d3a0ba176465f91024bf73aa89c1ba45aaa4f739a93288f2cbcafdb30bc"
}

fun payload_bcs_hash(): vector<u8> {
    x"1758945e0c59cd5fe4d77bdbc628d9730d752beb8011dcb57936aae71e1cec42"
}

fun oracle_public_key(): vector<u8> {
    x"ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c"
}

fun oracle_signature(): vector<u8> {
    x"16cc2bce20f532dc9396dc62903ebc65abccb97221e72a75415cf6fc707fd0a285a761144db877f9ad1bc276aaeaec24f164583239dce269b766fe0c4d2a7708"
}

fun finalized_payload_bcs(): vector<u8> {
    x"010100000000000000ab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd0103010000000c757337303030736f6e617269214d20372e31202d20536f6e61726920466978747572652045617274687175616b6515536f6e617269204669787475726520526567696f6e00f451c28c010000c60200000000000000b153c78c01000000b153c78c010000010306fc83f3519bc43798fb3e8a285445d3a2f267d79796d73cea1099e9de1333adecd638ae8aea66d2a8ee5b486c39dc8e71f9d342697549e66381397909a7b0a93a697066733a2f2f736f6e6172692f6578616d706c65732f757337303030736f6e6172692f7261775f646174615f6d616e69666573742e6a736f6e526e982479c985a009227facabf22c6d7633110fb1a15a743b453218f7f1890f37697066733a2f2f736f6e6172692f6578616d706c65732f757337303030736f6e6172692f61666665637465645f63656c6c732e6a736f6ec3bb6d3a0ba176465f91024bf73aa89c1ba45aaa4f739a93288f2cbcafdb30bc0200000000000000070101010100489dc88c010000"
}

fun revision_payload_bcs(revision: u8): vector<u8> {
    let mut bytes = finalized_payload_bcs();
    *bytes.borrow_mut(43) = revision;
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
    raw_data_uri: vector<u8>,
    affected_cells_uri: vector<u8>,
    event_revision: u32,
    magnitude_x100: u64,
    affected_cell_count: u64,
    freshness_deadline_ms: u64,
): vector<u8> {
    let mut bytes = vector[];
    let oracle_version = ORACLE_VERSION;
    let occurred_at_ms = OCCURRED_AT_MS;
    let verified_at_ms = VERIFIED_AT_MS;
    let source_updated_at_ms = SOURCE_UPDATED_AT_MS;
    bytes.push_back(payload_v1::intent_earthquake_oracle_payload_v1());
    bytes.append(bcs::to_bytes(&oracle_version));
    bytes.append(event_uid());
    bytes.push_back(payload_v1::hazard_type_earthquake());
    bytes.push_back(payload_v1::status_finalized());
    bytes.append(bcs::to_bytes(&event_revision));
    bytes.append(bcs::to_bytes(&source_event_id));
    bytes.append(bcs::to_bytes(&title));
    bytes.append(bcs::to_bytes(&region));
    bytes.append(bcs::to_bytes(&occurred_at_ms));
    bytes.append(bcs::to_bytes(&magnitude_x100));
    bytes.append(bcs::to_bytes(&verified_at_ms));
    bytes.append(bcs::to_bytes(&source_updated_at_ms));
    bytes.push_back(PRIMARY_SOURCE_USGS);
    bytes.push_back(SEVERITY_BAND);
    bytes.append(source_set_hash());
    bytes.append(raw_data_hash());
    bytes.append(bcs::to_bytes(&raw_data_uri));
    bytes.append(affected_cells_root());
    bytes.append(bcs::to_bytes(&affected_cells_uri));
    bytes.append(affected_cells_data_hash());
    bytes.append(bcs::to_bytes(&affected_cell_count));
    bytes.push_back(GEO_RESOLUTION);
    bytes.push_back(CELLS_GENERATION_METHOD);
    bytes.push_back(CELL_METRIC_USGS_MMI);
    bytes.push_back(1);
    bytes.push_back(INTENSITY_SCALE_MMI_X100);
    bytes.append(bcs::to_bytes(&freshness_deadline_ms));
    bytes
}
