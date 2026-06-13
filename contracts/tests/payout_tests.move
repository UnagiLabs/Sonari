#[allow(unused_const, unused_use)]
#[test_only]
module contracts::payout_tests;

use contracts::admin;
use contracts::affected_cell;
use contracts::campaign;
use contracts::category_pool;
use contracts::census_result;
use contracts::identity_registry;
use contracts::membership;
use contracts::pools;
use sui::event;
use sui::test_scenario;

const ADMIN: address = @0xA11CE;
const MEMBER: address = @0xBEEF;

// Campaign created at this time
const NOW_MS: u64 = 1_704_170_000_000;

// DONATION_PERIOD_MS = 2_592_000_000
const DONATION_END_MS: u64 = NOW_MS + 2_592_000_000;

// ROUND_INTERVAL_MS = 7_776_000_000
const ROUND_INTERVAL_MS: u64 = 7_776_000_000;

const EVENT_UID: vector<u8> = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EVENT_REVISION: u32 = 1u32;

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------

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
    let mut clock = sui::clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(NOW_MS);

    campaign::create_campaign(
        &cat_registry,
        &cat_pool,
        object::id_from_address(@0xDEAD),
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

// Creates a pass for `owner` with default home_cell=0 and timestamps=0
fun make_pass_for(
    owner: address,
    scenario: &mut test_scenario::Scenario,
): (membership::MembershipRegistry, membership::MembershipPass) {
    membership::create_registry_and_pass_for_testing(owner, 1, b"", scenario.ctx())
}

// 本払いのみの claim 呼び出し。これらのテストはセンサス未設定なので
// 床払い・本人確認は発生せず、本払い経路だけが走る。
// leaf/proof/disaster 引数は既申請ブランチで使われないためダミーを渡す。
// 本人確認も skip されるので空の IdentityRegistry を都度作って破棄する。
fun claim_payout_only(
    c: &mut campaign::Campaign,
    mem_registry: &membership::MembershipRegistry,
    pass: &membership::MembershipPass,
    now_ms: u64,
    ctx: &mut TxContext,
) {
    let id_registry = identity_registry::create_identity_registry_for_testing(ctx);
    campaign::claim(
        c,
        object::id_from_address(@0xDEAD),
        EVENT_UID,
        EVENT_REVISION,
        b"",
        NOW_MS,
        &id_registry,
        mem_registry,
        pass,
        identity_registry::provider_kyc(),
        b"",
        option::none<affected_cell::AffectedCellLeaf>(),
        vector[],
        now_ms,
        ctx,
    );
    identity_registry::destroy_identity_registry_for_testing(id_registry);
}


// ---------------------------------------------------------------
// 1. happy path: finalize_round Round 1 computes payouts correctly
// ---------------------------------------------------------------

#[test]
fun finalize_round_computes_band_payouts_for_round_1() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        // Fund campaign: 1000 USDC
        campaign::fund_campaign_for_testing(&mut c, 1_000_000_000, scenario.ctx());

        // Add 2 verified band-1 members (band_target_1 = 50_000_000)
        let pass_lineage_1 = object::id_from_address(@0x0001);
        let pass_lineage_2 = object::id_from_address(@0x0002);
        campaign::add_claim_application_for_testing(&mut c, pass_lineage_1, 1u8, true, false, false, NOW_MS);
        campaign::add_claim_application_for_testing(&mut c, pass_lineage_2, 1u8, true, false, false, NOW_MS);

        test_scenario::return_shared(c);
    };

    // Simulate finalize_round after donation period ends
    // But add_claim_application_for_testing doesn't increment verified_count_by_band.
    // Use set_claim_verified to increment.
    scenario.next_tx(ADMIN);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let pass_lineage_1 = object::id_from_address(@0x0001);
        let pass_lineage_2 = object::id_from_address(@0x0002);
        campaign::set_claim_verified(&mut c, pass_lineage_1, 0);
        campaign::set_claim_verified(&mut c, pass_lineage_2, 0);

        // verified_count_by_band[0] == 2
        let vcounts = campaign::campaign_verified_count_by_band(&c);
        assert!(*vcounts.borrow(0) == 2);

        // Finalize at donation_end_ms
        campaign::finalize_round_v2(&mut c, DONATION_END_MS);

        let (round, _, band_payout, closed, sweep_eligible) =
            campaign::campaign_payout_round_fields(&c);
        assert!(round == 1);
        assert!(!closed);
        assert!(!sweep_eligible);

        // liability = 2 × 50_000_000 = 100_000_000
        // campaign_av = 1_000_000_000
        // cap = 100_000_000 × 3 = 300_000_000 < campaign_av → effective_av = 300_000_000
        // band_payout[0] = 50_000_000 × 300_000_000 / 100_000_000 = 150_000_000
        assert!(*band_payout.borrow(0) == 150_000_000);

        let events = event::events_by_type<campaign::RoundFinalized>();
        assert!(events.length() == 1);
        let (_, ev_round, ev_liability, ev_av, ev_payout, ev_elig, _) =
            campaign::round_finalized_event_fields(*events.borrow(0));
        assert!(ev_round == 1);
        assert!(ev_liability == 100_000_000);
        assert!(ev_av == 1_000_000_000);
        assert!(*ev_payout.borrow(0) == 150_000_000);
        assert!(ev_elig == 2);

        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 2. reject: finalize_round too early (before donation_end_ms)
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::ERoundTooEarly)]
fun finalize_round_rejects_too_early() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        // Try to finalize before donation period ends
        campaign::finalize_round_v2(&mut c, DONATION_END_MS - 1);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 3. finalize_round with liability=0 sets sweep_eligible
