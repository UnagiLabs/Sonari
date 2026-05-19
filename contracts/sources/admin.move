module contracts::admin;

use contracts::donation;
use contracts::pools;
use sui::event;
use sui::vec_set::{Self, VecSet};

const SCOPE_GLOBAL: u8 = 1;
const SCOPE_TARGET: u8 = 2;
const TARGET_KIND_NONE: u8 = 0;

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

fun init(ctx: &mut TxContext) {
    initialize(ctx);
}

fun initialize(ctx: &mut TxContext) {
    let admin_cap = AdminCap { id: object::new(ctx) };
    transfer::transfer(admin_cap, ctx.sender());

    let pause_state = PauseState {
        id: object::new(ctx),
        global_paused: false,
        paused_targets: vec_set::empty(),
    };
    transfer::share_object(pause_state);
}

public fun create_donor_registry(_: &AdminCap, ctx: &mut TxContext) {
    donation::create_donor_registry(ctx);
}

public fun create_main_pool(_: &AdminCap, ctx: &mut TxContext) {
    pools::create_main_pool(ctx);
}

public fun create_designated_pool(
    _: &AdminCap,
    related_id: Option<ID>,
    ctx: &mut TxContext,
) {
    pools::create_designated_pool(related_id, ctx);
}

public fun create_operations_pool(_: &AdminCap, ctx: &mut TxContext) {
    pools::create_operations_pool(ctx);
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
