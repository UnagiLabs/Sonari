#[test_only]
module contracts::disaster_claim_tests;

use contracts::accessor;
use contracts::admin;
use contracts::affected_cell::{Self, AffectedCellLeaf};
use contracts::allowed_residence_cell;
use contracts::claim;
use contracts::disaster_event;
use contracts::identity_registry;
use contracts::membership;
use contracts::payload;
use contracts::payout_policy;
use contracts::pools;
use contracts::program;
use contracts::reader;
use sui::clock;
use sui::coin;
use sui::test_scenario;
use usdc::usdc::USDC;

const ADMIN: address = @0xA11CE;
const MEMBER: address = @0x51A;

const NINETY_ONE_DAYS_MS: u64 = 7_862_400_000;
const CLAIM_WINDOW_END_MS: u64 = 20_000_000_000;
const NOW_BEFORE_FRESHNESS_DEADLINE_MS: u64 = 1_704_170_000_000;
const H3_INDEX: u64 = 608_819_013_597_790_207;
const PROMOTED_H3_INDEX: u64 = 608_819_013_681_676_287;
const GEO_RESOLUTION: u8 = 7;
const ALLOWLIST_VERSION: u64 = 1;
const KYC_DUPLICATE_KEY_HASH: vector<u8> =
    x"4444444444444444444444444444444444444444444444444444444444444444";
const WORLD_ID_DUPLICATE_KEY_HASH: vector<u8> =
    x"9999999999999999999999999999999999999999999999999999999999999999";

#[test, expected_failure(abort_code = identity_registry::EIdentityRecordNotFound)]
fun disaster_claim_rejects_unverified_membership() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NINETY_ONE_DAYS_MS);
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);

    execute_disaster_claim_with_clock(&mut scenario, &clock);
    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = identity_registry::EIdentityVerificationExpired)]
fun disaster_claim_rejects_expired_identity_record() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NINETY_ONE_DAYS_MS);
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    // expires_at_ms を claim 時刻(NINETY_ONE_DAYS_MS)以下にして期限切れにする
    verify_member_with_expired_record(
        &mut scenario,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
        NINETY_ONE_DAYS_MS - 1, // expires_at_ms < now_ms ではなく now_ms >= expires_at_ms
    );
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);

    execute_disaster_claim_with_clock(&mut scenario, &clock);
    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = identity_registry::EIdentityProviderNotVerified)]
fun disaster_claim_rejects_provider_mismatch() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NINETY_ONE_DAYS_MS);
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    // KYC で record を書くが、claim 時は WORLD_ID provider を指定
    verify_member_with_provider(
        &mut scenario,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
    );
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);

    // dedup も WORLD_ID で bind して dedup チェックは通過させた上で provider チェックで落とす
    // assert_identity_verified が dedup より先なので provider 不一致で落ちる
    execute_disaster_claim_with_identity(
        &mut scenario,
        identity_registry::provider_world_id(),
        KYC_DUPLICATE_KEY_HASH, // dedup key は KYC で bind 済みなので通過しない
    );
    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = identity_registry::EIdentityRecordOwnerMismatch)]
fun disaster_claim_rejects_owner_mismatch() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NINETY_ONE_DAYS_MS);
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    // record の owner を別アドレスにして owner 不一致を起こす
    verify_member_with_wrong_owner(
        &mut scenario,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
    );
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);

    execute_disaster_claim_with_clock(&mut scenario, &clock);
    scenario.end();
    clock.destroy_for_testing();
}

