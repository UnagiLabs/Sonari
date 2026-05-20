module contracts::payout_policy;

use contracts::admin::AdminCap;
use contracts::pools::{Self, DesignatedPool, MainPool};
use contracts::program::{Self, Campaign, Program};
use sui::event;

const BPS_DENOMINATOR: u64 = 10_000;
const THIRTY_DAYS_MS: u64 = 2_592_000_000;
const NINETY_DAYS_MS: u64 = 7_776_000_000;

const DEFAULT_BAND_1_USDC: u64 = 50_000_000;
const DEFAULT_BAND_2_USDC: u64 = 150_000_000;
const DEFAULT_BAND_3_USDC: u64 = 300_000_000;

const DEFAULT_POLICY_MAX_USDC: u64 = 300_000_000;
const FUTURE_RESERVE_FLOOR_BPS: u64 = 5_000;
const LIQUID_RESERVE_TARGET_BPS: u64 = 7_000;
const MAIN_BACKSTOP_OF_LIQUID_BPS: u64 = 2_000;
const DESIGNATED_BUDGET_BPS: u64 = 8_000;

const RISK_BUCKET_MEDIUM: u8 = 2;
const RISK_BUCKET_HIGH: u8 = 3;

const EInvalidEligibilityTier: u64 = 0;
const EBudgetProgramMismatch: u64 = 1;
const EBudgetCampaignMismatch: u64 = 2;
const EBudgetExceeded: u64 = 3;

public struct PayoutPolicy has key {
    id: UID,
    tier1_amount_usdc: u64,
    tier2_amount_usdc: u64,
    tier3_amount_usdc: u64,
    policy_max_amount_usdc: u64,
    future_reserve_floor_bps: u64,
    liquid_reserve_target_bps: u64,
    main_backstop_of_liquid_bps: u64,
    designated_budget_bps: u64,
    created_at_ms: u64,
}

public struct CampaignBudget has key {
    id: UID,
    program_id: ID,
    campaign_id: ID,
    designated_pool_id: Option<ID>,
    designated_budget_usdc: u64,
    main_backstop_budget_usdc: u64,
    designated_claimed_usdc: u64,
    main_claimed_usdc: u64,
    created_at_ms: u64,
}

public struct PayoutPolicyCreated has copy, drop {
    policy_id: ID,
    tier1_amount_usdc: u64,
    tier2_amount_usdc: u64,
    tier3_amount_usdc: u64,
    policy_max_amount_usdc: u64,
    created_at_ms: u64,
    actor: address,
}

public struct CampaignBudgetOpened has copy, drop {
    budget_id: ID,
    program_id: ID,
    campaign_id: ID,
    designated_pool_id: Option<ID>,
    designated_budget_usdc: u64,
    main_backstop_budget_usdc: u64,
    created_at_ms: u64,
    actor: address,
}

public(package) fun create_default_disaster_policy(_: &AdminCap, ctx: &mut TxContext) {
    let policy = PayoutPolicy {
        id: object::new(ctx),
        tier1_amount_usdc: DEFAULT_BAND_1_USDC,
        tier2_amount_usdc: DEFAULT_BAND_2_USDC,
        tier3_amount_usdc: DEFAULT_BAND_3_USDC,
        policy_max_amount_usdc: DEFAULT_POLICY_MAX_USDC,
        future_reserve_floor_bps: FUTURE_RESERVE_FLOOR_BPS,
        liquid_reserve_target_bps: LIQUID_RESERVE_TARGET_BPS,
        main_backstop_of_liquid_bps: MAIN_BACKSTOP_OF_LIQUID_BPS,
        designated_budget_bps: DESIGNATED_BUDGET_BPS,
        created_at_ms: ctx.epoch_timestamp_ms(),
    };
    let policy_id = object::id(&policy);

    event::emit(PayoutPolicyCreated {
        policy_id,
        tier1_amount_usdc: policy.tier1_amount_usdc,
        tier2_amount_usdc: policy.tier2_amount_usdc,
        tier3_amount_usdc: policy.tier3_amount_usdc,
        policy_max_amount_usdc: policy.policy_max_amount_usdc,
        created_at_ms: policy.created_at_ms,
        actor: ctx.sender(),
    });

    transfer::share_object(policy);
}

