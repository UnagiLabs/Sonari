module contracts::metadata_verifier;

use contracts::membership::{Self, MembershipPass};
use sui::bcs;
use sui::clock::{Self, Clock};
use sui::ed25519;
use sui::event;
use sui::vec_map::{Self, VecMap};

const VERIFIER_FAMILY_RESIDENCE: u8 = 1;
const VERIFIER_FAMILY_STUDENT: u8 = 2;
const VERIFIER_FAMILY_EARTHQUAKE_ORACLE: u8 = 3;
const VERIFIER_VERSION_V1: u64 = 1;
const TARGET_KIND_VERIFIER_REGISTRY: u8 = 6;
const REGISTRY_KIND_VERIFIER: u8 = 3;

const INTENT_RESIDENCE_METADATA_UPDATE_V1: vector<u8> =
    b"SONARI_RESIDENCE_METADATA_UPDATE_V1";
const INTENT_STUDENT_METADATA_UPDATE_V1: vector<u8> =
    b"SONARI_STUDENT_METADATA_UPDATE_V1";

const ED25519_PUBLIC_KEY_LENGTH: u64 = 32;
const ED25519_SIGNATURE_LENGTH: u64 = 64;
const ALLOWED_CLOCK_SKEW_MS: u64 = 300_000;

const EInvalidPublicKeyLength: u64 = 0;
const EInvalidSignatureLength: u64 = 1;
const EVerifierKeyAlreadyRegistered: u64 = 2;
const EVerifierKeyNotRegistered: u64 = 3;
const EVerifierKeyDisabled: u64 = 4;
const EVerifierFamilyMismatch: u64 = 5;
const EVerifierVersionMismatch: u64 = 6;
const EInvalidIntent: u64 = 7;
const EInvalidSignature: u64 = 8;
const EExpiredUpdate: u64 = 9;
const EInvalidTimeRange: u64 = 10;
const EFutureIssuedAt: u64 = 11;
const ERegistryMismatch: u64 = 12;
const EPassLineageMismatch: u64 = 13;
const EOwnerMismatch: u64 = 14;
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

public struct ResidenceMetadataUpdateMessage has copy, drop {
    intent: vector<u8>,
    verifier_family: u8,
    verifier_version: u64,
    registry_id: ID,
    pass_lineage_id: ID,
    owner: address,
    update_id: u64,
    issued_at_ms: u64,
    expires_at_ms: u64,
    verified_residence_cell: vector<u8>,
    residence_confidence: u64,
    risk_bucket: u8,
    evidence_snapshot_hash: vector<u8>,
}