#[test]
fun kyc_verified_member_can_claim_full_disaster_payout() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NINETY_ONE_DAYS_MS);
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    verify_member_with_provider(
        &mut scenario,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
    );
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);

    execute_disaster_claim_with_clock(&mut scenario, &clock);

    scenario.next_tx(MEMBER);
    {
        let receipt = scenario.take_from_sender<claim::ClaimReceipt>();
        let (_, _, _, amount, _, _, claimant, recipient) =
            claim::claim_receipt_summary(&receipt);
        let tier_label = claim::claim_receipt_tier_label(&receipt);
        assert!(amount == 50_000_000);
        assert!(tier_label == b"Tier 1".to_string());
        assert!(claimant == MEMBER);
        assert!(recipient == MEMBER);
        scenario.return_to_sender(receipt);
    };

    scenario.next_tx(ADMIN);
    {
        let budget = scenario.take_shared<payout_policy::CampaignBudget>();
        let designated_pool = scenario.take_shared<pools::DesignatedPool>();
        let main_pool = scenario.take_shared<pools::MainPool>();
        assert!(pools::designated_pool_balance_usdc(&designated_pool) == 4_000_000);
        assert!(pools::main_pool_balance_usdc(&main_pool) == 966_000_000);
        assert!(payout_policy::campaign_budget_claimed_usdc(&budget) == 50_000_000);

        test_scenario::return_shared(budget);
        test_scenario::return_shared(designated_pool);
        test_scenario::return_shared(main_pool);
    };

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = claim::EClaimBandTooLow)]
fun disaster_claim_rejects_affected_cell_below_policy_min_claim_band() {
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    verify_member_with_provider(
        &mut scenario,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
    );
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut policy = scenario.take_shared<payout_policy::PayoutPolicy>();
        payout_policy::set_min_claim_band_for_testing(&mut policy, 2);
        test_scenario::return_shared(policy);
    };

    execute_disaster_claim(&mut scenario);
    scenario.end();
}

#[test, expected_failure(abort_code = program::EPayoutPolicyMismatch)]
fun disaster_claim_rejects_program_policy_mismatch() {
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    verify_member_with_provider(
        &mut scenario,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
    );
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let mut program = scenario.take_shared<program::Program>();
        let designated_pool = scenario.take_shared<pools::DesignatedPool>();
        program::set_payout_policy_id_for_testing(
            &mut program,
            option::some(pools::designated_pool_id(&designated_pool)),
        );
        test_scenario::return_shared(program);
        test_scenario::return_shared(designated_pool);
    };

    execute_disaster_claim(&mut scenario);
    scenario.end();
}

#[test]
fun world_id_verified_member_can_claim_full_disaster_payout() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NINETY_ONE_DAYS_MS);
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    verify_member_with_provider(
        &mut scenario,
        identity_registry::provider_world_id(),
        WORLD_ID_DUPLICATE_KEY_HASH,
    );
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);

    execute_disaster_claim_with_identity(
        &mut scenario,
        identity_registry::provider_world_id(),
        WORLD_ID_DUPLICATE_KEY_HASH,
    );

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = program::EClaimWindowNotOpen)]
fun disaster_claim_window_uses_clock_timestamp() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(CLAIM_WINDOW_END_MS);
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    create_disaster_claim_objects(&mut scenario);

    execute_disaster_claim_with_clock(&mut scenario, &clock);
    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = payout_policy::EDesignatedPoolMismatch)]
fun disaster_claim_rejects_mismatched_designated_pool() {
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        admin::create_designated_pool(&cap, option::none(), scenario.ctx());
        scenario.return_to_sender(cap);
    };

    execute_disaster_claim(&mut scenario);
    scenario.end();
}

#[test, expected_failure(abort_code = payout_policy::EMainOnlyBudgetCannotUseDesignatedPool)]
fun disaster_claim_rejects_main_only_budget() {
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects_without_budget(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let program = scenario.take_shared<program::Program>();
        let mut campaign = scenario.take_shared<program::Campaign>();
        let main_pool = scenario.take_shared<pools::MainPool>();
        payout_policy::open_campaign_budget_from_main(
            &program,
            &mut campaign,
            &main_pool,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(program);
        test_scenario::return_shared(campaign);
        test_scenario::return_shared(main_pool);
    };

    execute_disaster_claim(&mut scenario);
    scenario.end();
}

#[test, expected_failure(abort_code = admin::ETargetPaused)]
fun disaster_claim_rejects_paused_designated_pool_before_payout() {
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);
    let designated_pool_id = designated_pool_id(&mut scenario);

    pause_target(&mut scenario, pools::target_kind_designated_pool(), designated_pool_id);

    execute_disaster_claim(&mut scenario);
    scenario.end();
}

