#[test_only]
module contracts::claim_payout_tests;

use contracts::accessor;
use contracts::admin;
use contracts::claim;
use contracts::donation;
use contracts::membership;
use contracts::payout_policy;
use contracts::pools;
use contracts::program;
use sui::coin;
use sui::test_scenario;
use usdc::usdc::USDC;

const ADMIN: address = @0xA11CE;
const DONOR: address = @0xD0A0;
const MEMBER: address = @0x51A;
const PAYOUT: address = @0xB0B;

const NINETY_ONE_DAYS_MS: u64 = 7_862_400_000;
const CLAIM_WINDOW_END_MS: u64 = 20_000_000_000;

#[test, expected_failure(abort_code = claim::EGenericClaimDisabled)]
fun generic_claim_rejects_self_created_eligibility() {
    let mut scenario = initialized();
    fund_main_pool(&mut scenario, 1_000_000_000);
    register_member(&mut scenario);
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_claim_objects(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut index = scenario.take_shared<claim::ClaimIndex>();
        let registry = scenario.take_shared<membership::MembershipRegistry>();
        let program = scenario.take_shared<program::Program>();
        let campaign = scenario.take_shared<program::Campaign>();
        let policy = scenario.take_shared<payout_policy::PayoutPolicy>();
        let mut budget = scenario.take_shared<payout_policy::CampaignBudget>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        let eligibility = eligibility(&program, &campaign, &pass, 1, 50_000_000);

        claim::claim_usdc(
            &mut index,
            &registry,
            &program,
            &campaign,
            &policy,
            &mut budget,
            &pass,
            &mut main_pool,
            eligibility,
            scenario.ctx(),
        );

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(index);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(program);
        test_scenario::return_shared(campaign);
        test_scenario::return_shared(policy);
        test_scenario::return_shared(budget);
        test_scenario::return_shared(main_pool);
        scenario.return_to_sender(pass);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = claim::EGenericClaimDisabled)]
fun duplicate_generic_claim_path_is_disabled_before_index_mutation() {
    let mut scenario = initialized();
    fund_main_pool(&mut scenario, 1_000_000_000);
    register_member(&mut scenario);
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_claim_objects(&mut scenario);
    execute_claim(&mut scenario);
    execute_claim(&mut scenario);
    scenario.end();
}

#[test, expected_failure(abort_code = claim::EGenericClaimDisabled)]
fun operations_pool_funds_are_not_used_by_disabled_generic_claim_path() {
    let mut scenario = initialized();
    fund_operations_pool(&mut scenario, 1_000_000_000);
    register_member(&mut scenario);
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_claim_objects(&mut scenario);
    execute_claim(&mut scenario);
    scenario.end();
}

#[test]
fun available_usdc_saturates_at_u64_max() {
    assert!(
        claim::available_usdc_for_testing(
            18_446_744_073_709_551_614,
            2,
        ) == 18_446_744_073_709_551_615,
    );
}

#[test]
fun quote_confidence_zero_pays_zero_and_full_confidence_is_capped() {
    let mut scenario = test_scenario::begin(ADMIN);
    payout_policy::create_default_disaster_policy(scenario.ctx());

    scenario.next_tx(ADMIN);
    {
        let policy = scenario.take_shared<payout_policy::PayoutPolicy>();
        let zero_confidence = payout_policy::quote_usdc(
            &policy,
            1,
            0,
            0,
            1,
            50_000_000,
            50_000_000,
            50_000_000,
            NINETY_ONE_DAYS_MS,
        );
        let full_confidence = payout_policy::quote_usdc(
            &policy,
            1,
            0,
            10_000,
            1,
            50_000_000,
            50_000_000,
            50_000_000,
            NINETY_ONE_DAYS_MS,
        );
        let clamped_confidence = payout_policy::quote_usdc(
            &policy,
            1,
            0,
            20_000,
            1,
            50_000_000,
            50_000_000,
            50_000_000,
            NINETY_ONE_DAYS_MS,
        );

        assert!(zero_confidence == 0);
        assert!(full_confidence == 50_000_000);
        assert!(clamped_confidence == 50_000_000);

        test_scenario::return_shared(policy);
    };

    scenario.end();
}

#[test]
fun quote_risk_bucket_valid_values_are_applied() {
    let mut scenario = test_scenario::begin(ADMIN);
    payout_policy::create_default_disaster_policy(scenario.ctx());

    scenario.next_tx(ADMIN);
    {
        let policy = scenario.take_shared<payout_policy::PayoutPolicy>();
        let low_risk = payout_policy::quote_usdc(
            &policy,
            1,
            0,
            10_000,
            1,
            50_000_000,
            50_000_000,
            50_000_000,
            NINETY_ONE_DAYS_MS,
        );
        let medium_risk = payout_policy::quote_usdc(
            &policy,
            1,
            0,
            10_000,
            2,
            50_000_000,
            50_000_000,
            50_000_000,
            NINETY_ONE_DAYS_MS,
        );
        let high_risk = payout_policy::quote_usdc(
            &policy,
            1,
            0,
            10_000,
            3,
            50_000_000,
            50_000_000,
            50_000_000,
            NINETY_ONE_DAYS_MS,
        );

        assert!(low_risk == 50_000_000);
        assert!(medium_risk == 25_000_000);
        assert!(high_risk == 0);

        test_scenario::return_shared(policy);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = payout_policy::EInvalidRiskBucket)]
