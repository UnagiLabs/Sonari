module contracts::accessor;

use contracts::admin::{Self, PauseState};
use contracts::affected_cell::{Self, AffectedCellLeaf, ProofStep};
use contracts::allowed_residence_cell;
use contracts::claim::{Self, ClaimIndex, ClaimReceipt};
use contracts::disaster_event::{Self, DisasterCampaignBinding, DisasterEvent, DisasterRegistry};
use contracts::donation::{Self, DonorPass, DonorRegistry};
use contracts::identity_registry::{Self, IdentityRegistry};
use contracts::identity_result_v1;
use contracts::membership;
use contracts::metadata_verifier;
use contracts::pools::{Self, DesignatedPool, MainPool, OperationsPool};
use contracts::payout_policy::{Self, CampaignBudget, PayoutPolicy};
use contracts::program::{Self, Campaign, Program};
use std::string::String;
use sui::clock::{Self, Clock};
use sui::coin::Coin;
use usdc::usdc::USDC;

const EInvalidResidenceCellProof: u64 = 0;

public fun donate_general_usdc(
    pause_state: &PauseState,
    registry: &mut DonorRegistry,
    main_pool: &mut MainPool,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
) {
    admin::assert_not_globally_paused(pause_state);
    admin::assert_target_not_paused(pause_state, pools::main_pool_id(main_pool));
    donation::donate_general_usdc(registry, main_pool, coin, ctx);
}

public fun donate_general_usdc_with_pass(
    pause_state: &PauseState,
    registry: &DonorRegistry,
    main_pool: &mut MainPool,
    pass: &mut DonorPass,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
) {
    admin::assert_not_globally_paused(pause_state);
    admin::assert_target_not_paused(pause_state, pools::main_pool_id(main_pool));
    donation::donate_general_usdc_with_pass(
        registry,
        main_pool,
        pass,
        coin,
        ctx,
    );
}

public fun donate_designated_usdc(
    pause_state: &PauseState,
    registry: &mut DonorRegistry,
    main_pool: &mut MainPool,
    designated_pool: &mut DesignatedPool,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
) {
    admin::assert_not_globally_paused(pause_state);
    admin::assert_target_not_paused(pause_state, pools::main_pool_id(main_pool));
    admin::assert_target_not_paused(pause_state, pools::designated_pool_id(designated_pool));
    donation::donate_designated_usdc(
        registry,
        main_pool,
        designated_pool,
        coin,
        ctx,
    );
}

public fun donate_designated_usdc_with_pass(
    pause_state: &PauseState,
    registry: &DonorRegistry,
    main_pool: &mut MainPool,
    designated_pool: &mut DesignatedPool,
    pass: &mut DonorPass,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
) {
    admin::assert_not_globally_paused(pause_state);
    admin::assert_target_not_paused(pause_state, pools::main_pool_id(main_pool));
    admin::assert_target_not_paused(pause_state, pools::designated_pool_id(designated_pool));
    donation::donate_designated_usdc_with_pass(
        registry,
        main_pool,
        designated_pool,
        pass,
        coin,
        ctx,
    );
}

public fun donate_operations_usdc(
    pause_state: &PauseState,
    registry: &mut DonorRegistry,
    operations_pool: &mut OperationsPool,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
) {
    admin::assert_not_globally_paused(pause_state);
    admin::assert_target_not_paused(pause_state, pools::operations_pool_id(operations_pool));
    donation::donate_operations_usdc(registry, operations_pool, coin, ctx);
}

public fun donate_operations_usdc_with_pass(
    pause_state: &PauseState,
    registry: &DonorRegistry,
    operations_pool: &mut OperationsPool,
    pass: &mut DonorPass,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
) {
    admin::assert_not_globally_paused(pause_state);
    admin::assert_target_not_paused(pause_state, pools::operations_pool_id(operations_pool));
    donation::donate_operations_usdc_with_pass(
        registry,
        operations_pool,
        pass,
        coin,
        ctx,
    );
}

public fun register_member(
    pause_state: &PauseState,
    registry: &mut membership::MembershipRegistry,
    residence_registry: &allowed_residence_cell::AllowedResidenceCellRegistry,
    home_cell: u64,
    proof: vector<allowed_residence_cell::ProofStep>,
    terms_version: u64,
    signed_statement_hash: vector<u8>,
    ctx: &mut TxContext,
) {
    admin::assert_not_globally_paused(pause_state);
    admin::assert_target_not_paused(pause_state, membership::registry_id(registry));
    assert!(
        allowed_residence_cell::is_valid_home_cell(residence_registry, home_cell, proof),
        EInvalidResidenceCellProof,
    );
    membership::register_member(
        registry,
        home_cell,
        terms_version,
        signed_statement_hash,
        ctx,
    );
}

