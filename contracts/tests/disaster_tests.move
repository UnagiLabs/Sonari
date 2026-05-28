#[test_only]
module contracts::disaster_tests;

use contracts::admin;
use contracts::affected_cell;
use contracts::disaster_event;
use contracts::metadata_verifier;
use contracts::payload_v1;
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
            x"8c91dac6cd4c206c4d8ac7cb0a99a4b0bdd7fefdf1205f1be3e26700aa1951a4",
        ),
    ];
    assert!(affected_cell::verify_proof(&leaf, proof, affected_cells_root()));
}

#[test]
fun finalized_disaster_payload_decodes_and_creates_disaster_event() {
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
        affected_cells_root,
        affected_cell_count,
        min_claim_band,
    ) = payload_v1::payload_summary(&payload);

    assert!(intent == payload_v1::intent_earthquake_oracle_payload_v1());
    assert!(oracle_version == ORACLE_VERSION);
    assert!(event_uid == event_uid());
    assert!(hazard_type == payload_v1::hazard_type_earthquake());
    assert!(status == payload_v1::status_finalized());
    assert!(event_revision == EVENT_REVISION);
    assert!(affected_cells_root == affected_cells_root());
    assert!(affected_cell_count == 2);
    assert!(min_claim_band == 1);

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
    let (event_uid, revision, affected_root, affected_count, actor) =
        disaster_event::disaster_event_created_event_fields(*events.borrow(0));
    assert!(event_uid == event_uid());
    assert!(revision == EVENT_REVISION);
    assert!(affected_root == affected_cells_root());
    assert!(affected_count == 2);
    assert!(actor == ADMIN);

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = payload_v1::EExpiredFreshness)]
fun expired_disaster_payload_is_rejected() {
    payload_v1::decode_finalized(
        finalized_payload_bcs(),
        1_704_172_800_000,
    );
}

#[test, expected_failure(abort_code = payload_v1::EUnsupportedPrimarySource)]
fun unsupported_primary_source_is_rejected() {
    assert_mutated_payload_is_rejected(71, 2);
}

#[test, expected_failure(abort_code = payload_v1::EInvalidSeverityBand)]
fun severity_band_zero_is_rejected() {
    assert_mutated_payload_is_rejected(72, 0);
}

#[test, expected_failure(abort_code = payload_v1::EUnsupportedCellsGenerationMethod)]
fun unsupported_cells_generation_method_is_rejected() {
    assert_mutated_payload_is_rejected(317, 3);
}

#[test, expected_failure(abort_code = payload_v1::EUnsupportedCellMetric)]
fun unsupported_cell_metric_is_rejected() {
    assert_mutated_payload_is_rejected(318, 2);
}

#[test, expected_failure(abort_code = payload_v1::EUnsupportedCellAggregation)]
fun unsupported_cell_aggregation_is_rejected() {
    assert_mutated_payload_is_rejected(319, 2);
}

#[test, expected_failure(abort_code = payload_v1::EUnsupportedIntensityScale)]
fun unsupported_intensity_scale_is_rejected() {
    assert_mutated_payload_is_rejected(320, 2);
}

#[test, expected_failure(abort_code = payload_v1::ESeverityBandMismatch)]
fun max_cell_band_must_match_severity_band() {
    assert_mutated_payload_is_rejected(321, 3);
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
    *bytes.borrow_mut(316) = 6;
    payload_v1::decode_finalized(
        bytes,
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
    let (_, _, _, _, actor) =
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
    x"54d59943d5e2a17abce689271c3124d6971f42258924109da6673ab57198ca93"
}

fun oracle_public_key(): vector<u8> {
    x"ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c"
}

fun oracle_signature(): vector<u8> {
    x"b4e0219fc8283b66f1736e28912c7c5fea816366c44090bbfe5aa5a4c08d501c4086b179f3c5b724b315bdcfe3dd2c5dfbc753902b71fb4397569b65037f8003"
}

fun finalized_payload_bcs(): vector<u8> {
    x"010100000000000000ab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd01030100000000f451c28c01000000b153c78c01000000b153c78c010000010206fc83f3519bc43798fb3e8a285445d3a2f267d79796d73cea1099e9de1333ad659a51caf0f12038b06e51fbff9f595663d2d4a76d530204b583582d5c896ab93a697066733a2f2f736f6e6172692f6578616d706c65732f757337303030736f6e6172692f7261775f646174615f6d616e69666573742e6a736f6e54d59943d5e2a17abce689271c3124d6971f42258924109da6673ab57198ca9337697066733a2f2f736f6e6172692f6578616d706c65732f757337303030736f6e6172692f61666665637465645f63656c6c732e6a736f6ee8f70b859ab72653f504e085728f6109885123065aefc623be0359311dcffb7d07010101010202000000000000000100489dc88c010000"
}

fun revision_payload_bcs(revision: u8): vector<u8> {
    let mut bytes = finalized_payload_bcs();
    *bytes.borrow_mut(43) = revision;
    bytes
}
