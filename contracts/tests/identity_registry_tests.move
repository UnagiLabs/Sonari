#[test_only]
module contracts::identity_registry_tests;

use contracts::identity_registry;
use contracts::membership;

const MEMBER: address = @0x51A;
const OTHER: address = @0xC0FFEE;
const DUPLICATE_KEY_HASH: vector<u8> = b"duplicate-key-hash";

#[test, expected_failure(abort_code = identity_registry::EIdentityKeyAlreadyBound)]
fun kyc_duplicate_key_rejects_different_pass() {
    let (mut registry, pass, other_pass) = setup();

    identity_registry::bind_duplicate_key(
        &mut registry,
        &pass,
        identity_registry::provider_kyc(),
        DUPLICATE_KEY_HASH,
    );
    identity_registry::bind_duplicate_key(
        &mut registry,
        &other_pass,
        identity_registry::provider_kyc(),
        DUPLICATE_KEY_HASH,
    );

    cleanup(registry, pass, other_pass);
}

#[test, expected_failure(abort_code = identity_registry::EIdentityKeyAlreadyBound)]
fun world_id_duplicate_key_rejects_different_pass() {
    let (mut registry, pass, other_pass) = setup();

    identity_registry::bind_duplicate_key(
        &mut registry,
        &pass,
        identity_registry::provider_world_id(),
        DUPLICATE_KEY_HASH,
    );
    identity_registry::bind_duplicate_key(
        &mut registry,
        &other_pass,
        identity_registry::provider_world_id(),
        DUPLICATE_KEY_HASH,
    );

    cleanup(registry, pass, other_pass);
}

#[test]
fun same_hash_across_providers_is_allowed() {
    let (mut registry, pass, other_pass) = setup();

    identity_registry::bind_duplicate_key(
        &mut registry,
        &pass,
        identity_registry::provider_kyc(),
        DUPLICATE_KEY_HASH,
    );
    identity_registry::bind_duplicate_key(
        &mut registry,
        &other_pass,
        identity_registry::provider_world_id(),
        DUPLICATE_KEY_HASH,
    );

    assert!(identity_registry::binding_count_for_testing(&registry) == 2);
    assert!(
        identity_registry::bound_pass_lineage_id_for_testing(
            &registry,
            identity_registry::provider_kyc(),
            DUPLICATE_KEY_HASH,
        ) == membership::membership_pass_lineage_id(&pass),
    );
    assert!(
        identity_registry::bound_pass_lineage_id_for_testing(
            &registry,
            identity_registry::provider_world_id(),
            DUPLICATE_KEY_HASH,
        ) == membership::membership_pass_lineage_id(&other_pass),
    );

    identity_registry::remove_binding_for_testing(
        &mut registry,
        identity_registry::provider_kyc(),
        DUPLICATE_KEY_HASH,
    );
    identity_registry::remove_binding_for_testing(
        &mut registry,
        identity_registry::provider_world_id(),
        DUPLICATE_KEY_HASH,
    );
    cleanup(registry, pass, other_pass);
}

#[test]
fun same_key_same_pass_is_idempotent() {
    let (mut registry, pass, other_pass) = setup();

    identity_registry::bind_duplicate_key(
        &mut registry,
        &pass,
        identity_registry::provider_kyc(),
        DUPLICATE_KEY_HASH,
    );
    identity_registry::bind_duplicate_key(
        &mut registry,
        &pass,
        identity_registry::provider_kyc(),
        DUPLICATE_KEY_HASH,
    );

    assert!(identity_registry::binding_count_for_testing(&registry) == 1);
    assert!(
        identity_registry::bound_pass_lineage_id_for_testing(
            &registry,
            identity_registry::provider_kyc(),
            DUPLICATE_KEY_HASH,
        ) == membership::membership_pass_lineage_id(&pass),
    );

    identity_registry::remove_binding_for_testing(
        &mut registry,
        identity_registry::provider_kyc(),
        DUPLICATE_KEY_HASH,
    );
    cleanup(registry, pass, other_pass);
}

fun setup(): (
    identity_registry::IdentityRegistry,
    membership::MembershipPass,
    membership::MembershipPass,
) {
    let mut ctx = tx_context::dummy();
    let registry = identity_registry::create_identity_registry_for_testing(&mut ctx);
    let pass = membership::create_pass_for_testing(MEMBER, &mut ctx);
    let other_pass = membership::create_pass_for_testing(OTHER, &mut ctx);
    (registry, pass, other_pass)
}

fun cleanup(
    registry: identity_registry::IdentityRegistry,
    pass: membership::MembershipPass,
    other_pass: membership::MembershipPass,
) {
    identity_registry::destroy_identity_registry_for_testing(registry);
    membership::destroy_pass_for_testing(pass);
    membership::destroy_pass_for_testing(other_pass);
}
