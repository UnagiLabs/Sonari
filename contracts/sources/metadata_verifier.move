module contracts::metadata_verifier;

use sui::ed25519;
use sui::event;
use sui::vec_map::{Self, VecMap};

const VERIFIER_FAMILY_EARTHQUAKE_ORACLE: u8 = 3;
const VERIFIER_FAMILY_IDENTITY: u8 = 4;
const VERIFIER_VERSION_V1: u64 = 1;
const TARGET_KIND_VERIFIER_REGISTRY: u8 = 6;
const REGISTRY_KIND_VERIFIER: u8 = 3;

const ED25519_PUBLIC_KEY_LENGTH: u64 = 32;
const ED25519_SIGNATURE_LENGTH: u64 = 64;

const EInvalidPublicKeyLength: u64 = 0;
const EInvalidSignatureLength: u64 = 1;
const EVerifierKeyAlreadyRegistered: u64 = 2;
const EVerifierKeyNotRegistered: u64 = 3;
const EVerifierKeyDisabled: u64 = 4;
const EVerifierFamilyMismatch: u64 = 5;
const EVerifierVersionMismatch: u64 = 6;
const EInvalidSignature: u64 = 8;
const EVerifierKeyAlreadyDisabled: u64 = 15;

public struct VerifierRegistry has key {
    id: UID,
    keys: VecMap<vector<u8>, VerifierKey>,
}

public struct VerifierKey has copy, drop, store {
    verifier_family: u8,
    verifier_version: u64,
    public_key: vector<u8>,
    enabled: bool,
    added_at_ms: u64,
    disabled_at_ms: Option<u64>,
}

public struct VerifierKeyAdded has copy, drop {
    registry_id: ID,
    public_key: vector<u8>,
    verifier_family: u8,
    verifier_version: u64,
    enabled: bool,
    actor: address,
}

public struct VerifierKeyDisabled has copy, drop {
    registry_id: ID,
    public_key: vector<u8>,
    actor: address,
}

public struct RegistryCreated has copy, drop {
    registry_id: ID,
    registry_kind: u8,
    created_at_ms: u64,
    actor: address,
}

public(package) fun create_verifier_registry(ctx: &mut TxContext): ID {
    let registry = new_registry(ctx);
    let registry_id = object::id(&registry);
    event::emit(RegistryCreated {
        registry_id,
        registry_kind: REGISTRY_KIND_VERIFIER,
        created_at_ms: ctx.epoch_timestamp_ms(),
        actor: ctx.sender(),
    });
    transfer::share_object(registry);
    registry_id
}

public(package) fun add_verifier_key(
    registry: &mut VerifierRegistry,
    verifier_family: u8,
    verifier_version: u64,
    public_key: vector<u8>,
    ctx: &TxContext,
) {
    add_verifier_key_internal(registry, verifier_family, verifier_version, public_key, ctx);
}

public(package) fun disable_verifier_key(
    registry: &mut VerifierRegistry,
    public_key: vector<u8>,
    ctx: &TxContext,
) {
    disable_verifier_key_internal(registry, public_key, ctx);
}

public(package) fun assert_signed_bytes(
    registry: &VerifierRegistry,
    expected_family: u8,
    expected_version: u64,
    signed_bytes: &vector<u8>,
    signature: &vector<u8>,
    public_key: &vector<u8>,
) {
    assert_public_key_length(public_key);
    assert_signature_length(signature);
    assert_allowed_verifier_family(expected_family);
    assert_allowed_verifier_version(expected_version);
    assert!(registry.keys.contains(public_key), EVerifierKeyNotRegistered);

    let key = registry.keys.get(public_key);
    assert!(key.enabled, EVerifierKeyDisabled);
    assert!(key.verifier_family == expected_family, EVerifierFamilyMismatch);
    assert!(key.verifier_version == expected_version, EVerifierVersionMismatch);
    assert!(
        ed25519::ed25519_verify(signature, public_key, signed_bytes),
        EInvalidSignature,
    );
}

public(package) fun registry_id(registry: &VerifierRegistry): ID {
    object::id(registry)
}

public(package) fun registry_kind_verifier(): u8 {
    REGISTRY_KIND_VERIFIER
}

public(package) fun verifier_family_earthquake_oracle(): u8 {
    VERIFIER_FAMILY_EARTHQUAKE_ORACLE
}

public(package) fun verifier_family_identity(): u8 {
    VERIFIER_FAMILY_IDENTITY
}

public(package) fun verifier_version_v1(): u64 {
    VERIFIER_VERSION_V1
}

public(package) fun target_kind_verifier_registry(): u8 {
    TARGET_KIND_VERIFIER_REGISTRY
}

fun new_registry(ctx: &mut TxContext): VerifierRegistry {
    VerifierRegistry {
        id: object::new(ctx),
        keys: vec_map::empty(),
    }
}