#[test, expected_failure(abort_code = admin::ETargetPaused)]
fun disaster_claim_rejects_paused_main_pool_before_payout() {
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);
    let main_pool_id = main_pool_id(&mut scenario);

    pause_target(&mut scenario, pools::target_kind_main_pool(), main_pool_id);

    execute_disaster_claim(&mut scenario);
    scenario.end();
}

#[test, expected_failure(abort_code = admin::ETargetPaused)]
fun disaster_claim_rejects_paused_identity_registry_before_payout() {
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    verify_member_with_provider(
        &mut scenario,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
    );
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);
    let identity_registry_id = identity_registry_id(&mut scenario);

    pause_target(
        &mut scenario,
        reader::target_kind_identity_registry(),
        identity_registry_id,
    );

    execute_disaster_claim(&mut scenario);
    scenario.end();
}

#[test, expected_failure(abort_code = disaster_event::EDisasterCampaignBindingMismatch)]
fun disaster_claim_rejects_other_disaster_event_for_bound_campaign() {
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut disaster_registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let other_payload = payload::decode_finalized(
            other_event_payload_bcs(),
            NOW_BEFORE_FRESHNESS_DEADLINE_MS,
        );
        disaster_event::create_from_payload_for_testing(
            &mut disaster_registry,
            other_payload,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(disaster_registry);
    };

    execute_disaster_claim(&mut scenario);
    scenario.end();
}

#[test, expected_failure(abort_code = claim::EAccountCreatedAfterCutoff)]
fun disaster_claim_rejects_account_created_after_cutoff() {
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    verify_member_with_provider(
        &mut scenario,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
    );
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);
    let cutoff_ms = disaster_cutoff_ms(&mut scenario);
    set_member_account_created_at_ms(&mut scenario, cutoff_ms + 1);

    execute_disaster_claim(&mut scenario);
    scenario.end();
}

#[test, expected_failure(abort_code = claim::EAccountCreatedAfterCutoff)]
fun disaster_claim_rejects_account_created_at_cutoff() {
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    verify_member_with_provider(
        &mut scenario,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
    );
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);
    let cutoff_ms = disaster_cutoff_ms(&mut scenario);
    set_member_account_created_at_ms(&mut scenario, cutoff_ms);

    execute_disaster_claim(&mut scenario);
    scenario.end();
}

#[test, expected_failure(abort_code = claim::EHomeCellRegisteredAfterCutoff)]
fun disaster_claim_rejects_home_cell_registered_after_cutoff() {
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    verify_member_with_provider(
        &mut scenario,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
    );
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);
    let cutoff_ms = disaster_cutoff_ms(&mut scenario);
    set_member_home_cell_registered_at_ms(&mut scenario, cutoff_ms + 1);

    execute_disaster_claim(&mut scenario);
    scenario.end();
}

#[test, expected_failure(abort_code = claim::EHomeCellRegisteredAfterCutoff)]
fun disaster_claim_rejects_home_cell_registered_at_cutoff() {
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    verify_member_with_provider(
        &mut scenario,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
    );
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);
    let cutoff_ms = disaster_cutoff_ms(&mut scenario);
    set_member_home_cell_registered_at_ms(&mut scenario, cutoff_ms);

    execute_disaster_claim(&mut scenario);
    scenario.end();
}

#[test, expected_failure(abort_code = claim::EHomeCellRegisteredAfterCutoff)]
fun disaster_claim_rejects_home_cell_changed_after_disaster_cutoff() {
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member_with_home_cell(&mut scenario, PROMOTED_H3_INDEX);
    verify_member_with_provider(
        &mut scenario,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
    );
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);
    let cutoff_ms = disaster_cutoff_ms(&mut scenario);
    let mut update_clock = clock::create_for_testing(&mut tx_context::dummy());
    update_clock.set_for_testing(cutoff_ms + 1);

    update_member_home_cell_with_clock(&mut scenario, &update_clock, H3_INDEX);

    execute_disaster_claim(&mut scenario);
    scenario.end();
    update_clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = claim::EResidenceCellMismatch)]
