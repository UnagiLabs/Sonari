#[test_only]
module contracts::disaster_claim_tests;

use contracts::accessor;
use contracts::admin;
use contracts::affected_cell::{Self, AffectedCellLeaf};
use contracts::claim;
use contracts::disaster_event;
use contracts::membership;
use contracts::payload_v1;
use contracts::payout_policy;
use contracts::pools;
use contracts::program;
use sui::bcs;
use sui::coin;
use sui::event;
use sui::test_scenario;
use usdc::usdc::USDC;

const ADMIN: address = @0xA11CE;
const MEMBER: address = @0x51A;
const PAYOUT: address = @0xB0B;

const NINETY_ONE_DAYS_MS: u64 = 7_862_400_000;
const CLAIM_WINDOW_END_MS: u64 = 20_000_000_000;
const NOW_BEFORE_FRESHNESS_DEADLINE_MS: u64 = 1_704_170_000_000;
const H3_INDEX: u64 = 608_819_013_597_790_207;

#[test]
fun disaster_claim_uses_designated_budget_first_and_main_pool_backstop() {
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    apply_residence_metadata(&mut scenario);
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut index = scenario.take_shared<claim::ClaimIndex>();
        let registry = scenario.take_shared<membership::MembershipRegistry>();
        let program = scenario.take_shared<program::Program>();
        let campaign = scenario.take_shared<program::Campaign>();
        let policy = scenario.take_shared<payout_policy::PayoutPolicy>();
        let mut budget = scenario.take_shared<payout_policy::CampaignBudget>();
        let disaster_event = scenario.take_shared<disaster_event::DisasterEvent>();
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
            &disaster_event,
            &pass,
            affected_leaf(),
            proof(),
            &mut designated_pool,
            &mut main_pool,
            50_000_000,
            scenario.ctx(),
        );

        assert!(pools::designated_pool_balance_usdc(&designated_pool) == 4_000_000);
        assert!(pools::main_pool_balance_usdc(&main_pool) == 966_000_000);
        assert!(payout_policy::campaign_budget_claimed_usdc(&budget) == 50_000_000);

        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(index);
        test_scenario::return_shared(registry);
        test_scenario::return_shared(program);
        test_scenario::return_shared(campaign);
        test_scenario::return_shared(policy);
        test_scenario::return_shared(budget);
        test_scenario::return_shared(disaster_event);
        test_scenario::return_shared(designated_pool);
        test_scenario::return_shared(main_pool);
        scenario.return_to_sender(pass);
    };

    let paid_events = event::events_by_type<claim::ClaimPaid>();
    assert!(paid_events.length() == 1);
    let (_, _, _, amount, main_paid, designated_paid, recipient, _) =
        claim::claim_paid_event_fields(*paid_events.borrow(0));
    assert!(amount == 50_000_000);
    assert!(main_paid == 34_000_000);
    assert!(designated_paid == 16_000_000);
    assert!(recipient == PAYOUT);

    scenario.end();
}

#[test, expected_failure(abort_code = claim::EResidenceCellMismatch)]
fun disaster_claim_rejects_pass_residence_cell_mismatch() {
    let mut scenario = initialized();
    fund_pools_directly(&mut scenario);
    register_member(&mut scenario);
    apply_wrong_residence_metadata(&mut scenario);
    test_scenario::later_epoch(&mut scenario, NINETY_ONE_DAYS_MS, ADMIN);
    create_disaster_claim_objects(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut index = scenario.take_shared<claim::ClaimIndex>();
        let registry = scenario.take_shared<membership::MembershipRegistry>();
        let program = scenario.take_shared<program::Program>();
        let campaign = scenario.take_shared<program::Campaign>();
        let policy = scenario.take_shared<payout_policy::PayoutPolicy>();
        let mut budget = scenario.take_shared<payout_policy::CampaignBudget>();
        let disaster_event = scenario.take_shared<disaster_event::DisasterEvent>();
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
            &disaster_event,
            &pass,
            affected_leaf(),
            proof(),
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
        test_scenario::return_shared(disaster_event);
        test_scenario::return_shared(designated_pool);
        test_scenario::return_shared(main_pool);
        scenario.return_to_sender(pass);
    };

    scenario.end();
}