public fun new_residence_proof_step_left(
    sibling_hash: vector<u8>,
): allowed_residence_cell::ProofStep {
    allowed_residence_cell::new_proof_step_left(sibling_hash)
}

public fun new_residence_proof_step_right(
    sibling_hash: vector<u8>,
): allowed_residence_cell::ProofStep {
    allowed_residence_cell::new_proof_step_right(sibling_hash)
}

public fun update_member_home_cell(
    pause_state: &PauseState,
    registry: &membership::MembershipRegistry,
    residence_registry: &allowed_residence_cell::AllowedResidenceCellRegistry,
    pass: &mut membership::MembershipPass,
    clock: &Clock,
    home_cell: u64,
    proof: vector<allowed_residence_cell::ProofStep>,
    ctx: &mut TxContext,
) {
    admin::assert_not_globally_paused(pause_state);
    admin::assert_target_not_paused(pause_state, membership::registry_id(registry));
    assert!(
        allowed_residence_cell::is_valid_home_cell(residence_registry, home_cell, proof),
        EInvalidResidenceCellProof,
    );
    membership::update_home_cell(
        registry,
        pass,
        ctx.sender(),
        home_cell,
        clock::timestamp_ms(clock),
    );
}

public fun update_identity_verification(
    pause_state: &PauseState,
    identity_registry: &mut identity_registry::IdentityRegistry,
    membership_registry: &membership::MembershipRegistry,
    verifier_registry: &metadata_verifier::VerifierRegistry,
    pass: &mut membership::MembershipPass,
    clock: &Clock,
    payload_bcs: vector<u8>,
    signature: vector<u8>,
    public_key: vector<u8>,
    ctx: &mut TxContext,
) {
    let _ = ctx;
    admin::assert_not_globally_paused(pause_state);
    admin::assert_target_not_paused(
        pause_state,
        identity_registry::registry_id(identity_registry),
    );
    admin::assert_target_not_paused(
        pause_state,
        membership::registry_id(membership_registry),
    );
    admin::assert_target_not_paused(
        pause_state,
        metadata_verifier::registry_id(verifier_registry),
    );

    let now_ms = clock::timestamp_ms(clock);
    metadata_verifier::assert_signed_bytes(
        verifier_registry,
        metadata_verifier::verifier_family_identity(),
        metadata_verifier::verifier_version_v1(),
        &payload_bcs,
        &signature,
        &public_key,
    );
    let result = identity_result_v1::decode_verified(payload_bcs, now_ms);
    identity_registry::apply_identity_verification_result(
        identity_registry,
        membership_registry,
        pass,
        &result,
        now_ms,
    );
}

public fun create_disaster_event_from_signed_payload(
    registry: &mut DisasterRegistry,
    verifier_registry: &metadata_verifier::VerifierRegistry,
    clock: &Clock,
    payload_bcs: vector<u8>,
    signature: vector<u8>,
    public_key: vector<u8>,
    ctx: &mut TxContext,
) {
    disaster_event::create_from_signed_payload(
        registry,
        verifier_registry,
        clock,
        payload_bcs,
        signature,
        public_key,
        ctx,
    );
}

public fun new_affected_cell_leaf(
    event_uid: vector<u8>,
    event_revision: u32,
    h3_index: u64,
    geo_resolution: u8,
    cell_metric: u8,
    intensity_value: u16,
    intensity_scale: u8,
    cell_band: u8,
    cells_generation_method: u8,
    oracle_version: u64,
): AffectedCellLeaf {
    affected_cell::new_leaf(
        event_uid,
        event_revision,
        h3_index,
        geo_resolution,
        cell_metric,
        intensity_value,
        intensity_scale,
        cell_band,
        cells_generation_method,
        oracle_version,
    )
}

public fun new_affected_cell_proof_step_left(sibling_hash: vector<u8>): ProofStep {
    affected_cell::new_proof_step_left(sibling_hash)
}

public fun new_affected_cell_proof_step_right(sibling_hash: vector<u8>): ProofStep {
    affected_cell::new_proof_step_right(sibling_hash)
}