public struct StudentMetadataUpdateMessage has copy, drop {
    intent: vector<u8>,
    verifier_family: u8,
    verifier_version: u64,
    registry_id: ID,
    pass_lineage_id: ID,
    owner: address,
    update_id: u64,
    issued_at_ms: u64,
    expires_at_ms: u64,
    school_region_hash: vector<u8>,
    student_status: u8,
    student_confidence: u64,
    risk_bucket: u8,
    evidence_snapshot_hash: vector<u8>,
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

public(package) fun verify_and_update_residence_metadata(
    registry: &VerifierRegistry,
    pass: &mut MembershipPass,
    clock: &Clock,
    message: ResidenceMetadataUpdateMessage,
    signature: vector<u8>,
    public_key: vector<u8>,
    ctx: &TxContext,
) {
    let now_ms = clock::timestamp_ms(clock);
    assert_valid_residence_update(registry, pass, now_ms, &message, &signature, &public_key);

    let ResidenceMetadataUpdateMessage {
        intent: _,
        verifier_family,
        verifier_version,
        registry_id: _,
        pass_lineage_id: _,
        owner: _,
        update_id,
        issued_at_ms,
        expires_at_ms,
        verified_residence_cell,
        residence_confidence,
        risk_bucket,
        evidence_snapshot_hash,
    } = message;

    membership::apply_residence_metadata_update(
        pass,
        update_id,
        verified_residence_cell,
        residence_confidence,
        risk_bucket,
        evidence_snapshot_hash,
        issued_at_ms,
        expires_at_ms,
        verifier_family,
        verifier_version,
        now_ms,
        ctx,
    );
}

public(package) fun verify_and_update_student_metadata(
    registry: &VerifierRegistry,
    pass: &mut MembershipPass,
    clock: &Clock,
    message: StudentMetadataUpdateMessage,
    signature: vector<u8>,
    public_key: vector<u8>,
    ctx: &TxContext,
) {
    let now_ms = clock::timestamp_ms(clock);
    assert_valid_student_update(registry, pass, now_ms, &message, &signature, &public_key);

    let StudentMetadataUpdateMessage {
        intent: _,
        verifier_family,
        verifier_version,
        registry_id: _,
        pass_lineage_id: _,
        owner: _,
        update_id,
        issued_at_ms,
        expires_at_ms,
        school_region_hash,
        student_status,
        student_confidence,
        risk_bucket,
        evidence_snapshot_hash,
    } = message;

    membership::apply_student_metadata_update(
        pass,
        update_id,
        school_region_hash,
        student_status,
        student_confidence,
        risk_bucket,
        evidence_snapshot_hash,
        issued_at_ms,
        expires_at_ms,
        verifier_family,
        verifier_version,
        now_ms,
        ctx,
    );
}

public fun new_residence_metadata_update_message(
    intent: vector<u8>,
    verifier_family: u8,
    verifier_version: u64,
    registry_id: ID,
    pass_lineage_id: ID,
    owner: address,
    update_id: u64,
    issued_at_ms: u64,
    expires_at_ms: u64,
    verified_residence_cell: vector<u8>,
    residence_confidence: u64,
    risk_bucket: u8,
    evidence_snapshot_hash: vector<u8>,
): ResidenceMetadataUpdateMessage {
    ResidenceMetadataUpdateMessage {
        intent,
        verifier_family,
        verifier_version,
        registry_id,
        pass_lineage_id,
        owner,
        update_id,
        issued_at_ms,
        expires_at_ms,
        verified_residence_cell,
        residence_confidence,
        risk_bucket,
        evidence_snapshot_hash,
    }
}

public fun new_student_metadata_update_message(
    intent: vector<u8>,
    verifier_family: u8,
    verifier_version: u64,
    registry_id: ID,
    pass_lineage_id: ID,
    owner: address,
    update_id: u64,
    issued_at_ms: u64,
    expires_at_ms: u64,
    school_region_hash: vector<u8>,
    student_status: u8,
    student_confidence: u64,
    risk_bucket: u8,
    evidence_snapshot_hash: vector<u8>,
): StudentMetadataUpdateMessage {
    StudentMetadataUpdateMessage {
        intent,
        verifier_family,
        verifier_version,
        registry_id,
        pass_lineage_id,
        owner,
        update_id,
        issued_at_ms,
        expires_at_ms,
        school_region_hash,
        student_status,
        student_confidence,
        risk_bucket,
        evidence_snapshot_hash,
    }
}

public fun residence_update_message_bcs(
    message: &ResidenceMetadataUpdateMessage,
): vector<u8> {
    bcs::to_bytes(message)
}

public fun student_update_message_bcs(message: &StudentMetadataUpdateMessage): vector<u8> {
    bcs::to_bytes(message)
}

public fun registry_id(registry: &VerifierRegistry): ID {
    object::id(registry)
}

public fun registry_kind_verifier(): u8 {
    REGISTRY_KIND_VERIFIER
}

public fun verifier_family_residence(): u8 {
    VERIFIER_FAMILY_RESIDENCE
}

public fun verifier_family_student(): u8 {
    VERIFIER_FAMILY_STUDENT
}

public fun verifier_family_earthquake_oracle(): u8 {
    VERIFIER_FAMILY_EARTHQUAKE_ORACLE
}

public fun verifier_version_v1(): u64 {
    VERIFIER_VERSION_V1
}

public fun target_kind_verifier_registry(): u8 {
    TARGET_KIND_VERIFIER_REGISTRY
}

public fun allowed_clock_skew_ms(): u64 {
    ALLOWED_CLOCK_SKEW_MS
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

fun assert_valid_residence_update(
    registry: &VerifierRegistry,
    pass: &MembershipPass,
    now_ms: u64,
    message: &ResidenceMetadataUpdateMessage,
    signature: &vector<u8>,
    public_key: &vector<u8>,
) {
    let ResidenceMetadataUpdateMessage {
        intent,
        verifier_family,
        verifier_version,
        registry_id,
        pass_lineage_id,
        owner,
        update_id: _,
        issued_at_ms,
        expires_at_ms,
        verified_residence_cell: _,
        residence_confidence: _,
        risk_bucket: _,
        evidence_snapshot_hash: _,
    } = message;

    assert_common_metadata_update(
        registry,
        pass,
        now_ms,
        *intent,
        *verifier_family,
        *verifier_version,
        *registry_id,
        *pass_lineage_id,
        *owner,
        *issued_at_ms,
        *expires_at_ms,
        INTENT_RESIDENCE_METADATA_UPDATE_V1,
        VERIFIER_FAMILY_RESIDENCE,
        signature,
        public_key,
        residence_update_message_bcs(message),
    );
}

fun assert_valid_student_update(
    registry: &VerifierRegistry,
    pass: &MembershipPass,
    now_ms: u64,
    message: &StudentMetadataUpdateMessage,
    signature: &vector<u8>,
    public_key: &vector<u8>,
) {
    let StudentMetadataUpdateMessage {
        intent,
        verifier_family,
        verifier_version,
        registry_id,
        pass_lineage_id,
        owner,
        update_id: _,
        issued_at_ms,
        expires_at_ms,
        school_region_hash: _,
        student_status: _,
        student_confidence: _,
        risk_bucket: _,
        evidence_snapshot_hash: _,
    } = message;

    assert_common_metadata_update(
        registry,
        pass,
        now_ms,
        *intent,
        *verifier_family,
        *verifier_version,
        *registry_id,
        *pass_lineage_id,
        *owner,
        *issued_at_ms,
        *expires_at_ms,
        INTENT_STUDENT_METADATA_UPDATE_V1,
        VERIFIER_FAMILY_STUDENT,
        signature,
        public_key,
        student_update_message_bcs(message),
    );
}

fun assert_common_metadata_update(
    registry: &VerifierRegistry,
    pass: &MembershipPass,
    now_ms: u64,
    intent: vector<u8>,
    verifier_family: u8,
    verifier_version: u64,
    message_registry_id: ID,
    pass_lineage_id: ID,
    owner: address,
    issued_at_ms: u64,
    expires_at_ms: u64,
    expected_intent: vector<u8>,
    expected_family: u8,
    signature: &vector<u8>,
    public_key: &vector<u8>,
    signed_message: vector<u8>,
) {
    assert_public_key_length(public_key);
    assert_signature_length(signature);
    assert!(message_registry_id == object::id(registry), ERegistryMismatch);
    assert!(intent == expected_intent, EInvalidIntent);
    assert!(verifier_family == expected_family, EVerifierFamilyMismatch);
    assert!(verifier_version == VERIFIER_VERSION_V1, EVerifierVersionMismatch);
    assert!(pass_lineage_id == membership::membership_pass_lineage_id(pass), EPassLineageMismatch);
    assert!(owner == membership::membership_pass_owner(pass), EOwnerMismatch);
    assert!(expires_at_ms > issued_at_ms, EInvalidTimeRange);
    assert!(expires_at_ms > now_ms, EExpiredUpdate);
    assert_issued_at_not_too_far_in_future(issued_at_ms, now_ms);
    membership::assert_metadata_update_precheck(pass);

    assert!(registry.keys.contains(public_key), EVerifierKeyNotRegistered);
    let key = registry.keys.get(public_key);
    assert!(key.enabled, EVerifierKeyDisabled);
    assert!(key.verifier_family == verifier_family, EVerifierFamilyMismatch);
    assert!(key.verifier_version == verifier_version, EVerifierVersionMismatch);
    assert!(
        ed25519::ed25519_verify(signature, public_key, &signed_message),
        EInvalidSignature,
    );
}

fun assert_public_key_length(public_key: &vector<u8>) {
    assert!(public_key.length() == ED25519_PUBLIC_KEY_LENGTH, EInvalidPublicKeyLength);
}

fun assert_signature_length(signature: &vector<u8>) {
    assert!(signature.length() == ED25519_SIGNATURE_LENGTH, EInvalidSignatureLength);
}

fun assert_allowed_verifier_family(verifier_family: u8) {
    assert!(
        verifier_family == VERIFIER_FAMILY_RESIDENCE
            || verifier_family == VERIFIER_FAMILY_STUDENT
            || verifier_family == VERIFIER_FAMILY_EARTHQUAKE_ORACLE,
        EVerifierFamilyMismatch,
    );
}

fun assert_allowed_verifier_version(verifier_version: u64) {
    assert!(verifier_version == VERIFIER_VERSION_V1, EVerifierVersionMismatch);
}

fun assert_issued_at_not_too_far_in_future(issued_at_ms: u64, now_ms: u64) {
    if (issued_at_ms > now_ms) {
        assert!(issued_at_ms - now_ms <= ALLOWED_CLOCK_SKEW_MS, EFutureIssuedAt);
    };
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
