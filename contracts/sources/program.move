module contracts::program;

use contracts::admin::{Self, AdminCap, PauseState};
use std::option::Option;
use sui::event;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::TxContext;

const STATUS_ACTIVE: u8 = 1;
const STATUS_INACTIVE: u8 = 2;
const STATUS_CLOSED: u8 = 3;

const TARGET_KIND_PROGRAM: u8 = 1;
const TARGET_KIND_CAMPAIGN: u8 = 2;

const EProgramNotActive: u64 = 0;
const ECampaignNotActive: u64 = 1;
const ECampaignProgramMismatch: u64 = 2;

public struct Program has key {
    id: UID,
    program_type: u8,
    required_pass_metadata: u64,
    required_verifier_family: u8,
    payout_policy_id: Option<ID>,
    default_pool_id: Option<ID>,
    status: u8,
    created_at_ms: u64,
}

public struct Campaign has key {
    id: UID,
    program_id: ID,
    campaign_type: u8,
    metadata_hash: vector<u8>,
    pool_id: Option<ID>,
    claim_start_ms: u64,
    claim_end_ms: u64,
    status: u8,
    created_at_ms: u64,
}

public struct ProgramCreated has copy, drop {
    program_id: ID,
    program_type: u8,
    required_pass_metadata: u64,
    required_verifier_family: u8,
    payout_policy_id: Option<ID>,
    default_pool_id: Option<ID>,
    created_at_ms: u64,
    actor: address,
}

public struct CampaignCreated has copy, drop {
    campaign_id: ID,
    program_id: ID,
    campaign_type: u8,
    metadata_hash: vector<u8>,
    pool_id: Option<ID>,
    claim_start_ms: u64,
    claim_end_ms: u64,
    created_at_ms: u64,
    actor: address,
}

public(package) entry fun create_program(
    _: &AdminCap,
    program_type: u8,
    required_pass_metadata: u64,
    required_verifier_family: u8,
    payout_policy_id: Option<ID>,
    default_pool_id: Option<ID>,
    ctx: &mut TxContext,
) {
    let program = Program {
        id: object::new(ctx),
        program_type,
        required_pass_metadata,
        required_verifier_family,
        payout_policy_id,
        default_pool_id,
        status: STATUS_ACTIVE,
        created_at_ms: ctx.epoch_timestamp_ms(),
    };
    let program_id = object::id(&program);

    event::emit(ProgramCreated {
        program_id,
        program_type,
        required_pass_metadata,
        required_verifier_family,
        payout_policy_id,
        default_pool_id,
        created_at_ms: program.created_at_ms,
        actor: ctx.sender(),
    });

    transfer::share_object(program);
}

public(package) entry fun create_campaign(
    _: &AdminCap,
    program: &Program,
    campaign_type: u8,
    metadata_hash: vector<u8>,
    pool_id: Option<ID>,
    claim_start_ms: u64,
    claim_end_ms: u64,
    ctx: &mut TxContext,
) {
    let program_id = object::id(program);
    let campaign = Campaign {
        id: object::new(ctx),
        program_id,
        campaign_type,
        metadata_hash,
        pool_id,
        claim_start_ms,
        claim_end_ms,
        status: STATUS_ACTIVE,
        created_at_ms: ctx.epoch_timestamp_ms(),
    };
    let campaign_id = object::id(&campaign);

    event::emit(CampaignCreated {
        campaign_id,
        program_id,
        campaign_type,
        metadata_hash: campaign.metadata_hash,
        pool_id,
        claim_start_ms,
        claim_end_ms,
        created_at_ms: campaign.created_at_ms,
        actor: ctx.sender(),
    });

    transfer::share_object(campaign);
}

public fun assert_claim_precheck(
    pause_state: &PauseState,
    program: &Program,
    campaign: &Campaign,
) {
    admin::assert_not_globally_paused(pause_state);
    assert!(program.status == STATUS_ACTIVE, EProgramNotActive);
    assert!(campaign.status == STATUS_ACTIVE, ECampaignNotActive);
    assert!(campaign.program_id == object::id(program), ECampaignProgramMismatch);
    admin::assert_target_not_paused(pause_state, object::id(program));
    admin::assert_target_not_paused(pause_state, object::id(campaign));
}

public fun id(program: &Program): ID {
    object::id(program)
}

public fun campaign_id(campaign: &Campaign): ID {
    object::id(campaign)
}

public fun status_active(): u8 {
    STATUS_ACTIVE
}

public fun status_inactive(): u8 {
    STATUS_INACTIVE
}

public fun status_closed(): u8 {
    STATUS_CLOSED
}

public fun target_kind_program(): u8 {
    TARGET_KIND_PROGRAM
}

public fun target_kind_campaign(): u8 {
    TARGET_KIND_CAMPAIGN
}

#[test_only]
public fun set_program_status_for_testing(program: &mut Program, status: u8) {
    program.status = status;
}

#[test_only]
public fun set_campaign_status_for_testing(campaign: &mut Campaign, status: u8) {
    campaign.status = status;
}

#[test_only]
public fun program_created_event_fields(
    event: ProgramCreated,
): (ID, u8, u64, u8, u64, address) {
    let ProgramCreated {
        program_id,
        program_type,
        required_pass_metadata,
        required_verifier_family,
        payout_policy_id: _,
        default_pool_id: _,
        created_at_ms,
        actor,
    } = event;
    (
        program_id,
        program_type,
        required_pass_metadata,
        required_verifier_family,
        created_at_ms,
        actor,
    )
}

#[test_only]
public fun campaign_created_event_fields(
    event: CampaignCreated,
): (ID, ID, u8, vector<u8>, u64, u64, u64, address) {
    let CampaignCreated {
        campaign_id,
        program_id,
        campaign_type,
        metadata_hash,
        pool_id: _,
        claim_start_ms,
        claim_end_ms,
        created_at_ms,
        actor,
    } = event;
    (
        campaign_id,
        program_id,
        campaign_type,
        metadata_hash,
        claim_start_ms,
        claim_end_ms,
        created_at_ms,
        actor,
    )
}
