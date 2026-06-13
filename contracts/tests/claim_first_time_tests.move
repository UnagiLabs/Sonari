#[test_only]
module contracts::claim_first_time_tests;

use contracts::affected_cell;
use contracts::campaign;
use contracts::category_pool;
use contracts::identity_registry;
use contracts::membership;
use contracts::admin;
use sui::clock;
use sui::event;
use sui::test_scenario;

const ADMIN: address = @0xA11CE;
const MEMBER: address = @0xBEEF;

// campaign created at this time (clock value in setup)
const NOW_MS: u64 = 1_704_170_000_000;

// DONATION_PERIOD_MS = 2_592_000_000
const DONATION_END_MS: u64 = NOW_MS + 2_592_000_000;

// DisasterEvent mock values (matching create_campaign_in_scenario)
const EVENT_UID: vector<u8> = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EVENT_REVISION: u32 = 1u32;

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

// Member without any identity record (KYC key not bound, not verified).
fun setup_unverified_member(
    scenario: &mut test_scenario::Scenario,
): (identity_registry::IdentityRegistry, membership::MembershipRegistry, membership::MembershipPass) {
    let id_registry = identity_registry::create_identity_registry_for_testing(scenario.ctx());
    let (mem_registry, pass) = membership::create_registry_and_pass_for_testing(
        MEMBER,
        1,
        b"",
        scenario.ctx(),
    );
    (id_registry, mem_registry, pass)
}

// Removes the KYC binding (if any) and destroys all member-scoped objects.
fun cleanup_member(
    mut id_registry: identity_registry::IdentityRegistry,
    mem_registry: membership::MembershipRegistry,
    pass: membership::MembershipPass,
) {
    let pass_lineage_id = membership::membership_pass_lineage_id(&pass);
    identity_registry::remove_binding_for_testing(
        &mut id_registry,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY,
    );
    identity_registry::destroy_identity_registry_for_testing(id_registry);
    membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
    membership::destroy_pass_for_testing(pass);
}

// ---------------------------------------------------------------
// 1. happy path: 初回 claim は資格を確立し ClaimSubmitted/ClaimVerified を出す
//    （センサス未確定なので床払いは発生しないが、初回登録なので abort しない）
// ---------------------------------------------------------------

