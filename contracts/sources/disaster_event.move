module contracts::disaster_event;

use contracts::campaign;
use contracts::category_pool::{CategoryPool, CategoryRegistry};
use contracts::metadata_verifier::{Self, VerifierRegistry};
use contracts::payload::{Self, Payload};
use contracts::program::{Self, Campaign};
use std::hash;
use std::string::{Self, String};
use sui::clock::{Self, Clock};
use sui::dynamic_field;
use sui::event;

const EDuplicateDisasterEvent: u64 = 0;
const EDisasterCampaignBindingMismatch: u64 = 1;
const EDuplicateDisasterCampaignBinding: u64 = 2;
const EStaleDisasterEventRevision: u64 = 3;
const EPayloadTooLarge: u64 = 4;
const MAX_PAYLOAD_BCS_BYTES: u64 = 4096;
const SIGNATURE_SCHEME_ED25519: u8 = 1;

public struct DisasterRegistry has key {
    id: UID,
    event_count: u64,
}

public struct DisasterEvent has key {
    id: UID,
    event_uid: vector<u8>,
    event_revision: u32,
    source_event_id: String,
    title: String,
    region: String,
    occurred_at_ms: u64,
    hazard_type: u8,
    hazard_label: String,
    severity_band: u8,
    oracle_version: u64,
    payload_bcs_hash: vector<u8>,
    payload_bcs: vector<u8>,
    signature_scheme: u8,
    verifier_public_key: vector<u8>,
    signature: vector<u8>,
    verifier_registry_id: ID,
    verifier_config_key: u64,
    verifier_config_version: u64,
    enclave_instance_public_key: vector<u8>,
    verified_at_ms: u64,
    freshness_deadline_ms: u64,
    affected_cells_root: vector<u8>,
    affected_cell_count: u64,
    evidence_manifest_uri: String,
    evidence_manifest_hash: vector<u8>,
    created_at_ms: u64,
}

public struct DisasterCampaignBinding has key {
    id: UID,
    campaign_id: ID,
    disaster_event_id: ID,
    event_uid: vector<u8>,
    event_revision: u32,
    created_at_ms: u64,
}

public struct DisasterEventKey has copy, drop, store {
    event_uid: vector<u8>,
    event_revision: u32,
}

public struct LatestDisasterEventRevisionKey has copy, drop, store {
    event_uid: vector<u8>,
}

public struct DisasterCampaignBindingKey has copy, drop, store {
    campaign_id: ID,
}

public struct DisasterRegistryCreated has copy, drop {
    registry_id: ID,
    created_at_ms: u64,
    actor: address,
}

public struct DisasterEventCreated has copy, drop {
    disaster_event_id: ID,
    event_uid: vector<u8>,
    event_revision: u32,
    source_event_id: String,
    title: String,
    region: String,
    hazard_type: u8,
    hazard_label: String,
    oracle_version: u64,
    payload_bcs_hash: vector<u8>,
    affected_cells_root: vector<u8>,
    affected_cell_count: u64,
    evidence_manifest_uri: String,
    evidence_manifest_hash: vector<u8>,
    created_at_ms: u64,
    actor: address,
}

public struct DisasterCampaignBound has copy, drop {
    binding_id: ID,
    campaign_id: ID,
    disaster_event_id: ID,
    event_uid: vector<u8>,
    event_revision: u32,
    created_at_ms: u64,
    actor: address,
}

public(package) fun create_disaster_registry(ctx: &mut TxContext): ID {
    let registry = DisasterRegistry {
        id: object::new(ctx),
        event_count: 0,
    };
    let registry_id = object::id(&registry);
    event::emit(DisasterRegistryCreated {
        registry_id,
        created_at_ms: ctx.epoch_timestamp_ms(),
        actor: ctx.sender(),
    });
    transfer::share_object(registry);
    registry_id
}

public(package) fun create_from_signed_payload(
    registry: &mut DisasterRegistry,
    verifier_registry: &VerifierRegistry,
    clock: &Clock,
    payload_bcs: vector<u8>,
    signature: vector<u8>,
    public_key: vector<u8>,
    ctx: &mut TxContext,
) {
    assert!(payload_bcs.length() <= MAX_PAYLOAD_BCS_BYTES, EPayloadTooLarge);
    let verifier_registry_id = metadata_verifier::registry_id(verifier_registry);
    let now_ms = clock::timestamp_ms(clock);
    let (verifier_config_key, verifier_config_version, enclave_instance_public_key) =
        metadata_verifier::assert_enclave_signed_bytes(
            verifier_registry,
            metadata_verifier::verifier_family_earthquake_oracle(),
            metadata_verifier::earthquake_v1_config_key(),
            &payload_bcs,
            &signature,
            &public_key,
            now_ms,
        );
    let payload = payload::decode_finalized(payload_bcs, now_ms);
    create_from_verified_payload(
        registry,
        payload,
        payload_bcs,
        SIGNATURE_SCHEME_ED25519,
        public_key,
        signature,
        verifier_registry_id,
        verifier_config_key,
        verifier_config_version,
        enclave_instance_public_key,
        ctx,
    );
}

