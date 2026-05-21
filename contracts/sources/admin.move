module contracts::admin;

use contracts::claim;
use contracts::disaster_event;
use contracts::donation;
use contracts::membership;
use contracts::metadata_verifier;
use contracts::payout_policy;
use contracts::pools;
use contracts::program;
use sui::event;
use sui::vec_set::{Self, VecSet};

const SCOPE_GLOBAL: u8 = 1;
const SCOPE_TARGET: u8 = 2;
const TARGET_KIND_NONE: u8 = 0;
const GENESIS_KIND_ADMIN_CAP: u8 = 1;
const GENESIS_KIND_PAUSE_STATE: u8 = 2;
const GENESIS_KIND_MAIN_POOL: u8 = 3;
const GENESIS_KIND_OPERATIONS_POOL: u8 = 4;
const GENESIS_KIND_DONOR_REGISTRY: u8 = 5;
const GENESIS_KIND_MEMBERSHIP_REGISTRY: u8 = 6;
const GENESIS_KIND_VERIFIER_REGISTRY: u8 = 7;

const EGlobalPaused: u64 = 0;
const ETargetPaused: u64 = 1;

public struct AdminCap has key {
    id: UID,
}

public struct PauseState has key {
    id: UID,
    global_paused: bool,
    paused_targets: VecSet<ID>,
}

public struct Paused has copy, drop {
    scope: u8,
    target_kind: u8,
    target_id: Option<ID>,
    actor: address,
}

public struct Unpaused has copy, drop {
    scope: u8,
    target_kind: u8,
    target_id: Option<ID>,
    actor: address,
}

public struct GenesisObjectCreated has copy, drop {
    object_id: ID,
    object_kind: u8,
    shared: bool,
    created_at_ms: u64,
    actor: address,
}

fun init(ctx: &mut TxContext) {
    initialize(ctx);
}

fun initialize(ctx: &mut TxContext) {
    let admin_cap = AdminCap { id: object::new(ctx) };
    emit_genesis_object(object::id(&admin_cap), GENESIS_KIND_ADMIN_CAP, false, ctx);
    transfer::transfer(admin_cap, ctx.sender());

    let pause_state = PauseState {
        id: object::new(ctx),
        global_paused: false,
        paused_targets: vec_set::empty(),
    };
    emit_genesis_object(object::id(&pause_state), GENESIS_KIND_PAUSE_STATE, true, ctx);
    transfer::share_object(pause_state);

    let main_pool_id = pools::create_main_pool(ctx);
    emit_genesis_object(main_pool_id, GENESIS_KIND_MAIN_POOL, true, ctx);

    let operations_pool_id = pools::create_operations_pool(ctx);
    emit_genesis_object(operations_pool_id, GENESIS_KIND_OPERATIONS_POOL, true, ctx);

    let donor_registry_id = donation::create_donor_registry(ctx);
    emit_genesis_object(donor_registry_id, GENESIS_KIND_DONOR_REGISTRY, true, ctx);

    let membership_registry_id = membership::create_membership_registry(ctx);
    emit_genesis_object(membership_registry_id, GENESIS_KIND_MEMBERSHIP_REGISTRY, true, ctx);

    let verifier_registry_id = metadata_verifier::create_verifier_registry(ctx);
    emit_genesis_object(verifier_registry_id, GENESIS_KIND_VERIFIER_REGISTRY, true, ctx);
}

public fun create_designated_pool(
    _: &AdminCap,
    related_id: Option<ID>,
    ctx: &mut TxContext,
) {
    pools::create_designated_pool(related_id, ctx);
}

public fun create_program(
    _: &AdminCap,
    program_type: u8,
    required_pass_metadata: u64,
    required_verifier_family: u8,
    payout_policy_id: Option<ID>,
    default_pool_id: Option<ID>,
    ctx: &mut TxContext,
) {
    program::create_program(
        program_type,
        required_pass_metadata,
        required_verifier_family,
        payout_policy_id,
        default_pool_id,
        ctx,
    );
}

