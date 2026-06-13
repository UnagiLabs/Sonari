#[allow(unused_const, unused_use)]
#[test_only]
module contracts::claim_accessor_tests;

use contracts::accessor;
use contracts::admin;
use contracts::affected_cell;
use contracts::campaign;
use contracts::category_pool;
use contracts::disaster_event;
use contracts::identity_registry;
use contracts::membership;
use sui::clock;
use sui::event;
use sui::test_scenario;

const ADMIN: address = @0xA11CE;
const MEMBER: address = @0xBEEF;

// Campaign は NOW_MS に作成される。
const NOW_MS: u64 = 1_704_170_000_000;

// DONATION_PERIOD_MS = 2_592_000_000。寄付期間終了でラウンド1が確定する。
const DONATION_END_MS: u64 = NOW_MS + 2_592_000_000;

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------

// admin 初期化 + 地震カテゴリプール + 災害レジストリを用意する。
// accessor::claim は PauseState を要求するため、ここで共有しておく。
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
    admin::create_disaster_registry(&cap, scenario.ctx());
    scenario.return_to_sender(cap);
    scenario.next_tx(ADMIN);

    scenario
}

// 実在する DisasterEvent を作り、それに紐づく Campaign を生成する。
// accessor::claim は &DisasterEvent を要求するので、ダミー ID では足りない。
// 本払い経路は災害バインディングを参照しないが、入口の委譲を実物で検証する。
fun create_campaign_with_event(scenario: &mut test_scenario::Scenario): object::ID {
    let cat_registry = scenario.take_shared<category_pool::CategoryRegistry>();
    let cat_pool = scenario.take_shared<category_pool::CategoryPool>();
    let mut disaster_registry = scenario.take_shared<disaster_event::DisasterRegistry>();
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(NOW_MS);

    let (event_uid, event_revision, de_id) = disaster_event::create_for_campaign_testing(
        &mut disaster_registry,
        campaign::hazard_type_earthquake_for_testing(),
        3u8,
        scenario.ctx(),
    );

    campaign::create_campaign(
        &cat_registry,
        &cat_pool,
        de_id,
        event_uid,
        event_revision,
        campaign::hazard_type_earthquake_for_testing(),
        3u8,
        &clock,
        scenario.ctx(),
    );

    test_scenario::return_shared(cat_registry);
    test_scenario::return_shared(cat_pool);
    test_scenario::return_shared(disaster_registry);
    clock.destroy_for_testing();

    de_id
}

// センサス未設定のキャンペーンに、検証済み・ラウンド1確定済みの申請を仕込む。
// この状態で accessor::claim を呼ぶと本払い経路だけが走る。
fun seed_verified_payout_applicant(
    c: &mut campaign::Campaign,
    pass: &membership::MembershipPass,
) {
    let pass_lineage_id = membership::membership_pass_lineage_id(pass);
    campaign::add_claim_application_for_testing(c, pass_lineage_id, 1u8, true, false, false, NOW_MS);
    campaign::set_claim_verified(c, pass_lineage_id, 0);
    campaign::finalize_round_v2(c, DONATION_END_MS);
}

// ---------------------------------------------------------------
// 1. happy path: accessor::claim が campaign::claim へ委譲し本払いする
// ---------------------------------------------------------------

#[test]
fun accessor_claim_pays_payout_via_delegation() {
    let mut scenario = setup();
    let de_id = create_campaign_with_event(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        campaign::fund_campaign_for_testing(&mut c, 1_000_000_000, scenario.ctx());
        test_scenario::return_shared(c);
    };

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let disaster_event = scenario.take_shared_by_id<disaster_event::DisasterEvent>(de_id);
        let pause_state = scenario.take_shared<admin::PauseState>();
        let (mem_registry, pass) =
            membership::create_registry_and_pass_for_testing(MEMBER, 1, b"", scenario.ctx());
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);

        seed_verified_payout_applicant(&mut c, &pass);

        let id_registry = identity_registry::create_identity_registry_for_testing(scenario.ctx());
        let mut clock = clock::create_for_testing(scenario.ctx());
        clock.set_for_testing(DONATION_END_MS);

        accessor::claim(
            &pause_state,
            &mut c,
            &disaster_event,
            &id_registry,
            &mem_registry,
            &pass,
            identity_registry::provider_kyc(),
            b"",
            option::none<affected_cell::AffectedCellLeaf>(),
            vector[],
            &clock,
            scenario.ctx(),
        );

        let events = event::events_by_type<campaign::PayoutClaimed>();
        assert!(events.length() == 1);
        let (_, ev_round, _, ev_band, ev_amount, ev_recipient) =
            campaign::payout_claimed_event_fields(*events.borrow(0));
        assert!(ev_round == 1);
        assert!(ev_band == 1u8);
        // band_payout[0] = 50M × (min(1000M, 50M×3) / 50M) = 150M
        assert!(ev_amount == 150_000_000);
        assert!(ev_recipient == MEMBER);

        clock.destroy_for_testing();
        identity_registry::destroy_identity_registry_for_testing(id_registry);
        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(disaster_event);
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 2. pause ガード: グローバル一時停止中は claim 先頭で abort する
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = admin::EGlobalPaused)]
fun accessor_claim_blocked_by_global_pause() {
    let mut scenario = setup();
    let de_id = create_campaign_with_event(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        campaign::fund_campaign_for_testing(&mut c, 1_000_000_000, scenario.ctx());
        test_scenario::return_shared(c);
    };

    // グローバル一時停止を有効化する。これ以外は happy path と同条件。
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pause_state = scenario.take_shared<admin::PauseState>();
        admin::pause_global(&cap, &mut pause_state, scenario.ctx());
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
    };

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let disaster_event = scenario.take_shared_by_id<disaster_event::DisasterEvent>(de_id);
        let pause_state = scenario.take_shared<admin::PauseState>();
        let (mem_registry, pass) =
            membership::create_registry_and_pass_for_testing(MEMBER, 1, b"", scenario.ctx());
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);

        seed_verified_payout_applicant(&mut c, &pass);

        let id_registry = identity_registry::create_identity_registry_for_testing(scenario.ctx());
        let mut clock = clock::create_for_testing(scenario.ctx());
        clock.set_for_testing(DONATION_END_MS);

        // 一時停止ガードが claim 先頭で効くため、ここで abort する。
        accessor::claim(
            &pause_state,
            &mut c,
            &disaster_event,
            &id_registry,
            &mem_registry,
            &pass,
            identity_registry::provider_kyc(),
            b"",
            option::none<affected_cell::AffectedCellLeaf>(),
            vector[],
            &clock,
            scenario.ctx(),
        );

        clock.destroy_for_testing();
        identity_registry::destroy_identity_registry_for_testing(id_registry);
        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(disaster_event);
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(c);
    };
    scenario.end();
}
