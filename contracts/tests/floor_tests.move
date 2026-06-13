#[test_only]
module contracts::floor_tests;

use contracts::admin;
use contracts::affected_cell;
use contracts::campaign;
use contracts::category_pool;
use contracts::census_result;
use contracts::identity_registry;
use contracts::membership;
use contracts::pools;
use sui::clock;
use sui::coin;
use sui::event;
use sui::test_scenario;
use usdc::usdc::USDC;

const ADMIN: address = @0xA11CE;
const MEMBER: address = @0xBEEF;
const NOW_MS: u64 = 1_704_170_000_000;

// DONATION_PERIOD_MS = 2_592_000_000
const DONATION_END_MS: u64 = 1_704_170_000_000 + 2_592_000_000_000;

// default event_uid / revision / cells_root for census
const EVENT_UID: vector<u8> = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EVENT_REVISION: u32 = 1u32;
const CELLS_ROOT: vector<u8> = x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const KYC_DUPLICATE_KEY: vector<u8> = x"4444444444444444444444444444444444444444444444444444444444444444";

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------

// setup: admin init (creates MainPool + OperationsPool) + category registry + pool
fun setup(): test_scenario::Scenario {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());
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

fun create_campaign_in_scenario(
    scenario: &mut test_scenario::Scenario,
    event_uid: vector<u8>,
) {
    let cat_registry = scenario.take_shared<category_pool::CategoryRegistry>();
    let cat_pool = scenario.take_shared<category_pool::CategoryPool>();
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(NOW_MS);

    let disaster_event_id = object::id_from_address(@0xDEAD);
    campaign::create_campaign(
        &cat_registry,
        &cat_pool,
        disaster_event_id,
        event_uid,
        EVENT_REVISION,
        campaign::hazard_type_earthquake_for_testing(),
        3u8,
        &clock,
        scenario.ctx(),
    );

    test_scenario::return_shared(cat_registry);
    test_scenario::return_shared(cat_pool);
    clock.destroy_for_testing();
}

fun fund_category_pool(scenario: &mut test_scenario::Scenario, amount: u64) {
    scenario.next_tx(ADMIN);
    let mut cat_pool = scenario.take_shared<category_pool::CategoryPool>();
    let coin = coin::mint_for_testing<USDC>(amount, scenario.ctx());
    category_pool::deposit_category_usdc(&mut cat_pool, coin);
    test_scenario::return_shared(cat_pool);
}

fun fund_main_pool(scenario: &mut test_scenario::Scenario, amount: u64) {
    scenario.next_tx(ADMIN);
    let mut main_pool = scenario.take_shared<pools::MainPool>();
    let coin = coin::mint_for_testing<USDC>(amount, scenario.ctx());
    pools::deposit_main_usdc(&mut main_pool, coin);
    test_scenario::return_shared(main_pool);
}

fun make_census_result(
    registered_by_band: vector<u64>,
): census_result::FloorCensusResult {
    census_result::new_for_testing(
        EVENT_UID,
        EVENT_REVISION,
        CELLS_ROOT,
        registered_by_band,
        NOW_MS,
    )
}

fun setup_verified_member(
    scenario: &mut test_scenario::Scenario,
): (identity_registry::IdentityRegistry, membership::MembershipRegistry, membership::MembershipPass) {
    let mut id_registry = identity_registry::create_identity_registry_for_testing(scenario.ctx());
    let (mem_registry, pass) = membership::create_registry_and_pass_for_testing(
        MEMBER,
        1,
        b"",
        scenario.ctx(),
    );
    let lineage_id = membership::membership_pass_lineage_id(&pass);
    identity_registry::bind_duplicate_key(
        &mut id_registry,
        lineage_id,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY,
    );
    identity_registry::record_identity_verification(
        &mut id_registry,
        lineage_id,
        MEMBER,
        identity_registry::provider_kyc(),
        NOW_MS,
        DONATION_END_MS + 1_000_000_000,
        1,
        b"",
    );
    (id_registry, mem_registry, pass)
}

// ---------------------------------------------------------------
// 1. set_floor_census with max_liability=0 sets census without escrow
// ---------------------------------------------------------------