public fun create_campaign(
    _: &AdminCap,
    program: &program::Program,
    campaign_type: u8,
    metadata_hash: vector<u8>,
    pool_id: Option<ID>,
    claim_start_ms: u64,
    claim_end_ms: u64,
    ctx: &mut TxContext,
) {
    program::create_campaign(
        program,
        campaign_type,
        metadata_hash,
        pool_id,
        claim_start_ms,
        claim_end_ms,
        ctx,
    );
}

public fun create_default_disaster_policy(cap: &AdminCap, ctx: &mut TxContext) {
    let _ = cap;
    payout_policy::create_default_disaster_policy(ctx);
}

public fun create_claim_index(cap: &AdminCap, ctx: &mut TxContext) {
    let _ = cap;
    claim::create_claim_index(ctx);
}

public fun create_disaster_registry(cap: &AdminCap, ctx: &mut TxContext) {
    let _ = cap;
    disaster_event::create_disaster_registry(ctx);
}

public fun bind_disaster_campaign(
    cap: &AdminCap,
    registry: &mut disaster_event::DisasterRegistry,
    campaign: &program::Campaign,
    disaster_event: &disaster_event::DisasterEvent,
    ctx: &mut TxContext,
) {
    let _ = cap;
    disaster_event::bind_campaign(registry, campaign, disaster_event, ctx);
}

public fun open_campaign_budget_from_main(
    cap: &AdminCap,
    program: &program::Program,
    campaign: &program::Campaign,
    main_pool: &pools::MainPool,
    ctx: &mut TxContext,
) {
    let _ = cap;
    payout_policy::open_campaign_budget_from_main(program, campaign, main_pool, ctx);
}

public fun open_campaign_budget_from_designated_and_main(
    cap: &AdminCap,
    program: &program::Program,
    campaign: &program::Campaign,
    designated_pool: &pools::DesignatedPool,
    main_pool: &pools::MainPool,
    ctx: &mut TxContext,
) {
    let _ = cap;
    payout_policy::open_campaign_budget_from_designated_and_main(
        program,
        campaign,
        designated_pool,
        main_pool,
        ctx,
    );
}

public fun assert_claim_precheck(
    pause_state: &PauseState,
    program: &program::Program,
    campaign: &program::Campaign,
) {
    assert_not_globally_paused(pause_state);
    assert_target_not_paused(pause_state, program::id(program));
    assert_target_not_paused(pause_state, program::campaign_id(campaign));
    program::assert_claim_precheck(program, campaign);
}

public fun add_verifier_key(
    _: &AdminCap,
    registry: &mut metadata_verifier::VerifierRegistry,
    verifier_family: u8,
    verifier_version: u64,
    public_key: vector<u8>,
    ctx: &mut TxContext,
) {
    metadata_verifier::add_verifier_key(
        registry,
        verifier_family,
        verifier_version,
        public_key,
        ctx,
    );
}

public fun disable_verifier_key(
    _: &AdminCap,
    registry: &mut metadata_verifier::VerifierRegistry,
    public_key: vector<u8>,
    ctx: &mut TxContext,
) {
    metadata_verifier::disable_verifier_key(registry, public_key, ctx);
}

public fun pause_global(
    _: &AdminCap,
    pause_state: &mut PauseState,
    ctx: &mut TxContext,
) {
    pause_state.global_paused = true;
    event::emit(Paused {
        scope: SCOPE_GLOBAL,
        target_kind: TARGET_KIND_NONE,
        target_id: option::none(),
        actor: ctx.sender(),
    });
}

public fun unpause_global(
    _: &AdminCap,
    pause_state: &mut PauseState,
    ctx: &mut TxContext,
) {
    pause_state.global_paused = false;
    event::emit(Unpaused {
        scope: SCOPE_GLOBAL,
        target_kind: TARGET_KIND_NONE,
        target_id: option::none(),
        actor: ctx.sender(),
    });
}