fun disaster_claim_rejects_affected_cell_mismatch() {
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member_with_home_cell(&mut scenario, PROMOTED_H3_INDEX);
    verify_member_with_provider(
        &mut scenario,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
    );
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);

    execute_disaster_claim(&mut scenario);
    scenario.end();
}

#[test, expected_failure(abort_code = identity_registry::EIdentityKeyNotBound)]
fun disaster_claim_rejects_missing_duplicate_key_binding() {
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    verify_member_with_provider(
        &mut scenario,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
    );
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);

    execute_disaster_claim_with_identity(
        &mut scenario,
        identity_registry::provider_kyc(),
        WORLD_ID_DUPLICATE_KEY_HASH,
    );
    scenario.end();
}

#[test, expected_failure(abort_code = identity_registry::EIdentityProviderNotVerified)]
fun disaster_claim_rejects_duplicate_key_with_wrong_provider() {
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    // KYC で record + dedup を書く
    verify_member_with_provider(
        &mut scenario,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
    );
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);

    // WORLD_ID provider で claim → assert_identity_verified で EIdentityProviderNotVerified
    execute_disaster_claim_with_identity(
        &mut scenario,
        identity_registry::provider_world_id(),
        KYC_DUPLICATE_KEY_HASH,
    );
    scenario.end();
}

#[test, expected_failure(abort_code = identity_registry::EIdentityKeyAlreadyBound)]
fun disaster_claim_rejects_duplicate_key_bound_to_other_sbt() {
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    mark_member_identity_verified_without_binding(
        &mut scenario,
        identity_registry::provider_kyc(),
    );
    bind_duplicate_key_to_other_pass(
        &mut scenario,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
    );
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);

    execute_disaster_claim(&mut scenario);
    scenario.end();
}