#[test]
fun floor_census_with_zero_members_sets_census_no_escrow() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario, EVENT_UID);
    // MainPool created by admin::init_for_testing

    scenario.next_tx(ADMIN);
    let mut cat_pool = scenario.take_shared<category_pool::CategoryPool>();
    let mut main_pool = scenario.take_shared<pools::MainPool>();
    let mut c = scenario.take_shared<campaign::Campaign>();

    let result = make_census_result(vector[0, 0, 0]);
    campaign::apply_floor_census(
        &mut c,
        &result,
        EVENT_UID,
        EVENT_REVISION,
        CELLS_ROOT,
        &mut cat_pool,
        &mut main_pool,
        NOW_MS,
        scenario.ctx(),
    );

    let (census_set, floor_amounts, draw_cat, draw_main, floor_bal, _) =
        campaign::campaign_floor_census_fields(&c);

    assert!(census_set == true);
    assert!(*floor_amounts.borrow(0) == 0);
    assert!(draw_cat == 0);
    assert!(draw_main == 0);
    assert!(floor_bal == 0);

    let emitted = event::events_by_type<campaign::FloorCensusSet>();
    assert!(emitted.length() == 1);
    let (_, registered, max_liability, floor_ratio, event_floor_amounts, _, _) =
        campaign::floor_census_set_event_fields(*emitted.borrow(0));
    assert!(*registered.borrow(0) == 0);
    assert!(*registered.borrow(1) == 0);
    assert!(*registered.borrow(2) == 0);
    assert!(max_liability == 0);
    assert!(floor_ratio == 0);
    assert!(*event_floor_amounts.borrow(0) == 0);

    test_scenario::return_shared(cat_pool);
    test_scenario::return_shared(main_pool);
    test_scenario::return_shared(c);
    scenario.end();
}

// ---------------------------------------------------------------
// 2. set_floor_census normal: correct floor_ratio and escrow amounts
// ---------------------------------------------------------------

#[test]
fun floor_census_normal_calculates_correct_ratio_and_escrows() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario, EVENT_UID);
    // 100 registered in band 1 (target 50M), 50 in band 2 (target 150M)
    // max_liability = 100*50M + 50*150M = 5B + 7.5B = 12.5B (micro-USDC)
    // floor_target = 5000 * 12.5B / 10000 = 6.25B
    // cat has 10B, cat_available = 10B / 5 = 2B
    // draw_category = min(6.25B, 2B) = 2B
    // rem = 4.25B
    // main has 200B, reserve=100B, disposable=100B, main_share = 100B * 2000 / 10000 = 20B
    // draw_main = min(4.25B, 20B) = 4.25B
    // floor_budget = 6.25B
    // floor_ratio_bps = min(5000, 6.25B * 10000 / 12.5B) = min(5000, 5000) = 5000
    // floor_amount_by_band[0] = 50M * 5000 / 10000 = 25M

    fund_category_pool(&mut scenario, 10_000_000_000);
    // MainPool created by admin::init_for_testing
    fund_main_pool(&mut scenario, 200_000_000_000);

    scenario.next_tx(ADMIN);
    let mut cat_pool = scenario.take_shared<category_pool::CategoryPool>();
    let mut main_pool = scenario.take_shared<pools::MainPool>();
    let mut c = scenario.take_shared<campaign::Campaign>();

    let result = make_census_result(vector[100, 50, 0]);
    campaign::apply_floor_census(
        &mut c,
        &result,
        EVENT_UID,
        EVENT_REVISION,
        CELLS_ROOT,
        &mut cat_pool,
        &mut main_pool,
        NOW_MS,
        scenario.ctx(),
    );

    let (census_set, floor_amounts, draw_cat, draw_main, floor_bal, _) =
        campaign::campaign_floor_census_fields(&c);

    assert!(census_set == true);
    assert!(*floor_amounts.borrow(0) == 25_000_000);
    assert!(*floor_amounts.borrow(1) == 75_000_000);
    assert!(*floor_amounts.borrow(2) == 150_000_000);
    assert!(draw_cat == 2_000_000_000);
    assert!(draw_main == 4_250_000_000);
    assert!(floor_bal == draw_cat + draw_main);

    let emitted = event::events_by_type<campaign::FloorCensusSet>();
    assert!(emitted.length() == 1);
    let (_, registered, event_max_liability, event_ratio, event_floor_amounts, event_draw_cat, event_draw_main) =
        campaign::floor_census_set_event_fields(*emitted.borrow(0));
    assert!(*registered.borrow(0) == 100);
    assert!(*registered.borrow(1) == 50);
    assert!(*registered.borrow(2) == 0);
    assert!(event_max_liability == 12_500_000_000);
    assert!(event_ratio == 5_000);
    assert!(*event_floor_amounts.borrow(0) == 25_000_000);
    assert!(*event_floor_amounts.borrow(1) == 75_000_000);
    assert!(*event_floor_amounts.borrow(2) == 150_000_000);
    assert!(event_draw_cat == 2_000_000_000);
    assert!(event_draw_main == 4_250_000_000);

    test_scenario::return_shared(cat_pool);
    test_scenario::return_shared(main_pool);
    test_scenario::return_shared(c);
    scenario.end();
}