public(package) fun create_from_signed_payload_and_campaign(
    registry: &mut DisasterRegistry,
    verifier_registry: &VerifierRegistry,
    category_registry: &CategoryRegistry,
    category_pool: &CategoryPool,
    clock: &Clock,
    payload_bcs: vector<u8>,
    signature: vector<u8>,
    public_key: vector<u8>,
    ctx: &mut TxContext,
): option::Option<ID> {
    assert!(payload_bcs.length() <= MAX_PAYLOAD_BCS_BYTES, EPayloadTooLarge);
    let verifier_registry_id = metadata_verifier::registry_id(verifier_registry);
    let now_ms = clock::timestamp_ms(clock);
    let (verifier_config_key, verifier_config_version, enclave_instance_public_key) =
        metadata_verifier::assert_enclave_signed_bytes(
            verifier_registry,
            metadata_verifier::verifier_family_earthquake_oracle(),
            metadata_verifier::earthquake_v1_config_key(),
            &payload_bcs,
            &signature,
            &public_key,
            now_ms,
        );
    let payload = payload::decode_finalized(payload_bcs, now_ms);
    let event_uid = payload::event_uid(&payload);
    let event_revision = payload::event_revision(&payload);
    let hazard_type = payload::hazard_type(&payload);
    let severity_band = payload::severity_band(&payload);
    let disaster_event_id = create_from_verified_payload_with_id(
        registry,
        payload,
        payload_bcs,
        SIGNATURE_SCHEME_ED25519,
        public_key,
        signature,
        verifier_registry_id,
        verifier_config_key,
        verifier_config_version,
        enclave_instance_public_key,
        ctx,
    );
    campaign::create_campaign(
        category_registry,
        category_pool,
        disaster_event_id,
        event_uid,
        event_revision,
        hazard_type,
        severity_band,
        clock,
        ctx,
    )
}

public(package) fun bind_campaign(
    registry: &mut DisasterRegistry,
    campaign: &Campaign,
    disaster_event: &DisasterEvent,
    ctx: &mut TxContext,
) {
    let campaign_id = program::campaign_id(campaign);
    let key = DisasterCampaignBindingKey { campaign_id };
    assert!(
        !dynamic_field::exists_with_type<DisasterCampaignBindingKey, bool>(&registry.id, key),
        EDuplicateDisasterCampaignBinding,
    );
    dynamic_field::add(&mut registry.id, key, true);

    let binding = DisasterCampaignBinding {
        id: object::new(ctx),
        campaign_id,
        disaster_event_id: object::id(disaster_event),
        event_uid: disaster_event.event_uid,
        event_revision: disaster_event.event_revision,
        created_at_ms: ctx.epoch_timestamp_ms(),
    };
    let binding_id = object::id(&binding);
    event::emit(DisasterCampaignBound {
        binding_id,
        campaign_id: binding.campaign_id,
        disaster_event_id: binding.disaster_event_id,
        event_uid: binding.event_uid,
        event_revision: binding.event_revision,
        created_at_ms: binding.created_at_ms,
        actor: ctx.sender(),
    });
    transfer::share_object(binding);
}

public(package) fun assert_campaign_binding(
    binding: &DisasterCampaignBinding,
    campaign: &Campaign,
    disaster_event: &DisasterEvent,
) {
    assert!(binding.campaign_id == program::campaign_id(campaign), EDisasterCampaignBindingMismatch);
    assert!(binding.disaster_event_id == object::id(disaster_event), EDisasterCampaignBindingMismatch);
    assert!(binding.event_uid == disaster_event.event_uid, EDisasterCampaignBindingMismatch);
    assert!(binding.event_revision == disaster_event.event_revision, EDisasterCampaignBindingMismatch);
}

fun create_from_verified_payload(
    registry: &mut DisasterRegistry,
    payload: Payload,
    payload_bcs: vector<u8>,
    signature_scheme: u8,
    verifier_public_key: vector<u8>,
    signature: vector<u8>,
    verifier_registry_id: ID,
    verifier_config_key: u64,
    verifier_config_version: u64,
    enclave_instance_public_key: vector<u8>,
    ctx: &mut TxContext,
) {
    create_from_verified_payload_with_id(
        registry,
        payload,
        payload_bcs,
        signature_scheme,
        verifier_public_key,
        signature,
        verifier_registry_id,
        verifier_config_key,
        verifier_config_version,
        enclave_instance_public_key,
        ctx,
    );
}

