module contracts::claim;
use contracts::affected_cell::{Self, AffectedCellLeaf, ProofStep};
use contracts::disaster_event::{DisasterCampaignBinding, DisasterEvent};
use contracts::disaster_event;
use contracts::membership::{Self, MembershipPass, MembershipRegistry};
use contracts::payout_policy::{Self, CampaignBudget, PayoutPolicy};
use contracts::pools::{Self, DesignatedPool, MainPool};
use contracts::program::{Self, Campaign, Program};
use sui::bcs;
use sui::clock::{Self, Clock};
use sui::coin;
use sui::dynamic_field;
use sui::event;

const EDuplicateClaim: u64 = 0;
const ENoPayableAmount: u64 = 1;
const EInvalidAffectedCellProof: u64 = 7;
const EDisasterEventMismatch: u64 = 8;
const EClaimBandTooLow: u64 = 9;
const EResidenceCellMismatch: u64 = 10;
const EResidenceMetadataExpired: u64 = 11;
const EGenericClaimDisabled: u64 = 12;
const EResidenceMetadataAfterDisaster: u64 = 13;
const U64_MAX: u64 = 18_446_744_073_709_551_615;
const U64_MAX_AS_U128: u128 = 18_446_744_073_709_551_615;

public struct ClaimIndex has key {
    id: UID,
    claim_count: u64,
}

#[allow(unused_field)]
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
    claimed_at_ms: u64,
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

public(package) fun create_claim_index(ctx: &mut TxContext): ID {
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
    claim_index_id
}

#[test_only]
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
    _index: &mut ClaimIndex,
    _registry: &MembershipRegistry,
    _program: &Program,
    _campaign: &Campaign,
    _policy: &PayoutPolicy,
    _budget: &mut CampaignBudget,
    _pass: &MembershipPass,
    _main_pool: &mut MainPool,
    _eligibility: EligibilityResult,
    _ctx: &mut TxContext,
) {
    abort EGenericClaimDisabled
}

public(package) fun claim_disaster_usdc(
    index: &mut ClaimIndex,
    registry: &MembershipRegistry,
    program: &Program,
    campaign: &Campaign,
    policy: &PayoutPolicy,
    budget: &mut CampaignBudget,
    binding: &DisasterCampaignBinding,
    disaster_event: &DisasterEvent,
    pass: &MembershipPass,
    clock: &Clock,
    leaf: AffectedCellLeaf,
    proof: vector<ProofStep>,
    designated_pool: &mut DesignatedPool,
    main_pool: &mut MainPool,
    user_max_amount_usdc: u64,
    ctx: &mut TxContext,
) {
    let now_ms = clock::timestamp_ms(clock);
    program::assert_claim_precheck(program, campaign);
    program::assert_claim_window(campaign, now_ms);
    payout_policy::assert_budget_matches(budget, program, campaign);
    payout_policy::assert_designated_pool_matches(budget, designated_pool);
    disaster_event::assert_campaign_binding(binding, campaign, disaster_event);
    membership::assert_current_pass_precheck(registry, pass, ctx.sender());
    assert_valid_disaster_eligibility(disaster_event, pass, &leaf, proof, now_ms);

    let duplicate_key = ClaimKey {
        pass_lineage_id: membership::membership_pass_lineage_id(pass),
        campaign_id: program::campaign_id(campaign),
    };
    assert!(
        !dynamic_field::exists_with_type<ClaimKey, bool>(&index.id, duplicate_key),
        EDuplicateClaim,
    );

    let designated_available = min_u64(
        pools::designated_pool_balance_usdc(designated_pool),
        payout_policy::designated_remaining_usdc(budget),
    );
    let main_available = min_u64(
        pools::main_pool_balance_usdc(main_pool),
        payout_policy::main_remaining_usdc(budget),
    );
    let total_available = available_usdc(designated_available, main_available);
    let (_, _, confidence, risk_bucket, _, _, _, _) =
        membership::residence_metadata_summary(pass);
    let amount = payout_policy::quote_usdc(
        policy,
        affected_cell::cell_band(&leaf),
        membership::membership_pass_issued_at_ms(pass),
        confidence,
        risk_bucket,
        user_max_amount_usdc,
        payout_policy::campaign_budget_remaining_usdc(budget),
        total_available,
        now_ms,
    );
    assert!(amount > 0, ENoPayableAmount);

    let designated_amount = min_u64(amount, designated_available);
    let main_amount = amount - designated_amount;
    assert!(main_amount <= main_available, ENoPayableAmount);

    dynamic_field::add(&mut index.id, duplicate_key, true);
    index.claim_count = index.claim_count + 1;
    payout_policy::record_claim(budget, main_amount, designated_amount);

    let recipient = membership::membership_pass_owner(pass);
    let mut payout_coin = pools::withdraw_designated_usdc(designated_pool, designated_amount, ctx);
    let main_coin = pools::withdraw_main_usdc(main_pool, main_amount, ctx);
    coin::join(&mut payout_coin, main_coin);
    transfer::public_transfer(payout_coin, recipient);

    create_receipt_and_emit(
        program,
        campaign,
        pass,
        affected_cell::cell_band(&leaf),
        amount,
        main_amount,
        designated_amount,
        recipient,
        now_ms,
        ctx,
    );
}

