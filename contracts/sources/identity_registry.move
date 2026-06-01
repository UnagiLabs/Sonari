module contracts::identity_registry;

use contracts::identity_result_v1::{Self, IdentityVerificationResult};
use contracts::membership::{Self, MembershipPass};
use sui::address;
use sui::dynamic_field;
use sui::event;

const PROVIDER_KYC: u8 = 1;
const PROVIDER_WORLD_ID: u8 = 2;
const REGISTRY_KIND_IDENTITY: u8 = 4;
const TARGET_KIND_IDENTITY_REGISTRY: u8 = 8;

const EUnknownIdentityProvider: u64 = 0;
const EIdentityKeyAlreadyBound: u64 = 1;
const EIdentityRegistryMismatch: u64 = 2;
const EMembershipIdMismatch: u64 = 3;
const EOwnerMismatch: u64 = 4;
const EIdentityKeyNotBound: u64 = 5;

public struct IdentityRegistry has key {
    id: UID,
    binding_count: u64,
}

public struct IdentityKey has copy, drop, store {
    provider: u8,
    duplicate_key_hash: vector<u8>,
}

public struct RegistryCreated has copy, drop {
    registry_id: ID,
    registry_kind: u8,
    created_at_ms: u64,
    actor: address,
}

public(package) fun create_identity_registry(ctx: &mut TxContext): ID {
    let registry = new_registry(ctx);
    let registry_id = object::id(&registry);
    event::emit(RegistryCreated {
        registry_id,
        registry_kind: REGISTRY_KIND_IDENTITY,
        created_at_ms: ctx.epoch_timestamp_ms(),
        actor: ctx.sender(),
    });
    transfer::share_object(registry);
    registry_id
}

public(package) fun bind_duplicate_key(
    registry: &mut IdentityRegistry,
    pass: &MembershipPass,
    provider: u8,
    duplicate_key_hash: vector<u8>,
) {
    assert_known_provider(provider);
    let pass_lineage_id = membership::membership_pass_lineage_id(pass);
    let key = IdentityKey {
        provider,
        duplicate_key_hash,
    };

    if (dynamic_field::exists_with_type<IdentityKey, ID>(&registry.id, key)) {
        let bound_pass_lineage_id = dynamic_field::borrow<IdentityKey, ID>(&registry.id, key);
        assert!(*bound_pass_lineage_id == pass_lineage_id, EIdentityKeyAlreadyBound);
    } else {
        dynamic_field::add(&mut registry.id, key, pass_lineage_id);
        registry.binding_count = registry.binding_count + 1;
    };
}

public(package) fun assert_duplicate_key_bound_to_pass(
    registry: &IdentityRegistry,
    pass: &MembershipPass,
    provider: u8,
    duplicate_key_hash: vector<u8>,
) {
    assert_known_provider(provider);
    let pass_lineage_id = membership::membership_pass_lineage_id(pass);
    let key = IdentityKey {
        provider,
        duplicate_key_hash,
    };
    assert!(
        dynamic_field::exists_with_type<IdentityKey, ID>(&registry.id, key),
        EIdentityKeyNotBound,
    );
    let bound_pass_lineage_id = dynamic_field::borrow<IdentityKey, ID>(&registry.id, key);
    assert!(*bound_pass_lineage_id == pass_lineage_id, EIdentityKeyAlreadyBound);
}

public(package) fun apply_identity_verification_result(
    registry: &mut IdentityRegistry,
    membership_registry: &membership::MembershipRegistry,
    pass: &mut MembershipPass,
    result: &IdentityVerificationResult,
    applied_at_ms: u64,
) {
    let registry_id = object::id(registry);
    assert!(
        identity_result_v1::registry_id(result) == object::id_to_bytes(&registry_id),
        EIdentityRegistryMismatch,
    );
    let pass_id = object::id(pass);
    assert!(
        identity_result_v1::membership_id(result) == object::id_to_bytes(&pass_id),
        EMembershipIdMismatch,
    );
    let pass_owner = membership::membership_pass_owner(pass);
    assert!(
        identity_result_v1::owner(result) == address::to_bytes(pass_owner),
        EOwnerMismatch,
    );

    membership::assert_current_pass_precheck(membership_registry, pass, pass_owner);
    bind_duplicate_key(
        registry,
        pass,
        identity_result_v1::provider(result),
        identity_result_v1::duplicate_key_hash(result),
    );
    membership::apply_identity_verification(
        pass,
        identity_result_v1::provider(result),
        applied_at_ms,
        identity_result_v1::expires_at_ms(result),
        identity_result_v1::terms_version(result),
        identity_result_v1::signed_statement_hash(result),
    );
}

public fun registry_id(registry: &IdentityRegistry): ID {
    object::id(registry)
}

public fun registry_kind_identity(): u8 {
    REGISTRY_KIND_IDENTITY
}

public fun target_kind_identity_registry(): u8 {
    TARGET_KIND_IDENTITY_REGISTRY
}

public fun provider_kyc(): u8 {
    PROVIDER_KYC
}

public fun provider_world_id(): u8 {
    PROVIDER_WORLD_ID
}

fun new_registry(ctx: &mut TxContext): IdentityRegistry {
    IdentityRegistry {
        id: object::new(ctx),
        binding_count: 0,
    }
}

fun assert_known_provider(provider: u8) {
    assert!(
        provider == PROVIDER_KYC || provider == PROVIDER_WORLD_ID,
        EUnknownIdentityProvider,
    );
}

#[test_only]
public fun create_identity_registry_for_testing(ctx: &mut TxContext): IdentityRegistry {
    new_registry(ctx)
}

#[test_only]
public fun destroy_identity_registry_for_testing(registry: IdentityRegistry) {
    let IdentityRegistry { id, binding_count } = registry;
    assert!(binding_count == 0);
    id.delete();
}

#[test_only]
public fun binding_count_for_testing(registry: &IdentityRegistry): u64 {
    registry.binding_count
}

#[test_only]
public fun bound_pass_lineage_id_for_testing(
    registry: &IdentityRegistry,
    provider: u8,
    duplicate_key_hash: vector<u8>,
): ID {
    let key = IdentityKey {
        provider,
        duplicate_key_hash,
    };
    assert!(
        dynamic_field::exists_with_type<IdentityKey, ID>(&registry.id, key),
        EIdentityKeyAlreadyBound,
    );
    *dynamic_field::borrow<IdentityKey, ID>(&registry.id, key)
}

#[test_only]
public fun remove_binding_for_testing(
    registry: &mut IdentityRegistry,
    provider: u8,
    duplicate_key_hash: vector<u8>,
) {
    let key = IdentityKey {
        provider,
        duplicate_key_hash,
    };
    assert!(
        dynamic_field::exists_with_type<IdentityKey, ID>(&registry.id, key),
        EIdentityKeyAlreadyBound,
    );
    let _ = dynamic_field::remove<IdentityKey, ID>(&mut registry.id, key);
    registry.binding_count = registry.binding_count - 1;
}

#[test_only]
public fun registry_created_event_fields(
    event: RegistryCreated,
): (ID, u8, u64, address) {
    let RegistryCreated {
        registry_id,
        registry_kind,
        created_at_ms,
        actor,
    } = event;
    (registry_id, registry_kind, created_at_ms, actor)
}
