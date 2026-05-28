#[test_only]
module contracts::metadata_verifier_tests;

use contracts::admin;
use contracts::metadata_verifier;
use sui::event;
use sui::test_scenario;

const ADMIN: address = @0xA11CE;

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
            metadata_verifier::verifier_family_earthquake_oracle(),
            metadata_verifier::verifier_version_v1(),
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
    assert!(family == metadata_verifier::verifier_family_earthquake_oracle());
    assert!(version == metadata_verifier::verifier_version_v1());
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
        metadata_verifier::verifier_family_identity(),
        metadata_verifier::verifier_version_v1(),
        valid_public_key(),
        &mut ctx,
    );

    let added_events = event::events_by_type<metadata_verifier::VerifierKeyAdded>();
    assert!(added_events.length() == 1);
    let (_, key, family, version, enabled, actor) =
        metadata_verifier::verifier_key_added_event_fields(*added_events.borrow(0));
    assert!(key == valid_public_key());
    assert!(family == metadata_verifier::verifier_family_identity());
    assert!(version == metadata_verifier::verifier_version_v1());
    assert!(enabled);
    assert!(actor == @0x0);

    metadata_verifier::destroy_verifier_registry_for_testing(registry);
}

#[test, expected_failure(abort_code = metadata_verifier::EVerifierKeyAlreadyDisabled)]
fun disabling_already_disabled_key_is_rejected() {
    let (mut registry, mut ctx) = direct_initialized();
    metadata_verifier::add_verifier_key_for_testing(
        &mut registry,
        metadata_verifier::verifier_family_earthquake_oracle(),
        metadata_verifier::verifier_version_v1(),
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
        metadata_verifier::verifier_version_v1(),
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
        metadata_verifier::verifier_family_earthquake_oracle(),
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
