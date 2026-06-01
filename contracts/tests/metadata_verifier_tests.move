#[test_only]
module contracts::metadata_verifier_tests;

use contracts::admin;
use contracts::metadata_verifier;
use contracts::reader;
use sui::event;
use sui::test_scenario;

const ADMIN: address = @0xA11CE;

#[test]
fun creates_earthquake_verifier_config_with_pcrs() {
    let mut scenario = initialized();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();

        admin::create_earthquake_verifier_config(
            &cap,
            &mut registry,
            valid_pcr0(),
            valid_pcr1(),
            valid_pcr2(),
            scenario.ctx(),
        );

        let (family, verifier_version, config_version, pcr0, pcr1, pcr2, enabled) =
            metadata_verifier::earthquake_verifier_config_fields_for_testing(&registry);
        assert!(family == reader::verifier_family_earthquake_oracle());
        assert!(verifier_version == reader::verifier_version_v1());
        assert!(config_version == 1);
        assert!(pcr0 == valid_pcr0());
        assert!(pcr1 == valid_pcr1());
        assert!(pcr2 == valid_pcr2());
        assert!(enabled);

        scenario.return_to_sender(cap);
        test_scenario::return_shared(registry);
    };

    let events = event::events_by_type<metadata_verifier::VerifierConfigCreated>();
    assert!(events.length() == 1);
    let (registry_id, family, verifier_version, config_version, pcr0, pcr1, pcr2, enabled, actor) =
        metadata_verifier::verifier_config_created_event_fields(*events.borrow(0));
    assert!(registry_id != object::id_from_address(@0x0));
    assert!(family == reader::verifier_family_earthquake_oracle());
    assert!(verifier_version == reader::verifier_version_v1());
    assert!(config_version == 1);
    assert!(pcr0 == valid_pcr0());
    assert!(pcr1 == valid_pcr1());
    assert!(pcr2 == valid_pcr2());
    assert!(enabled);
    assert!(actor == ADMIN);

    scenario.end();
}

#[test, expected_failure(abort_code = metadata_verifier::EInvalidPcrValue)]
fun create_earthquake_verifier_config_rejects_all_zero_pcrs_through_admin() {
    let mut scenario = initialized();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        admin::create_earthquake_verifier_config(
            &cap,
            &mut registry,
            zero_pcr(),
            valid_pcr1(),
            valid_pcr2(),
            scenario.ctx(),
        );

        scenario.return_to_sender(cap);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = metadata_verifier::EInvalidPcrLength)]
fun create_earthquake_verifier_config_rejects_invalid_pcr_length() {
    let mut scenario = initialized();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        admin::create_earthquake_verifier_config(
            &cap,
            &mut registry,
            vector[1],
            valid_pcr1(),
            valid_pcr2(),
            scenario.ctx(),
        );

        scenario.return_to_sender(cap);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

#[test]
fun updating_earthquake_verifier_config_pcrs_increments_config_version() {
    let mut scenario = initialized();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        admin::create_earthquake_verifier_config(
            &cap,
            &mut registry,
            valid_pcr0(),
            valid_pcr1(),
            valid_pcr2(),
            scenario.ctx(),
        );
        admin::update_earthquake_verifier_config_pcrs(
            &cap,
            &mut registry,
            updated_pcr0(),
            updated_pcr1(),
            updated_pcr2(),
            scenario.ctx(),
        );

        let (_, _, config_version, pcr0, pcr1, pcr2, enabled) =
            metadata_verifier::earthquake_verifier_config_fields_for_testing(&registry);
        assert!(config_version == 2);
        assert!(pcr0 == updated_pcr0());
        assert!(pcr1 == updated_pcr1());
        assert!(pcr2 == updated_pcr2());
        assert!(enabled);

        scenario.return_to_sender(cap);
        test_scenario::return_shared(registry);
    };

    let events = event::events_by_type<metadata_verifier::VerifierConfigPcrsUpdated>();
    assert!(events.length() == 1);
    let (_, family, verifier_version, config_version, pcr0, pcr1, pcr2, enabled, actor) =
        metadata_verifier::verifier_config_pcrs_updated_event_fields(*events.borrow(0));
    assert!(family == reader::verifier_family_earthquake_oracle());
    assert!(verifier_version == reader::verifier_version_v1());
    assert!(config_version == 2);
    assert!(pcr0 == updated_pcr0());
    assert!(pcr1 == updated_pcr1());
    assert!(pcr2 == updated_pcr2());
    assert!(enabled);
    assert!(actor == ADMIN);

    scenario.end();
}

#[test]
fun disabling_earthquake_verifier_config_flips_enabled_false() {
    let mut scenario = initialized();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        admin::create_earthquake_verifier_config(
            &cap,
            &mut registry,
            valid_pcr0(),
            valid_pcr1(),
            valid_pcr2(),
            scenario.ctx(),
        );
        admin::disable_earthquake_verifier_config(&cap, &mut registry, scenario.ctx());

        let (_, _, config_version, _, _, _, enabled) =
            metadata_verifier::earthquake_verifier_config_fields_for_testing(&registry);
        assert!(config_version == 1);
        assert!(!enabled);

        scenario.return_to_sender(cap);
        test_scenario::return_shared(registry);
    };

    let events = event::events_by_type<metadata_verifier::VerifierConfigDisabled>();
    assert!(events.length() == 1);
    let (_, family, verifier_version, config_version, actor) =
        metadata_verifier::verifier_config_disabled_event_fields(*events.borrow(0));
    assert!(family == reader::verifier_family_earthquake_oracle());
    assert!(verifier_version == reader::verifier_version_v1());
    assert!(config_version == 1);
    assert!(actor == ADMIN);

    scenario.end();
}

