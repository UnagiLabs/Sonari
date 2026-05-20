module contracts::claim;

use contracts::admin::{AdminCap, PauseState};
use contracts::membership::{Self, MembershipPass, MembershipRegistry};
use contracts::payout_policy::{Self, CampaignBudget, PayoutPolicy};
use contracts::pools::{Self, MainPool};
use contracts::program::{Self, Campaign, Program};
use sui::dynamic_field;
use sui::event;

const EDuplicateClaim: u64 = 0;
const ENoPayableAmount: u64 = 1;
const EEligibilityProgramMismatch: u64 = 2;
const EEligibilityCampaignMismatch: u64 = 3;
const EEligibilityPassMismatch: u64 = 4;
const EEligibilityExpired: u64 = 5;
const EEligibilityInvalidTimeRange: u64 = 6;

public struct ClaimIndex has key {
    id: UID,
    claim_count: u64,
}

public struct EligibilityResult has copy, drop, store {
    program_id: ID,
    campaign_id: ID,
    pass_lineage_id: ID,
    eligibility_tier: u8,
    max_amount: u64,
    verifier_family: u8,
    result_hash: vector<u8>,
    issued_at_ms: u64,
    expires_at_ms: u64,
}

public struct ClaimKey has copy, drop, store {
    pass_lineage_id: ID,
    campaign_id: ID,
}

public struct ClaimReceipt has key {
    id: UID,
    program_id: ID,
    campaign_id: ID,
    pass_lineage_id: ID,
    eligibility_tier: u8,
    amount_usdc: u64,
    main_paid_usdc: u64,
    designated_paid_usdc: u64,
    claimant: address,
    recipient: address,
    claimed_at_ms: u64,
}

public struct ClaimIndexCreated has copy, drop {
    claim_index_id: ID,
    created_at_ms: u64,
    actor: address,
}

public struct ClaimPaid has copy, drop {
    receipt_id: ID,
    program_id: ID,
    campaign_id: ID,
    amount_usdc: u64,
    main_paid_usdc: u64,
    designated_paid_usdc: u64,
    recipient: address,
    actor: address,
}

public struct ClaimReceiptCreated has copy, drop {
    receipt_id: ID,
    program_id: ID,
    campaign_id: ID,
    pass_lineage_id: ID,
    amount_usdc: u64,
    claimant: address,
    recipient: address,
    actor: address,
}

public(package) fun create_claim_index(_: &AdminCap, ctx: &mut TxContext) {
    let index = ClaimIndex {
        id: object::new(ctx),
        claim_count: 0,
    };
    let claim_index_id = object::id(&index);
    event::emit(ClaimIndexCreated {
        claim_index_id,
        created_at_ms: ctx.epoch_timestamp_ms(),
        actor: ctx.sender(),
    });
    transfer::share_object(index);
}

public fun new_eligibility_result(
    program_id: ID,
    campaign_id: ID,
    pass_lineage_id: ID,
    eligibility_tier: u8,
    max_amount: u64,
    verifier_family: u8,
    result_hash: vector<u8>,
    issued_at_ms: u64,
    expires_at_ms: u64,
): EligibilityResult {
    EligibilityResult {
        program_id,
        campaign_id,
        pass_lineage_id,
        eligibility_tier,
        max_amount,
        verifier_family,
        result_hash,
        issued_at_ms,
        expires_at_ms,
    }
}

