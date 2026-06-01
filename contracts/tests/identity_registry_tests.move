#[test_only]
module contracts::identity_registry_tests;

use contracts::accessor;
use contracts::identity_registry;
use contracts::identity_result_v1;
use contracts::membership;
use sui::address;
use sui::bcs;

const MEMBER: address = @0x51A;
const OTHER: address = @0xC0FFEE;
const DUPLICATE_KEY_HASH: vector<u8> = b"duplicate-key-hash";
const RESULT_DUPLICATE_KEY_HASH: vector<u8> =
    x"4444444444444444444444444444444444444444444444444444444444444444";
const OTHER_DUPLICATE_KEY_HASH: vector<u8> =
    x"9999999999999999999999999999999999999999999999999999999999999999";
const EVIDENCE_HASH: vector<u8> =
    x"5555555555555555555555555555555555555555555555555555555555555555";
const SIGNED_STATEMENT_HASH: vector<u8> =
    x"6666666666666666666666666666666666666666666666666666666666666666";
const OTHER_SIGNED_STATEMENT_HASH: vector<u8> =
    x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TERMS_VERSION: u64 = 7;
const NOW_MS: u64 = 1_800_000_000_000;
const ISSUED_AT_MS: u64 = 1_800_000_000_000;
const APPLY_TIME_MS: u64 = 1_800_000_010_000;
const EXPIRES_AT_MS: u64 = 1_831_536_000_000;

#[test]
fun decoded_kyc_result_updates_membership_pass_identity_fields() {
    let (mut registry, membership_registry, mut pass) = setup_step3();
    let pass_id = object::id(&pass);
    let result = decoded_result(
        object::id(&registry),
        pass_id,
        MEMBER,
        accessor::identity_provider_kyc(),
        RESULT_DUPLICATE_KEY_HASH,
        TERMS_VERSION,
        SIGNED_STATEMENT_HASH,
    );

    identity_registry::apply_identity_verification_result(
        &mut registry,
        &membership_registry,
        &mut pass,
        &result,
        APPLY_TIME_MS,
    );

    let (
        _account_created_at_ms,
        _home_cell,
        _home_cell_registered_at_ms,
        identity_verified,
        identity_provider_mask,
        identity_verified_at_ms,
        identity_expires_at_ms,
        terms_version,
        signed_statement_hash,
    ) = accessor::membership_pass_mvp_summary(&pass);
    assert!(identity_verified);
    assert!(identity_provider_mask == accessor::identity_provider_kyc());
    assert!(identity_verified_at_ms == APPLY_TIME_MS);
    assert!(identity_expires_at_ms == EXPIRES_AT_MS);
    assert!(terms_version == TERMS_VERSION);
    assert!(signed_statement_hash == SIGNED_STATEMENT_HASH);
    let (_, provider_label) = accessor::membership_pass_display_labels(&pass);
    assert!(provider_label == b"KYC".to_string());
    assert!(identity_registry::binding_count_for_testing(&registry) == 1);
    assert!(
        identity_registry::bound_pass_lineage_id_for_testing(
            &registry,
            accessor::identity_provider_kyc(),
            RESULT_DUPLICATE_KEY_HASH,
        ) == accessor::membership_pass_lineage_id(&pass),
    );

    cleanup_step3(registry, membership_registry, pass, MEMBER);
}

#[test]
fun decoded_world_id_result_accumulates_provider_mask() {
    let (mut registry, membership_registry, mut pass) = setup_step3();
    let pass_id = object::id(&pass);
    let kyc_result = decoded_result(
        object::id(&registry),
        pass_id,
        MEMBER,
        accessor::identity_provider_kyc(),
        RESULT_DUPLICATE_KEY_HASH,
        TERMS_VERSION,
        SIGNED_STATEMENT_HASH,
    );
    let world_id_result = decoded_result(
        object::id(&registry),
        pass_id,
        MEMBER,
        accessor::identity_provider_world_id(),
        OTHER_DUPLICATE_KEY_HASH,
        TERMS_VERSION,
        SIGNED_STATEMENT_HASH,
    );

    identity_registry::apply_identity_verification_result(
        &mut registry,
        &membership_registry,
        &mut pass,
        &kyc_result,
        APPLY_TIME_MS,
    );
    identity_registry::apply_identity_verification_result(
        &mut registry,
        &membership_registry,
        &mut pass,
        &world_id_result,
        APPLY_TIME_MS + 1,
    );

    let (_, _, _, identity_verified, identity_provider_mask, identity_verified_at_ms, _, _, _) =
        accessor::membership_pass_mvp_summary(&pass);
    assert!(identity_verified);
    assert!(
        identity_provider_mask ==
            accessor::identity_provider_kyc() + accessor::identity_provider_world_id(),
    );
    let (_, provider_label) = accessor::membership_pass_display_labels(&pass);
    assert!(provider_label == b"KYC + World ID".to_string());
    assert!(identity_verified_at_ms == APPLY_TIME_MS + 1);
    assert!(identity_registry::binding_count_for_testing(&registry) == 2);

    cleanup_step3_with_two_bindings(registry, membership_registry, pass, MEMBER);
}