#[test]
fun verifier_registry_adds_and_disables_key_with_events() {
    let mut scenario = initialized();

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        let public_key = valid_public_key();

        admin::add_verifier_key(
            &cap,
            &mut registry,
            reader::verifier_family_earthquake_oracle(),
            reader::verifier_version_v1(),
            public_key,
            scenario.ctx(),
        );
        admin::disable_verifier_key(&cap, &mut registry, public_key, scenario.ctx());

        scenario.return_to_sender(cap);
        test_scenario::return_shared(registry);
    };

    let added_events = event::events_by_type<metadata_verifier::VerifierKeyAdded>();
    assert!(added_events.length() == 1);
    let (registry_id, key, family, version, enabled, actor) =
        metadata_verifier::verifier_key_added_event_fields(*added_events.borrow(0));
    assert!(registry_id != object::id_from_address(@0x0));
    assert!(key == valid_public_key());
    assert!(family == reader::verifier_family_earthquake_oracle());
    assert!(version == reader::verifier_version_v1());
    assert!(enabled);
    assert!(actor == ADMIN);

    let disabled_events = event::events_by_type<metadata_verifier::VerifierKeyDisabled>();
    assert!(disabled_events.length() == 1);
    let (disabled_registry_id, disabled_key, disabled_actor) =
        metadata_verifier::verifier_key_disabled_event_fields(*disabled_events.borrow(0));
    assert!(disabled_registry_id == registry_id);
    assert!(disabled_key == valid_public_key());
    assert!(disabled_actor == ADMIN);

    scenario.end();
}

#[test]
fun identity_verifier_key_registration_is_allowed() {
    let (mut registry, mut ctx) = direct_initialized();

    metadata_verifier::add_verifier_key_for_testing(
        &mut registry,
        reader::verifier_family_identity(),
        reader::verifier_version_v1(),
        valid_public_key(),
        &mut ctx,
    );

    let added_events = event::events_by_type<metadata_verifier::VerifierKeyAdded>();
    assert!(added_events.length() == 1);
    let (_, key, family, version, enabled, actor) =
        metadata_verifier::verifier_key_added_event_fields(*added_events.borrow(0));
    assert!(key == valid_public_key());
    assert!(family == reader::verifier_family_identity());
    assert!(version == reader::verifier_version_v1());
    assert!(enabled);
    assert!(actor == @0x0);

    metadata_verifier::destroy_verifier_registry_for_testing(registry);
}

#[test, expected_failure(abort_code = metadata_verifier::EVerifierKeyAlreadyDisabled)]
fun disabling_already_disabled_key_is_rejected() {
    let (mut registry, mut ctx) = direct_initialized();
    metadata_verifier::add_verifier_key_for_testing(
        &mut registry,
        reader::verifier_family_earthquake_oracle(),
        reader::verifier_version_v1(),
        valid_public_key(),
        &mut ctx,
    );
    metadata_verifier::disable_verifier_key_for_testing(&mut registry, valid_public_key(), &mut ctx);
    metadata_verifier::disable_verifier_key_for_testing(&mut registry, valid_public_key(), &mut ctx);
    metadata_verifier::destroy_verifier_registry_for_testing(registry);
}

#[test, expected_failure(abort_code = metadata_verifier::EVerifierFamilyMismatch)]
fun unknown_verifier_family_registration_is_rejected() {
    let (mut registry, mut ctx) = direct_initialized();
    metadata_verifier::add_verifier_key_for_testing(
        &mut registry,
        99,
        reader::verifier_version_v1(),
        valid_public_key(),
        &mut ctx,
    );
    metadata_verifier::destroy_verifier_registry_for_testing(registry);
}

#[test, expected_failure(abort_code = metadata_verifier::EVerifierVersionMismatch)]
fun unknown_verifier_version_registration_is_rejected() {
    let (mut registry, mut ctx) = direct_initialized();
    metadata_verifier::add_verifier_key_for_testing(
        &mut registry,
        reader::verifier_family_earthquake_oracle(),
        99,
        valid_public_key(),
        &mut ctx,
    );
    metadata_verifier::destroy_verifier_registry_for_testing(registry);
}

fun initialized(): test_scenario::Scenario {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);
    scenario
}

fun direct_initialized(): (
    metadata_verifier::VerifierRegistry,
    tx_context::TxContext,
) {
    let mut ctx = tx_context::dummy();
    let registry = metadata_verifier::create_verifier_registry_for_testing(&mut ctx);
    (registry, ctx)
}

fun valid_public_key(): vector<u8> {
    x"95faf5df49c416e1070f77ff0a06853f4bc12a4eb4b96f2dfc0d11e441b0cd7f"
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

fun zero_pcr(): vector<u8> {
    x"000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
}