// ---------------------------------------------------------------
// 3. set_floor_census binding mismatch rejects wrong event_uid
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EFloorCensusBindingMismatch)]
fun floor_census_binding_mismatch_rejects_wrong_event_uid() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario, EVENT_UID);
    // MainPool created by admin::init_for_testing

    scenario.next_tx(ADMIN);
    let mut cat_pool = scenario.take_shared<category_pool::CategoryPool>();
    let mut main_pool = scenario.take_shared<pools::MainPool>();
    let mut c = scenario.take_shared<campaign::Campaign>();

    let wrong_uid = x"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    let result = census_result::new_for_testing(
        wrong_uid,
        EVENT_REVISION,
        CELLS_ROOT,
        vector[10, 0, 0],
        NOW_MS,
    );
    campaign::apply_floor_census(
        &mut c,
        &result,
        EVENT_UID,
        EVENT_REVISION,
        CELLS_ROOT,
        &mut cat_pool,
        &mut main_pool,
        NOW_MS,
        scenario.ctx(),
    );

    test_scenario::return_shared(cat_pool);
    test_scenario::return_shared(main_pool);
    test_scenario::return_shared(c);
    scenario.end();
}

// ---------------------------------------------------------------
// 4. set_floor_census called twice aborts EFloorCensusAlreadySet
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EFloorCensusAlreadySet)]
fun floor_census_cannot_be_set_twice() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario, EVENT_UID);
    // MainPool created by admin::init_for_testing

    scenario.next_tx(ADMIN);
    let mut cat_pool = scenario.take_shared<category_pool::CategoryPool>();
    let mut main_pool = scenario.take_shared<pools::MainPool>();
    let mut c = scenario.take_shared<campaign::Campaign>();

    let result = make_census_result(vector[0, 0, 0]);
    campaign::apply_floor_census(
        &mut c, &result, EVENT_UID, EVENT_REVISION, CELLS_ROOT, &mut cat_pool, &mut main_pool, NOW_MS, scenario.ctx(),
    );
    // second call should abort
    campaign::apply_floor_census(
        &mut c, &result, EVENT_UID, EVENT_REVISION, CELLS_ROOT, &mut cat_pool, &mut main_pool, NOW_MS, scenario.ctx(),
    );

    test_scenario::return_shared(cat_pool);
    test_scenario::return_shared(main_pool);
    test_scenario::return_shared(c);
    scenario.end();
}

// ---------------------------------------------------------------
// 5. set_floor_census after donation_end_ms aborts
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EFloorCensusAfterDonationEnd)]
fun floor_census_after_donation_end_is_rejected() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario, EVENT_UID);
    // MainPool created by admin::init_for_testing

    scenario.next_tx(ADMIN);
    let mut cat_pool = scenario.take_shared<category_pool::CategoryPool>();
    let mut main_pool = scenario.take_shared<pools::MainPool>();
    let mut c = scenario.take_shared<campaign::Campaign>();

    let result = make_census_result(vector[0, 0, 0]);
    // call with now_ms >= donation_end_ms
    campaign::apply_floor_census(
        &mut c,
        &result,
        EVENT_UID,
        EVENT_REVISION,
        CELLS_ROOT,
        &mut cat_pool,
        &mut main_pool,
        DONATION_END_MS,
        scenario.ctx(),
    );

    test_scenario::return_shared(cat_pool);
    test_scenario::return_shared(main_pool);
    test_scenario::return_shared(c);
    scenario.end();
}