fun assert_valid_disaster_eligibility(
    disaster_event: &DisasterEvent,
    pass: &MembershipPass,
    leaf: &AffectedCellLeaf,
    proof: vector<ProofStep>,
    now_ms: u64,
) {
    assert!(
        affected_cell::event_uid(leaf) == disaster_event::event_uid(disaster_event)
            && affected_cell::event_revision(leaf) == disaster_event::event_revision(disaster_event),
        EDisasterEventMismatch,
    );
    assert!(
        affected_cell::verify_proof(
            leaf,
            proof,
            disaster_event::affected_cells_root(disaster_event),
        ),
        EInvalidAffectedCellProof,
    );
    assert!(
        affected_cell::cell_band(leaf) >= disaster_event::min_claim_band(disaster_event),
        EClaimBandTooLow,
    );

    let (
        _update_id,
        residence_cell,
        _confidence,
        _risk_bucket,
        _evidence_hash,
        residence_issued_at_ms,
        expires_at_ms,
        _verifier_version,
    ) = membership::residence_metadata_summary(pass);
    assert!(
        residence_issued_at_ms <= disaster_event::occurred_at_ms(disaster_event),
        EResidenceMetadataAfterDisaster,
    );
    assert!(expires_at_ms > now_ms, EResidenceMetadataExpired);
    assert!(
        residence_cell == bcs::to_bytes(&affected_cell::h3_index(leaf)),
        EResidenceCellMismatch,
    );
}

fun create_receipt_and_emit(
    program: &Program,
    campaign: &Campaign,
    pass: &MembershipPass,
    eligibility_tier: u8,
    amount: u64,
    main_amount: u64,
    designated_amount: u64,
    recipient: address,
    claimed_at_ms: u64,
    ctx: &mut TxContext,
) {
    let receipt = ClaimReceipt {
        id: object::new(ctx),
        program_id: program::id(program),
        campaign_id: program::campaign_id(campaign),
        pass_lineage_id: membership::membership_pass_lineage_id(pass),
        eligibility_tier,
        amount_usdc: amount,
        main_paid_usdc: main_amount,
        designated_paid_usdc: designated_amount,
        claimant: ctx.sender(),
        recipient,
        claimed_at_ms,
    };
    let receipt_id = object::id(&receipt);

    event::emit(ClaimPaid {
        receipt_id,
        program_id: receipt.program_id,
        campaign_id: receipt.campaign_id,
        amount_usdc: amount,
        main_paid_usdc: main_amount,
        designated_paid_usdc: designated_amount,
        recipient,
        claimed_at_ms,
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

fun available_usdc(designated_available: u64, main_available: u64): u64 {
    let total = (designated_available as u128) + (main_available as u128);
    if (total > U64_MAX_AS_U128) {
        U64_MAX
    } else {
        (total as u64)
    }
}

#[test_only]
public fun available_usdc_for_testing(designated_available: u64, main_available: u64): u64 {
    available_usdc(designated_available, main_available)
}

#[test_only]
public fun claim_paid_event_fields(
    event: ClaimPaid,
): (ID, ID, ID, u64, u64, u64, address, u64, address) {
    let ClaimPaid {
        receipt_id,
        program_id,
        campaign_id,
        amount_usdc,
        main_paid_usdc,
        designated_paid_usdc,
        recipient,
        claimed_at_ms,
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
        claimed_at_ms,
        actor,
    )
}