fun add_verifier_key_internal(
    registry: &mut VerifierRegistry,
    verifier_family: u8,
    verifier_version: u64,
    public_key: vector<u8>,
    ctx: &TxContext,
) {
    assert_public_key_length(&public_key);
    assert_allowed_verifier_family(verifier_family);
    assert_allowed_verifier_version(verifier_version);
    assert!(!registry.keys.contains(&public_key), EVerifierKeyAlreadyRegistered);

    registry.keys.insert(
        public_key,
        VerifierKey {
            verifier_family,
            verifier_version,
            public_key,
            enabled: true,
            added_at_ms: ctx.epoch_timestamp_ms(),
            disabled_at_ms: option::none(),
        },
    );
    event::emit(VerifierKeyAdded {
        registry_id: object::id(registry),
        public_key,
        verifier_family,
        verifier_version,
        enabled: true,
        actor: ctx.sender(),
    });
}

fun disable_verifier_key_internal(
    registry: &mut VerifierRegistry,
    public_key: vector<u8>,
    ctx: &TxContext,
) {
    assert_public_key_length(&public_key);
    assert!(registry.keys.contains(&public_key), EVerifierKeyNotRegistered);

    let key = registry.keys.get_mut(&public_key);
    assert!(key.enabled, EVerifierKeyAlreadyDisabled);
    key.enabled = false;
    key.disabled_at_ms = option::some(ctx.epoch_timestamp_ms());
    event::emit(VerifierKeyDisabled {
        registry_id: object::id(registry),
        public_key,
        actor: ctx.sender(),
    });
}

fun assert_public_key_length(public_key: &vector<u8>) {
    assert!(public_key.length() == ED25519_PUBLIC_KEY_LENGTH, EInvalidPublicKeyLength);
}

fun assert_signature_length(signature: &vector<u8>) {
    assert!(signature.length() == ED25519_SIGNATURE_LENGTH, EInvalidSignatureLength);
}

fun assert_allowed_verifier_family(verifier_family: u8) {
    assert!(
        verifier_family == VERIFIER_FAMILY_EARTHQUAKE_ORACLE
            || verifier_family == VERIFIER_FAMILY_IDENTITY,
        EVerifierFamilyMismatch,
    );
}

fun assert_allowed_verifier_version(verifier_version: u64) {
    assert!(verifier_version == VERIFIER_VERSION_V1, EVerifierVersionMismatch);
}

#[test_only]
public fun create_verifier_registry_for_testing(ctx: &mut TxContext): VerifierRegistry {
    new_registry(ctx)
}

#[test_only]
public fun destroy_verifier_registry_for_testing(registry: VerifierRegistry) {
    let VerifierRegistry { id, keys } = registry;
    destroy_keys_for_testing(keys);
    id.delete();
}

#[test_only]
fun destroy_keys_for_testing(mut keys: VecMap<vector<u8>, VerifierKey>) {
    while (!keys.is_empty()) {
        let (_, _) = keys.pop();
    };
    keys.destroy_empty();
}

#[test_only]
public fun add_verifier_key_for_testing(
    registry: &mut VerifierRegistry,
    verifier_family: u8,
    verifier_version: u64,
    public_key: vector<u8>,
    ctx: &mut TxContext,
) {
    add_verifier_key_internal(registry, verifier_family, verifier_version, public_key, ctx);
}

#[test_only]
public fun add_verifier_key_unchecked_for_testing(
    registry: &mut VerifierRegistry,
    verifier_family: u8,
    verifier_version: u64,
    public_key: vector<u8>,
    ctx: &mut TxContext,
) {
    assert_public_key_length(&public_key);
    assert!(!registry.keys.contains(&public_key), EVerifierKeyAlreadyRegistered);
    registry.keys.insert(
        public_key,
        VerifierKey {
            verifier_family,
            verifier_version,
            public_key,
            enabled: true,
            added_at_ms: ctx.epoch_timestamp_ms(),
            disabled_at_ms: option::none(),
        },
    );
}

#[test_only]
public fun disable_verifier_key_for_testing(
    registry: &mut VerifierRegistry,
    public_key: vector<u8>,
    ctx: &mut TxContext,
) {
    disable_verifier_key_internal(registry, public_key, ctx);
}

#[test_only]
public fun verifier_key_added_event_fields(
    event: VerifierKeyAdded,
): (ID, vector<u8>, u8, u64, bool, address) {
    let VerifierKeyAdded {
        registry_id,
        public_key,
        verifier_family,
        verifier_version,
        enabled,
        actor,
    } = event;
    (registry_id, public_key, verifier_family, verifier_version, enabled, actor)
}

#[test_only]
public fun verifier_key_disabled_event_fields(
    event: VerifierKeyDisabled,
): (ID, vector<u8>, address) {
    let VerifierKeyDisabled {
        registry_id,
        public_key,
        actor,
    } = event;
    (registry_id, public_key, actor)
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