// ---------------------------------------------------------------

#[test]
fun finalize_round_with_zero_eligible_sets_sweep_eligible() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        // No verified members → liability == 0
        campaign::finalize_round_v2(&mut c, DONATION_END_MS);

        let (round, _, band_payout, _, sweep_eligible) =
            campaign::campaign_payout_round_fields(&c);
        assert!(round == 1);
        assert!(sweep_eligible);
        assert!(*band_payout.borrow(0) == 0);

        let events = event::events_by_type<campaign::RoundFinalized>();
        let (_, _, _, _, _, ev_elig, _) = campaign::round_finalized_event_fields(*events.borrow(0));
        assert!(ev_elig == 0);

        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 4. finalize_round termination sets sweep_eligible without advancing round
// ---------------------------------------------------------------

#[test]
fun finalize_round_termination_sets_sweep_eligible_no_round_advance() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        // Fund with tiny amount (1 unit, min_payout_per_recipient = 1_000_000)
        // With 1 verified member, campaign_av / eligible = 1 < 1_000_000 → termination
        campaign::fund_campaign_for_testing(&mut c, 1, scenario.ctx());

        let pass_lineage = object::id_from_address(@0x0001);
        campaign::add_claim_application_for_testing(&mut c, pass_lineage, 1u8, true, false, false, NOW_MS);
        campaign::set_claim_verified(&mut c, pass_lineage, 0);

        campaign::finalize_round_v2(&mut c, DONATION_END_MS);

        let (round, _, _, _, sweep_eligible) = campaign::campaign_payout_round_fields(&c);
        // Round NOT advanced (termination path)
        assert!(round == 0);
        assert!(sweep_eligible);

        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 5. happy path: claim_payout transfers coin and issues PayoutReceipt
// ---------------------------------------------------------------