#[test, expected_failure(abort_code = identity_registry::EIdentityRegistryMismatch)]
fun decoded_result_rejects_wrong_identity_registry() {
    let (mut registry, membership_registry, mut pass) = setup_step3();
    let result = decoded_result(
        object::id(&pass),
        object::id(&pass),
        MEMBER,
        accessor::identity_provider_kyc(),
        RESULT_DUPLICATE_KEY_HASH,
        TERMS_VERSION,
        SIGNED_STATEMENT_HASH,
    );

    identity_registry::apply_identity_verification_result(
        &mut registry,
        &membership_registry,
        &mut pass,
        &result,
        APPLY_TIME_MS,
    );

    cleanup_step3(registry, membership_registry, pass, MEMBER);
}

#[test, expected_failure(abort_code = identity_registry::EMembershipIdMismatch)]
fun decoded_result_rejects_wrong_membership_id() {
    let (mut registry, membership_registry, mut pass) = setup_step3();
    let (other_membership_registry, other_pass) = setup_other_step3_pass();
    let result = decoded_result(
        object::id(&registry),
        object::id(&other_pass),
        MEMBER,
        accessor::identity_provider_kyc(),
        RESULT_DUPLICATE_KEY_HASH,
        TERMS_VERSION,
        SIGNED_STATEMENT_HASH,
    );

    identity_registry::apply_identity_verification_result(
        &mut registry,
        &membership_registry,
        &mut pass,
        &result,
        APPLY_TIME_MS,
    );

    cleanup_step3(registry, membership_registry, pass, MEMBER);
    membership::destroy_membership_registry_for_testing(
        other_membership_registry,
        OTHER,
        accessor::membership_pass_lineage_id(&other_pass),
    );
    membership::destroy_pass_for_testing(other_pass);
}

#[test, expected_failure(abort_code = membership::ERegistryPassMismatch)]
fun decoded_result_rejects_pass_that_is_not_membership_registry_current_sbt() {
    let (mut registry, mut membership_registry, mut pass) = setup_step3();
    let result = decoded_result(
        object::id(&registry),
        object::id(&pass),
        MEMBER,
        accessor::identity_provider_kyc(),
        RESULT_DUPLICATE_KEY_HASH,
        TERMS_VERSION,
        SIGNED_STATEMENT_HASH,
    );
    membership::set_current_pass_id_for_testing(
        &mut membership_registry,
        accessor::membership_pass_lineage_id(&pass),
        object::id(&registry),
    );

    identity_registry::apply_identity_verification_result(
        &mut registry,
        &membership_registry,
        &mut pass,
        &result,
        APPLY_TIME_MS,
    );

    cleanup_step3(registry, membership_registry, pass, MEMBER);
}

#[test, expected_failure(abort_code = identity_registry::EOwnerMismatch)]
fun decoded_result_rejects_wrong_owner() {
    let (mut registry, membership_registry, mut pass) = setup_step3();
    let result = decoded_result(
        object::id(&registry),
        object::id(&pass),
        OTHER,
        accessor::identity_provider_kyc(),
        RESULT_DUPLICATE_KEY_HASH,
        TERMS_VERSION,
        SIGNED_STATEMENT_HASH,
    );

    identity_registry::apply_identity_verification_result(
        &mut registry,
        &membership_registry,
        &mut pass,
        &result,
        APPLY_TIME_MS,
    );

    cleanup_step3(registry, membership_registry, pass, MEMBER);
}