public fun pause_target(
    _: &AdminCap,
    pause_state: &mut PauseState,
    target_kind: u8,
    target_id: ID,
    ctx: &mut TxContext,
) {
    if (!pause_state.paused_targets.contains(&target_id)) {
        pause_state.paused_targets.insert(target_id);
    };
    event::emit(Paused {
        scope: SCOPE_TARGET,
        target_kind,
        target_id: option::some(target_id),
        actor: ctx.sender(),
    });
}

public fun unpause_target(
    _: &AdminCap,
    pause_state: &mut PauseState,
    target_kind: u8,
    target_id: ID,
    ctx: &mut TxContext,
) {
    if (pause_state.paused_targets.contains(&target_id)) {
        pause_state.paused_targets.remove(&target_id);
    };
    event::emit(Unpaused {
        scope: SCOPE_TARGET,
        target_kind,
        target_id: option::some(target_id),
        actor: ctx.sender(),
    });
}

public fun is_global_paused(pause_state: &PauseState): bool {
    pause_state.global_paused
}

public fun is_target_paused(pause_state: &PauseState, target_id: ID): bool {
    pause_state.paused_targets.contains(&target_id)
}

public fun assert_not_globally_paused(pause_state: &PauseState) {
    assert!(!is_global_paused(pause_state), EGlobalPaused);
}

public fun assert_target_not_paused(pause_state: &PauseState, target_id: ID) {
    assert!(!is_target_paused(pause_state, target_id), ETargetPaused);
}

public fun paused_target_count(pause_state: &PauseState): u64 {
    pause_state.paused_targets.length()
}

public fun scope_global(): u8 {
    SCOPE_GLOBAL
}

public fun scope_target(): u8 {
    SCOPE_TARGET
}

public fun target_kind_none(): u8 {
    TARGET_KIND_NONE
}

public fun genesis_kind_admin_cap(): u8 {
    GENESIS_KIND_ADMIN_CAP
}

public fun genesis_kind_pause_state(): u8 {
    GENESIS_KIND_PAUSE_STATE
}

public fun genesis_kind_main_pool(): u8 {
    GENESIS_KIND_MAIN_POOL
}

public fun genesis_kind_operations_pool(): u8 {
    GENESIS_KIND_OPERATIONS_POOL
}

public fun genesis_kind_donor_registry(): u8 {
    GENESIS_KIND_DONOR_REGISTRY
}

public fun genesis_kind_membership_registry(): u8 {
    GENESIS_KIND_MEMBERSHIP_REGISTRY
}

public fun genesis_kind_verifier_registry(): u8 {
    GENESIS_KIND_VERIFIER_REGISTRY
}

fun emit_genesis_object(object_id: ID, object_kind: u8, shared: bool, ctx: &TxContext) {
    event::emit(GenesisObjectCreated {
        object_id,
        object_kind,
        shared,
        created_at_ms: ctx.epoch_timestamp_ms(),
        actor: ctx.sender(),
    });
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    initialize(ctx);
}

#[test_only]
public fun paused_event_fields(event: Paused): (u8, u8, Option<ID>, address) {
    let Paused {
        scope,
        target_kind,
        target_id,
        actor,
    } = event;
    (scope, target_kind, target_id, actor)
}

#[test_only]
public fun unpaused_event_fields(event: Unpaused): (u8, u8, Option<ID>, address) {
    let Unpaused {
        scope,
        target_kind,
        target_id,
        actor,
    } = event;
    (scope, target_kind, target_id, actor)
}

#[test_only]
public fun genesis_object_created_event_fields(
    event: GenesisObjectCreated,
): (ID, u8, bool, u64, address) {
    let GenesisObjectCreated {
        object_id,
        object_kind,
        shared,
        created_at_ms,
        actor,
    } = event;
    (object_id, object_kind, shared, created_at_ms, actor)
}
