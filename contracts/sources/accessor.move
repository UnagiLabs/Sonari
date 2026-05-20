module contracts::accessor;

use contracts::admin::{Self, PauseState};
use contracts::affected_cell::{AffectedCellLeaf, ProofStep};
use contracts::claim::{Self, ClaimIndex, EligibilityResult};
use contracts::disaster_event::{DisasterCampaignBinding, DisasterEvent};
use contracts::donation::{Self, DonorPass, DonorRegistry};
use contracts::membership;
use contracts::metadata_verifier::{
    Self,
    ResidenceMetadataUpdateMessage,
    StudentMetadataUpdateMessage,
    VerifierRegistry,
};
use contracts::pools::{Self, DesignatedPool, MainPool, OperationsPool};
use contracts::payout_policy::{CampaignBudget, PayoutPolicy};
use contracts::program::{Campaign, Program};
use sui::clock::Clock;
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

public fun register_member_usdc(
    pause_state: &PauseState,
    registry: &mut membership::MembershipRegistry,
    operations_pool: &mut OperationsPool,
    fee: Coin<USDC>,
    payout_address: address,
    ctx: &mut TxContext,
) {
    admin::assert_not_globally_paused(pause_state);
    admin::assert_target_not_paused(pause_state, pools::operations_pool_id(operations_pool));
    admin::assert_target_not_paused(pause_state, membership::registry_id(registry));
    membership::register_member_usdc(registry, operations_pool, fee, payout_address, ctx);
}

public fun update_residence_metadata(
    pause_state: &PauseState,
    registry: &VerifierRegistry,
    pass: &mut membership::MembershipPass,
    clock: &Clock,
    message: ResidenceMetadataUpdateMessage,
    signature: vector<u8>,
    public_key: vector<u8>,
    ctx: &mut TxContext,
) {
    admin::assert_not_globally_paused(pause_state);
    admin::assert_target_not_paused(pause_state, metadata_verifier::registry_id(registry));
    metadata_verifier::verify_and_update_residence_metadata(
        registry,
        pass,
        clock,
        message,
        signature,
        public_key,
        ctx,
    );
}

public fun update_student_metadata(
    pause_state: &PauseState,
    registry: &VerifierRegistry,
    pass: &mut membership::MembershipPass,
    clock: &Clock,
    message: StudentMetadataUpdateMessage,
    signature: vector<u8>,
    public_key: vector<u8>,
    ctx: &mut TxContext,
) {
    admin::assert_not_globally_paused(pause_state);
    admin::assert_target_not_paused(pause_state, metadata_verifier::registry_id(registry));
    metadata_verifier::verify_and_update_student_metadata(
        registry,
        pass,
        clock,
        message,
        signature,
        public_key,
        ctx,
    );
}

public fun claim_usdc(
    pause_state: &PauseState,
    index: &mut ClaimIndex,
    registry: &membership::MembershipRegistry,
    program: &Program,
    campaign: &Campaign,
    policy: &PayoutPolicy,
    budget: &mut CampaignBudget,
    pass: &membership::MembershipPass,
    main_pool: &mut MainPool,
    eligibility: EligibilityResult,
    ctx: &mut TxContext,
) {
    claim::claim_usdc(
        pause_state,
        index,
        registry,
        program,
        campaign,
        policy,
        budget,
        pass,
        main_pool,
        eligibility,
        ctx,
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
    leaf: AffectedCellLeaf,
    proof: vector<ProofStep>,
    designated_pool: &mut DesignatedPool,
    main_pool: &mut MainPool,
    user_max_amount_usdc: u64,
    ctx: &mut TxContext,
) {
    claim::claim_disaster_usdc(
        pause_state,
        index,
        registry,
        program,
        campaign,
        policy,
        budget,
        binding,
        disaster_event,
        pass,
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