#[test, expected_failure(abort_code = disaster_event::EDuplicateDisasterCampaignBinding)]
fun bind_campaign_rejects_duplicate_campaign_binding() {
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    create_disaster_claim_objects(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut disaster_registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let campaign = scenario.take_shared<program::Campaign>();
        let disaster_event = scenario.take_shared<disaster_event::DisasterEvent>();
        disaster_event::bind_campaign(
            &mut disaster_registry,
            &campaign,
            &disaster_event,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(disaster_registry);
        test_scenario::return_shared(campaign);
        test_scenario::return_shared(disaster_event);
    };

    scenario.end();
}

fun initialized(): test_scenario::Scenario {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    {
        let mut cap = scenario.take_from_sender<admin::AdminCap>();
        admin::create_designated_pool(&cap, option::none(), scenario.ctx());
        admin::create_allowed_residence_cell_registry(
            &mut cap,
            residence_root(),
            GEO_RESOLUTION,
            ALLOWLIST_VERSION,
            source_hash(),
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
    };

    scenario.next_tx(ADMIN);
    scenario
}

fun fund_pools_directly(scenario: &mut test_scenario::Scenario) {
    scenario.next_tx(ADMIN);
    {
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let mut designated_pool = scenario.take_shared<pools::DesignatedPool>();
        pools::deposit_main_usdc(
            &mut main_pool,
            coin::mint_for_testing<USDC>(1_000_000_000, scenario.ctx()),
        );
        pools::deposit_designated_usdc(
            &mut designated_pool,
            coin::mint_for_testing<USDC>(20_000_000, scenario.ctx()),
        );
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(designated_pool);
    };
}

fun register_member(scenario: &mut test_scenario::Scenario) {
    register_member_with_home_cell(scenario, H3_INDEX);
}

fun register_member_with_home_cell(scenario: &mut test_scenario::Scenario, home_cell: u64) {
    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<membership::MembershipRegistry>();
        let residence_registry =
            scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();
        accessor::register_member(
            &pause_state,
            &mut registry,
            &residence_registry,
            home_cell,
            residence_proof(home_cell),
            0u64,
            b"",
            scenario.ctx(),
        );
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(residence_registry);
    };
}

fun verify_member_with_provider(
    scenario: &mut test_scenario::Scenario,
    provider: u8,
    duplicate_key_hash: vector<u8>,
) {
    scenario.next_tx(MEMBER);
    {
        let mut identity_registry = scenario.take_shared<identity_registry::IdentityRegistry>();
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        identity_registry::bind_duplicate_key(
            &mut identity_registry,
            membership::membership_pass_lineage_id(&pass),
            provider,
            duplicate_key_hash,
        );
        identity_registry::record_identity_verification(
            &mut identity_registry,
            membership::membership_pass_lineage_id(&pass),
            membership::membership_pass_owner(&pass),
            provider,
            1,
            CLAIM_WINDOW_END_MS + 1,
            0,
            b"",
        );
        test_scenario::return_shared(identity_registry);
        scenario.return_to_sender(pass);
    };
}

fun verify_member_with_expired_record(
    scenario: &mut test_scenario::Scenario,
    provider: u8,
    duplicate_key_hash: vector<u8>,
    expires_at_ms: u64,
) {
    scenario.next_tx(MEMBER);
    {
        let mut identity_registry = scenario.take_shared<identity_registry::IdentityRegistry>();
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        identity_registry::bind_duplicate_key(
            &mut identity_registry,
            membership::membership_pass_lineage_id(&pass),
            provider,
            duplicate_key_hash,
        );
        identity_registry::record_identity_verification(
            &mut identity_registry,
            membership::membership_pass_lineage_id(&pass),
            membership::membership_pass_owner(&pass),
            provider,
            1,
            expires_at_ms,
            0,
            b"",
        );
        test_scenario::return_shared(identity_registry);
        scenario.return_to_sender(pass);
    };
}

fun verify_member_with_wrong_owner(
    scenario: &mut test_scenario::Scenario,
    provider: u8,
    duplicate_key_hash: vector<u8>,
) {
    scenario.next_tx(MEMBER);
    {
        let mut identity_registry = scenario.take_shared<identity_registry::IdentityRegistry>();
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        let other_pass = membership::create_pass_for_testing(@0xBAD, scenario.ctx());
        // dedup は MEMBER の pass_lineage_id で bind（dedup チェックは通過させる）
        identity_registry::bind_duplicate_key(
            &mut identity_registry,
            membership::membership_pass_lineage_id(&pass),
            provider,
            duplicate_key_hash,
        );
        // record は別 owner アドレスで書く（owner 不一致を起こす）
        identity_registry::record_identity_verification(
            &mut identity_registry,
            membership::membership_pass_lineage_id(&pass),
            @0xBAD, // 別アドレス（MEMBER とは異なる）
            provider,
            1,
            CLAIM_WINDOW_END_MS + 1,
            0,
            b"",
        );
        membership::destroy_pass_for_testing(other_pass);
        test_scenario::return_shared(identity_registry);
        scenario.return_to_sender(pass);
    };
}

fun mark_member_identity_verified_without_binding(
    scenario: &mut test_scenario::Scenario,
    provider: u8,
) {
    scenario.next_tx(MEMBER);
    {
        let mut identity_registry = scenario.take_shared<identity_registry::IdentityRegistry>();
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        // dedup binding は作らず、record だけ書く
        identity_registry::record_identity_verification(
            &mut identity_registry,
            membership::membership_pass_lineage_id(&pass),
            membership::membership_pass_owner(&pass),
            provider,
            1,
            CLAIM_WINDOW_END_MS + 1,
            0,
            b"",
        );
        test_scenario::return_shared(identity_registry);
        scenario.return_to_sender(pass);
    };
}

fun bind_duplicate_key_to_other_pass(
    scenario: &mut test_scenario::Scenario,
    provider: u8,
    duplicate_key_hash: vector<u8>,
) {
    scenario.next_tx(ADMIN);
    {
        let mut identity_registry = scenario.take_shared<identity_registry::IdentityRegistry>();
        let other_pass = membership::create_pass_for_testing(@0xC0FFEE, scenario.ctx());
        identity_registry::bind_duplicate_key(
            &mut identity_registry,
            membership::membership_pass_lineage_id(&other_pass),
            provider,
            duplicate_key_hash,
        );
        membership::destroy_pass_for_testing(other_pass);
        test_scenario::return_shared(identity_registry);
    };
}

fun disaster_cutoff_ms(scenario: &mut test_scenario::Scenario): u64 {
    scenario.next_tx(ADMIN);
    {
        let disaster_event = scenario.take_shared<disaster_event::DisasterEvent>();
        let cutoff_ms = disaster_event::occurred_at_ms(&disaster_event);
        test_scenario::return_shared(disaster_event);
        cutoff_ms
    }
}

fun set_member_account_created_at_ms(
    scenario: &mut test_scenario::Scenario,
    account_created_at_ms: u64,
) {
    scenario.next_tx(MEMBER);
    {
        let mut pass = scenario.take_from_sender<membership::MembershipPass>();
        membership::set_account_created_at_ms_for_testing(&mut pass, account_created_at_ms);
        scenario.return_to_sender(pass);
    };
}

fun set_member_home_cell_registered_at_ms(
    scenario: &mut test_scenario::Scenario,
    home_cell_registered_at_ms: u64,
) {
    scenario.next_tx(MEMBER);
    {
        let mut pass = scenario.take_from_sender<membership::MembershipPass>();
        membership::set_home_cell_registered_at_ms_for_testing(
            &mut pass,
            home_cell_registered_at_ms,
        );
        scenario.return_to_sender(pass);
    };
}

fun update_member_home_cell_with_clock(
    scenario: &mut test_scenario::Scenario,
    clock: &clock::Clock,
    home_cell: u64,
) {
    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let registry = scenario.take_shared<membership::MembershipRegistry>();
        let residence_registry =
            scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();
        let mut pass = scenario.take_from_sender<membership::MembershipPass>();
        accessor::update_member_home_cell(
            &pause_state,
            &registry,
            &residence_registry,
            &mut pass,
            clock,
            home_cell,
            residence_proof(home_cell),
            scenario.ctx(),
        );
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(residence_registry);
        scenario.return_to_sender(pass);
    };
}

