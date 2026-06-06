module contracts::identity_registry;

use contracts::identity_result_v1::{Self, IdentityVerificationResult};
use contracts::membership;
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
const EIdentityProviderReplay: u64 = 6;
const EIdentityRecordNotFound: u64 = 7;
const EIdentityRecordOwnerMismatch: u64 = 8;
const EIdentityVerificationExpired: u64 = 9;
const EIdentityProviderNotVerified: u64 = 10;
const EMembershipRecordNotActive: u64 = 11;

public struct IdentityRegistry has key {
    id: UID,
    binding_count: u64,
}

public struct IdentityKey has copy, drop, store {
    provider: u8,
    duplicate_key_hash: vector<u8>,
}

public struct IdentityVerificationRecord has copy, drop, store {
    owner: address,
    provider_mask: u8,
    verified_at_ms: u64,
    expires_at_ms: u64,
    terms_version: u64,
    signed_statement_hash: vector<u8>,
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
    pass_lineage_id: ID,
    provider: u8,
    duplicate_key_hash: vector<u8>,
) {
    assert_known_provider(provider);
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
    pass_lineage_id: ID,
    provider: u8,
    duplicate_key_hash: vector<u8>,
) {
    assert_known_provider(provider);
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
    result: &IdentityVerificationResult,
    applied_at_ms: u64,
) {
    // 1. registry_id 照合
    let registry_id = object::id(registry);
    assert!(
        identity_result_v1::registry_id(result) == object::id_to_bytes(&registry_id),
        EIdentityRegistryMismatch,
    );
    // 2. payload の owner(vector<u8>) を address に変換
    let owner_addr = address::from_bytes(identity_result_v1::owner(result));
    // 3. owner から lineage を解決（owner 未登録なら membership 側 ERegistryRecordNotFound で abort）
    let lineage = membership::membership_owner_lineage_id(membership_registry, owner_addr);
    // 4. record summary を取得
    let (_rec_lineage, current_pass_id, current_owner, status, _issued, _updated) =
        membership::membership_record_summary(membership_registry, lineage);
    // 5. membership_id 照合
    assert!(
        identity_result_v1::membership_id(result) == object::id_to_bytes(&current_pass_id),
        EMembershipIdMismatch,
    );
    // 6. owner 整合（防御的）
    assert!(current_owner == owner_addr, EOwnerMismatch);
    // 7. status active 確認
    assert!(status == membership::status_active(), EMembershipRecordNotActive);
    // 8. dedup 登録
    bind_duplicate_key(
        registry,
        lineage,
        identity_result_v1::provider(result),
        identity_result_v1::duplicate_key_hash(result),
    );
    // 9. record 保存
    record_identity_verification(
        registry,
        lineage,
        owner_addr,
        identity_result_v1::provider(result),
        applied_at_ms,
        identity_result_v1::expires_at_ms(result),
        identity_result_v1::terms_version(result),
        identity_result_v1::signed_statement_hash(result),
    );
}

public(package) fun record_identity_verification(
    registry: &mut IdentityRegistry,
    pass_lineage_id: ID,
    owner: address,
    provider: u8,
    verified_at_ms: u64,
    expires_at_ms: u64,
    terms_version: u64,
    signed_statement_hash: vector<u8>,
) {
    assert_known_provider(provider);
    if (dynamic_field::exists_with_type<ID, IdentityVerificationRecord>(&registry.id, pass_lineage_id)) {
        let record = dynamic_field::borrow_mut<ID, IdentityVerificationRecord>(
            &mut registry.id,
            pass_lineage_id,
        );
        assert!(record.owner == owner, EIdentityRecordOwnerMismatch);
        assert!(record.provider_mask & provider == 0, EIdentityProviderReplay);
        record.provider_mask = record.provider_mask + provider;
        record.verified_at_ms = verified_at_ms;
        record.expires_at_ms = expires_at_ms;
        record.terms_version = terms_version;
        record.signed_statement_hash = signed_statement_hash;
    } else {
        dynamic_field::add(
            &mut registry.id,
            pass_lineage_id,
            IdentityVerificationRecord {
                owner,
                provider_mask: provider,
                verified_at_ms,
                expires_at_ms,
                terms_version,
                signed_statement_hash,
            },
        );
    };
}

public(package) fun assert_identity_verified(
    registry: &IdentityRegistry,
    pass_lineage_id: ID,
    owner: address,
    provider: u8,
    now_ms: u64,
) {
    assert!(
        dynamic_field::exists_with_type<ID, IdentityVerificationRecord>(&registry.id, pass_lineage_id),
        EIdentityRecordNotFound,
    );
    let record = dynamic_field::borrow<ID, IdentityVerificationRecord>(&registry.id, pass_lineage_id);
    assert!(record.owner == owner, EIdentityRecordOwnerMismatch);
    assert!(record.provider_mask & provider != 0, EIdentityProviderNotVerified);
    assert!(now_ms < record.expires_at_ms, EIdentityVerificationExpired);
}

public(package) fun registry_id(registry: &IdentityRegistry): ID {
    object::id(registry)
}

public(package) fun registry_kind_identity(): u8 {
    REGISTRY_KIND_IDENTITY
}

public(package) fun target_kind_identity_registry(): u8 {
    TARGET_KIND_IDENTITY_REGISTRY
}

public(package) fun provider_kyc(): u8 {
    PROVIDER_KYC
}

public(package) fun provider_world_id(): u8 {
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
public fun identity_verification_record_for_testing(
    registry: &IdentityRegistry,
    pass_lineage_id: ID,
): (address, u8, u64, u64, u64, vector<u8>) {
    assert!(
        dynamic_field::exists_with_type<ID, IdentityVerificationRecord>(&registry.id, pass_lineage_id),
        EIdentityRecordNotFound,
    );
    let record = dynamic_field::borrow<ID, IdentityVerificationRecord>(&registry.id, pass_lineage_id);
    (
        record.owner,
        record.provider_mask,
        record.verified_at_ms,
        record.expires_at_ms,
        record.terms_version,
        record.signed_statement_hash,
    )
}

#[test_only]
public fun remove_identity_record_for_testing(
    registry: &mut IdentityRegistry,
    pass_lineage_id: ID,
) {
    assert!(
        dynamic_field::exists_with_type<ID, IdentityVerificationRecord>(&registry.id, pass_lineage_id),
        EIdentityRecordNotFound,
    );
    let _ = dynamic_field::remove<ID, IdentityVerificationRecord>(&mut registry.id, pass_lineage_id);
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