#[test, expected_failure(abort_code = membership::EIdentityTermsVersionMismatch)]
fun decoded_result_rejects_terms_version_mismatch() {
    let (mut registry, membership_registry, mut pass) = setup_step3();
    let result = decoded_result(
        object::id(&registry),
        object::id(&pass),
        MEMBER,
        accessor::identity_provider_kyc(),
        RESULT_DUPLICATE_KEY_HASH,
        TERMS_VERSION + 1,
        SIGNED_STATEMENT_HASH,
    );

    identity_registry::apply_identity_verification_result(
        &mut registry,
        &membership_registry,
        &mut pass,
        &result,
        APPLY_TIME_MS,
    );

    cleanup_step3(registry, membership_registry, pass, MEMBER);
}

#[test, expected_failure(abort_code = membership::EIdentitySignedStatementHashMismatch)]
fun decoded_result_rejects_signed_statement_hash_mismatch() {
    let (mut registry, membership_registry, mut pass) = setup_step3();
    let result = decoded_result(
        object::id(&registry),
        object::id(&pass),
        MEMBER,
        accessor::identity_provider_kyc(),
        RESULT_DUPLICATE_KEY_HASH,
        TERMS_VERSION,
        OTHER_SIGNED_STATEMENT_HASH,
    );

    identity_registry::apply_identity_verification_result(
        &mut registry,
        &membership_registry,
        &mut pass,
        &result,
        APPLY_TIME_MS,
    );

    cleanup_step3(registry, membership_registry, pass, MEMBER);
}

#[test, expected_failure(abort_code = identity_registry::EIdentityKeyAlreadyBound)]
fun decoded_result_rejects_duplicate_key_bound_to_another_sbt() {
    let (mut registry, membership_registry, mut pass) = setup_step3();
    let (other_membership_registry, other_pass) = setup_other_step3_pass();
    identity_registry::bind_duplicate_key(
        &mut registry,
        &other_pass,
        accessor::identity_provider_kyc(),
        RESULT_DUPLICATE_KEY_HASH,
    );
    let result = decoded_result(
        object::id(&registry),
        object::id(&pass),
        MEMBER,
        accessor::identity_provider_kyc(),
        RESULT_DUPLICATE_KEY_HASH,
        TERMS_VERSION,
        SIGNED_STATEMENT_HASH,
    );

    identity_registry::apply_identity_verification_result(
        &mut registry,
        &membership_registry,
        &mut pass,
        &result,
        APPLY_TIME_MS,
    );

    cleanup_step3(registry, membership_registry, pass, MEMBER);
    cleanup_other_step3_pass(other_membership_registry, other_pass);
}

#[test, expected_failure(abort_code = membership::EIdentityProviderReplay)]
fun decoded_result_rejects_replay_for_same_provider() {
    let (mut registry, membership_registry, mut pass) = setup_step3();
    let result = decoded_result(
        object::id(&registry),
        object::id(&pass),
        MEMBER,
        accessor::identity_provider_kyc(),
        RESULT_DUPLICATE_KEY_HASH,
        TERMS_VERSION,
        SIGNED_STATEMENT_HASH,
    );

    identity_registry::apply_identity_verification_result(
        &mut registry,
        &membership_registry,
        &mut pass,
        &result,
        APPLY_TIME_MS,
    );
    identity_registry::apply_identity_verification_result(
        &mut registry,
        &membership_registry,
        &mut pass,
        &result,
        APPLY_TIME_MS + 1,
    );

    cleanup_step3(registry, membership_registry, pass, MEMBER);
}