fun execute_disaster_claim(scenario: &mut test_scenario::Scenario) {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NINETY_ONE_DAYS_MS);
    execute_disaster_claim_with_clock(scenario, &clock);
    clock.destroy_for_testing();
}

fun execute_disaster_claim_with_identity(
    scenario: &mut test_scenario::Scenario,
    provider: u8,
    duplicate_key_hash: vector<u8>,
) {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NINETY_ONE_DAYS_MS);
    execute_disaster_claim_with_clock_and_identity(
        scenario,
        &clock,
        provider,
        duplicate_key_hash,
    );
    clock.destroy_for_testing();
}

fun execute_disaster_claim_with_clock(
    scenario: &mut test_scenario::Scenario,
    clock: &clock::Clock,
) {
    execute_disaster_claim_with_clock_and_identity(
        scenario,
        clock,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
    );
}

fun execute_disaster_claim_with_clock_and_identity(
    scenario: &mut test_scenario::Scenario,
    clock: &clock::Clock,
    provider: u8,
    duplicate_key_hash: vector<u8>,
) {
    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let index = scenario.take_shared<claim::ClaimIndex>();
        let registry = scenario.take_shared<membership::MembershipRegistry>();
        let program = scenario.take_shared<program::Program>();
        let campaign = scenario.take_shared<program::Campaign>();
        execute_disaster_claim_with_objects(
            scenario,
            pause_state,
            index,
            registry,
            program,
            campaign,
            clock,
            provider,
            duplicate_key_hash,
        );
    };
}

fun main_pool_id(scenario: &mut test_scenario::Scenario): object::ID {
    scenario.next_tx(ADMIN);
    let main_pool = scenario.take_shared<pools::MainPool>();
    let id = pools::main_pool_id(&main_pool);
    test_scenario::return_shared(main_pool);
    id
}

fun designated_pool_id(scenario: &mut test_scenario::Scenario): object::ID {
    scenario.next_tx(ADMIN);
    let designated_pool = scenario.take_shared<pools::DesignatedPool>();
    let id = pools::designated_pool_id(&designated_pool);
    test_scenario::return_shared(designated_pool);
    id
}