#[test]
fun claim_first_time_creates_application_and_emits_events() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (id_registry, mem_registry, pass) = setup_verified_member(&mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);

        let leaf = make_leaf(2u8);
        let root = affected_cell::leaf_hash(&leaf);

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

        // 資格確立: ClaimApplication が登録済み・検証済み・未受給
        assert!(campaign::campaign_has_claim_application(&c, pass_lineage_id));
        let (band, applied_at_ms, verified, floor_claimed, excluded) =
            campaign::campaign_claim_application_fields(&c, pass_lineage_id);
        assert!(band == 2u8);
        assert!(applied_at_ms == NOW_MS);
        assert!(verified);
        assert!(!floor_claimed);
        assert!(!excluded);

        // センサス未確定なので支払いは発生しない
        assert!(campaign::campaign_total_paid_usdc(&c) == 0);
        let (round_before, _, _, _, _) = campaign::campaign_payout_round_fields(&c);
        assert!(round_before == 0);

        // ClaimSubmitted / ClaimVerified が 1 件ずつ出る
        let submitted = event::events_by_type<campaign::ClaimSubmitted>();
        assert!(submitted.length() == 1);
        let (_, sub_lineage, sub_band, sub_at, sub_applicant) =
            campaign::claim_submitted_event_fields(*submitted.borrow(0));
        assert!(sub_lineage == pass_lineage_id);
        assert!(sub_band == 2u8);
        assert!(sub_at == NOW_MS);
        assert!(sub_applicant == MEMBER);

        let verified_events = event::events_by_type<campaign::ClaimVerified>();
        assert!(verified_events.length() == 1);
        let (_, ver_lineage, ver_band, _, ver_verifier) =
            campaign::claim_verified_event_fields(*verified_events.borrow(0));
        assert!(ver_lineage == pass_lineage_id);
        assert!(ver_band == 2u8);
        assert!(ver_verifier == MEMBER);

        cleanup_member(id_registry, mem_registry, pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 2. reject: 申請期間終了後（now_ms >= claim_end_ms）
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EClaimWindowClosed)]
fun claim_rejects_after_window_closed() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        campaign::set_claim_end_ms_for_testing(&mut c, NOW_MS);
        let (id_registry, mem_registry, pass) = setup_verified_member(&mut scenario);

        let leaf = make_leaf(2u8);
        let root = affected_cell::leaf_hash(&leaf);

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

        cleanup_member(id_registry, mem_registry, pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 3. reject: disaster event id mismatch
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EDisasterEventMismatch)]
fun claim_rejects_wrong_disaster_event_id() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (id_registry, mem_registry, pass) = setup_verified_member(&mut scenario);

        let leaf = make_leaf(2u8);
        let root = affected_cell::leaf_hash(&leaf);

        campaign::claim(
            &mut c,
            object::id_from_address(@0x1234), // wrong ID
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

        cleanup_member(id_registry, mem_registry, pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 4. reject: invalid Merkle proof (wrong affected_cells_root)
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EInvalidAffectedCellProof)]
fun claim_rejects_invalid_merkle_proof() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (id_registry, mem_registry, pass) = setup_verified_member(&mut scenario);

        let leaf = make_leaf(2u8);
        let wrong_root =
            x"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

        campaign::claim(
            &mut c,
            object::id_from_address(@0xDEAD),
            EVENT_UID,
            EVENT_REVISION,
            wrong_root,
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

        cleanup_member(id_registry, mem_registry, pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 5. reject: cell band below min_claim_band (band=0 < MIN_CLAIM_BAND=1)
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EClaimBandTooLow)]
fun claim_rejects_band_too_low() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (id_registry, mem_registry, pass) = setup_verified_member(&mut scenario);

        let leaf = make_leaf(0u8); // band=0 < MIN_CLAIM_BAND=1
        let root = affected_cell::leaf_hash(&leaf);

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

        cleanup_member(id_registry, mem_registry, pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 6. reject: account created after disaster occurred_at_ms
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EAccountCreatedAfterCutoff)]
fun claim_rejects_account_created_after_cutoff() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (id_registry, mem_registry, mut pass) = setup_verified_member(&mut scenario);
        // account_created_at_ms を occurred_at_ms より後にする
        membership::set_account_created_at_ms_for_testing(&mut pass, OCCURRED_AT_MS + 1);

        let leaf = make_leaf(2u8);
        let root = affected_cell::leaf_hash(&leaf);

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

        cleanup_member(id_registry, mem_registry, pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 7. reject: home cell registered after disaster occurred_at_ms
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EHomeCellRegisteredAfterCutoff)]
fun claim_rejects_home_cell_registered_after_cutoff() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (id_registry, mem_registry, mut pass) = setup_verified_member(&mut scenario);
        // home_cell_registered_at_ms を occurred_at_ms より後にする
        membership::set_home_cell_registered_at_ms_for_testing(&mut pass, OCCURRED_AT_MS + 1);

        let leaf = make_leaf(2u8);
        let root = affected_cell::leaf_hash(&leaf);

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

        cleanup_member(id_registry, mem_registry, pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 8. reject: residence cell mismatch (leaf.h3_index != pass.home_cell)
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EResidenceCellMismatch)]
fun claim_rejects_residence_cell_mismatch() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (id_registry, mem_registry, pass) = setup_verified_member(&mut scenario);

        // h3_index=999 だが pass.home_cell=0
        let leaf = affected_cell::new_leaf(
            EVENT_UID,
            EVENT_REVISION,
            999u64, // mismatch with home_cell=0
            3u8,
            1u8,
            100u16,
            1u8,
            2u8,
            0u8,
            1u64,
        );
        let root = affected_cell::leaf_hash(&leaf);

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

        cleanup_member(id_registry, mem_registry, pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 9. reject: 初回なのに leaf が無い → EClaimLeafRequired
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EClaimLeafRequired)]
fun claim_first_time_rejects_missing_leaf() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (id_registry, mem_registry, pass) = setup_verified_member(&mut scenario);

        campaign::claim(
            &mut c,
            object::id_from_address(@0xDEAD),
            EVENT_UID,
            EVENT_REVISION,
            EVENT_UID, // root（使われない: leaf が無い時点で abort）
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

        cleanup_member(id_registry, mem_registry, pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 10. reject: 初回は本人確認必須（未確認は identity registry 側で abort）
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = identity_registry::EIdentityRecordNotFound)]
fun claim_first_time_requires_verified_identity() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (id_registry, mem_registry, pass) = setup_unverified_member(&mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);

        let leaf = make_leaf(2u8);
        let root = affected_cell::leaf_hash(&leaf);

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

        // 未確認 member なので bind されておらず binding_count=0 のまま破棄できる
        identity_registry::destroy_identity_registry_for_testing(id_registry);
        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}