public(package) fun open_campaign_budget_from_main(
    _: &AdminCap,
    program: &Program,
    campaign: &Campaign,
    main_pool: &MainPool,
    ctx: &mut TxContext,
) {
    let budget = CampaignBudget {
        id: object::new(ctx),
        program_id: program::id(program),
        campaign_id: program::campaign_id(campaign),
        designated_pool_id: option::none(),
        designated_budget_usdc: 0,
        main_backstop_budget_usdc: main_backstop_budget_usdc(
            pools::main_pool_total_received_usdc(main_pool),
            pools::main_pool_balance_usdc(main_pool),
        ),
        designated_claimed_usdc: 0,
        main_claimed_usdc: 0,
        created_at_ms: ctx.epoch_timestamp_ms(),
    };
    share_budget(budget, ctx);
}

public(package) fun open_campaign_budget_from_designated_and_main(
    _: &AdminCap,
    program: &Program,
    campaign: &Campaign,
    designated_pool: &DesignatedPool,
    main_pool: &MainPool,
    ctx: &mut TxContext,
) {
    let budget = CampaignBudget {
        id: object::new(ctx),
        program_id: program::id(program),
        campaign_id: program::campaign_id(campaign),
        designated_pool_id: option::some(pools::designated_pool_id(designated_pool)),
        designated_budget_usdc: apply_bps(
            pools::designated_pool_balance_usdc(designated_pool),
            DESIGNATED_BUDGET_BPS,
        ),
        main_backstop_budget_usdc: main_backstop_budget_usdc(
            pools::main_pool_total_received_usdc(main_pool),
            pools::main_pool_balance_usdc(main_pool),
        ),
        designated_claimed_usdc: 0,
        main_claimed_usdc: 0,
        created_at_ms: ctx.epoch_timestamp_ms(),
    };
    share_budget(budget, ctx);
}

fun share_budget(budget: CampaignBudget, ctx: &TxContext) {
    let budget_id = object::id(&budget);
    event::emit(CampaignBudgetOpened {
        budget_id,
        program_id: budget.program_id,
        campaign_id: budget.campaign_id,
        designated_pool_id: budget.designated_pool_id,
        designated_budget_usdc: budget.designated_budget_usdc,
        main_backstop_budget_usdc: budget.main_backstop_budget_usdc,
        created_at_ms: budget.created_at_ms,
        actor: ctx.sender(),
    });
    transfer::share_object(budget);
}

public(package) fun assert_budget_matches(
    budget: &CampaignBudget,
    program: &Program,
    campaign: &Campaign,
) {
    assert!(budget.program_id == program::id(program), EBudgetProgramMismatch);
    assert!(budget.campaign_id == program::campaign_id(campaign), EBudgetCampaignMismatch);
}

public(package) fun record_claim(
    budget: &mut CampaignBudget,
    main_amount_usdc: u64,
    designated_amount_usdc: u64,
) {
    assert!(main_amount_usdc <= main_remaining_usdc(budget), EBudgetExceeded);
    assert!(
        designated_amount_usdc <= designated_remaining_usdc(budget),
        EBudgetExceeded,
    );
    budget.main_claimed_usdc = budget.main_claimed_usdc + main_amount_usdc;
    budget.designated_claimed_usdc = budget.designated_claimed_usdc + designated_amount_usdc;
}

public fun quote_usdc(
    policy: &PayoutPolicy,
    eligibility_tier: u8,
    membership_issued_at_ms: u64,
    confidence: u64,
    risk_bucket: u8,
    user_max_amount_usdc: u64,
    budget_remaining_usdc: u64,
    pool_available_usdc: u64,
    now_ms: u64,
): u64 {
    let mut amount = tier_amount_usdc(policy, eligibility_tier);
    amount = apply_bps(amount, membership_age_multiplier_bps(membership_issued_at_ms, now_ms));
    amount = apply_bps(amount, confidence_multiplier_bps(confidence));
    amount = apply_bps(amount, risk_multiplier_bps(risk_bucket));
    amount = min_u64(amount, user_max_amount_usdc);
    amount = min_u64(amount, policy.policy_max_amount_usdc);
    amount = min_u64(amount, budget_remaining_usdc);
    min_u64(amount, pool_available_usdc)
}