public fun claim_disaster_usdc(
    pause_state: &PauseState,
    index: &mut ClaimIndex,
    registry: &membership::MembershipRegistry,
    program: &Program,
    campaign: &Campaign,
    policy: &PayoutPolicy,
    budget: &mut CampaignBudget,
    binding: &DisasterCampaignBinding,
    disaster_event: &DisasterEvent,
    identity_registry: &IdentityRegistry,
    pass: &membership::MembershipPass,
    clock: &Clock,
    leaf: AffectedCellLeaf,
    proof: vector<ProofStep>,
    identity_provider: u8,
    duplicate_key_hash: vector<u8>,
    designated_pool: &mut DesignatedPool,
    main_pool: &mut MainPool,
    user_max_amount_usdc: u64,
    ctx: &mut TxContext,
) {
    admin::assert_not_globally_paused(pause_state);
    admin::assert_target_not_paused(pause_state, program::id(program));
    admin::assert_target_not_paused(pause_state, program::campaign_id(campaign));
    admin::assert_target_not_paused(
        pause_state,
        identity_registry::registry_id(identity_registry),
    );
    admin::assert_target_not_paused(pause_state, pools::designated_pool_id(designated_pool));
    admin::assert_target_not_paused(pause_state, pools::main_pool_id(main_pool));
    claim::claim_disaster_usdc(
        index,
        registry,
        program,
        campaign,
        policy,
        budget,
        binding,
        disaster_event,
        identity_registry,
        pass,
        clock,
        leaf,
        proof,
        identity_provider,
        duplicate_key_hash,
        designated_pool,
        main_pool,
        user_max_amount_usdc,
        ctx,
    );
}

public fun donor_pass_tier_label(pass: &DonorPass): String {
    donation::donor_pass_tier_label(pass)
}

public fun donation_record_summary(
    pass: &DonorPass,
    donation_index: u64,
): (u64, u8, Option<ID>, Option<ID>, ID, u64, vector<u8>, u64) {
    donation::donation_record_summary(pass, donation_index)
}

public fun donor_registry_id(registry: &DonorRegistry): ID {
    donation::registry_id(registry)
}

public fun registry_kind_donor(): u8 {
    donation::registry_kind_donor()
}

public fun membership_registry_id(registry: &membership::MembershipRegistry): ID {
    membership::registry_id(registry)
}

public fun registry_kind_membership(): u8 {
    membership::registry_kind_membership()
}

public fun target_kind_membership_registry(): u8 {
    membership::target_kind_membership_registry()
}

public fun membership_registry_issued_count(registry: &membership::MembershipRegistry): u64 {
    membership::membership_registry_issued_count(registry)
}

public fun membership_owner_lineage_id(
    registry: &membership::MembershipRegistry,
    owner: address,
): ID {
    membership::membership_owner_lineage_id(registry, owner)
}

public fun membership_record_summary(
    registry: &membership::MembershipRegistry,
    pass_lineage_id: ID,
): (ID, ID, address, u8, u64, u64) {
    membership::membership_record_summary(registry, pass_lineage_id)
}

public fun membership_pass_owner(pass: &membership::MembershipPass): address {
    membership::membership_pass_owner(pass)
}

public fun membership_pass_lineage_id(pass: &membership::MembershipPass): ID {
    membership::membership_pass_lineage_id(pass)
}

public fun membership_pass_status(pass: &membership::MembershipPass): u8 {
    membership::membership_pass_status(pass)
}

public fun membership_pass_issued_at_ms(pass: &membership::MembershipPass): u64 {
    membership::membership_pass_issued_at_ms(pass)
}

public fun membership_pass_display_labels(
    pass: &membership::MembershipPass,
): (String, String) {
    membership::membership_pass_display_labels(pass)
}

public fun membership_pass_mvp_summary(
    pass: &membership::MembershipPass,
): (u64, u64, u64, bool, u8, u64, u64, u64, vector<u8>) {
    membership::membership_pass_mvp_summary(pass)
}

public fun membership_status_active(): u8 {
    membership::status_active()
}

public fun membership_status_suspended(): u8 {
    membership::status_suspended()
}

public fun membership_status_revoked(): u8 {
    membership::status_revoked()
}

public fun membership_status_migrated(): u8 {
    membership::status_migrated()
}

public fun identity_registry_id(registry: &IdentityRegistry): ID {
    identity_registry::registry_id(registry)
}

public fun registry_kind_identity(): u8 {
    identity_registry::registry_kind_identity()
}

public fun identity_provider_kyc(): u8 {
    identity_registry::provider_kyc()
}

public fun identity_provider_world_id(): u8 {
    identity_registry::provider_world_id()
}

public fun claim_index_claim_count(index: &ClaimIndex): u64 {
    claim::claim_index_claim_count(index)
}

public fun claim_receipt_summary(
    receipt: &ClaimReceipt,
): (ID, ID, ID, u64, u64, u64, address, address) {
    claim::claim_receipt_summary(receipt)
}