// ---------------------------------------------------------------
// 6. claim_floor normal: correct payout, FloorPaid event, FloorReceipt
// ---------------------------------------------------------------

#[test]
fun claim_floor_pays_correct_amount_and_emits_events() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario, EVENT_UID);
    fund_category_pool(&mut scenario, 10_000_000_000);
    // MainPool created by admin::init_for_testing
    fund_main_pool(&mut scenario, 200_000_000_000);

    // Set census: 1 member in band 1
    scenario.next_tx(ADMIN);
    {
        let mut cat_pool = scenario.take_shared<category_pool::CategoryPool>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let mut c = scenario.take_shared<campaign::Campaign>();
        let result = make_census_result(vector[1, 0, 0]);
        campaign::apply_floor_census(
            &mut c, &result, EVENT_UID, EVENT_REVISION, CELLS_ROOT, &mut cat_pool, &mut main_pool, NOW_MS, scenario.ctx(),
        );
        test_scenario::return_shared(cat_pool);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(c);
    };

    // Claim floor as MEMBER
    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (mut id_registry, mem_registry, pass) = setup_verified_member(&mut scenario);

        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);
        // Add a verified ClaimApplication
        campaign::add_claim_application_for_testing(&mut c, pass_lineage_id, 1u8, true, false, false, NOW_MS);

        // 既申請者の床払い: leaf/proof は不要（既申請ブランチで破棄される）
        campaign::claim(
            &mut c,
            object::id_from_address(@0xDEAD),
            EVENT_UID,
            EVENT_REVISION,
            CELLS_ROOT,
            NOW_MS,
            &id_registry,
            &mem_registry,
            &pass,
            identity_registry::provider_kyc(),
            KYC_DUPLICATE_KEY,
            option::none<affected_cell::AffectedCellLeaf>(),
            vector[],
            NOW_MS,
            scenario.ctx(),
        );

        let total_paid = campaign::campaign_total_paid_usdc(&c);
        assert!(total_paid == 25_000_000);

        let emitted_paid = event::events_by_type<campaign::FloorPaid>();
        assert!(emitted_paid.length() == 1);
        let (_, _, band, amount_usdc, recipient, _) =
            campaign::floor_paid_event_fields(*emitted_paid.borrow(0));
        assert!(band == 1u8);
        assert!(amount_usdc == 25_000_000);
        assert!(recipient == MEMBER);

        // clean up: remove binding so we can destroy registry
        identity_registry::remove_binding_for_testing(
            &mut id_registry,
            identity_registry::provider_kyc(),
            KYC_DUPLICATE_KEY,
        );
        identity_registry::destroy_identity_registry_for_testing(id_registry);
        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 7. claim: センサス未確定では床払いできず（既申請・本払いも無いので）ENothingToClaim
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::ENothingToClaim)]
fun claim_floor_census_not_set_is_rejected() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario, EVENT_UID);

    scenario.next_tx(MEMBER);
    let mut c = scenario.take_shared<campaign::Campaign>();
    let (id_registry, mem_registry, pass) = setup_verified_member(&mut scenario);
    let pass_lineage_id = membership::membership_pass_lineage_id(&pass);
    campaign::add_claim_application_for_testing(&mut c, pass_lineage_id, 1u8, true, false, false, NOW_MS);

    campaign::claim(
        &mut c,
        object::id_from_address(@0xDEAD),
        EVENT_UID,
        EVENT_REVISION,
        CELLS_ROOT,
        NOW_MS,
        &id_registry,
        &mem_registry,
        &pass,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY,
        option::none<affected_cell::AffectedCellLeaf>(),
        vector[],
        NOW_MS,
        scenario.ctx(),
    );

    identity_registry::destroy_identity_registry_for_testing(id_registry);
    membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
    membership::destroy_pass_for_testing(pass);
    test_scenario::return_shared(c);
    scenario.end();
}

