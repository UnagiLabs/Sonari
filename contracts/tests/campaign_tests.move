#[test_only]
module contracts::campaign_tests;

use contracts::admin;
use contracts::campaign;
use contracts::category_pool;
use contracts::disaster_event;
use sui::clock;
use sui::event;
use sui::test_scenario;

const ADMIN: address = @0xA11CE;

const NOW_MS: u64 = 1_704_170_000_000;

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------

fun initialized_with_category(): test_scenario::Scenario {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);

    let cap = scenario.take_from_sender<admin::AdminCap>();
    admin::create_disaster_registry(&cap, scenario.ctx());
    scenario.return_to_sender(cap);
    scenario.next_tx(ADMIN);

    let registry_id = category_pool::create_category_registry_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);

    let cap = scenario.take_from_sender<admin::AdminCap>();
    let mut registry = scenario.take_shared_by_id<category_pool::CategoryRegistry>(registry_id);
    admin::create_category_pool(
        &cap,
        &mut registry,
        category_pool::category_earthquake(),
        scenario.ctx(),
    );
    test_scenario::return_shared(registry);
    scenario.return_to_sender(cap);
    scenario.next_tx(ADMIN);

    scenario
}

// ---------------------------------------------------------------
// 1. create_campaign creates campaign and emits event (severity_band=3)
// ---------------------------------------------------------------

#[test]
fun create_campaign_creates_campaign_and_emits_event() {
    let mut scenario = initialized_with_category();
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(NOW_MS);

    let category_registry = scenario.take_shared<category_pool::CategoryRegistry>();
    let category_pool = scenario.take_shared<category_pool::CategoryPool>();

    let disaster_event_id = object::id_from_address(@0xDEAD);
    let result = campaign::create_campaign(
        &category_registry,
        &category_pool,
        disaster_event_id,
        b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        1u32,
        campaign::hazard_type_earthquake_for_testing(),
        3u8,
        &clock,
        scenario.ctx(),
    );

    assert!(result.is_some());

    let emitted = event::events_by_type<campaign::CampaignCreated>();
    assert!(emitted.length() == 1);

    test_scenario::return_shared(category_registry);
    test_scenario::return_shared(category_pool);
    clock.destroy_for_testing();
    scenario.end();
}

// ---------------------------------------------------------------
// 2. create_campaign with low band returns none (severity_band=0)
// ---------------------------------------------------------------

#[test]
fun create_campaign_with_low_band_returns_none() {
    let mut scenario = initialized_with_category();
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(NOW_MS);

    let category_registry = scenario.take_shared<category_pool::CategoryRegistry>();
    let category_pool = scenario.take_shared<category_pool::CategoryPool>();

    let disaster_event_id = object::id_from_address(@0xDEAD);
    let result = campaign::create_campaign(
        &category_registry,
        &category_pool,
        disaster_event_id,
        b"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        1u32,
        campaign::hazard_type_earthquake_for_testing(),
        0u8,
        &clock,
        scenario.ctx(),
    );

    assert!(result.is_none());

    // no CampaignCreated event emitted
    let emitted = event::events_by_type<campaign::CampaignCreated>();
    assert!(emitted.length() == 0);

    test_scenario::return_shared(category_registry);
    test_scenario::return_shared(category_pool);
    clock.destroy_for_testing();
    scenario.end();
}

// ---------------------------------------------------------------
// 3. campaign version is 1 after create
// ---------------------------------------------------------------

#[test]
fun campaign_version_is_1_after_create() {
    let mut scenario = initialized_with_category();
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(NOW_MS);

    let category_registry = scenario.take_shared<category_pool::CategoryRegistry>();
    let category_pool = scenario.take_shared<category_pool::CategoryPool>();

    let disaster_event_id = object::id_from_address(@0xDEAD);
    let result = campaign::create_campaign(
        &category_registry,
        &category_pool,
        disaster_event_id,
        b"cccccccccccccccccccccccccccccccc",
        1u32,
        campaign::hazard_type_earthquake_for_testing(),
        2u8,
        &clock,
        scenario.ctx(),
    );
    assert!(result.is_some());

    test_scenario::return_shared(category_registry);
    test_scenario::return_shared(category_pool);
    clock.destroy_for_testing();

    scenario.next_tx(ADMIN);
    let c = scenario.take_shared<campaign::Campaign>();
    assert!(campaign::campaign_version(&c) == campaign::version());
    assert!(campaign::campaign_version(&c) == 1u64);
    campaign::assert_campaign_version(&c);

    test_scenario::return_shared(c);
    scenario.end();
}

// ---------------------------------------------------------------
// 4. campaign snapshot fields match constants
// ---------------------------------------------------------------

