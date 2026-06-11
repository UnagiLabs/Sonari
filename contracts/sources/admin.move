module contracts::admin;

use contracts::campaign as campaign_v2;
use contracts::category_pool;
use contracts::allowed_residence_cell;
use contracts::disaster_event;
use contracts::donation;
use contracts::identity_registry;
use contracts::membership;
use contracts::metadata_verifier;
use contracts::pools;
use std::string::{Self, String};
use sui::display;
use sui::event;
use sui::package::{Self, Publisher};
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
const GENESIS_KIND_IDENTITY_REGISTRY: u8 = 9;
const GENESIS_KIND_CATEGORY_REGISTRY: u8 = 10;
const GENESIS_KIND_EARTHQUAKE_POOL: u8 = 11;

const EGlobalPaused: u64 = 0;
const ETargetPaused: u64 = 1;
const EAllowedResidenceCellRegistryAlreadyCreated: u64 = 2;

public struct ADMIN has drop {}

public struct AdminCap has key {
    id: UID,
    allowed_residence_cell_registry_id: Option<ID>,
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

fun init(otw: ADMIN, ctx: &mut TxContext) {
    initialize_with_displays(package::claim(otw, ctx), ctx);
}

fun initialize(ctx: &mut TxContext) {
    let admin_cap = AdminCap {
        id: object::new(ctx),
        allowed_residence_cell_registry_id: option::none(),
    };
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

    // CategoryRegistry は ClaimIndex と同じ counter 位置に置き、IdentityRegistry の ID を保持する
    let mut category_registry = category_pool::new_category_registry(ctx);
    let category_registry_id = object::id(&category_registry);
    emit_genesis_object(category_registry_id, GENESIS_KIND_CATEGORY_REGISTRY, true, ctx);

    let identity_registry_id = identity_registry::create_identity_registry(ctx);
    emit_genesis_object(identity_registry_id, GENESIS_KIND_IDENTITY_REGISTRY, true, ctx);

    let earthquake_pool_id =
        category_pool::create_category_pool(&mut category_registry, category_pool::category_earthquake(), ctx);
    emit_genesis_object(earthquake_pool_id, GENESIS_KIND_EARTHQUAKE_POOL, true, ctx);

    category_pool::share_category_registry(category_registry);
}

#[allow(lint(self_transfer))]
fun initialize_with_displays(publisher: Publisher, ctx: &mut TxContext) {
    initialize(ctx);
    create_initial_displays(&publisher, ctx);
    transfer::public_transfer(publisher, ctx.sender());
}

fun create_initial_displays(publisher: &Publisher, ctx: &mut TxContext) {
    let mut membership_display = display::new_with_fields<membership::MembershipPass>(
        publisher,
        display_field_keys(),
        vector[
            b"Sonari Passport".to_string(),
            b"Status: {status_label}.".to_string(),
            b"https://raw.githubusercontent.com/UnagiLabs/Sonari/main/docs/assets/display/membership-pass.svg".to_string(),
            b"https://app.sonari.xyz/passport/{id}".to_string(),
        ],
        ctx,
    );
    display::update_version(&mut membership_display);
    transfer::public_freeze_object(membership_display);

    let mut donor_display = display::new_with_fields<donation::DonorPass>(
        publisher,
        display_field_keys(),
        vector[
            string::utf8(x"536f6e61726920446f6e6f72205061737320e28094207b746965725f6c6162656c7d"),
            b"Total donated: {total_donated_usdc} USDC units across {donation_count} donations.".to_string(),
            b"https://raw.githubusercontent.com/UnagiLabs/Sonari/main/docs/assets/display/donor-pass.svg".to_string(),
            b"https://app.sonari.xyz/donor/{id}".to_string(),
        ],
        ctx,
    );
    display::update_version(&mut donor_display);
    transfer::public_freeze_object(donor_display);

    let mut disaster_display = display::new_with_fields<disaster_event::DisasterEvent>(
        publisher,
        display_field_keys(),
        vector[
            b"{title}".to_string(),
            b"{hazard_label} in {region}. Verified disaster event.".to_string(),
            b"https://raw.githubusercontent.com/UnagiLabs/Sonari/main/docs/assets/display/disaster-event.svg".to_string(),
            b"https://app.sonari.xyz/disaster/{id}".to_string(),
        ],
        ctx,
    );
    display::update_version(&mut disaster_display);
    transfer::public_freeze_object(disaster_display);
}

fun display_field_keys(): vector<String> {
    vector[
        b"name".to_string(),
        b"description".to_string(),
        b"image_url".to_string(),
        b"link".to_string(),
    ]
}

public fun create_category_pool(
    _: &AdminCap,
    registry: &mut category_pool::CategoryRegistry,
    category: u8,
    ctx: &mut TxContext,
): ID {
    category_pool::create_category_pool(registry, category, ctx)
}

public fun exclude_recipient(
    _: &AdminCap,
    campaign: &mut campaign_v2::Campaign,
    pass_lineage_id: ID,
    reason_code: u8,
    _ctx: &mut TxContext,
) {
    campaign_v2::exclude_recipient_internal(
        campaign,
        pass_lineage_id,
        reason_code,
        0,
        _ctx,
    );
}

public fun create_disaster_registry(cap: &AdminCap, ctx: &mut TxContext): ID {
    let _ = cap;
    disaster_event::create_disaster_registry(ctx)
}

public fun spend_operations(
    _: &AdminCap,
    ops_pool: &mut pools::OperationsPool,
    amount: u64,
    recipient: address,
    reason_code: u8,
    ctx: &mut TxContext,
) {
    let coin = pools::spend_from_operations(ops_pool, amount, recipient, reason_code, ctx);
    transfer::public_transfer(coin, recipient);
}

public fun migrate_main_pool(
    _: &AdminCap,
    pool: &mut pools::MainPool,
    new_version: u64,
    ctx: &mut TxContext,
) {
    let _ = ctx;
    pools::migrate_main_pool_to_version(pool, new_version);
}

public fun migrate_operations_pool(
    _: &AdminCap,
    pool: &mut pools::OperationsPool,
    new_version: u64,
    ctx: &mut TxContext,
) {
    let _ = ctx;
    pools::migrate_operations_pool_to_version(pool, new_version);
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

public fun create_earthquake_verifier_config(
    _: &AdminCap,
    registry: &mut metadata_verifier::VerifierRegistry,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &mut TxContext,
) {
    metadata_verifier::create_earthquake_verifier_config(registry, pcr0, pcr1, pcr2, ctx);
}

public fun update_earthquake_verifier_config_pcrs(
    _: &AdminCap,
    registry: &mut metadata_verifier::VerifierRegistry,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &mut TxContext,
) {
    metadata_verifier::update_earthquake_verifier_config_pcrs(
        registry,
        pcr0,
        pcr1,
        pcr2,
        ctx,
    );
}

public fun disable_earthquake_verifier_config(
    _: &AdminCap,
    registry: &mut metadata_verifier::VerifierRegistry,
    ctx: &mut TxContext,
) {
    metadata_verifier::disable_earthquake_verifier_config(registry, ctx);
}

public fun create_identity_verifier_config(
    _: &AdminCap,
    registry: &mut metadata_verifier::VerifierRegistry,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &mut TxContext,
) {
    metadata_verifier::create_identity_verifier_config(registry, pcr0, pcr1, pcr2, ctx);
}

public fun update_identity_verifier_config_pcrs(
    _: &AdminCap,
    registry: &mut metadata_verifier::VerifierRegistry,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &mut TxContext,
) {
    metadata_verifier::update_identity_verifier_config_pcrs(
        registry,
        pcr0,
        pcr1,
        pcr2,
        ctx,
    );
}

public fun disable_identity_verifier_config(
    _: &AdminCap,
    registry: &mut metadata_verifier::VerifierRegistry,
    ctx: &mut TxContext,
) {
    metadata_verifier::disable_identity_verifier_config(registry, ctx);
}

public fun create_census_verifier_config(
    _: &AdminCap,
    registry: &mut metadata_verifier::VerifierRegistry,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &mut TxContext,
) {
    metadata_verifier::create_census_verifier_config(registry, pcr0, pcr1, pcr2, ctx);
}

public fun update_census_verifier_config_pcrs(
    _: &AdminCap,
    registry: &mut metadata_verifier::VerifierRegistry,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &mut TxContext,
) {
    metadata_verifier::update_census_verifier_config_pcrs(
        registry,
        pcr0,
        pcr1,
        pcr2,
        ctx,
    );
}

public fun disable_census_verifier_config(
    _: &AdminCap,
    registry: &mut metadata_verifier::VerifierRegistry,
    ctx: &mut TxContext,
) {
    metadata_verifier::disable_census_verifier_config(registry, ctx);
}

public fun create_allowed_residence_cell_registry(
    cap: &mut AdminCap,
    root: vector<u8>,
    geo_resolution: u8,
    allowlist_version: u64,
    source_hash: vector<u8>,
    ctx: &mut TxContext,
): ID {
    assert!(
        !option::is_some(&cap.allowed_residence_cell_registry_id),
        EAllowedResidenceCellRegistryAlreadyCreated,
    );
    let registry_id = allowed_residence_cell::create_registry(
        root,
        geo_resolution,
        allowlist_version,
        source_hash,
        ctx,
    );
    cap.allowed_residence_cell_registry_id = option::some(registry_id);
    registry_id
}

public fun update_allowed_residence_cell_root(
    _: &AdminCap,
    registry: &mut allowed_residence_cell::AllowedResidenceCellRegistry,
    root: vector<u8>,
    geo_resolution: u8,
    allowlist_version: u64,
    source_hash: vector<u8>,
    ctx: &mut TxContext,
) {
    allowed_residence_cell::update_root(
        registry,
        root,
        geo_resolution,
        allowlist_version,
        source_hash,
        ctx,
    );
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

public(package) fun is_global_paused(pause_state: &PauseState): bool {
    pause_state.global_paused
}

public(package) fun is_target_paused(pause_state: &PauseState, target_id: ID): bool {
    pause_state.paused_targets.contains(&target_id)
}

public(package) fun assert_not_globally_paused(pause_state: &PauseState) {
    assert!(!is_global_paused(pause_state), EGlobalPaused);
}

public(package) fun assert_target_not_paused(pause_state: &PauseState, target_id: ID) {
    assert!(!is_target_paused(pause_state, target_id), ETargetPaused);
}

public(package) fun paused_target_count(pause_state: &PauseState): u64 {
    pause_state.paused_targets.length()
}

public(package) fun scope_global(): u8 {
    SCOPE_GLOBAL
}

public(package) fun scope_target(): u8 {
    SCOPE_TARGET
}

public(package) fun target_kind_none(): u8 {
    TARGET_KIND_NONE
}

public(package) fun genesis_kind_admin_cap(): u8 {
    GENESIS_KIND_ADMIN_CAP
}

public(package) fun genesis_kind_pause_state(): u8 {
    GENESIS_KIND_PAUSE_STATE
}

public(package) fun genesis_kind_main_pool(): u8 {
    GENESIS_KIND_MAIN_POOL
}

public(package) fun genesis_kind_operations_pool(): u8 {
    GENESIS_KIND_OPERATIONS_POOL
}

public(package) fun genesis_kind_donor_registry(): u8 {
    GENESIS_KIND_DONOR_REGISTRY
}

public(package) fun genesis_kind_membership_registry(): u8 {
    GENESIS_KIND_MEMBERSHIP_REGISTRY
}

public(package) fun genesis_kind_verifier_registry(): u8 {
    GENESIS_KIND_VERIFIER_REGISTRY
}

public(package) fun genesis_kind_identity_registry(): u8 {
    GENESIS_KIND_IDENTITY_REGISTRY
}

public(package) fun genesis_kind_category_registry(): u8 {
    GENESIS_KIND_CATEGORY_REGISTRY
}

public(package) fun genesis_kind_earthquake_pool(): u8 {
    GENESIS_KIND_EARTHQUAKE_POOL
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
public fun init_with_displays_for_testing(ctx: &mut TxContext) {
    initialize_with_displays(package::test_claim(ADMIN {}, ctx), ctx);
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