// ---------------------------------------------------------------
// 8. claim: 既申請が未検証なら EClaimNotVerified
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EClaimNotVerified)]
fun claim_floor_not_verified_is_rejected() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario, EVENT_UID);
    fund_category_pool(&mut scenario, 10_000_000_000);
    // MainPool created by admin::init_for_testing
    fund_main_pool(&mut scenario, 200_000_000_000);

    // Set census
    scenario.next_tx(ADMIN);
    {
        let mut cat_pool = scenario.take_shared<category_pool::CategoryPool>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let mut c = scenario.take_shared<campaign::Campaign>();
        let result = make_census_result(vector[1, 0, 0]);
        campaign::apply_floor_census(
            &mut c, &result, EVENT_UID, EVENT_REVISION, CELLS_ROOT, &mut cat_pool, &mut main_pool, NOW_MS, scenario.ctx(),
        );
        test_scenario::return_shared(cat_pool);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(c);
    };

    scenario.next_tx(MEMBER);
    let mut c = scenario.take_shared<campaign::Campaign>();
    let (id_registry, mem_registry, pass) = setup_verified_member(&mut scenario);
    let pass_lineage_id = membership::membership_pass_lineage_id(&pass);
    // Not verified
    campaign::add_claim_application_for_testing(&mut c, pass_lineage_id, 1u8, false, false, false, NOW_MS);

    campaign::claim(
        &mut c,
        object::id_from_address(@0xDEAD),
        EVENT_UID,
        EVENT_REVISION,
        CELLS_ROOT,
        NOW_MS,
        &id_registry,
        &mem_registry,
        &pass,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY,
        option::none<affected_cell::AffectedCellLeaf>(),
        vector[],
        NOW_MS,
        scenario.ctx(),
    );

    identity_registry::destroy_identity_registry_for_testing(id_registry);
    membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
    membership::destroy_pass_for_testing(pass);
    test_scenario::return_shared(c);
    scenario.end();
}

// ---------------------------------------------------------------
// 9. claim: 既に床受給済みなら（本払いも無いので）ENothingToClaim
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::ENothingToClaim)]
fun claim_floor_already_claimed_is_rejected() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario, EVENT_UID);
    fund_category_pool(&mut scenario, 10_000_000_000);
    // MainPool created by admin::init_for_testing
    fund_main_pool(&mut scenario, 200_000_000_000);

    // Set census
    scenario.next_tx(ADMIN);
    {
        let mut cat_pool = scenario.take_shared<category_pool::CategoryPool>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let mut c = scenario.take_shared<campaign::Campaign>();
        let result = make_census_result(vector[1, 0, 0]);
        campaign::apply_floor_census(
            &mut c, &result, EVENT_UID, EVENT_REVISION, CELLS_ROOT, &mut cat_pool, &mut main_pool, NOW_MS, scenario.ctx(),
        );
        test_scenario::return_shared(cat_pool);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(c);
    };

    scenario.next_tx(MEMBER);
    let mut c = scenario.take_shared<campaign::Campaign>();
    let (id_registry, mem_registry, pass) = setup_verified_member(&mut scenario);
    let pass_lineage_id = membership::membership_pass_lineage_id(&pass);
    // Already claimed
    campaign::add_claim_application_for_testing(&mut c, pass_lineage_id, 1u8, true, true, false, NOW_MS);

    campaign::claim(
        &mut c,
        object::id_from_address(@0xDEAD),
        EVENT_UID,
        EVENT_REVISION,
        CELLS_ROOT,
        NOW_MS,
        &id_registry,
        &mem_registry,
        &pass,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY,
        option::none<affected_cell::AffectedCellLeaf>(),
        vector[],
        NOW_MS,
        scenario.ctx(),
    );

    identity_registry::destroy_identity_registry_for_testing(id_registry);
    membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
    membership::destroy_pass_for_testing(pass);
    test_scenario::return_shared(c);
    scenario.end();
}

