#[test_only]
module contracts::admin_program_tests;

use contracts::admin;
use contracts::allowed_residence_cell;
use contracts::category_pool;
use contracts::disaster_event;
use contracts::donation;
use contracts::identity_registry;
use contracts::membership;
use contracts::metadata_verifier;
use contracts::pools;
use sui::display::{Self, Display};
use sui::event;
use sui::package::Publisher;
use std::string::{Self, String};
use sui::test_scenario;

const ADMIN: address = @0xA11CE;
const NON_ADMIN: address = @0xB0B;
const ALLOWLIST_UPDATE_MS: u64 = 1_234;

#[test]
fun init_creates_genesis_objects_and_tracking_events() {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());

    let pool_events = event::events_by_type<pools::PoolCreated>();
    assert!(pool_events.length() == 2);
    let (main_pool_id_from_event, main_pool_kind, _, _, _) =
        pools::pool_created_event_fields(*pool_events.borrow(0));
    let (operations_pool_id_from_event, operations_pool_kind, _, _, _) =
        pools::pool_created_event_fields(*pool_events.borrow(1));
    assert!(main_pool_kind == pools::pool_kind_main());
    assert!(operations_pool_kind == pools::pool_kind_operations());

    let donor_events = event::events_by_type<donation::RegistryCreated>();
    assert!(donor_events.length() == 1);
    let (donor_registry_id_from_event, donor_registry_kind, _, _) =
        donation::registry_created_event_fields(*donor_events.borrow(0));
    assert!(donor_registry_kind == donation::registry_kind_donor());

    let membership_events = event::events_by_type<membership::RegistryCreated>();
    assert!(membership_events.length() == 1);
    let (membership_registry_id_from_event, membership_registry_kind, _, _) =
        membership::registry_created_event_fields(*membership_events.borrow(0));
    assert!(membership_registry_kind == membership::registry_kind_membership());

    let verifier_events = event::events_by_type<metadata_verifier::RegistryCreated>();
    assert!(verifier_events.length() == 1);
    let (verifier_registry_id_from_event, verifier_registry_kind, _, _) =
        metadata_verifier::registry_created_event_fields(*verifier_events.borrow(0));
    assert!(verifier_registry_kind == metadata_verifier::registry_kind_verifier());

    let identity_events = event::events_by_type<identity_registry::RegistryCreated>();
    assert!(identity_events.length() == 1);
    let (identity_registry_id_from_event, identity_registry_kind, _, _) =
        identity_registry::registry_created_event_fields(*identity_events.borrow(0));
    assert!(identity_registry_kind == identity_registry::registry_kind_identity());

    let disaster_registry_events = event::events_by_type<disaster_event::DisasterRegistryCreated>();
    assert!(disaster_registry_events.length() == 1);

    let allowed_residence_events =
        event::events_by_type<allowed_residence_cell::AllowedResidenceCellRootUpdated>();
    assert!(allowed_residence_events.length() == 1);

    let genesis_events = event::events_by_type<admin::GenesisObjectCreated>();
    assert!(genesis_events.length() == 12);
    let (_, category_registry_kind, category_registry_shared, _, _) =
        admin::genesis_object_created_event_fields(*genesis_events.borrow(7));
    assert!(category_registry_kind == admin::genesis_kind_category_registry());
    assert!(category_registry_shared);
    let (_, identity_registry_kind, identity_registry_shared, _, _) =
        admin::genesis_object_created_event_fields(*genesis_events.borrow(8));
    assert!(identity_registry_kind == admin::genesis_kind_identity_registry());
    assert!(identity_registry_shared);
    let (_, earthquake_pool_kind, earthquake_pool_shared, _, _) =
        admin::genesis_object_created_event_fields(*genesis_events.borrow(9));
    assert!(earthquake_pool_kind == admin::genesis_kind_earthquake_pool());
    assert!(earthquake_pool_shared);
    let (disaster_registry_id_from_genesis, disaster_registry_kind, disaster_registry_shared, _, _) =
        admin::genesis_object_created_event_fields(*genesis_events.borrow(10));
    assert!(disaster_registry_kind == admin::genesis_kind_disaster_registry());
    assert!(disaster_registry_shared);
    let (
        allowed_residence_registry_id_from_genesis,
        allowed_residence_registry_kind,
        allowed_residence_registry_shared,
        _,
        _,
    ) = admin::genesis_object_created_event_fields(*genesis_events.borrow(11));
    assert!(
        allowed_residence_registry_kind == admin::genesis_kind_allowed_residence_cell_registry(),
    );
    assert!(allowed_residence_registry_shared);

    scenario.next_tx(ADMIN);
    {
        assert!(scenario.has_most_recent_for_sender<admin::AdminCap>());
        assert!(test_scenario::has_most_recent_shared<admin::PauseState>());
        assert!(test_scenario::has_most_recent_shared<pools::MainPool>());
        assert!(test_scenario::has_most_recent_shared<pools::OperationsPool>());
        assert!(test_scenario::has_most_recent_shared<donation::DonorRegistry>());
        assert!(test_scenario::has_most_recent_shared<membership::MembershipRegistry>());
        assert!(test_scenario::has_most_recent_shared<metadata_verifier::VerifierRegistry>());
        assert!(test_scenario::has_most_recent_shared<identity_registry::IdentityRegistry>());
        assert!(test_scenario::has_most_recent_shared<category_pool::CategoryRegistry>());
        assert!(test_scenario::has_most_recent_shared<disaster_event::DisasterRegistry>());
        assert!(
            test_scenario::has_most_recent_shared<
                allowed_residence_cell::AllowedResidenceCellRegistry,
            >(),
        );

        let cap = scenario.take_from_sender<admin::AdminCap>();
        let pause_state = scenario.take_shared<admin::PauseState>();
        let main_pool = scenario.take_shared<pools::MainPool>();
        let operations_pool = scenario.take_shared<pools::OperationsPool>();
        let donor_registry = scenario.take_shared<donation::DonorRegistry>();
        let membership_registry = scenario.take_shared<membership::MembershipRegistry>();
        let verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        let identity_registry = scenario.take_shared<identity_registry::IdentityRegistry>();
        let category_registry = scenario.take_shared<category_pool::CategoryRegistry>();
        let disaster_registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let allowed_residence_registry =
            scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();

        assert!(!admin::is_global_paused(&pause_state));
        assert!(admin::paused_target_count(&pause_state) == 0);

        assert!(main_pool_id_from_event == pools::main_pool_id(&main_pool));
        assert!(operations_pool_id_from_event == pools::operations_pool_id(&operations_pool));
        assert!(donor_registry_id_from_event == donation::registry_id(&donor_registry));
        assert!(membership_registry_id_from_event == membership::registry_id(&membership_registry));
        assert!(
            verifier_registry_id_from_event == metadata_verifier::registry_id(&verifier_registry),
        );
        assert!(
            identity_registry_id_from_event == identity_registry::registry_id(&identity_registry),
        );
        let (disaster_event_registry_id, _) =
            disaster_event::registry_fields_for_testing(&disaster_registry);
        assert!(disaster_registry_id_from_genesis == disaster_event_registry_id);
        let (allowed_residence_registry_id, _, _, _, _, _) =
            allowed_residence_cell::registry_fields_for_testing(&allowed_residence_registry);
        assert!(allowed_residence_registry_id_from_genesis == allowed_residence_registry_id);

        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(operations_pool);
        test_scenario::return_shared(donor_registry);
        test_scenario::return_shared(membership_registry);
        test_scenario::return_shared(verifier_registry);
        test_scenario::return_shared(identity_registry);
        test_scenario::return_shared(category_registry);
        test_scenario::return_shared(disaster_registry);
        test_scenario::return_shared(allowed_residence_registry);
    };

    scenario.end();
}

