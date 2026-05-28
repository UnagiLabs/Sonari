module contracts::accessor;

use contracts::admin::{Self, PauseState};
use contracts::affected_cell::{AffectedCellLeaf, ProofStep};
use contracts::claim::{Self, ClaimIndex};
use contracts::disaster_event::{DisasterCampaignBinding, DisasterEvent};
use contracts::donation::{Self, DonorPass, DonorRegistry};
use contracts::identity_registry;
use contracts::identity_result_v1;
use contracts::membership;
use contracts::metadata_verifier;
use contracts::pools::{Self, DesignatedPool, MainPool, OperationsPool};
use contracts::payout_policy::{CampaignBudget, PayoutPolicy};
use contracts::program::{Self, Campaign, Program};
use sui::clock::{Self, Clock};
use sui::coin::Coin;
use usdc::usdc::USDC;

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
    home_cell: u64,
    terms_version: u64,
    signed_statement_hash: vector<u8>,
    ctx: &mut TxContext,
) {
    admin::assert_not_globally_paused(pause_state);
    admin::assert_target_not_paused(pause_state, membership::registry_id(registry));
    membership::register_member(
        registry,
        home_cell,
        terms_version,
        signed_statement_hash,
        ctx,
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
    pass: &membership::MembershipPass,
    clock: &Clock,
    leaf: AffectedCellLeaf,
    proof: vector<ProofStep>,
    designated_pool: &mut DesignatedPool,
    main_pool: &mut MainPool,
    user_max_amount_usdc: u64,
    ctx: &mut TxContext,
) {
    admin::assert_not_globally_paused(pause_state);
    admin::assert_target_not_paused(pause_state, program::id(program));
    admin::assert_target_not_paused(pause_state, program::campaign_id(campaign));
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
        pass,
        clock,
        leaf,
        proof,
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