fun identity_registry_id(scenario: &mut test_scenario::Scenario): object::ID {
    scenario.next_tx(ADMIN);
    let identity_registry = scenario.take_shared<identity_registry::IdentityRegistry>();
    let id = identity_registry::registry_id(&identity_registry);
    test_scenario::return_shared(identity_registry);
    id
}

fun pause_target(
    scenario: &mut test_scenario::Scenario,
    target_kind: u8,
    target_id: object::ID,
) {
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pause_state = scenario.take_shared<admin::PauseState>();
        admin::pause_target(&cap, &mut pause_state, target_kind, target_id, scenario.ctx());
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
    };
}

fun execute_disaster_claim_with_objects(
    scenario: &mut test_scenario::Scenario,
    pause_state: admin::PauseState,
    mut index: claim::ClaimIndex,
    registry: membership::MembershipRegistry,
    program: program::Program,
    campaign: program::Campaign,
    clock: &clock::Clock,
    provider: u8,
    duplicate_key_hash: vector<u8>,
) {
    let policy = scenario.take_shared<payout_policy::PayoutPolicy>();
    let mut budget = scenario.take_shared<payout_policy::CampaignBudget>();
    let binding = scenario.take_shared<disaster_event::DisasterCampaignBinding>();
    let disaster_event = scenario.take_shared<disaster_event::DisasterEvent>();
    let identity_registry = scenario.take_shared<identity_registry::IdentityRegistry>();
    let pass = scenario.take_from_sender<membership::MembershipPass>();
    let mut designated_pool = scenario.take_shared<pools::DesignatedPool>();
    let mut main_pool = scenario.take_shared<pools::MainPool>();

    accessor::claim_disaster_usdc(
        &pause_state,
        &mut index,
        &registry,
        &program,
        &campaign,
        &policy,
        &mut budget,
        &binding,
        &disaster_event,
        &identity_registry,
        &pass,
        clock,
        affected_leaf(),
        proof(),
        provider,
        duplicate_key_hash,
        &mut designated_pool,
        &mut main_pool,
        50_000_000,
        scenario.ctx(),
    );

    test_scenario::return_shared(pause_state);
    test_scenario::return_shared(index);
    test_scenario::return_shared(registry);
    test_scenario::return_shared(program);
    test_scenario::return_shared(campaign);
    test_scenario::return_shared(policy);
    test_scenario::return_shared(budget);
    test_scenario::return_shared(binding);
    test_scenario::return_shared(disaster_event);
    test_scenario::return_shared(identity_registry);
    test_scenario::return_shared(designated_pool);
    test_scenario::return_shared(main_pool);
    scenario.return_to_sender(pass);
}

fun create_disaster_claim_objects(scenario: &mut test_scenario::Scenario) {
    let designated_pool_id = designated_pool_id(scenario);
    create_disaster_claim_objects_without_budget_with_pool(
        scenario,
        option::some(designated_pool_id),
    );
    open_designated_campaign_budget(scenario);
}

fun create_disaster_claim_objects_without_budget(scenario: &mut test_scenario::Scenario) {
    create_disaster_claim_objects_without_budget_with_pool(scenario, option::none());
}

fun create_disaster_claim_objects_without_budget_with_pool(
    scenario: &mut test_scenario::Scenario,
    campaign_pool_id: Option<object::ID>,
) {
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let payout_policy_id = admin::create_default_disaster_policy(&cap, scenario.ctx());
        admin::create_program(
            &cap,
            1,
            1,
            1,
            option::some(payout_policy_id),
            option::none(),
            scenario.ctx(),
        );
        admin::create_disaster_registry(&cap, scenario.ctx());
        scenario.return_to_sender(cap);
    };

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let program = scenario.take_shared<program::Program>();
        admin::create_campaign(
            &cap,
            &program,
            1,
            b"disaster-claim",
            campaign_pool_id,
            0,
            CLAIM_WINDOW_END_MS,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(program);
    };

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut disaster_registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let payload = payload::decode_finalized(
            finalized_payload_bcs(),
            NOW_BEFORE_FRESHNESS_DEADLINE_MS,
        );
        disaster_event::create_from_payload_for_testing(
            &mut disaster_registry,
            payload,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(disaster_registry);
    };

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let program = scenario.take_shared<program::Program>();
        let campaign = scenario.take_shared<program::Campaign>();
        let disaster_event = scenario.take_shared<disaster_event::DisasterEvent>();
        let mut disaster_registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        disaster_event::bind_campaign(
            &mut disaster_registry,
            &campaign,
            &disaster_event,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(disaster_registry);
        test_scenario::return_shared(program);
        test_scenario::return_shared(campaign);
        test_scenario::return_shared(disaster_event);
    };
}