public fun claim_receipt_tier_label(receipt: &ClaimReceipt): String {
    claim::claim_receipt_tier_label(receipt)
}

public fun quote_usdc(
    policy: &PayoutPolicy,
    eligibility_tier: u8,
    user_max_amount_usdc: u64,
    budget_remaining_usdc: u64,
    pool_available_usdc: u64,
): u64 {
    payout_policy::quote_usdc(
        policy,
        eligibility_tier,
        user_max_amount_usdc,
        budget_remaining_usdc,
        pool_available_usdc,
    )
}

public fun main_backstop_budget_usdc(
    main_total_received_usdc: u64,
    main_balance_usdc: u64,
): u64 {
    payout_policy::main_backstop_budget_usdc(main_total_received_usdc, main_balance_usdc)
}

public fun future_reserve_floor_usdc(main_total_received_usdc: u64): u64 {
    payout_policy::future_reserve_floor_usdc(main_total_received_usdc)
}

public fun liquid_reserve_target_usdc(main_total_received_usdc: u64): u64 {
    payout_policy::liquid_reserve_target_usdc(main_total_received_usdc)
}

public fun campaign_budget_claimed_usdc(budget: &CampaignBudget): u64 {
    payout_policy::campaign_budget_claimed_usdc(budget)
}

public fun campaign_budget_remaining_usdc(budget: &CampaignBudget): u64 {
    payout_policy::campaign_budget_remaining_usdc(budget)
}

public fun main_remaining_usdc(budget: &CampaignBudget): u64 {
    payout_policy::main_remaining_usdc(budget)
}

public fun designated_remaining_usdc(budget: &CampaignBudget): u64 {
    payout_policy::designated_remaining_usdc(budget)
}

public fun policy_id(policy: &PayoutPolicy): ID {
    payout_policy::policy_id(policy)
}

public fun min_claim_band(policy: &PayoutPolicy): u8 {
    payout_policy::min_claim_band(policy)
}

public fun program_id(program: &Program): ID {
    program::id(program)
}

public fun campaign_id(campaign: &Campaign): ID {
    program::campaign_id(campaign)
}

public fun program_required_pass_metadata(program: &Program): u64 {
    program::required_pass_metadata(program)
}

public fun program_required_verifier_family(program: &Program): u8 {
    program::required_verifier_family(program)
}

public fun program_payout_policy_id(program: &Program): Option<ID> {
    program::payout_policy_id(program)
}

public fun campaign_claim_start_ms(campaign: &Campaign): u64 {
    program::campaign_claim_start_ms(campaign)
}

public fun campaign_claim_end_ms(campaign: &Campaign): u64 {
    program::campaign_claim_end_ms(campaign)
}

public fun program_status_active(): u8 {
    program::status_active()
}

public fun program_status_inactive(): u8 {
    program::status_inactive()
}

public fun program_status_closed(): u8 {
    program::status_closed()
}

public fun affected_cells_root(disaster_event: &DisasterEvent): vector<u8> {
    disaster_event::affected_cells_root(disaster_event)
}

public fun disaster_event_uid(disaster_event: &DisasterEvent): vector<u8> {
    disaster_event::event_uid(disaster_event)
}

public fun disaster_event_revision(disaster_event: &DisasterEvent): u32 {
    disaster_event::event_revision(disaster_event)
}

public fun occurred_at_ms(disaster_event: &DisasterEvent): u64 {
    disaster_event::occurred_at_ms(disaster_event)
}

public fun disaster_registry_event_count(registry: &DisasterRegistry): u64 {
    disaster_event::disaster_registry_event_count(registry)
}

public fun disaster_event_id(disaster_event: &DisasterEvent): ID {
    disaster_event::disaster_event_id(disaster_event)
}

public fun affected_cell_leaf_hash(leaf: &AffectedCellLeaf): vector<u8> {
    affected_cell::leaf_hash(leaf)
}

public fun verify_affected_cell_proof(
    leaf: &AffectedCellLeaf,
    proof: vector<ProofStep>,
    expected_root: vector<u8>,
): bool {
    affected_cell::verify_proof(leaf, proof, expected_root)
}

public fun affected_cell_h3_index(leaf: &AffectedCellLeaf): u64 {
    affected_cell::h3_index(leaf)
}

public fun affected_cell_band(leaf: &AffectedCellLeaf): u8 {
    affected_cell::cell_band(leaf)
}

public fun affected_cell_event_uid(leaf: &AffectedCellLeaf): vector<u8> {
    affected_cell::event_uid(leaf)
}

public fun affected_cell_event_revision(leaf: &AffectedCellLeaf): u32 {
    affected_cell::event_revision(leaf)
}