public fun main_backstop_budget_usdc(
    main_total_received_usdc: u64,
    main_balance_usdc: u64,
): u64 {
    let reserve_floor = future_reserve_floor_usdc(main_total_received_usdc);
    let spendable = if (main_balance_usdc > reserve_floor) {
        main_balance_usdc - reserve_floor
    } else {
        0
    };
    let liquid_budget =
        apply_bps(liquid_reserve_target_usdc(main_total_received_usdc), MAIN_BACKSTOP_OF_LIQUID_BPS);
    min_u64(liquid_budget, spendable)
}

public fun future_reserve_floor_usdc(main_total_received_usdc: u64): u64 {
    apply_bps(main_total_received_usdc, FUTURE_RESERVE_FLOOR_BPS)
}

public fun liquid_reserve_target_usdc(main_total_received_usdc: u64): u64 {
    apply_bps(main_total_received_usdc, LIQUID_RESERVE_TARGET_BPS)
}

public fun campaign_budget_claimed_usdc(budget: &CampaignBudget): u64 {
    budget.designated_claimed_usdc + budget.main_claimed_usdc
}

public fun campaign_budget_remaining_usdc(budget: &CampaignBudget): u64 {
    designated_remaining_usdc(budget) + main_remaining_usdc(budget)
}

public fun main_remaining_usdc(budget: &CampaignBudget): u64 {
    budget.main_backstop_budget_usdc - budget.main_claimed_usdc
}

public fun designated_remaining_usdc(budget: &CampaignBudget): u64 {
    budget.designated_budget_usdc - budget.designated_claimed_usdc
}

public fun policy_id(policy: &PayoutPolicy): ID {
    object::id(policy)
}

fun tier_amount_usdc(policy: &PayoutPolicy, eligibility_tier: u8): u64 {
    if (eligibility_tier == 1) {
        policy.tier1_amount_usdc
    } else if (eligibility_tier == 2) {
        policy.tier2_amount_usdc
    } else if (eligibility_tier == 3) {
        policy.tier3_amount_usdc
    } else {
        abort EInvalidEligibilityTier
    }
}

fun membership_age_multiplier_bps(issued_at_ms: u64, now_ms: u64): u64 {
    let age = if (now_ms > issued_at_ms) { now_ms - issued_at_ms } else { 0 };
    if (age < THIRTY_DAYS_MS) {
        0
    } else if (age < NINETY_DAYS_MS) {
        5_000
    } else {
        BPS_DENOMINATOR
    }
}

fun confidence_multiplier_bps(confidence: u64): u64 {
    if (confidence == 0) {
        BPS_DENOMINATOR
    } else {
        min_u64(confidence, BPS_DENOMINATOR)
    }
}

fun risk_multiplier_bps(risk_bucket: u8): u64 {
    if (risk_bucket >= RISK_BUCKET_HIGH) {
        0
    } else if (risk_bucket == RISK_BUCKET_MEDIUM) {
        5_000
    } else {
        BPS_DENOMINATOR
    }
}

fun apply_bps(amount: u64, bps: u64): u64 {
    (((amount as u128) * (bps as u128)) / (BPS_DENOMINATOR as u128)) as u64
}

fun min_u64(a: u64, b: u64): u64 {
    if (a < b) { a } else { b }
}

#[test_only]
public fun campaign_budget_opened_event_fields(
    event: CampaignBudgetOpened,
): (ID, ID, ID, Option<ID>, u64, u64, address) {
    let CampaignBudgetOpened {
        budget_id,
        program_id,
        campaign_id,
        designated_pool_id,
        designated_budget_usdc,
        main_backstop_budget_usdc,
        created_at_ms: _,
        actor,
    } = event;
    (
        budget_id,
        program_id,
        campaign_id,
        designated_pool_id,
        designated_budget_usdc,
        main_backstop_budget_usdc,
        actor,
    )
}