fun create_from_verified_payload_with_id(
    registry: &mut DisasterRegistry,
    payload: Payload,
    payload_bcs: vector<u8>,
    signature_scheme: u8,
    verifier_public_key: vector<u8>,
    signature: vector<u8>,
    verifier_registry_id: ID,
    verifier_config_key: u64,
    verifier_config_version: u64,
    enclave_instance_public_key: vector<u8>,
    ctx: &mut TxContext,
): ID {
    let event_uid = payload::event_uid(&payload);
    let event_revision = payload::event_revision(&payload);
    let key = DisasterEventKey {
        event_uid,
        event_revision,
    };
    assert!(
        !dynamic_field::exists_with_type<DisasterEventKey, bool>(&registry.id, key),
        EDuplicateDisasterEvent,
    );

    let latest_key = LatestDisasterEventRevisionKey { event_uid };
    if (dynamic_field::exists_with_type<LatestDisasterEventRevisionKey, u32>(
        &registry.id,
        latest_key,
    )) {
        let latest_revision =
            dynamic_field::borrow_mut<LatestDisasterEventRevisionKey, u32>(
                &mut registry.id,
                latest_key,
            );
        assert!(event_revision > *latest_revision, EStaleDisasterEventRevision);
        *latest_revision = event_revision;
    } else {
        dynamic_field::add(&mut registry.id, latest_key, event_revision);
    };

    dynamic_field::add(&mut registry.id, key, true);
    registry.event_count = registry.event_count + 1;

    let disaster_event = DisasterEvent {
        id: object::new(ctx),
        event_uid,
        event_revision,
        source_event_id: string::utf8(payload::source_event_id(&payload)),
        title: string::utf8(payload::title(&payload)),
        region: string::utf8(payload::region(&payload)),
        occurred_at_ms: payload::occurred_at_ms(&payload),
        hazard_type: payload::hazard_type(&payload),
        hazard_label: hazard_label(payload::hazard_type(&payload)),
        severity_band: payload::severity_band(&payload),
        oracle_version: payload::oracle_version(&payload),
        payload_bcs_hash: hash::sha2_256(payload_bcs),
        payload_bcs,
        signature_scheme,
        verifier_public_key,
        signature,
        verifier_registry_id,
        verifier_config_key,
        verifier_config_version,
        enclave_instance_public_key,
        verified_at_ms: payload::verified_at_ms(&payload),
        freshness_deadline_ms: payload::freshness_deadline_ms(&payload),
        affected_cells_root: payload::affected_cells_root(&payload),
        affected_cell_count: payload::affected_cell_count(&payload),
        evidence_manifest_uri: string::utf8(payload::evidence_manifest_uri(&payload)),
        evidence_manifest_hash: payload::evidence_manifest_hash(&payload),
        created_at_ms: ctx.epoch_timestamp_ms(),
    };
    let disaster_event_id = object::id(&disaster_event);

    event::emit(DisasterEventCreated {
        disaster_event_id,
        event_uid: disaster_event.event_uid,
        event_revision: disaster_event.event_revision,
        source_event_id: disaster_event.source_event_id,
        title: disaster_event.title,
        region: disaster_event.region,
        hazard_type: disaster_event.hazard_type,
        hazard_label: disaster_event.hazard_label,
        oracle_version: disaster_event.oracle_version,
        payload_bcs_hash: disaster_event.payload_bcs_hash,
        affected_cells_root: disaster_event.affected_cells_root,
        affected_cell_count: disaster_event.affected_cell_count,
        evidence_manifest_uri: disaster_event.evidence_manifest_uri,
        evidence_manifest_hash: disaster_event.evidence_manifest_hash,
        created_at_ms: disaster_event.created_at_ms,
        actor: ctx.sender(),
    });

    transfer::share_object(disaster_event);
    disaster_event_id
}

#[test_only]
public fun create_from_payload_for_testing(
    registry: &mut DisasterRegistry,
    payload: Payload,
    ctx: &mut TxContext,
) {
    let verifier_registry_id = object::id(registry);
    create_from_verified_payload_with_id(
        registry,
        payload,
        vector[],
        SIGNATURE_SCHEME_ED25519,
        vector[],
        vector[],
        verifier_registry_id,
        0,
        0,
        vector[],
        ctx,
    );
}