#[test]
fun init_creates_display_objects_for_explorer() {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_with_displays_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    {
        let publisher = scenario.take_from_sender<Publisher>();
        assert!(!scenario.has_most_recent_for_sender<Display<membership::MembershipPass>>());
        assert!(!scenario.has_most_recent_for_sender<Display<donation::DonorPass>>());
        assert!(!scenario.has_most_recent_for_sender<Display<disaster_event::DisasterEvent>>());
        assert!(test_scenario::has_most_recent_immutable<Display<membership::MembershipPass>>());
        assert!(test_scenario::has_most_recent_immutable<Display<donation::DonorPass>>());
        assert!(test_scenario::has_most_recent_immutable<Display<disaster_event::DisasterEvent>>());

        let membership_display =
            scenario.take_immutable<Display<membership::MembershipPass>>();
        let donor_display = scenario.take_immutable<Display<donation::DonorPass>>();
        let disaster_display =
            scenario.take_immutable<Display<disaster_event::DisasterEvent>>();

        assert_display_fields(
            &membership_display,
            1,
            b"Sonari Passport".to_string(),
            b"Status: {status_label}.".to_string(),
            b"https://raw.githubusercontent.com/UnagiLabs/Sonari/main/docs/assets/display/membership-pass.svg".to_string(),
            b"https://app.sonari.xyz/passport/{id}".to_string(),
        );
        assert_display_fields(
            &donor_display,
            1,
            string::utf8(x"536f6e61726920446f6e6f72205061737320e28094207b746965725f6c6162656c7d"),
            b"Total donated: {total_donated_usdc_display} USDC across {donation_count} donations.".to_string(),
            b"https://raw.githubusercontent.com/UnagiLabs/Sonari/main/docs/assets/display/donor-pass.svg".to_string(),
            b"https://app.sonari.xyz/donor/{id}".to_string(),
        );
        assert_display_fields(
            &disaster_display,
            1,
            b"{title}".to_string(),
            b"{hazard_label} in {region}. Verified disaster event.".to_string(),
            b"https://raw.githubusercontent.com/UnagiLabs/Sonari/main/docs/assets/display/disaster-event.svg".to_string(),
            b"https://app.sonari.xyz/disaster/{id}".to_string(),
        );

        scenario.return_to_sender(publisher);
        test_scenario::return_immutable(membership_display);
        test_scenario::return_immutable(donor_display);
        test_scenario::return_immutable(disaster_display);
    };

    scenario.end();
}