fun open_designated_campaign_budget(scenario: &mut test_scenario::Scenario) {
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let program = scenario.take_shared<program::Program>();
        let mut campaign = scenario.take_shared<program::Campaign>();
        let main_pool = scenario.take_shared<pools::MainPool>();
        let designated_pool = scenario.take_shared<pools::DesignatedPool>();
        payout_policy::open_campaign_budget_from_designated_and_main(
            &program,
            &mut campaign,
            &designated_pool,
            &main_pool,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(program);
        test_scenario::return_shared(campaign);
        test_scenario::return_shared(main_pool);
        test_scenario::return_shared(designated_pool);
    };
}

fun affected_leaf(): AffectedCellLeaf {
    accessor::new_affected_cell_leaf(
        event_uid(),
        1,
        H3_INDEX,
        7,
        1,
        723,
        1,
        1,
        1,
        1,
    )
}

fun proof(): vector<affected_cell::ProofStep> {
    vector[
        accessor::new_affected_cell_proof_step_left(
            x"83bc299c544edc5bff30176c8840ae2b3c001f8a10ea28c158761a5793c79b2f",
        ),
    ]
}

fun residence_proof(home_cell: u64): vector<allowed_residence_cell::ProofStep> {
    if (home_cell == PROMOTED_H3_INDEX) {
        promoted_residence_proof()
    } else {
        target_residence_proof()
    }
}

fun target_residence_proof(): vector<allowed_residence_cell::ProofStep> {
    vector[
        accessor::new_residence_proof_step_left(
            x"07985a56b782bd13b8ec079d4c243c8c2399605872223fc86066f59f4ae37569",
        ),
        accessor::new_residence_proof_step_right(
            x"8f8a501ba455071229e715f5eccb4322190440fa2ecb6b72d123378648b60ec7",
        ),
    ]
}

fun promoted_residence_proof(): vector<allowed_residence_cell::ProofStep> {
    vector[
        accessor::new_residence_proof_step_left(
            x"312e3863ccf00e446423342e1acebdab8e7119ee19dae854904de693225c2678",
        ),
    ]
}

fun residence_root(): vector<u8> {
    x"a26a12dc49754fde5b90e6bff69d1bc8b51fb8a3de07aa9122a9a2958bb75020"
}

fun source_hash(): vector<u8> {
    x"1111111111111111111111111111111111111111111111111111111111111111"
}

fun event_uid(): vector<u8> {
    x"ab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd"
}

fun finalized_payload_bcs(): vector<u8> {
    x"010100000000000000ab131dd48ad8b67e8ba22ed461a885f0c8aaf937b665d04931018c31d5cf69bd010000000c757337303030736f6e617269214d20372e31202d20536f6e61726920466978747572652045617274687175616b6515536f6e617269204669787475726520526567696f6e00f451c28c010000010303526e982479c985a009227facabf22c6d7633110fb1a15a743b453218f7f1890f02000000000000003a697066733a2f2f736f6e6172692f6578616d706c65732f757337303030736f6e6172692f65766964656e63655f6d616e69666573742e6a736f6eb2a52d7769fb2c83fc0f2be97eb52015d7108dbb703a94821152b045d802f28e00b153c78c01000000489dc88c010000"
}

fun other_event_payload_bcs(): vector<u8> {
    let mut bytes = finalized_payload_bcs();
    *bytes.borrow_mut(9) = 0xed;
    bytes
}
