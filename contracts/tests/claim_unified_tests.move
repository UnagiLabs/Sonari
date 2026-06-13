#[test_only]
module contracts::claim_unified_tests;

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

// campaign created at this time (clock value in setup)
const NOW_MS: u64 = 1_704_170_000_000;

// DONATION_PERIOD_MS = 2_592_000_000
const DONATION_END_MS: u64 = NOW_MS + 2_592_000_000;

// DisasterEvent mock values (matching create_campaign_in_scenario)
const EVENT_UID: vector<u8> = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EVENT_REVISION: u32 = 1u32;
const CELLS_ROOT: vector<u8> = x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// occurred_at_ms for the disaster; account/home cell timestamps default to 0
// so the cutoff checks (< occurred_at_ms) pass automatically
const OCCURRED_AT_MS: u64 = 1_704_067_200_000;

const KYC_DUPLICATE_KEY: vector<u8> =
    x"4444444444444444444444444444444444444444444444444444444444444444";

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------

// admin init (MainPool + OperationsPool) + CategoryRegistry + CategoryPool
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

fun create_campaign_in_scenario(scenario: &mut test_scenario::Scenario) {
    let cat_registry = scenario.take_shared<category_pool::CategoryRegistry>();
    let cat_pool = scenario.take_shared<category_pool::CategoryPool>();
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(NOW_MS);

    let disaster_event_id = object::id_from_address(@0xDEAD);
    campaign::create_campaign(
        &cat_registry,
        &cat_pool,
        disaster_event_id,
        EVENT_UID,
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

fun make_census_result(registered_by_band: vector<u64>): census_result::FloorCensusResult {
    census_result::new_for_testing(
        EVENT_UID,
        EVENT_REVISION,
        CELLS_ROOT,
        registered_by_band,
        NOW_MS,
    )
}

// Creates an AffectedCellLeaf whose h3_index matches the member home_cell=0
fun make_leaf(cell_band: u8): affected_cell::AffectedCellLeaf {
    affected_cell::new_leaf(
        EVENT_UID,
        EVENT_REVISION,
        /* h3_index */ 0u64,
        /* geo_resolution */ 3u8,
        /* cell_metric */ 1u8,
        /* intensity_value */ 100u16,
        /* intensity_scale */ 1u8,
        cell_band,
        /* cells_generation_method */ 0u8,
        /* oracle_version */ 1u64,
    )
}

// Member with home_cell=0 and timestamps=0, identity verified and KYC key bound.
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
// 1. happy path: 初回 claim で資格確立＋床払い、2回目 claim で lazy finalize＋本払い
// ---------------------------------------------------------------

#[test]
fun claim_first_time_pays_floor_then_lazy_finalize_pays_payout() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);
    fund_category_pool(&mut scenario, 10_000_000_000);
    fund_main_pool(&mut scenario, 200_000_000_000);

    // ADMIN: 床センサス [1,0,0] を確定し、本払い用に campaign balance を 100M 用意する。
    // census [1,0,0] + 標準資金 → floor_amount_by_band[0] = 25M（floor_tests と同条件）。
    scenario.next_tx(ADMIN);
    {
        let mut cat_pool = scenario.take_shared<category_pool::CategoryPool>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let mut c = scenario.take_shared<campaign::Campaign>();
        let result = make_census_result(vector[1, 0, 0]);
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
        campaign::fund_campaign_for_testing(&mut c, 100_000_000, scenario.ctx());
        test_scenario::return_shared(cat_pool);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(c);
    };

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (mut id_registry, mem_registry, pass) = setup_verified_member(&mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);

        let leaf = make_leaf(1u8);
        let root = affected_cell::leaf_hash(&leaf);

        // --- claim #1: 初回 → 資格確立 + 床払い ---
        campaign::claim(
            &mut c,
            object::id_from_address(@0xDEAD),
            EVENT_UID,
            EVENT_REVISION,
            root,
            OCCURRED_AT_MS,
            &id_registry,
            &mem_registry,
            &pass,
            identity_registry::provider_kyc(),
            KYC_DUPLICATE_KEY,
            option::some(leaf),
            vector[],
            NOW_MS,
            scenario.ctx(),
        );

        // 資格確立: ClaimApplication が登録済み・検証済み・床受給済み
        assert!(campaign::campaign_has_claim_application(&c, pass_lineage_id));
        let (band, _, verified, floor_claimed, excluded) =
            campaign::campaign_claim_application_fields(&c, pass_lineage_id);
        assert!(band == 1u8);
        assert!(verified);
        assert!(floor_claimed);
        assert!(!excluded);

        // 床払い額はオンチェーン確定値（floor_amount_by_band[0] = 25M）由来
        assert!(campaign::campaign_total_paid_usdc(&c) == 25_000_000);

        let floor_events = event::events_by_type<campaign::FloorPaid>();
        assert!(floor_events.length() == 1);
        let (_, ev_floor_lineage, ev_floor_band, ev_floor_amount, ev_floor_recipient, _) =
            campaign::floor_paid_event_fields(*floor_events.borrow(0));
        assert!(ev_floor_lineage == pass_lineage_id);
        assert!(ev_floor_band == 1u8);
        assert!(ev_floor_amount == 25_000_000);
        assert!(ev_floor_recipient == MEMBER);

        // この時点ではラウンド未確定（current_round == 0）
        let (round_before, _, _, _, _) = campaign::campaign_payout_round_fields(&c);
        assert!(round_before == 0);

        // --- claim #2: 既申請 → lazy finalize（round 0→1）+ 本払い ---
        campaign::claim(
            &mut c,
            object::id_from_address(@0xDEAD),
            EVENT_UID,
            EVENT_REVISION,
            root,
            OCCURRED_AT_MS,
            &id_registry,
            &mem_registry,
            &pass,
            identity_registry::provider_kyc(),
            KYC_DUPLICATE_KEY,
            option::none<affected_cell::AffectedCellLeaf>(),
            vector[],
            DONATION_END_MS,
            scenario.ctx(),
        );

        // lazy finalize でラウンドが 1 に進む
        let (round_after, _, band_payout, closed, sweep_eligible) =
            campaign::campaign_payout_round_fields(&c);
        assert!(round_after == 1);
        assert!(!closed);
        assert!(!sweep_eligible);
        // liability = 1×50M, cap = 150M, av = 100M → effective = 100M, payout[0] = 100M
        assert!(*band_payout.borrow(0) == 100_000_000);

        // 本払い額もオンチェーン確定値（round_payout_by_band[0] = 100M）由来
        // total = 床 25M + 本払い 100M = 125M
        assert!(campaign::campaign_total_paid_usdc(&c) == 125_000_000);

        let finalized = event::events_by_type<campaign::RoundFinalized>();
        assert!(finalized.length() == 1);
        let (_, fr_round, fr_liability, fr_av, fr_payout, fr_elig, _) =
            campaign::round_finalized_event_fields(*finalized.borrow(0));
        assert!(fr_round == 1);
        assert!(fr_liability == 50_000_000);
        assert!(fr_av == 100_000_000);
        assert!(*fr_payout.borrow(0) == 100_000_000);
        assert!(fr_elig == 1);

        let payout_events = event::events_by_type<campaign::PayoutClaimed>();
        assert!(payout_events.length() == 1);
        let (_, pr_round, pr_lineage, pr_band, pr_amount, pr_recipient) =
            campaign::payout_claimed_event_fields(*payout_events.borrow(0));
        assert!(pr_round == 1);
        assert!(pr_lineage == pass_lineage_id);
        assert!(pr_band == 1u8);
        assert!(pr_amount == 100_000_000);
        assert!(pr_recipient == MEMBER);

        // cleanup
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
// 2. ENothingToClaim: 既申請・床受給済み・本払い対象外なら「払えるものが無い」で abort
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::ENothingToClaim)]
fun claim_existing_applicant_with_nothing_to_pay_aborts() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (id_registry, mem_registry, pass) = setup_verified_member(&mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);

        // 既申請: 検証済み・床受給済み・除外なし。current_round は 0 のまま。
        campaign::add_claim_application_for_testing(
            &mut c,
            pass_lineage_id,
            1u8,
            /* verified */ true,
            /* floor_claimed */ true,
            /* excluded */ false,
            NOW_MS,
        );

        // 床は受給済み、ラウンドは 0（本払いなし）、申請期限内なので finalize もなし
        // → 何も払えないので ENothingToClaim で abort する。
        campaign::claim(
            &mut c,
            object::id_from_address(@0xDEAD),
            EVENT_UID,
            EVENT_REVISION,
            CELLS_ROOT,
            OCCURRED_AT_MS,
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
    };
    scenario.end();
}