fun initialized(): test_scenario::Scenario {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        admin::create_designated_pool(&cap, option::none(), scenario.ctx());
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

fun apply_residence_metadata(scenario: &mut test_scenario::Scenario) {
    let h3_index = H3_INDEX;
    apply_residence_metadata_cell(scenario, bcs::to_bytes(&h3_index));
}

fun apply_wrong_residence_metadata(scenario: &mut test_scenario::Scenario) {
    apply_residence_metadata_cell(scenario, bcs::to_bytes(&0u64));
}

fun apply_residence_metadata_cell(
    scenario: &mut test_scenario::Scenario,
    residence_cell: vector<u8>,
) {
    scenario.next_tx(MEMBER);
    {
        let mut pass = scenario.take_from_sender<membership::MembershipPass>();
        membership::apply_residence_metadata_update(
            &mut pass,
            1,
            residence_cell,
            10_000,
            1,
            b"evidence",
            0,
            CLAIM_WINDOW_END_MS,
            1,
            1,
            scenario.ctx().epoch_timestamp_ms(),
            scenario.ctx(),
        );
        scenario.return_to_sender(pass);
    };
}

fun create_disaster_claim_objects(scenario: &mut test_scenario::Scenario) {
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        program::create_program(
            &cap,
            1,
            1,
            1,
            option::none(),
            option::none(),
            scenario.ctx(),
        );
        payout_policy::create_default_disaster_policy(&cap, scenario.ctx());
        claim::create_claim_index(&cap, scenario.ctx());
        disaster_event::create_disaster_registry(&cap, scenario.ctx());
        scenario.return_to_sender(cap);
    };

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let program = scenario.take_shared<program::Program>();
        program::create_campaign(
            &cap,
            &program,
            1,
            b"disaster-claim",
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
        let mut disaster_registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        let payload = payload_v1::decode_finalized(
            finalized_payload_bcs(),
            NOW_BEFORE_FRESHNESS_DEADLINE_MS,
        );
        disaster_event::create_from_payload(&cap, &mut disaster_registry, payload, scenario.ctx());
        scenario.return_to_sender(cap);
        test_scenario::return_shared(disaster_registry);
    };

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let program = scenario.take_shared<program::Program>();
        let campaign = scenario.take_shared<program::Campaign>();
        let main_pool = scenario.take_shared<pools::MainPool>();
        let designated_pool = scenario.take_shared<pools::DesignatedPool>();
        payout_policy::open_campaign_budget_from_designated_and_main(
            &cap,
            &program,
            &campaign,
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
    affected_cell::new_leaf(
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
        affected_cell::new_proof_step_left(
            x"954d0c90f737aa6e9015cf4d33a1ff98997bb6ebe2006e200d91bdecb1ba8ba0",
        ),
    ]
}

fun event_uid(): vector<u8> {
    x"eef4db66cd5fb2f612f5295553d192ed3b9754ed75ec58fec0f814a85a13437f"
}

fun finalized_payload_bcs(): vector<u8> {
    x"010100000000000000eef4db66cd5fb2f612f5295553d192ed3b9754ed75ec58fec0f814a85a13437f01030100000000f451c28c01000000b153c78c01000000b153c78c0100000102d905a14141efb9b0a8f23dbb01bdb9b537182faf5038d1fa76d9acfe2af298a72c051b491e6f2da3e7d193071bcdf2748f3c077a1eb1f94ffd03cfbe976c2efd3a697066733a2f2f736f6e6172692f6578616d706c65732f757337303030736f6e6172692f7261775f646174615f6d616e69666573742e6a736f6e56e5b1020cb655fa99cec324da2fbf79e03dcfe84d3eee72e163111d3b01f6af37697066733a2f2f736f6e6172692f6578616d706c65732f757337303030736f6e6172692f61666665637465645f63656c6c732e6a736f6e86a82292fbdc1381c58742d53c02fd0534d49bd6f8858e24219f9f3d57b3df2507010101010202000000000000000100489dc88c010000"
}