public(package) fun claim_usdc(
    pause_state: &PauseState,
    index: &mut ClaimIndex,
    registry: &MembershipRegistry,
    program: &Program,
    campaign: &Campaign,
    policy: &PayoutPolicy,
    budget: &mut CampaignBudget,
    pass: &MembershipPass,
    main_pool: &mut MainPool,
    eligibility: EligibilityResult,
    ctx: &mut TxContext,
) {
    let now_ms = ctx.epoch_timestamp_ms();
    program::assert_claim_precheck(pause_state, program, campaign);
    program::assert_claim_window(campaign, now_ms);
    payout_policy::assert_budget_matches(budget, program, campaign);
    membership::assert_current_pass_precheck(registry, pass, ctx.sender());

    assert_valid_eligibility(program, campaign, pass, &eligibility, now_ms);
    let duplicate_key = ClaimKey {
        pass_lineage_id: membership::membership_pass_lineage_id(pass),
        campaign_id: program::campaign_id(campaign),
    };
    assert!(
        !dynamic_field::exists_with_type<ClaimKey, bool>(&index.id, duplicate_key),
        EDuplicateClaim,
    );

    let pool_available = min_u64(
        pools::main_pool_balance_usdc(main_pool),
        payout_policy::main_remaining_usdc(budget),
    );
    let amount = payout_policy::quote_usdc(
        policy,
        eligibility.eligibility_tier,
        membership::membership_pass_issued_at_ms(pass),
        0,
        0,
        eligibility.max_amount,
        payout_policy::campaign_budget_remaining_usdc(budget),
        pool_available,
        now_ms,
    );
    assert!(amount > 0, ENoPayableAmount);

    dynamic_field::add(&mut index.id, duplicate_key, true);
    index.claim_count = index.claim_count + 1;
    payout_policy::record_claim(budget, amount, 0);

    let recipient = membership::membership_pass_payout_address(pass);
    let payout_coin = pools::withdraw_main_usdc(main_pool, amount, ctx);
    transfer::public_transfer(payout_coin, recipient);

    let receipt = ClaimReceipt {
        id: object::new(ctx),
        program_id: program::id(program),
        campaign_id: program::campaign_id(campaign),
        pass_lineage_id: membership::membership_pass_lineage_id(pass),
        eligibility_tier: eligibility.eligibility_tier,
        amount_usdc: amount,
        main_paid_usdc: amount,
        designated_paid_usdc: 0,
        claimant: ctx.sender(),
        recipient,
        claimed_at_ms: now_ms,
    };
    let receipt_id = object::id(&receipt);

    event::emit(ClaimPaid {
        receipt_id,
        program_id: receipt.program_id,
        campaign_id: receipt.campaign_id,
        amount_usdc: amount,
        main_paid_usdc: amount,
        designated_paid_usdc: 0,
        recipient,
        actor: ctx.sender(),
    });
    event::emit(ClaimReceiptCreated {
        receipt_id,
        program_id: receipt.program_id,
        campaign_id: receipt.campaign_id,
        pass_lineage_id: receipt.pass_lineage_id,
        amount_usdc: amount,
        claimant: ctx.sender(),
        recipient,
        actor: ctx.sender(),
    });

    transfer::transfer(receipt, ctx.sender());
}

fun assert_valid_eligibility(
    program: &Program,
    campaign: &Campaign,
    pass: &MembershipPass,
    eligibility: &EligibilityResult,
    now_ms: u64,
) {
    assert!(eligibility.program_id == program::id(program), EEligibilityProgramMismatch);
    assert!(
        eligibility.campaign_id == program::campaign_id(campaign),
        EEligibilityCampaignMismatch,
    );
    assert!(
        eligibility.pass_lineage_id == membership::membership_pass_lineage_id(pass),
        EEligibilityPassMismatch,
    );
    assert!(eligibility.expires_at_ms > eligibility.issued_at_ms, EEligibilityInvalidTimeRange);
    assert!(eligibility.expires_at_ms > now_ms, EEligibilityExpired);
}

public fun claim_index_claim_count(index: &ClaimIndex): u64 {
    index.claim_count
}

public fun claim_receipt_summary(
    receipt: &ClaimReceipt,
): (ID, ID, ID, u64, u64, u64, address, address) {
    (
        receipt.program_id,
        receipt.campaign_id,
        receipt.pass_lineage_id,
        receipt.amount_usdc,
        receipt.main_paid_usdc,
        receipt.designated_paid_usdc,
        receipt.claimant,
        receipt.recipient,
    )
}

fun min_u64(a: u64, b: u64): u64 {
    if (a < b) { a } else { b }
}

#[test_only]
public fun claim_paid_event_fields(
    event: ClaimPaid,
): (ID, ID, ID, u64, u64, u64, address, address) {
    let ClaimPaid {
        receipt_id,
        program_id,
        campaign_id,
        amount_usdc,
        main_paid_usdc,
        designated_paid_usdc,
        recipient,
        actor,
    } = event;
    (
        receipt_id,
        program_id,
        campaign_id,
        amount_usdc,
        main_paid_usdc,
        designated_paid_usdc,
        recipient,
        actor,
    )
}