#[test]
fun non_admin_cannot_access_admin_cap_required_for_admin_entries() {
    // create_program / create_campaign / pause_* / residence allowlist registry
    // admin wrappers all require &AdminCap.
    // Direct calls without &AdminCap are rejected at compile time, so this
    // fixes the runtime boundary that NON_ADMIN cannot obtain ADMIN's cap.
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());

    scenario.next_tx(NON_ADMIN);
    assert!(!scenario.has_most_recent_for_sender<admin::AdminCap>());

    scenario.end();
}

#[test]
fun init_creates_allowed_residence_cell_registry() {
    let scenario = initialized();

    {
        let registry = scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();
        let (_, root, geo_resolution, allowlist_version, source_hash, updated_at_ms) =
            allowed_residence_cell::registry_fields_for_testing(&registry);
        assert!(root == zero_hash());
        assert!(geo_resolution == 7u8);
        assert!(allowlist_version == 0u64);
        assert!(source_hash == zero_hash());
        assert!(updated_at_ms == 0u64);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

#[test]
fun admin_can_update_allowed_residence_cell_registry_metadata() {
    let mut scenario = initialized_with_allowed_residence_cell_registry();
    test_scenario::later_epoch(&mut scenario, ALLOWLIST_UPDATE_MS, ADMIN);

    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut registry = scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();
        let (registry_id, _, _, _, _, _) =
            allowed_residence_cell::registry_fields_for_testing(&registry);
        admin::update_allowed_residence_cell_root(
            &cap,
            &mut registry,
            root_b(),
            7,
            2,
            source_hash_b(),
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);

        let (
            updated_registry_id,
            updated_root,
            updated_geo_resolution,
            updated_allowlist_version,
            updated_source_hash,
            updated_at_ms,
        ) = allowed_residence_cell::registry_fields_for_testing(&registry);
        assert!(updated_registry_id == registry_id);
        assert!(updated_root == root_b());
        assert!(updated_geo_resolution == 7u8);
        assert!(updated_allowlist_version == 2u64);
        assert!(updated_source_hash == source_hash_b());
        assert!(updated_at_ms == ALLOWLIST_UPDATE_MS);
        test_scenario::return_shared(registry);

        let events = event::events_by_type<allowed_residence_cell::AllowedResidenceCellRootUpdated>();
        assert!(events.length() == 1);
        let (
            event_registry_id,
            event_root,
            event_geo_resolution,
            event_allowlist_version,
            event_source_hash,
            event_updated_at_ms,
            event_actor,
        ) = allowed_residence_cell::root_updated_event_fields(*events.borrow(0));
        assert!(event_registry_id == registry_id);
        assert!(event_root == root_b());
        assert!(event_geo_resolution == 7u8);
        assert!(event_allowlist_version == 2u64);
        assert!(event_source_hash == source_hash_b());
        assert!(event_updated_at_ms == ALLOWLIST_UPDATE_MS);
        assert!(event_actor == ADMIN);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = admin::EAllowedResidenceCellRegistryAlreadyCreated)]
fun create_allowed_residence_cell_registry_rejects_invalid_root_length() {
    let mut scenario = initialized();

    let mut cap = scenario.take_from_sender<admin::AdminCap>();
    admin::create_allowed_residence_cell_registry(
        &mut cap,
        vector[0],
        7,
        1,
        source_hash_a(),
        scenario.ctx(),
    );
    scenario.return_to_sender(cap);

    scenario.end();
}

#[test, expected_failure(abort_code = admin::EAllowedResidenceCellRegistryAlreadyCreated)]
fun create_allowed_residence_cell_registry_rejects_invalid_source_hash_length() {
    let mut scenario = initialized();

    let mut cap = scenario.take_from_sender<admin::AdminCap>();
    admin::create_allowed_residence_cell_registry(
        &mut cap,
        root_a(),
        7,
        1,
        vector[0],
        scenario.ctx(),
    );
    scenario.return_to_sender(cap);

    scenario.end();
}

#[test, expected_failure(abort_code = admin::EAllowedResidenceCellRegistryAlreadyCreated)]
fun create_allowed_residence_cell_registry_rejects_non_res7_root() {
    let mut scenario = initialized();

    let mut cap = scenario.take_from_sender<admin::AdminCap>();
    admin::create_allowed_residence_cell_registry(
        &mut cap,
        root_a(),
        8,
        1,
        source_hash_a(),
        scenario.ctx(),
    );
    scenario.return_to_sender(cap);

    scenario.end();
}

#[test, expected_failure(abort_code = admin::EAllowedResidenceCellRegistryAlreadyCreated)]
fun create_allowed_residence_cell_registry_rejects_second_registry() {
    let mut scenario = initialized_with_allowed_residence_cell_registry();

    let mut cap = scenario.take_from_sender<admin::AdminCap>();
    admin::create_allowed_residence_cell_registry(
        &mut cap,
        root_b(),
        7,
        2,
        source_hash_b(),
        scenario.ctx(),
    );
    scenario.return_to_sender(cap);

    scenario.end();
}

#[test, expected_failure(abort_code = allowed_residence_cell::EInvalidHashLength)]
fun update_allowed_residence_cell_registry_rejects_invalid_root_length() {
    let mut scenario = initialized_with_allowed_residence_cell_registry();

    let cap = scenario.take_from_sender<admin::AdminCap>();
    let mut registry = scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();
    admin::update_allowed_residence_cell_root(
        &cap,
        &mut registry,
        vector[0],
        7,
        2,
        source_hash_b(),
        scenario.ctx(),
    );
    scenario.return_to_sender(cap);
    test_scenario::return_shared(registry);

    scenario.end();
}

#[test, expected_failure(abort_code = allowed_residence_cell::EInvalidHashLength)]
fun update_allowed_residence_cell_registry_rejects_invalid_source_hash_length() {
    let mut scenario = initialized_with_allowed_residence_cell_registry();

    let cap = scenario.take_from_sender<admin::AdminCap>();
    let mut registry = scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();
    admin::update_allowed_residence_cell_root(
        &cap,
        &mut registry,
        root_b(),
        7,
        2,
        vector[0],
        scenario.ctx(),
    );
    scenario.return_to_sender(cap);
    test_scenario::return_shared(registry);

    scenario.end();
}

#[test, expected_failure(abort_code = allowed_residence_cell::EUnsupportedGeoResolution)]
fun update_allowed_residence_cell_registry_rejects_non_res7_root() {
    let mut scenario = initialized_with_allowed_residence_cell_registry();

    let cap = scenario.take_from_sender<admin::AdminCap>();
    let mut registry = scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();
    admin::update_allowed_residence_cell_root(
        &cap,
        &mut registry,
        root_b(),
        8,
        2,
        source_hash_b(),
        scenario.ctx(),
    );
    scenario.return_to_sender(cap);
    test_scenario::return_shared(registry);

    scenario.end();
}


fun initialized(): test_scenario::Scenario {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);
    scenario
}