#[test, expected_failure(abort_code = identity_registry::EIdentityKeyAlreadyBound)]
fun kyc_duplicate_key_rejects_different_pass() {
    let (mut registry, pass, other_pass) = setup();

    identity_registry::bind_duplicate_key(
        &mut registry,
        &pass,
        accessor::identity_provider_kyc(),
        DUPLICATE_KEY_HASH,
    );
    identity_registry::bind_duplicate_key(
        &mut registry,
        &other_pass,
        accessor::identity_provider_kyc(),
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
        accessor::identity_provider_world_id(),
        DUPLICATE_KEY_HASH,
    );
    identity_registry::bind_duplicate_key(
        &mut registry,
        &other_pass,
        accessor::identity_provider_world_id(),
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
        accessor::identity_provider_kyc(),
        DUPLICATE_KEY_HASH,
    );
    identity_registry::bind_duplicate_key(
        &mut registry,
        &other_pass,
        accessor::identity_provider_world_id(),
        DUPLICATE_KEY_HASH,
    );

    assert!(identity_registry::binding_count_for_testing(&registry) == 2);
    assert!(
        identity_registry::bound_pass_lineage_id_for_testing(
            &registry,
            accessor::identity_provider_kyc(),
            DUPLICATE_KEY_HASH,
        ) == accessor::membership_pass_lineage_id(&pass),
    );
    assert!(
        identity_registry::bound_pass_lineage_id_for_testing(
            &registry,
            accessor::identity_provider_world_id(),
            DUPLICATE_KEY_HASH,
        ) == accessor::membership_pass_lineage_id(&other_pass),
    );

    identity_registry::remove_binding_for_testing(
        &mut registry,
        accessor::identity_provider_kyc(),
        DUPLICATE_KEY_HASH,
    );
    identity_registry::remove_binding_for_testing(
        &mut registry,
        accessor::identity_provider_world_id(),
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
        accessor::identity_provider_kyc(),
        DUPLICATE_KEY_HASH,
    );
    identity_registry::bind_duplicate_key(
        &mut registry,
        &pass,
        accessor::identity_provider_kyc(),
        DUPLICATE_KEY_HASH,
    );

    assert!(identity_registry::binding_count_for_testing(&registry) == 1);
    assert!(
        identity_registry::bound_pass_lineage_id_for_testing(
            &registry,
            accessor::identity_provider_kyc(),
            DUPLICATE_KEY_HASH,
        ) == accessor::membership_pass_lineage_id(&pass),
    );

    identity_registry::remove_binding_for_testing(
        &mut registry,
        accessor::identity_provider_kyc(),
        DUPLICATE_KEY_HASH,
    );
    cleanup(registry, pass, other_pass);
}

#[test]
fun duplicate_key_binding_check_accepts_same_pass() {
    let (mut registry, pass, other_pass) = setup();

    identity_registry::bind_duplicate_key(
        &mut registry,
        &pass,
        accessor::identity_provider_kyc(),
        DUPLICATE_KEY_HASH,
    );
    identity_registry::assert_duplicate_key_bound_to_pass(
        &registry,
        &pass,
        accessor::identity_provider_kyc(),
        DUPLICATE_KEY_HASH,
    );

    identity_registry::remove_binding_for_testing(
        &mut registry,
        accessor::identity_provider_kyc(),
        DUPLICATE_KEY_HASH,
    );
    cleanup(registry, pass, other_pass);
}

#[test, expected_failure(abort_code = identity_registry::EIdentityKeyNotBound)]
fun duplicate_key_binding_check_rejects_missing_key() {
    let (registry, pass, other_pass) = setup();

    identity_registry::assert_duplicate_key_bound_to_pass(
        &registry,
        &pass,
        accessor::identity_provider_kyc(),
        DUPLICATE_KEY_HASH,
    );

    cleanup(registry, pass, other_pass);
}

#[test, expected_failure(abort_code = identity_registry::EIdentityKeyAlreadyBound)]
fun duplicate_key_binding_check_rejects_different_pass() {
    let (mut registry, pass, other_pass) = setup();

    identity_registry::bind_duplicate_key(
        &mut registry,
        &other_pass,
        accessor::identity_provider_kyc(),
        DUPLICATE_KEY_HASH,
    );
    identity_registry::assert_duplicate_key_bound_to_pass(
        &registry,
        &pass,
        accessor::identity_provider_kyc(),
        DUPLICATE_KEY_HASH,
    );

    cleanup(registry, pass, other_pass);
}