#[test]
fun claim_payout_transfers_coin_and_issues_receipt() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    // Fund and setup verified member
    scenario.next_tx(ADMIN);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        campaign::fund_campaign_for_testing(&mut c, 1_000_000_000, scenario.ctx());
        test_scenario::return_shared(c);
    };

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (mem_registry, pass) = make_pass_for(MEMBER, &mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);

        campaign::add_claim_application_for_testing(&mut c, pass_lineage_id, 1u8, true, false, false, NOW_MS);
        campaign::set_claim_verified(&mut c, pass_lineage_id, 0);

        // Finalize round
        campaign::finalize_round_v2(&mut c, DONATION_END_MS);

        // Claim payout
        claim_payout_only(&mut c, &mem_registry, &pass, DONATION_END_MS, scenario.ctx());

        let events = event::events_by_type<campaign::PayoutClaimed>();
        assert!(events.length() == 1);
        let (_, ev_round, _, ev_band, ev_amount, ev_recipient) =
            campaign::payout_claimed_event_fields(*events.borrow(0));
        assert!(ev_round == 1);
        assert!(ev_band == 1u8);
        // band_payout[0] = 50M × (min(1000M, 50M×3) / 50M) = 50M × 3 = 150M
        assert!(ev_amount == 150_000_000);
        assert!(ev_recipient == MEMBER);

        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 6. reject: claim_payout duplicate (same pass + same round)
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::ENothingToClaim)]
fun claim_payout_rejects_duplicate() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        campaign::fund_campaign_for_testing(&mut c, 1_000_000_000, scenario.ctx());
        test_scenario::return_shared(c);
    };

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (mem_registry, pass) = make_pass_for(MEMBER, &mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);

        campaign::add_claim_application_for_testing(&mut c, pass_lineage_id, 1u8, true, false, false, NOW_MS);
        campaign::set_claim_verified(&mut c, pass_lineage_id, 0);
        campaign::finalize_round_v2(&mut c, DONATION_END_MS);

        claim_payout_only(&mut c, &mem_registry, &pass, DONATION_END_MS, scenario.ctx());
        // 2 回目は支払い対象がないため ENothingToClaim で abort する
        claim_payout_only(&mut c, &mem_registry, &pass, DONATION_END_MS, scenario.ctx());

        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 7. reject: claim_payout before finalize (round==0) → ERoundNotStarted
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::ENothingToClaim)]
fun claim_payout_rejects_before_finalize() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (mem_registry, pass) = make_pass_for(MEMBER, &mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);

        campaign::add_claim_application_for_testing(&mut c, pass_lineage_id, 1u8, true, false, false, NOW_MS);
        campaign::set_claim_verified(&mut c, pass_lineage_id, 0);

        // No finalize_round called → current_round == 0 なので支払い対象なし → ENothingToClaim
        claim_payout_only(&mut c, &mem_registry, &pass, NOW_MS, scenario.ctx());

        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 8. reject: claim_payout excluded member
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EClaimExcluded)]
fun claim_payout_rejects_excluded_member() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        campaign::fund_campaign_for_testing(&mut c, 1_000_000_000, scenario.ctx());
        test_scenario::return_shared(c);
    };

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (mem_registry, pass) = make_pass_for(MEMBER, &mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);

        campaign::add_claim_application_for_testing(&mut c, pass_lineage_id, 1u8, true, false, false, NOW_MS);
        campaign::set_claim_verified(&mut c, pass_lineage_id, 0);
        campaign::finalize_round_v2(&mut c, DONATION_END_MS);

        // Exclude member
        campaign::exclude_recipient_internal(
            &mut c,
            pass_lineage_id,
            1u8,
            DONATION_END_MS,
            scenario.ctx(),
        );

        // Claim → EClaimExcluded
        claim_payout_only(&mut c, &mem_registry, &pass, DONATION_END_MS, scenario.ctx());

        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 9. reject: claim_payout with verified_in_round >= current_round
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::ENothingToClaim)]
fun claim_payout_rejects_verified_after_finalize() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        campaign::fund_campaign_for_testing(&mut c, 1_000_000_000, scenario.ctx());
        test_scenario::return_shared(c);
    };

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (mem_registry, pass) = make_pass_for(MEMBER, &mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);

        // Add app with verified_in_round = 0, then finalize to round 1
        campaign::add_claim_application_for_testing(&mut c, pass_lineage_id, 1u8, true, false, false, NOW_MS);

        // Finalize first so round becomes 1
        campaign::finalize_round_v2(&mut c, DONATION_END_MS);

        // Now "verify" the member at round 1 (verified_in_round = 1)
        campaign::set_claim_verified(&mut c, pass_lineage_id, 1);

        // verified_in_round (1) == current_round (1) なので支払い対象なし → ENothingToClaim
        claim_payout_only(&mut c, &mem_registry, &pass, DONATION_END_MS, scenario.ctx());

        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 10. sweep_residual happy path (via census + return_floor_budget)
