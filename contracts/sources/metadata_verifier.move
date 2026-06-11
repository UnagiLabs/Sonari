module contracts::metadata_verifier;

use sui::ed25519;
use sui::event;
use sui::nitro_attestation::{Self, NitroAttestationDocument};
use sui::vec_map::{Self, VecMap};

const VERIFIER_FAMILY_EARTHQUAKE_ORACLE: u8 = 3;
const VERIFIER_FAMILY_IDENTITY: u8 = 4;
const VERIFIER_FAMILY_CENSUS: u8 = 5;
const VERIFIER_VERSION_V1: u64 = 1;
const TARGET_KIND_VERIFIER_REGISTRY: u8 = 6;
const REGISTRY_KIND_VERIFIER: u8 = 3;

const ED25519_PUBLIC_KEY_LENGTH: u64 = 32;
const ED25519_SIGNATURE_LENGTH: u64 = 64;
const PCR_LENGTH: u64 = 48;
const EARTHQUAKE_V1_CONFIG_KEY: u64 = 1;
const IDENTITY_V1_CONFIG_KEY: u64 = 2;
const CENSUS_V1_CONFIG_KEY: u64 = 3;

const EInvalidPublicKeyLength: u64 = 0;
const EInvalidSignatureLength: u64 = 1;
const EVerifierKeyAlreadyRegistered: u64 = 2;
const EVerifierKeyNotRegistered: u64 = 3;
const EVerifierKeyDisabled: u64 = 4;
const EVerifierFamilyMismatch: u64 = 5;
const EVerifierVersionMismatch: u64 = 6;
const EInvalidSignature: u64 = 8;
const EVerifierConfigAlreadyRegistered: u64 = 9;
const EVerifierConfigNotRegistered: u64 = 10;
const EVerifierConfigAlreadyDisabled: u64 = 11;
const EInvalidPcrLength: u64 = 12;
const EInvalidPcrValue: u64 = 13;
const EVerifierKeyAlreadyDisabled: u64 = 15;
const EEnclaveInstanceAlreadyRegistered: u64 = 16;
const EEnclaveInstanceNotRegistered: u64 = 17;
const EEnclaveInstanceAlreadyDisabled: u64 = 18;
const EEnclaveAttestationMissingPublicKey: u64 = 19;
const EEnclavePcrMissing: u64 = 20;
const EEnclavePcrMismatch: u64 = 21;
const EEnclaveInstanceExpired: u64 = 22;
const EEnclaveInstanceDisabled: u64 = 23;
const EEnclaveInstanceConfigMismatch: u64 = 24;

public struct VerifierRegistry has key {
    id: UID,
    keys: VecMap<vector<u8>, VerifierKey>,
    configs: VecMap<u64, VerifierConfig>,
    instances: VecMap<vector<u8>, EnclaveInstance>,
}

public struct VerifierKey has copy, drop, store {
    verifier_family: u8,
    verifier_version: u64,
    public_key: vector<u8>,
    enabled: bool,
    added_at_ms: u64,
    disabled_at_ms: Option<u64>,
}

public struct VerifierConfig has copy, drop, store {
    verifier_family: u8,
    verifier_version: u64,
    config_version: u64,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    enabled: bool,
    created_at_ms: u64,
    updated_at_ms: u64,
    disabled_at_ms: Option<u64>,
}

