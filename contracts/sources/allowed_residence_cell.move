module contracts::allowed_residence_cell;

use std::hash;
use sui::event;
use sui::bcs;

const EInvalidHashLength: u64 = 0;
const EUnsupportedGeoResolution: u64 = 1;
const GEO_RESOLUTION_RES7: u8 = 7;

public struct AllowedResidenceCellRegistry has key {
    id: UID,
    root: vector<u8>,
    geo_resolution: u8,
    allowlist_version: u64,
    source_hash: vector<u8>,
    updated_at_ms: u64,
}

public struct ResidenceCellLeaf has copy, drop, store {
    h3_index: u64,
    geo_resolution: u8,
    allowlist_version: u64,
}

public struct ProofStep has copy, drop, store {
    sibling_hash: vector<u8>,
    sibling_on_left: bool,
}

public struct AllowedResidenceCellRootUpdated has copy, drop {
    registry_id: ID,
    root: vector<u8>,
    geo_resolution: u8,
    allowlist_version: u64,
    source_hash: vector<u8>,
    updated_at_ms: u64,
    actor: address,
}

public(package) fun create_registry(
    root: vector<u8>,
    geo_resolution: u8,
    allowlist_version: u64,
    source_hash: vector<u8>,
    ctx: &mut TxContext,
): ID {
    assert_32_bytes(&root);
    assert_32_bytes(&source_hash);
    assert_supported_geo_resolution(geo_resolution);

    let registry = AllowedResidenceCellRegistry {
        id: object::new(ctx),
        root,
        geo_resolution,
        allowlist_version,
        source_hash,
        updated_at_ms: ctx.epoch_timestamp_ms(),
    };
    let registry_id = object::id(&registry);
    emit_root_updated(&registry, ctx);
    transfer::share_object(registry);
    registry_id
}

public(package) fun update_root(
    registry: &mut AllowedResidenceCellRegistry,
    root: vector<u8>,
    geo_resolution: u8,
    allowlist_version: u64,
    source_hash: vector<u8>,
    ctx: &TxContext,
) {
    assert_32_bytes(&root);
    assert_32_bytes(&source_hash);
    assert_supported_geo_resolution(geo_resolution);

    registry.root = root;
    registry.geo_resolution = geo_resolution;
    registry.allowlist_version = allowlist_version;
    registry.source_hash = source_hash;
    registry.updated_at_ms = ctx.epoch_timestamp_ms();
    emit_root_updated(registry, ctx);
}

fun new_leaf(
    h3_index: u64,
    geo_resolution: u8,
    allowlist_version: u64,
): ResidenceCellLeaf {
    ResidenceCellLeaf {
        h3_index,
        geo_resolution,
        allowlist_version,
    }
}

public(package) fun new_proof_step_left(sibling_hash: vector<u8>): ProofStep {
    assert_32_bytes(&sibling_hash);
    ProofStep { sibling_hash, sibling_on_left: true }
}

public(package) fun new_proof_step_right(sibling_hash: vector<u8>): ProofStep {
    assert_32_bytes(&sibling_hash);
    ProofStep { sibling_hash, sibling_on_left: false }
}

fun leaf_hash(leaf: &ResidenceCellLeaf): vector<u8> {
    let mut bytes = vector[0x00];
    bytes.append(bcs::to_bytes(leaf));
    hash::sha2_256(bytes)
}

fun verify_proof(
    leaf: &ResidenceCellLeaf,
    proof: vector<ProofStep>,
    expected_root: vector<u8>,
): bool {
    assert_32_bytes(&expected_root);
    let mut current = leaf_hash(leaf);
    let mut i = 0;
    while (i < proof.length()) {
        let step = proof.borrow(i);
        assert_32_bytes(&step.sibling_hash);
        current = internal_hash(&current, &step.sibling_hash, step.sibling_on_left);
        i = i + 1;
    };
    current == expected_root
}

public(package) fun is_valid_home_cell(
    registry: &AllowedResidenceCellRegistry,
    home_cell: u64,
    proof: vector<ProofStep>,
): bool {
    let leaf = new_leaf(
        home_cell,
        registry.geo_resolution,
        registry.allowlist_version,
    );
    verify_proof(&leaf, proof, registry.root)
}

fun emit_root_updated(registry: &AllowedResidenceCellRegistry, ctx: &TxContext) {
    event::emit(AllowedResidenceCellRootUpdated {
        registry_id: object::id(registry),
        root: registry.root,
        geo_resolution: registry.geo_resolution,
        allowlist_version: registry.allowlist_version,
        source_hash: registry.source_hash,
        updated_at_ms: registry.updated_at_ms,
        actor: ctx.sender(),
    });
}

fun internal_hash(
    current: &vector<u8>,
    sibling_hash: &vector<u8>,
    sibling_on_left: bool,
): vector<u8> {
    let mut bytes = vector[0x01];
    if (sibling_on_left) {
        bytes.append(*sibling_hash);
        bytes.append(*current);
    } else {
        bytes.append(*current);
        bytes.append(*sibling_hash);
    };
    hash::sha2_256(bytes)
}

fun assert_32_bytes(bytes: &vector<u8>) {
    assert!(bytes.length() == 32, EInvalidHashLength);
}

fun assert_supported_geo_resolution(geo_resolution: u8) {
    assert!(geo_resolution == GEO_RESOLUTION_RES7, EUnsupportedGeoResolution);
}

#[test_only]
public fun leaf_hash_for_testing(
    h3_index: u64,
    geo_resolution: u8,
    allowlist_version: u64,
): vector<u8> {
    leaf_hash(&new_leaf(h3_index, geo_resolution, allowlist_version))
}

#[test_only]
public fun verify_proof_for_testing(
    h3_index: u64,
    geo_resolution: u8,
    allowlist_version: u64,
    proof: vector<ProofStep>,
    expected_root: vector<u8>,
): bool {
    let leaf = new_leaf(h3_index, geo_resolution, allowlist_version);
    verify_proof(&leaf, proof, expected_root)
}

#[test_only]
public fun registry_fields_for_testing(
    registry: &AllowedResidenceCellRegistry,
): (ID, vector<u8>, u8, u64, vector<u8>, u64) {
    (
        object::id(registry),
        registry.root,
        registry.geo_resolution,
        registry.allowlist_version,
        registry.source_hash,
        registry.updated_at_ms,
    )
}

#[test_only]
public fun root_updated_event_fields(
    event: AllowedResidenceCellRootUpdated,
): (ID, vector<u8>, u8, u64, vector<u8>, u64, address) {
    let AllowedResidenceCellRootUpdated {
        registry_id,
        root,
        geo_resolution,
        allowlist_version,
        source_hash,
        updated_at_ms,
        actor,
    } = event;
    (
        registry_id,
        root,
        geo_resolution,
        allowlist_version,
        source_hash,
        updated_at_ms,
        actor,
    )
}