// ---------------------------------------------------------------

#[test]
fun sweep_residual_transfers_balance_to_main() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let mut cat_pool = scenario.take_shared<category_pool::CategoryPool>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();

        campaign::fund_campaign_for_testing(&mut c, 500_000_000, scenario.ctx());

        // Set floor census (0 members) to satisfy census_set
        let census = census_result::new_for_testing(
            EVENT_UID,
            EVENT_REVISION,
            x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            vector[0, 0, 0],
            NOW_MS,
        );
        campaign::apply_floor_census(
            &mut c,
            &census,
            EVENT_UID,
            EVENT_REVISION,
            x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            &mut cat_pool,
            &mut main_pool,
            NOW_MS,
            scenario.ctx(),
        );

        // Return floor budget (campaign now at donation_end_ms which is in the past relative to DONATION_END_MS)
        campaign::return_floor_budget(
            &mut c,
            &mut cat_pool,
            &mut main_pool,
            DONATION_END_MS,
            scenario.ctx(),
        );

        // Finalize with 0 eligible → sweep_eligible = true
        campaign::finalize_round_v2(&mut c, DONATION_END_MS);

        let main_before = pools::main_pool_balance_usdc(&main_pool);

        // Sweep
        campaign::sweep_residual_v2(
            &mut c,
            &mut main_pool,
            DONATION_END_MS,
            scenario.ctx(),
        );

        let (_, _, _, closed, _) = campaign::campaign_payout_round_fields(&c);
        assert!(closed);

        // Main received the balance
        let main_after = pools::main_pool_balance_usdc(&main_pool);
        assert!(main_after == main_before + 500_000_000);

        let events = event::events_by_type<campaign::ResidualSweep>();
        assert!(events.length() == 1);
        let (_, ev_amount, ev_final_round) = campaign::residual_sweep_event_fields(*events.borrow(0));
        assert!(ev_amount == 500_000_000);
        assert!(ev_final_round == 1);

        test_scenario::return_shared(c);
        test_scenario::return_shared(cat_pool);
        test_scenario::return_shared(main_pool);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 11. reject: sweep_residual before floor_budget_returned
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EFloorBudgetNotReturned)]
fun sweep_residual_rejects_floor_budget_not_returned() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        // Finalize → sweep_eligible=true
        campaign::finalize_round_v2(&mut c, DONATION_END_MS);
        // No return_floor_budget → EFloorBudgetNotReturned
        campaign::sweep_residual_v2(&mut c, &mut main_pool, DONATION_END_MS, scenario.ctx());
        test_scenario::return_shared(c);
        test_scenario::return_shared(main_pool);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 12. reject: sweep_residual on already closed campaign
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EAlreadyClosed)]
fun sweep_residual_rejects_already_closed() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let mut cat_pool = scenario.take_shared<category_pool::CategoryPool>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();

        let census = census_result::new_for_testing(
            EVENT_UID,
            EVENT_REVISION,
            x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            vector[0, 0, 0],
            NOW_MS,
        );
        campaign::apply_floor_census(
            &mut c,
            &census,
            EVENT_UID,
            EVENT_REVISION,
            x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            &mut cat_pool,
            &mut main_pool,
            NOW_MS,
            scenario.ctx(),
        );
        campaign::return_floor_budget(&mut c, &mut cat_pool, &mut main_pool, DONATION_END_MS, scenario.ctx());
        campaign::finalize_round_v2(&mut c, DONATION_END_MS);
        campaign::sweep_residual_v2(&mut c, &mut main_pool, DONATION_END_MS, scenario.ctx());
        // Second sweep → EAlreadyClosed
        campaign::sweep_residual_v2(&mut c, &mut main_pool, DONATION_END_MS, scenario.ctx());

        test_scenario::return_shared(c);
        test_scenario::return_shared(cat_pool);
        test_scenario::return_shared(main_pool);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 13. exclude_recipient decrements verified count and emits event
