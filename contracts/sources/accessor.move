module contracts::accessor;

use contracts::admin::{Self, PauseState};
use contracts::affected_cell::{Self, AffectedCellLeaf, ProofStep};
use contracts::allowed_residence_cell;
use contracts::claim::{Self, ClaimIndex};
use contracts::disaster_event::{Self, DisasterCampaignBinding, DisasterEvent, DisasterRegistry};
use contracts::donation::{Self, DonorPass, DonorRegistry};
use contracts::identity_registry::{Self, IdentityRegistry};
use contracts::identity_result_v1;
use contracts::membership;
use contracts::metadata_verifier;
use contracts::pools::{Self, DesignatedPool, MainPool, OperationsPool};
use contracts::payout_policy::{CampaignBudget, PayoutPolicy};
use contracts::program::{Self, Campaign, Program};
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

public fun donation_record_summary(
    pass: &DonorPass,
    donation_index: u64,
): (u64, u8, Option<ID>, Option<ID>, ID, u64, vector<u8>, u64) {
    donation::donation_record_summary(pass, donation_index)
}