#[test, expected_failure(abort_code = identity_registry::EIdentityKeyNotBound)]
fun duplicate_key_binding_check_rejects_wrong_provider() {
    let (mut registry, pass, other_pass) = setup();

    identity_registry::bind_duplicate_key(
        &mut registry,
        &pass,
        accessor::identity_provider_kyc(),
        DUPLICATE_KEY_HASH,
    );
    identity_registry::assert_duplicate_key_bound_to_pass(
        &registry,
        &pass,
        accessor::identity_provider_world_id(),
        DUPLICATE_KEY_HASH,
    );

    identity_registry::remove_binding_for_testing(
        &mut registry,
        accessor::identity_provider_kyc(),
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

fun setup_step3(): (
    identity_registry::IdentityRegistry,
    membership::MembershipRegistry,
    membership::MembershipPass,
) {
    let mut ctx = tx_context::dummy();
    let registry = identity_registry::create_identity_registry_for_testing(&mut ctx);
    let (membership_registry, pass) = membership::create_registry_and_pass_for_testing(
        MEMBER,
        TERMS_VERSION,
        SIGNED_STATEMENT_HASH,
        &mut ctx,
    );
    (registry, membership_registry, pass)
}

fun setup_other_step3_pass(): (membership::MembershipRegistry, membership::MembershipPass) {
    let mut ctx = tx_context::dummy();
    membership::create_registry_and_pass_for_testing(
        OTHER,
        TERMS_VERSION,
        SIGNED_STATEMENT_HASH,
        &mut ctx,
    )
}

fun cleanup_step3(
    mut registry: identity_registry::IdentityRegistry,
    membership_registry: membership::MembershipRegistry,
    pass: membership::MembershipPass,
    owner: address,
) {
    identity_registry::remove_binding_for_testing(
        &mut registry,
        accessor::identity_provider_kyc(),
        RESULT_DUPLICATE_KEY_HASH,
    );
    identity_registry::destroy_identity_registry_for_testing(registry);
    membership::destroy_membership_registry_for_testing(
        membership_registry,
        owner,
        accessor::membership_pass_lineage_id(&pass),
    );
    membership::destroy_pass_for_testing(pass);
}

fun cleanup_step3_with_two_bindings(
    mut registry: identity_registry::IdentityRegistry,
    membership_registry: membership::MembershipRegistry,
    pass: membership::MembershipPass,
    owner: address,
) {
    identity_registry::remove_binding_for_testing(
        &mut registry,
        accessor::identity_provider_kyc(),
        RESULT_DUPLICATE_KEY_HASH,
    );
    identity_registry::remove_binding_for_testing(
        &mut registry,
        accessor::identity_provider_world_id(),
        OTHER_DUPLICATE_KEY_HASH,
    );
    identity_registry::destroy_identity_registry_for_testing(registry);
    membership::destroy_membership_registry_for_testing(
        membership_registry,
        owner,
        accessor::membership_pass_lineage_id(&pass),
    );
    membership::destroy_pass_for_testing(pass);
}

fun cleanup_other_step3_pass(
    membership_registry: membership::MembershipRegistry,
    pass: membership::MembershipPass,
) {
    membership::destroy_membership_registry_for_testing(
        membership_registry,
        OTHER,
        accessor::membership_pass_lineage_id(&pass),
    );
    membership::destroy_pass_for_testing(pass);
}

fun decoded_result(
    registry_id: ID,
    membership_id: ID,
    owner: address,
    provider: u8,
    duplicate_key_hash: vector<u8>,
    terms_version: u64,
    signed_statement_hash: vector<u8>,
): identity_result_v1::IdentityVerificationResult {
    identity_result_v1::decode_verified(
        identity_result_bcs(
            registry_id,
            membership_id,
            owner,
            provider,
            duplicate_key_hash,
            terms_version,
            signed_statement_hash,
        ),
        NOW_MS,
    )
}

fun identity_result_bcs(
    registry_id: ID,
    membership_id: ID,
    owner: address,
    provider: u8,
    duplicate_key_hash: vector<u8>,
    terms_version: u64,
    signed_statement_hash: vector<u8>,
): vector<u8> {
    let issued_at_ms = ISSUED_AT_MS;
    let expires_at_ms = EXPIRES_AT_MS;
    let mut bytes = bcs::to_bytes(&b"SONARI_IDENTITY_VERIFICATION_V1");
    bytes.append(bcs::to_bytes(&b"identity"));
    bytes.append(bcs::to_bytes(&1u64));
    bytes.append(object::id_to_bytes(&registry_id));
    bytes.append(object::id_to_bytes(&membership_id));
    bytes.append(address::to_bytes(owner));
    bytes.append(bcs::to_bytes(&provider));
    bytes.append(bcs::to_bytes(&true));
    bytes.append(duplicate_key_hash);
    bytes.append(EVIDENCE_HASH);
    bytes.append(bcs::to_bytes(&issued_at_ms));
    bytes.append(bcs::to_bytes(&expires_at_ms));
    bytes.append(bcs::to_bytes(&terms_version));
    bytes.append(signed_statement_hash);
    bytes
}