#[test_only]
public fun create_for_campaign_testing(
    registry: &mut DisasterRegistry,
    hazard_type: u8,
    severity_band: u8,
    ctx: &mut TxContext,
): (vector<u8>, u32, ID) {
    let event_uid = b"testcampaign00000000000000000000";
    let event_revision = 1u32;
    let p = payload::new_payload_for_testing(
        event_uid,
        event_revision,
        b"test-campaign-source",
        b"Test Campaign Event",
        b"Test Region",
        1_704_067_200_000u64,
        hazard_type,
        severity_band,
        b"\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa\xaa",
        5u64,
        b"https://example.com/evidence",
        b"\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb\xbb",
        1_704_151_200_000u64,
        1_704_172_800_000u64,
    );
    let verifier_registry_id = object::id(registry);
    let de_id = create_from_verified_payload_with_id(
        registry,
        p,
        vector[],
        SIGNATURE_SCHEME_ED25519,
        vector[],
        vector[],
        verifier_registry_id,
        0,
        0,
        vector[],
        ctx,
    );
    (event_uid, event_revision, de_id)
}

public(package) fun affected_cells_root(disaster_event: &DisasterEvent): vector<u8> {
    disaster_event.affected_cells_root
}

public(package) fun event_uid(disaster_event: &DisasterEvent): vector<u8> {
    disaster_event.event_uid
}

public(package) fun event_revision(disaster_event: &DisasterEvent): u32 {
    disaster_event.event_revision
}

public(package) fun occurred_at_ms(disaster_event: &DisasterEvent): u64 {
    disaster_event.occurred_at_ms
}

public(package) fun disaster_registry_event_count(registry: &DisasterRegistry): u64 {
    registry.event_count
}

public(package) fun disaster_event_id(disaster_event: &DisasterEvent): ID {
    object::id(disaster_event)
}

#[test_only]
public fun disaster_event_created_event_fields(
    event: DisasterEventCreated,
): (
    vector<u8>,
    u32,
    String,
    String,
    String,
    vector<u8>,
    vector<u8>,
    u64,
    String,
    vector<u8>,
    address,
) {
    let DisasterEventCreated {
        disaster_event_id: _,
        event_uid,
        event_revision,
        source_event_id,
        title,
        region,
        hazard_type: _,
        hazard_label: _,
        oracle_version: _,
        payload_bcs_hash,
        affected_cells_root,
        affected_cell_count,
        evidence_manifest_uri,
        evidence_manifest_hash,
        created_at_ms: _,
        actor,
    } = event;
    (
        event_uid,
        event_revision,
        source_event_id,
        title,
        region,
        payload_bcs_hash,
        affected_cells_root,
        affected_cell_count,
        evidence_manifest_uri,
        evidence_manifest_hash,
        actor,
    )
}

#[test_only]
public fun certificate_identity_for_testing(
    disaster_event: &DisasterEvent,
): (vector<u8>, u32, String, String, String, u64, u8, String, u8, u64) {
    (
        disaster_event.event_uid,
        disaster_event.event_revision,
        disaster_event.source_event_id,
        disaster_event.title,
        disaster_event.region,
        disaster_event.occurred_at_ms,
        disaster_event.hazard_type,
        disaster_event.hazard_label,
        disaster_event.severity_band,
        disaster_event.oracle_version,
    )
}

#[test_only]
public fun certificate_verifier_for_testing(
    disaster_event: &DisasterEvent,
): (u8, vector<u8>, vector<u8>, ID, u64, u64, vector<u8>) {
    (
        disaster_event.signature_scheme,
        disaster_event.verifier_public_key,
        disaster_event.signature,
        disaster_event.verifier_registry_id,
        disaster_event.verifier_config_key,
        disaster_event.verifier_config_version,
        disaster_event.enclave_instance_public_key,
    )
}

#[test_only]
public fun certificate_evidence_for_testing(
    disaster_event: &DisasterEvent,
): (
    vector<u8>,
    vector<u8>,
    u64,
    u64,
    vector<u8>,
    u64,
    String,
    vector<u8>,
) {
    (
        disaster_event.payload_bcs_hash,
        disaster_event.payload_bcs,
        disaster_event.verified_at_ms,
        disaster_event.freshness_deadline_ms,
        disaster_event.affected_cells_root,
        disaster_event.affected_cell_count,
        disaster_event.evidence_manifest_uri,
        disaster_event.evidence_manifest_hash,
    )
}

fun hazard_label(hazard_type: u8): String {
    if (hazard_type == payload::hazard_type_earthquake()) {
        string::utf8(b"Earthquake")
    } else {
        string::utf8(b"Unknown")
    }
}