fun initialized_with_allowed_residence_cell_registry(): test_scenario::Scenario {
    let mut scenario = initialized();
    let cap = scenario.take_from_sender<admin::AdminCap>();
    let mut registry = scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();
    admin::update_allowed_residence_cell_root(
        &cap,
        &mut registry,
        root_a(),
        7,
        1,
        source_hash_a(),
        scenario.ctx(),
    );
    scenario.return_to_sender(cap);
    test_scenario::return_shared(registry);
    scenario.next_tx(ADMIN);
    scenario
}

fun zero_hash(): vector<u8> {
    x"0000000000000000000000000000000000000000000000000000000000000000"
}

fun root_a(): vector<u8> {
    x"a26a12dc49754fde5b90e6bff69d1bc8b51fb8a3de07aa9122a9a2958bb75020"
}

fun root_b(): vector<u8> {
    x"b26a12dc49754fde5b90e6bff69d1bc8b51fb8a3de07aa9122a9a2958bb75021"
}

fun source_hash_a(): vector<u8> {
    x"1111111111111111111111111111111111111111111111111111111111111111"
}

fun source_hash_b(): vector<u8> {
    x"2222222222222222222222222222222222222222222222222222222222222222"
}

fun assert_display_fields<T: key>(
    display_object: &Display<T>,
    expected_version: u16,
    name: String,
    description: String,
    image_url: String,
    link: String,
) {
    let fields = display::fields(display_object);
    assert!(fields.length() == 4);
    assert!(fields[&b"name".to_string()] == name);
    assert!(fields[&b"description".to_string()] == description);
    assert!(fields[&b"image_url".to_string()] == image_url);
    assert!(fields[&b"link".to_string()] == link);
    assert!(!fields.contains(&b"project_url".to_string()));
    assert!(!fields.contains(&b"creator".to_string()));
    assert!(display::version(display_object) == expected_version);
}