#[test]
fun campaign_snapshot_fields_match_constants() {
    let mut scenario = initialized_with_category();
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(NOW_MS);

    let category_registry = scenario.take_shared<category_pool::CategoryRegistry>();
    let category_pool = scenario.take_shared<category_pool::CategoryPool>();

    let disaster_event_id = object::id_from_address(@0xDEAD);
    let result = campaign::create_campaign(
        &category_registry,
        &category_pool,
        disaster_event_id,
        b"dddddddddddddddddddddddddddddddd",
        1u32,
        campaign::hazard_type_earthquake_for_testing(),
        3u8,
        &clock,
        scenario.ctx(),
    );
    assert!(result.is_some());

    test_scenario::return_shared(category_registry);
    test_scenario::return_shared(category_pool);
    clock.destroy_for_testing();

    scenario.next_tx(ADMIN);
    let c = scenario.take_shared<campaign::Campaign>();

    let (
        band_targets,
        round_cap_multiplier,
        floor_target_ratio_bps,
        min_claim_band,
        split_campaign_bps,
        split_main_bps,
        split_ops_bps,
        campaign_ops_cap_usdc,
        round_interval_ms,
        min_payout_per_recipient_usdc,
        category_annual_event_divisor,
        floor_main_share_bps,
    ) = campaign::campaign_terms_fields_for_testing(&c);

    assert!(band_targets.length() == 3);
    assert!(*band_targets.borrow(0) == 50_000_000u64);
    assert!(*band_targets.borrow(1) == 150_000_000u64);
    assert!(*band_targets.borrow(2) == 300_000_000u64);
    assert!(round_cap_multiplier == 3u64);
    assert!(floor_target_ratio_bps == 5_000u64);
    assert!(min_claim_band == 1u8);
    assert!(split_campaign_bps == 9_000u64);
    assert!(split_main_bps == 500u64);
    assert!(split_ops_bps == 500u64);
    assert!(campaign_ops_cap_usdc == 50_000_000_000u64);
    assert!(round_interval_ms == 7_776_000_000u64);
    assert!(min_payout_per_recipient_usdc == 1_000_000u64);
    assert!(category_annual_event_divisor == 5u64);
    assert!(floor_main_share_bps == 2_000u64);

    test_scenario::return_shared(c);
    scenario.end();
}

// ---------------------------------------------------------------
// 5. campaign donation_end and claim_end are set correctly
// ---------------------------------------------------------------

#[test]
fun campaign_donation_end_and_claim_end_are_set() {
    let mut scenario = initialized_with_category();
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(NOW_MS);

    let category_registry = scenario.take_shared<category_pool::CategoryRegistry>();
    let category_pool = scenario.take_shared<category_pool::CategoryPool>();

    let disaster_event_id = object::id_from_address(@0xDEAD);
    let result = campaign::create_campaign(
        &category_registry,
        &category_pool,
        disaster_event_id,
        b"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        1u32,
        campaign::hazard_type_earthquake_for_testing(),
        3u8,
        &clock,
        scenario.ctx(),
    );
    assert!(result.is_some());

    test_scenario::return_shared(category_registry);
    test_scenario::return_shared(category_pool);
    clock.destroy_for_testing();

    scenario.next_tx(ADMIN);
    let c = scenario.take_shared<campaign::Campaign>();

    let created_at = campaign::campaign_created_at_ms(&c);
    let donation_end = campaign::campaign_donation_end_ms(&c);
    let claim_end = campaign::campaign_claim_end_ms(&c);

    // DONATION_PERIOD_MS = 2_592_000_000
    assert!(donation_end == created_at + 2_592_000_000u64);
    // CLAIM_PERIOD_MS = 1_814_400_000
    assert!(claim_end == created_at + 1_814_400_000u64);

    test_scenario::return_shared(c);
    scenario.end();
}

// ---------------------------------------------------------------
// 6. disaster_event + campaign integration: both created
// ---------------------------------------------------------------

#[test]
fun create_disaster_event_and_campaign_creates_both() {
    let mut scenario = initialized_with_category();
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(NOW_MS);

    let category_registry = scenario.take_shared<category_pool::CategoryRegistry>();
    let category_pool = scenario.take_shared<category_pool::CategoryPool>();
    let mut disaster_registry = scenario.take_shared<disaster_event::DisasterRegistry>();

    // create DisasterEvent via test-only helper (uses a Payload directly)
    let (event_uid, event_revision, de_id) = disaster_event::create_for_campaign_testing(
        &mut disaster_registry,
        campaign::hazard_type_earthquake_for_testing(),
        3u8,
        scenario.ctx(),
    );

    let result = campaign::create_campaign(
        &category_registry,
        &category_pool,
        de_id,
        event_uid,
        event_revision,
        campaign::hazard_type_earthquake_for_testing(),
        3u8,
        &clock,
        scenario.ctx(),
    );
    assert!(result.is_some());

    test_scenario::return_shared(disaster_registry);
    test_scenario::return_shared(category_registry);
    test_scenario::return_shared(category_pool);
    clock.destroy_for_testing();

    scenario.next_tx(ADMIN);
    let c = scenario.take_shared<campaign::Campaign>();
    assert!(campaign::campaign_category(&c) == category_pool::category_earthquake());
    assert!(campaign::campaign_census_set(&c) == false);
    assert!(campaign::campaign_paused(&c) == false);
    assert!(campaign::campaign_min_claim_band(&c) == campaign::min_claim_band());
    assert!(campaign::campaign_disaster_event_id(&c) == de_id);

    test_scenario::return_shared(c);
    scenario.end();
}