fun quote_rejects_zero_risk_bucket() {
    let mut scenario = test_scenario::begin(ADMIN);
    payout_policy::create_default_disaster_policy(scenario.ctx());

    scenario.next_tx(ADMIN);
    {
        let policy = scenario.take_shared<payout_policy::PayoutPolicy>();
        payout_policy::quote_usdc(
            &policy,
            1,
            0,
            10_000,
            0,
            50_000_000,
            50_000_000,
            50_000_000,
            NINETY_ONE_DAYS_MS,
        );

        test_scenario::return_shared(policy);
    };

    scenario.end();
}

#[test, expected_failure(abort_code = payout_policy::EInvalidRiskBucket)]
fun quote_rejects_unknown_risk_bucket() {
    let mut scenario = test_scenario::begin(ADMIN);
    payout_policy::create_default_disaster_policy(scenario.ctx());

    scenario.next_tx(ADMIN);
    {
        let policy = scenario.take_shared<payout_policy::PayoutPolicy>();
        payout_policy::quote_usdc(
            &policy,
            1,
            0,
            10_000,
            4,
            50_000_000,
            50_000_000,
            50_000_000,
            NINETY_ONE_DAYS_MS,
        );

        test_scenario::return_shared(policy);
    };

    scenario.end();
}

fun initialized(): test_scenario::Scenario {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);
    scenario
}

fun create_claim_objects(scenario: &mut test_scenario::Scenario) {
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        program::create_program(
            1,
            0,
            0,
            option::none(),
            option::none(),
            scenario.ctx(),
        );
        payout_policy::create_default_disaster_policy(scenario.ctx());
        scenario.return_to_sender(cap);
    };

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let program = scenario.take_shared<program::Program>();
        program::create_campaign(
            &program,
            1,
            b"generic-claim",
            option::none(),
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
}

fun execute_claim(scenario: &mut test_scenario::Scenario) {
    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut index = scenario.take_shared<claim::ClaimIndex>();
        let registry = scenario.take_shared<membership::MembershipRegistry>();
        let program = scenario.take_shared<program::Program>();
        let campaign = scenario.take_shared<program::Campaign>();
        let policy = scenario.take_shared<payout_policy::PayoutPolicy>();
        let mut budget = scenario.take_shared<payout_policy::CampaignBudget>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let pass = scenario.take_from_sender<membership::MembershipPass>();
        let eligibility = eligibility(&program, &campaign, &pass, 1, 50_000_000);

        claim::claim_usdc(
            &mut index,
            &registry,
            &program,
            &campaign,
            &policy,
            &mut budget,
            &pass,
            &mut main_pool,
            eligibility,
            scenario.ctx(),
        );

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(index);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(program);
        test_scenario::return_shared(campaign);
        test_scenario::return_shared(policy);
        test_scenario::return_shared(budget);
        test_scenario::return_shared(main_pool);
        scenario.return_to_sender(pass);
    };
}

fun eligibility(
    program: &program::Program,
    campaign: &program::Campaign,
    pass: &membership::MembershipPass,
    tier: u8,
    max_amount: u64,
): claim::EligibilityResult {
    claim::new_eligibility_result(
        program::id(program),
        program::campaign_id(campaign),
        membership::membership_pass_lineage_id(pass),
        tier,
        max_amount,
        0,
        b"generic-result",
        0,
        CLAIM_WINDOW_END_MS,
    )
}

fun fund_main_pool(scenario: &mut test_scenario::Scenario, amount: u64) {
    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();
        let mut main_pool = scenario.take_shared<pools::MainPool>();
        let coin = coin::mint_for_testing<USDC>(amount, scenario.ctx());
        accessor::donate_general_usdc(
            &pause_state,
            &mut registry,
            &mut main_pool,
            coin,
            scenario.ctx(),
        );
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(main_pool);
    };
}

fun fund_operations_pool(scenario: &mut test_scenario::Scenario, amount: u64) {
    scenario.next_tx(DONOR);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<donation::DonorRegistry>();
        let mut operations_pool = scenario.take_shared<pools::OperationsPool>();
        let coin = coin::mint_for_testing<USDC>(amount, scenario.ctx());
        accessor::donate_operations_usdc(
            &pause_state,
            &mut registry,
            &mut operations_pool,
            coin,
            scenario.ctx(),
        );
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(operations_pool);
    };
}

fun register_member(scenario: &mut test_scenario::Scenario) {
    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut registry = scenario.take_shared<membership::MembershipRegistry>();
        let mut operations_pool = scenario.take_shared<pools::OperationsPool>();
        let fee = coin::mint_for_testing<USDC>(1, scenario.ctx());
        accessor::register_member_usdc(
            &pause_state,
            &mut registry,
            &mut operations_pool,
            fee,
            PAYOUT,
            scenario.ctx(),
        );
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(operations_pool);
    };
}