// ---------------------------------------------------------------

#[test]
fun exclude_recipient_decrements_verified_count_and_emits_event() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();

        let pass_lineage = object::id_from_address(@0x0001);
        campaign::add_claim_application_for_testing(&mut c, pass_lineage, 2u8, true, false, false, NOW_MS);
        campaign::set_claim_verified(&mut c, pass_lineage, 0);

        let vcounts_before = campaign::campaign_verified_count_by_band(&c);
        assert!(*vcounts_before.borrow(1) == 1); // band 2 → index 1

        campaign::exclude_recipient_internal(
            &mut c,
            pass_lineage,
            42u8,
            NOW_MS,
            scenario.ctx(),
        );

        let vcounts_after = campaign::campaign_verified_count_by_band(&c);
        assert!(*vcounts_after.borrow(1) == 0);

        let events = event::events_by_type<campaign::RecipientExcluded>();
        assert!(events.length() == 1);
        let (_, ev_lineage, ev_reason, ev_round, _) =
            campaign::recipient_excluded_event_fields(*events.borrow(0));
        assert!(ev_lineage == pass_lineage);
        assert!(ev_reason == 42u8);
        assert!(ev_round == 0);

        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 14. Round 2: finalize_round after round_interval_ms re-distributes
// ---------------------------------------------------------------

#[test]
fun finalize_round_2_redistributes_remaining_balance() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        campaign::fund_campaign_for_testing(&mut c, 1_000_000_000, scenario.ctx());

        let pass_lineage = object::id_from_address(@0x0001);
        campaign::add_claim_application_for_testing(&mut c, pass_lineage, 1u8, true, false, false, NOW_MS);
        campaign::set_claim_verified(&mut c, pass_lineage, 0);

        // Round 1 finalize
        campaign::finalize_round_v2(&mut c, DONATION_END_MS);

        let (round_1, _, _, _, _) = campaign::campaign_payout_round_fields(&c);
        assert!(round_1 == 1);

        // Round 2: too early
        // round_finalized_at_ms = DONATION_END_MS
        // round_interval_ms = 7_776_000_000
        // next valid time = DONATION_END_MS + 7_776_000_000

        let round_2_ms = DONATION_END_MS + ROUND_INTERVAL_MS;
        campaign::finalize_round_v2(&mut c, round_2_ms);

        let (round_2, _, _, _, _) = campaign::campaign_payout_round_fields(&c);
        assert!(round_2 == 2);

        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 15. sweep_eligible は liability>0 の finalize でリセットされる
//     (Round1 で eligible=0 → sweep_eligible=true, Round2 で eligible>0 → false)
// ---------------------------------------------------------------