// ---------------------------------------------------------------
// 10. return_floor_budget before Day 30 aborts EDonationPeriodNotOver
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EDonationPeriodNotOver)]
fun return_floor_budget_before_donation_end_is_rejected() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario, EVENT_UID);
    // MainPool created by admin::init_for_testing

    // Set census (no escrow)
    scenario.next_tx(ADMIN);
    {
        let mut cat_pool = scenario.take_shared<category_pool::CategoryPool>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let mut c = scenario.take_shared<campaign::Campaign>();
        let result = make_census_result(vector[0, 0, 0]);
        campaign::apply_floor_census(
            &mut c, &result, EVENT_UID, EVENT_REVISION, CELLS_ROOT, &mut cat_pool, &mut main_pool, NOW_MS, scenario.ctx(),
        );
        // Try return before donation_end_ms
        campaign::return_floor_budget(&mut c, &mut cat_pool, &mut main_pool, NOW_MS, scenario.ctx());
        test_scenario::return_shared(cat_pool);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 11. return_floor_budget normal: proportional split, correct amounts
// ---------------------------------------------------------------

#[test]
fun return_floor_budget_proportional_split() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario, EVENT_UID);
    // 1 member band 1 → draw_cat = 2B (min(25M, 2B)), draw_main = 23M
    // Actually let's use a simpler setup: 10 members in band 1
    // max_liability = 10 * 50M = 500M
    // floor_target = 5000 * 500M / 10000 = 250M
    // cat_available = 10B / 5 = 2B → draw_cat = min(250M, 2B) = 250M
    // rem = 0 → draw_main = 0
    // floor_budget = 250M, ratio = 250M * 10000 / 500M = 5000
    // floor_amount[0] = 50M * 5000 / 10000 = 25M
    fund_category_pool(&mut scenario, 10_000_000_000);
    // MainPool created by admin::init_for_testing
    fund_main_pool(&mut scenario, 200_000_000_000);

    // Set census
    scenario.next_tx(ADMIN);
    {
        let mut cat_pool = scenario.take_shared<category_pool::CategoryPool>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let mut c = scenario.take_shared<campaign::Campaign>();
        let result = make_census_result(vector[10, 0, 0]);
        campaign::apply_floor_census(
            &mut c, &result, EVENT_UID, EVENT_REVISION, CELLS_ROOT, &mut cat_pool, &mut main_pool, NOW_MS, scenario.ctx(),
        );
        // Verify escrow: draw_cat=250M, draw_main=0
        let (_, _, draw_cat, draw_main, floor_bal, _) = campaign::campaign_floor_census_fields(&c);
        assert!(draw_cat == 250_000_000);
        assert!(draw_main == 0);
        assert!(floor_bal == 250_000_000);
        test_scenario::return_shared(cat_pool);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(c);
    };

    // Return after donation_end_ms (no one claimed)
    scenario.next_tx(ADMIN);
    {
        let mut cat_pool = scenario.take_shared<category_pool::CategoryPool>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let mut c = scenario.take_shared<campaign::Campaign>();
        let cat_before = category_pool::category_pool_balance_usdc(&cat_pool);
        campaign::return_floor_budget(&mut c, &mut cat_pool, &mut main_pool, DONATION_END_MS, scenario.ctx());

        let (_, _, _, _, floor_bal, budget_returned) = campaign::campaign_floor_census_fields(&c);
        assert!(floor_bal == 0);
        assert!(budget_returned == true);

        // All 250M came from category, so all goes back to category
        let cat_after = category_pool::category_pool_balance_usdc(&cat_pool);
        assert!(cat_after == cat_before + 250_000_000);

        let emitted = event::events_by_type<campaign::FloorBudgetReturned>();
        assert!(emitted.length() == 1);
        let (_, returned_cat, returned_main) = campaign::floor_budget_returned_event_fields(*emitted.borrow(0));
        assert!(returned_cat == 250_000_000);
        assert!(returned_main == 0);

        test_scenario::return_shared(cat_pool);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 12. floor census から別 DisasterEvent の census を適用しようとすると拒否される
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EFloorCensusBindingMismatch)]
fun floor_census_from_different_disaster_event_is_rejected() {
    let mut scenario = setup();
    // キャンペーンは EVENT_UID で作成
    create_campaign_in_scenario(&mut scenario, EVENT_UID);

    scenario.next_tx(ADMIN);
    {
        let mut cat_pool = scenario.take_shared<category_pool::CategoryPool>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let mut c = scenario.take_shared<campaign::Campaign>();

        // 別の災害の uid/revision を持つ census を生成
        let other_uid = x"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        let result = census_result::new_for_testing(
            other_uid,
            EVENT_REVISION,
            CELLS_ROOT,
            vector[10, 0, 0],
            NOW_MS,
        );
        // other_uid で呼び出す → campaign.event_uid != other_uid で abort
        campaign::apply_floor_census(
            &mut c,
            &result,
            other_uid,
            EVENT_REVISION,
            CELLS_ROOT,
            &mut cat_pool,
            &mut main_pool,
            NOW_MS,
            scenario.ctx(),
        );

        test_scenario::return_shared(cat_pool);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 13. claim_floor issues ClaimReceipt with kind=FLOOR
// ---------------------------------------------------------------

#[test]
fun claim_floor_issues_claim_receipt_with_floor_kind() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario, EVENT_UID);
    fund_category_pool(&mut scenario, 10_000_000_000);
    fund_main_pool(&mut scenario, 200_000_000_000);

    // Set census: 1 member in band 1
    scenario.next_tx(ADMIN);
    {
        let mut cat_pool = scenario.take_shared<category_pool::CategoryPool>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let mut c = scenario.take_shared<campaign::Campaign>();
        let result = make_census_result(vector[1, 0, 0]);
        campaign::apply_floor_census(
            &mut c, &result, EVENT_UID, EVENT_REVISION, CELLS_ROOT, &mut cat_pool, &mut main_pool, NOW_MS, scenario.ctx(),
        );
        test_scenario::return_shared(cat_pool);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(c);
    };

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (mut id_registry, mem_registry, pass) = setup_verified_member(&mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);
        campaign::add_claim_application_for_testing(&mut c, pass_lineage_id, 1u8, true, false, false, NOW_MS);

        campaign::claim(
            &mut c,
            object::id_from_address(@0xDEAD),
            EVENT_UID,
            EVENT_REVISION,
            CELLS_ROOT,
            NOW_MS,
            &id_registry,
            &mem_registry,
            &pass,
            identity_registry::provider_kyc(),
            KYC_DUPLICATE_KEY,
            option::none<affected_cell::AffectedCellLeaf>(),
            vector[],
            NOW_MS,
            scenario.ctx(),
        );

        test_scenario::return_shared(c);
        identity_registry::remove_binding_for_testing(
            &mut id_registry,
            identity_registry::provider_kyc(),
            KYC_DUPLICATE_KEY,
        );
        identity_registry::destroy_identity_registry_for_testing(id_registry);
        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
    };

    // Verify ClaimReceipt transferred to MEMBER
    scenario.next_tx(MEMBER);
    {
        let receipt = scenario.take_from_sender<campaign::ClaimReceipt>();
        let (campaign_id_r, pass_lineage_id_r, round_r, band_r, amount_usdc_r, claimed_at_ms_r, kind_r) =
            campaign::claim_receipt_fields(receipt);
        assert!(band_r == 1u8);
        assert!(amount_usdc_r == 25_000_000);
        assert!(claimed_at_ms_r == NOW_MS);
        assert!(round_r == 0);
        assert!(kind_r == campaign::claim_kind_floor());
        let _ = campaign_id_r;
        let _ = pass_lineage_id_r;
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 14. return_floor_budget twice aborts EFloorBudgetAlreadyReturned
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EFloorBudgetAlreadyReturned)]
fun return_floor_budget_twice_is_rejected() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario, EVENT_UID);
    // MainPool created by admin::init_for_testing

    scenario.next_tx(ADMIN);
    {
        let mut cat_pool = scenario.take_shared<category_pool::CategoryPool>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let mut c = scenario.take_shared<campaign::Campaign>();
        let result = make_census_result(vector[0, 0, 0]);
        campaign::apply_floor_census(
            &mut c, &result, EVENT_UID, EVENT_REVISION, CELLS_ROOT, &mut cat_pool, &mut main_pool, NOW_MS, scenario.ctx(),
        );
        campaign::return_floor_budget(&mut c, &mut cat_pool, &mut main_pool, DONATION_END_MS, scenario.ctx());
        // second call should abort
        campaign::return_floor_budget(&mut c, &mut cat_pool, &mut main_pool, DONATION_END_MS, scenario.ctx());
        test_scenario::return_shared(cat_pool);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(c);
    };
    scenario.end();
}