public struct EnclaveInstance has copy, drop, store {
    verifier_family: u8,
    verifier_version: u64,
    config_version: u64,
    public_key: vector<u8>,
    enabled: bool,
    registered_at_ms: u64,
    expires_at_ms: u64,
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

public struct VerifierConfigCreated has copy, drop {
    registry_id: ID,
    verifier_family: u8,
    verifier_version: u64,
    config_version: u64,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    enabled: bool,
    actor: address,
}

public struct VerifierConfigPcrsUpdated has copy, drop {
    registry_id: ID,
    verifier_family: u8,
    verifier_version: u64,
    config_version: u64,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    enabled: bool,
    actor: address,
}

public struct VerifierConfigDisabled has copy, drop {
    registry_id: ID,
    verifier_family: u8,
    verifier_version: u64,
    config_version: u64,
    actor: address,
}

public struct EnclaveInstanceRegistered has copy, drop {
    registry_id: ID,
    verifier_family: u8,
    verifier_version: u64,
    config_version: u64,
    public_key: vector<u8>,
    enabled: bool,
    registered_at_ms: u64,
    expires_at_ms: u64,
    actor: address,
}

public struct EnclaveInstanceDisabled has copy, drop {
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

public(package) fun create_earthquake_verifier_config(
    registry: &mut VerifierRegistry,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &TxContext,
) {
    create_verifier_config_internal(
        registry,
        VERIFIER_FAMILY_EARTHQUAKE_ORACLE,
        VERIFIER_VERSION_V1,
        earthquake_v1_config_key(),
        pcr0,
        pcr1,
        pcr2,
        ctx,
    );
}

public(package) fun update_earthquake_verifier_config_pcrs(
    registry: &mut VerifierRegistry,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &TxContext,
) {
    update_verifier_config_pcrs_internal(
        registry,
        earthquake_v1_config_key(),
        pcr0,
        pcr1,
        pcr2,
        ctx,
    );
}

public(package) fun disable_earthquake_verifier_config(
    registry: &mut VerifierRegistry,
    ctx: &TxContext,
) {
    disable_verifier_config_internal(registry, earthquake_v1_config_key(), ctx);
}

public(package) fun create_identity_verifier_config(
    registry: &mut VerifierRegistry,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &TxContext,
) {
    create_verifier_config_internal(
        registry,
        VERIFIER_FAMILY_IDENTITY,
        VERIFIER_VERSION_V1,
        identity_v1_config_key(),
        pcr0,
        pcr1,
        pcr2,
        ctx,
    );
}

public(package) fun update_identity_verifier_config_pcrs(
    registry: &mut VerifierRegistry,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &TxContext,
) {
    update_verifier_config_pcrs_internal(
        registry,
        identity_v1_config_key(),
        pcr0,
        pcr1,
        pcr2,
        ctx,
    );
}

public(package) fun disable_identity_verifier_config(
    registry: &mut VerifierRegistry,
    ctx: &TxContext,
) {
    disable_verifier_config_internal(registry, identity_v1_config_key(), ctx);
}

public(package) fun create_census_verifier_config(
    registry: &mut VerifierRegistry,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &TxContext,
) {
    create_verifier_config_internal(
        registry,
        VERIFIER_FAMILY_CENSUS,
        VERIFIER_VERSION_V1,
        census_v1_config_key(),
        pcr0,
        pcr1,
        pcr2,
        ctx,
    );
}

public(package) fun update_census_verifier_config_pcrs(
    registry: &mut VerifierRegistry,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &TxContext,
) {
    update_verifier_config_pcrs_internal(
        registry,
        census_v1_config_key(),
        pcr0,
        pcr1,
        pcr2,
        ctx,
    );
}

public(package) fun disable_census_verifier_config(
    registry: &mut VerifierRegistry,
    ctx: &TxContext,
) {
    disable_verifier_config_internal(registry, census_v1_config_key(), ctx);
}

public fun register_enclave_instance(
    registry: &mut VerifierRegistry,
    document: NitroAttestationDocument,
    expires_at_ms: u64,
    ctx: &mut TxContext,
) {
    register_enclave_instance_internal(
        registry,
        earthquake_v1_config_key(),
        document,
        expires_at_ms,
        ctx,
    );
}

public fun register_enclave_instance_for_config(
    registry: &mut VerifierRegistry,
    config_key: u64,
    document: NitroAttestationDocument,
    expires_at_ms: u64,
    ctx: &mut TxContext,
) {
    register_enclave_instance_internal(
        registry,
        config_key,
        document,
        expires_at_ms,
        ctx,
    );
}

public(package) fun disable_enclave_instance(
    registry: &mut VerifierRegistry,
    public_key: vector<u8>,
    ctx: &TxContext,
) {
    disable_enclave_instance_internal(registry, public_key, ctx);
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
    // identity および census は enclave 署名ルート（assert_enclave_signed_bytes）へ移行済み。
    // 旧 VerifierKey ルートは enabled / expiry / config_version /
    // config-family 整合チェックを通さないため、これらの family がこのルートを
    // 通ることを構造的に禁止し、将来の package 内誤用を fail-closed で防ぐ。
    assert!(expected_family != VERIFIER_FAMILY_IDENTITY, EVerifierFamilyMismatch);
    assert!(expected_family != VERIFIER_FAMILY_CENSUS, EVerifierFamilyMismatch);
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

public(package) fun assert_enclave_signed_bytes(
    registry: &VerifierRegistry,
    expected_family: u8,
    config_key: u64,
    signed_bytes: &vector<u8>,
    signature: &vector<u8>,
    public_key: &vector<u8>,
    now_ms: u64,
): (u64, u64, vector<u8>) {
    assert_public_key_length(public_key);
    assert_signature_length(signature);
    assert!(
        registry.instances.contains(public_key),
        EEnclaveInstanceNotRegistered,
    );

    let instance = registry.instances.get(public_key);
    assert!(instance.enabled, EEnclaveInstanceDisabled);
    assert!(instance.expires_at_ms > now_ms, EEnclaveInstanceExpired);
    assert!(
        instance.verifier_family == expected_family,
        EVerifierFamilyMismatch,
    );
    assert!(
        instance.verifier_version == VERIFIER_VERSION_V1,
        EVerifierVersionMismatch,
    );

    assert!(registry.configs.contains(&config_key), EVerifierConfigNotRegistered);
    let config = registry.configs.get(&config_key);
    assert!(
        config.verifier_family == expected_family,
        EVerifierFamilyMismatch,
    );
    assert!(config.enabled, EVerifierConfigAlreadyDisabled);
    assert!(
        instance.config_version == config.config_version,
        EEnclaveInstanceConfigMismatch,
    );
    assert!(
        ed25519::ed25519_verify(signature, public_key, signed_bytes),
        EInvalidSignature,
    );
    let config_version = config.config_version;
    let instance_public_key = instance.public_key;
    (config_key, config_version, instance_public_key)
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
        configs: vec_map::empty(),
        instances: vec_map::empty(),
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

fun create_verifier_config_internal(
    registry: &mut VerifierRegistry,
    verifier_family: u8,
    verifier_version: u64,
    config_key: u64,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &TxContext,
) {
    assert_pcr(&pcr0);
    assert_pcr(&pcr1);
    assert_pcr(&pcr2);
    assert!(
        !registry.configs.contains(&config_key),
        EVerifierConfigAlreadyRegistered,
    );

    registry.configs.insert(
        config_key,
        VerifierConfig {
            verifier_family,
            verifier_version,
            config_version: 1,
            pcr0,
            pcr1,
            pcr2,
            enabled: true,
            created_at_ms: ctx.epoch_timestamp_ms(),
            updated_at_ms: ctx.epoch_timestamp_ms(),
            disabled_at_ms: option::none(),
        },
    );
    event::emit(VerifierConfigCreated {
        registry_id: object::id(registry),
        verifier_family,
        verifier_version,
        config_version: 1,
        pcr0,
        pcr1,
        pcr2,
        enabled: true,
        actor: ctx.sender(),
    });
}

fun update_verifier_config_pcrs_internal(
    registry: &mut VerifierRegistry,
    config_key: u64,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &TxContext,
) {
    assert_pcr(&pcr0);
    assert_pcr(&pcr1);
    assert_pcr(&pcr2);
    assert!(registry.configs.contains(&config_key), EVerifierConfigNotRegistered);
    let registry_id = object::id(registry);
    let (verifier_family, verifier_version, config_version, enabled) = {
        let config = registry.configs.get_mut(&config_key);
        assert!(config.enabled, EVerifierConfigAlreadyDisabled);
        config.config_version = config.config_version + 1;
        config.pcr0 = pcr0;
        config.pcr1 = pcr1;
        config.pcr2 = pcr2;
        config.updated_at_ms = ctx.epoch_timestamp_ms();
        (
            config.verifier_family,
            config.verifier_version,
            config.config_version,
            config.enabled,
        )
    };

    event::emit(VerifierConfigPcrsUpdated {
        registry_id,
        verifier_family,
        verifier_version,
        config_version,
        pcr0,
        pcr1,
        pcr2,
        enabled,
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

fun disable_verifier_config_internal(
    registry: &mut VerifierRegistry,
    config_key: u64,
    ctx: &TxContext,
) {
    assert!(registry.configs.contains(&config_key), EVerifierConfigNotRegistered);
    let registry_id = object::id(registry);
    let (verifier_family, verifier_version, config_version) = {
        let config = registry.configs.get_mut(&config_key);
        assert!(config.enabled, EVerifierConfigAlreadyDisabled);
        config.enabled = false;
        config.updated_at_ms = ctx.epoch_timestamp_ms();
        config.disabled_at_ms = option::some(ctx.epoch_timestamp_ms());
        (
            config.verifier_family,
            config.verifier_version,
            config.config_version,
        )
    };

    event::emit(VerifierConfigDisabled {
        registry_id,
        verifier_family,
        verifier_version,
        config_version,
        actor: ctx.sender(),
    });
}

fun register_enclave_instance_internal(
    registry: &mut VerifierRegistry,
    config_key: u64,
    document: NitroAttestationDocument,
    expires_at_ms: u64,
    ctx: &TxContext,
) {
    assert!(expires_at_ms > ctx.epoch_timestamp_ms(), EEnclaveInstanceExpired);
    let public_key = public_key_from_attestation(&document);
    assert_public_key_length(&public_key);
    assert!(
        !registry.instances.contains(&public_key),
        EEnclaveInstanceAlreadyRegistered,
    );
    assert!(registry.configs.contains(&config_key), EVerifierConfigNotRegistered);

    let config = registry.configs.get(&config_key);
    assert!(config.enabled, EVerifierConfigAlreadyDisabled);
    assert_attestation_pcr_matches(&document, 0, &config.pcr0);
    assert_attestation_pcr_matches(&document, 1, &config.pcr1);
    assert_attestation_pcr_matches(&document, 2, &config.pcr2);

    registry.instances.insert(
        public_key,
        EnclaveInstance {
            verifier_family: config.verifier_family,
            verifier_version: config.verifier_version,
            config_version: config.config_version,
            public_key,
            enabled: true,
            registered_at_ms: ctx.epoch_timestamp_ms(),
            expires_at_ms,
            disabled_at_ms: option::none(),
        },
    );
    event::emit(EnclaveInstanceRegistered {
        registry_id: object::id(registry),
        verifier_family: config.verifier_family,
        verifier_version: config.verifier_version,
        config_version: config.config_version,
        public_key,
        enabled: true,
        registered_at_ms: ctx.epoch_timestamp_ms(),
        expires_at_ms,
        actor: ctx.sender(),
    });
}

fun disable_enclave_instance_internal(
    registry: &mut VerifierRegistry,
    public_key: vector<u8>,
    ctx: &TxContext,
) {
    assert_public_key_length(&public_key);
    assert!(
        registry.instances.contains(&public_key),
        EEnclaveInstanceNotRegistered,
    );

    let instance = registry.instances.get_mut(&public_key);
    assert!(instance.enabled, EEnclaveInstanceAlreadyDisabled);
    instance.enabled = false;
    instance.disabled_at_ms = option::some(ctx.epoch_timestamp_ms());
    event::emit(EnclaveInstanceDisabled {
        registry_id: object::id(registry),
        public_key,
        actor: ctx.sender(),
    });
}

fun public_key_from_attestation(document: &NitroAttestationDocument): vector<u8> {
    let public_key = nitro_attestation::public_key(document);
    assert!(public_key.is_some(), EEnclaveAttestationMissingPublicKey);
    *public_key.borrow()
}

fun assert_attestation_pcr_matches(
    document: &NitroAttestationDocument,
    expected_index: u8,
    expected_value: &vector<u8>,
) {
    let pcr = attestation_pcr_value(document, expected_index);
    assert!(pcr.is_some(), EEnclavePcrMissing);
    assert!(*pcr.borrow() == *expected_value, EEnclavePcrMismatch);
}

fun attestation_pcr_value(
    document: &NitroAttestationDocument,
    expected_index: u8,
): Option<vector<u8>> {
    let pcrs = nitro_attestation::pcrs(document);
    let mut index = 0;
    while (index < pcrs.length()) {
        let pcr = pcrs.borrow(index);
        if (nitro_attestation::index(pcr) == expected_index) {
            return option::some(*nitro_attestation::value(pcr))
        };
        index = index + 1;
    };
    option::none()
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
            || verifier_family == VERIFIER_FAMILY_IDENTITY
            || verifier_family == VERIFIER_FAMILY_CENSUS,
        EVerifierFamilyMismatch,
    );
}

fun assert_allowed_verifier_version(verifier_version: u64) {
    assert!(verifier_version == VERIFIER_VERSION_V1, EVerifierVersionMismatch);
}

fun assert_pcr(pcr: &vector<u8>) {
    assert!(pcr.length() == PCR_LENGTH, EInvalidPcrLength);
    assert!(!is_all_zero(pcr), EInvalidPcrValue);
}

fun is_all_zero(bytes: &vector<u8>): bool {
    let mut index = 0;
    let mut all_zero = true;
    while (index < bytes.length()) {
        if (*bytes.borrow(index) != 0) {
            all_zero = false;
        };
        index = index + 1;
    };
    all_zero
}

public(package) fun earthquake_v1_config_key(): u64 {
    EARTHQUAKE_V1_CONFIG_KEY
}

public(package) fun identity_v1_config_key(): u64 {
    IDENTITY_V1_CONFIG_KEY
}

public(package) fun census_v1_config_key(): u64 {
    CENSUS_V1_CONFIG_KEY
}

public(package) fun verifier_family_census(): u8 {
    VERIFIER_FAMILY_CENSUS
}

#[test_only]
public fun create_verifier_registry_for_testing(ctx: &mut TxContext): VerifierRegistry {
    new_registry(ctx)
}

#[test_only]
public fun destroy_verifier_registry_for_testing(registry: VerifierRegistry) {
    let VerifierRegistry {
        id,
        keys,
        configs,
        instances,
    } = registry;
    destroy_keys_for_testing(keys);
    destroy_configs_for_testing(configs);
    destroy_instances_for_testing(instances);
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
fun destroy_configs_for_testing(mut configs: VecMap<u64, VerifierConfig>) {
    while (!configs.is_empty()) {
        let (_, _) = configs.pop();
    };
    configs.destroy_empty();
}

#[test_only]
fun destroy_instances_for_testing(mut instances: VecMap<vector<u8>, EnclaveInstance>) {
    while (!instances.is_empty()) {
        let (_, _) = instances.pop();
    };
    instances.destroy_empty();
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
public fun register_enclave_instance_for_testing(
    registry: &mut VerifierRegistry,
    document: NitroAttestationDocument,
    expires_at_ms: u64,
    ctx: &mut TxContext,
) {
    register_enclave_instance_internal(
        registry,
        earthquake_v1_config_key(),
        document,
        expires_at_ms,
        ctx,
    );
}

#[test_only]
public fun disable_enclave_instance_for_testing(
    registry: &mut VerifierRegistry,
    public_key: vector<u8>,
    ctx: &mut TxContext,
) {
    disable_enclave_instance_internal(registry, public_key, ctx);
}

#[test_only]
public fun add_enclave_instance_for_testing(
    registry: &mut VerifierRegistry,
    public_key: vector<u8>,
    expires_at_ms: u64,
    ctx: &mut TxContext,
) {
    add_enclave_instance_for_config_for_testing(
        registry,
        earthquake_v1_config_key(),
        public_key,
        expires_at_ms,
        ctx,
    );
}

#[test_only]
public fun add_enclave_instance_for_config_for_testing(
    registry: &mut VerifierRegistry,
    config_key: u64,
    public_key: vector<u8>,
    expires_at_ms: u64,
    ctx: &mut TxContext,
) {
    assert_public_key_length(&public_key);
    assert!(
        !registry.instances.contains(&public_key),
        EEnclaveInstanceAlreadyRegistered,
    );
    assert!(registry.configs.contains(&config_key), EVerifierConfigNotRegistered);
    let config = registry.configs.get(&config_key);
    assert!(config.enabled, EVerifierConfigAlreadyDisabled);

    registry.instances.insert(
        public_key,
        EnclaveInstance {
            verifier_family: config.verifier_family,
            verifier_version: config.verifier_version,
            config_version: config.config_version,
            public_key,
            enabled: true,
            registered_at_ms: ctx.epoch_timestamp_ms(),
            expires_at_ms,
            disabled_at_ms: option::none(),
        },
    );
}

#[test_only]
public fun create_earthquake_verifier_config_for_testing(
    registry: &mut VerifierRegistry,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &TxContext,
) {
    create_earthquake_verifier_config(registry, pcr0, pcr1, pcr2, ctx);
}

#[test_only]
public fun create_identity_verifier_config_for_testing(
    registry: &mut VerifierRegistry,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &TxContext,
) {
    create_identity_verifier_config(registry, pcr0, pcr1, pcr2, ctx);
}

#[test_only]
public fun update_identity_verifier_config_pcrs_for_testing(
    registry: &mut VerifierRegistry,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &TxContext,
) {
    update_identity_verifier_config_pcrs(registry, pcr0, pcr1, pcr2, ctx);
}

#[test_only]
public fun earthquake_verifier_config_fields_for_testing(
    registry: &VerifierRegistry,
): (u8, u64, u64, vector<u8>, vector<u8>, vector<u8>, bool) {
    verifier_config_fields_for_testing(registry, earthquake_v1_config_key())
}

#[test_only]
public fun identity_verifier_config_fields_for_testing(
    registry: &VerifierRegistry,
): (u8, u64, u64, vector<u8>, vector<u8>, vector<u8>, bool) {
    verifier_config_fields_for_testing(registry, identity_v1_config_key())
}

#[test_only]
public fun create_census_verifier_config_for_testing(
    registry: &mut VerifierRegistry,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &TxContext,
) {
    create_census_verifier_config(registry, pcr0, pcr1, pcr2, ctx);
}

#[test_only]
public fun census_verifier_config_fields_for_testing(
    registry: &VerifierRegistry,
): (u8, u64, u64, vector<u8>, vector<u8>, vector<u8>, bool) {
    verifier_config_fields_for_testing(registry, census_v1_config_key())
}

#[test_only]
fun verifier_config_fields_for_testing(
    registry: &VerifierRegistry,
    config_key: u64,
): (u8, u64, u64, vector<u8>, vector<u8>, vector<u8>, bool) {
    assert!(registry.configs.contains(&config_key), EVerifierConfigNotRegistered);
    let config = registry.configs.get(&config_key);
    (
        config.verifier_family,
        config.verifier_version,
        config.config_version,
        config.pcr0,
        config.pcr1,
        config.pcr2,
        config.enabled,
    )
}

#[test_only]
public fun enclave_instance_fields_for_testing(
    registry: &VerifierRegistry,
    public_key: vector<u8>,
): (u8, u64, u64, vector<u8>, bool, u64, u64, Option<u64>) {
    assert!(
        registry.instances.contains(&public_key),
        EEnclaveInstanceNotRegistered,
    );
    let instance = registry.instances.get(&public_key);
    (
        instance.verifier_family,
        instance.verifier_version,
        instance.config_version,
        instance.public_key,
        instance.enabled,
        instance.registered_at_ms,
        instance.expires_at_ms,
        instance.disabled_at_ms,
    )
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
public fun verifier_config_created_event_fields(
    event: VerifierConfigCreated,
): (ID, u8, u64, u64, vector<u8>, vector<u8>, vector<u8>, bool, address) {
    let VerifierConfigCreated {
        registry_id,
        verifier_family,
        verifier_version,
        config_version,
        pcr0,
        pcr1,
        pcr2,
        enabled,
        actor,
    } = event;
    (
        registry_id,
        verifier_family,
        verifier_version,
        config_version,
        pcr0,
        pcr1,
        pcr2,
        enabled,
        actor,
    )
}

#[test_only]
public fun verifier_config_pcrs_updated_event_fields(
    event: VerifierConfigPcrsUpdated,
): (ID, u8, u64, u64, vector<u8>, vector<u8>, vector<u8>, bool, address) {
    let VerifierConfigPcrsUpdated {
        registry_id,
        verifier_family,
        verifier_version,
        config_version,
        pcr0,
        pcr1,
        pcr2,
        enabled,
        actor,
    } = event;
    (
        registry_id,
        verifier_family,
        verifier_version,
        config_version,
        pcr0,
        pcr1,
        pcr2,
        enabled,
        actor,
    )
}

#[test_only]
public fun verifier_config_disabled_event_fields(
    event: VerifierConfigDisabled,
): (ID, u8, u64, u64, address) {
    let VerifierConfigDisabled {
        registry_id,
        verifier_family,
        verifier_version,
        config_version,
        actor,
    } = event;
    (registry_id, verifier_family, verifier_version, config_version, actor)
}

#[test_only]
public fun enclave_instance_registered_event_fields(
    event: EnclaveInstanceRegistered,
): (ID, u8, u64, u64, vector<u8>, bool, u64, u64, address) {
    let EnclaveInstanceRegistered {
        registry_id,
        verifier_family,
        verifier_version,
        config_version,
        public_key,
        enabled,
        registered_at_ms,
        expires_at_ms,
        actor,
    } = event;
    (
        registry_id,
        verifier_family,
        verifier_version,
        config_version,
        public_key,
        enabled,
        registered_at_ms,
        expires_at_ms,
        actor,
    )
}

#[test_only]
public fun enclave_instance_disabled_event_fields(
    event: EnclaveInstanceDisabled,
): (ID, vector<u8>, address) {
    let EnclaveInstanceDisabled {
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