#[test]
fun finalize_round_resets_sweep_eligible_when_liability_gt_0() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        // Round 1: 適格メンバーなし → sweep_eligible = true
        campaign::finalize_round_v2(&mut c, DONATION_END_MS);

        let (_, _, _, _, sweep_eligible) = campaign::campaign_payout_round_fields(&c);
        assert!(sweep_eligible);

        // Round 2: メンバーを追加して liability > 0 にする
        // 残高を積んで termination check を回避する (MIN_PAYOUT_PER_RECIPIENT = 1_000_000)
        campaign::fund_campaign_for_testing(&mut c, 10_000_000, scenario.ctx());
        let pass_lineage = object::id_from_address(@0x0001);
        campaign::add_claim_application_for_testing(&mut c, pass_lineage, 1u8, false, false, false, NOW_MS);
        campaign::set_claim_verified(&mut c, pass_lineage, 0);

        let round2_time = DONATION_END_MS + ROUND_INTERVAL_MS;
        campaign::finalize_round_v2(&mut c, round2_time);

        let (round, _, _, _, sweep_after) = campaign::campaign_payout_round_fields(&c);
        assert!(round == 2);
        // sweep_eligible がリセットされていることを確認
        assert!(!sweep_after);

        let events = event::events_by_type<campaign::RoundFinalized>();
        let (_, _, _, _, _, eligible, _) = campaign::round_finalized_event_fields(*events.borrow(1));
        assert!(eligible == 1);

        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 16. sweep_residual は liability>0 finalize 後に拒否される (ESweepNotEligible)
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::ESweepNotEligible)]
fun sweep_residual_rejects_when_sweep_eligible_reset() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let mut cat_pool = scenario.take_shared<category_pool::CategoryPool>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();

        // Round 1: eligible=0 → sweep_eligible=true
        campaign::finalize_round_v2(&mut c, DONATION_END_MS);

        // Round 2: eligible>0 → sweep_eligible=false (リセット)
        // termination check 回避のため残高を積む
        campaign::fund_campaign_for_testing(&mut c, 10_000_000, scenario.ctx());
        let pass_lineage = object::id_from_address(@0x0001);
        campaign::add_claim_application_for_testing(&mut c, pass_lineage, 1u8, false, false, false, NOW_MS);
        campaign::set_claim_verified(&mut c, pass_lineage, 0);
        let round2_time = DONATION_END_MS + ROUND_INTERVAL_MS;
        campaign::finalize_round_v2(&mut c, round2_time);

        // floor budget を返還（sweep の前提条件）
        let census = census_result::new_for_testing(
            EVENT_UID,
            EVENT_REVISION,
            x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            vector[0, 0, 0],
            DONATION_END_MS - 1,
        );
        campaign::apply_floor_census(
            &mut c,
            &census,
            EVENT_UID,
            EVENT_REVISION,
            x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            &mut cat_pool,
            &mut main_pool,
            DONATION_END_MS - 1,
            scenario.ctx(),
        );
        campaign::return_floor_budget(&mut c, &mut cat_pool, &mut main_pool, DONATION_END_MS, scenario.ctx());

        // sweep_eligible=false のため ESweepNotEligible で abort すること
        campaign::sweep_residual_v2(&mut c, &mut main_pool, round2_time, scenario.ctx());

        test_scenario::return_shared(c);
        test_scenario::return_shared(cat_pool);
        test_scenario::return_shared(main_pool);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 17. claim_payout issues ClaimReceipt with kind=PAYOUT
// ---------------------------------------------------------------

#[test]
fun claim_payout_issues_claim_receipt_with_payout_kind() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        campaign::fund_campaign_for_testing(&mut c, 1_000_000_000, scenario.ctx());
        test_scenario::return_shared(c);
    };

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (mem_registry, pass) = make_pass_for(MEMBER, &mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);

        campaign::add_claim_application_for_testing(&mut c, pass_lineage_id, 1u8, true, false, false, NOW_MS);
        campaign::set_claim_verified(&mut c, pass_lineage_id, 0);
        campaign::finalize_round_v2(&mut c, DONATION_END_MS);
        claim_payout_only(&mut c, &mem_registry, &pass, DONATION_END_MS, scenario.ctx());

        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(c);
    };

    // Verify ClaimReceipt transferred to MEMBER
    scenario.next_tx(MEMBER);
    {
        let receipt = scenario.take_from_sender<campaign::ClaimReceipt>();
        let (campaign_id_r, pass_lineage_id_r, round_r, band_r, amount_usdc_r, claimed_at_ms_r, kind_r) =
            campaign::claim_receipt_fields(receipt);
        assert!(band_r == 1u8);
        assert!(amount_usdc_r == 150_000_000);
        assert!(round_r == 1);
        assert!(claimed_at_ms_r == DONATION_END_MS);
        assert!(kind_r == campaign::claim_kind_payout());
        let _ = campaign_id_r;
        let _ = pass_lineage_id_r;
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 18. reject: finalize_round Round 2 too early
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::ERoundTooEarly)]
fun finalize_round_2_rejects_too_early() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        campaign::finalize_round_v2(&mut c, DONATION_END_MS);

        // Too early for round 2
        campaign::finalize_round_v2(&mut c, DONATION_END_MS + 1);

        test_scenario::return_shared(c);
    };
    scenario.end();
}
