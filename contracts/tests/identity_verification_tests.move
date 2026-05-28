#[test_only]
module contracts::identity_verification_tests;

use contracts::accessor;
use contracts::admin;
use contracts::identity_registry;
use contracts::membership;
use contracts::metadata_verifier;
use sui::address;
use sui::bcs;
use sui::clock;
use sui::test_scenario;

const ADMIN: address = @0xA11CE;
const MEMBER: address = @0x51A;
const RELAYER: address = @0xB0B;

const NOW_MS: u64 = 1_800_000_000_000;
const ISSUED_AT_MS: u64 = 1_800_000_000_000;
const EXPIRES_AT_MS: u64 = 1_831_536_000_000;
const TERMS_VERSION: u64 = 7;
const KYC_DUPLICATE_KEY_HASH: vector<u8> =
    x"4444444444444444444444444444444444444444444444444444444444444444";
const WORLD_ID_DUPLICATE_KEY_HASH: vector<u8> =
    x"9999999999999999999999999999999999999999999999999999999999999999";
const EVIDENCE_HASH: vector<u8> =
    x"5555555555555555555555555555555555555555555555555555555555555555";
const SIGNED_STATEMENT_HASH: vector<u8> =
    x"6666666666666666666666666666666666666666666666666666666666666666";

#[test]
fun relayer_without_admin_cap_can_submit_signed_kyc_result() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_MS);
    let mut scenario = initialized_with_registered_member();
    add_identity_verifier_key(&mut scenario);

    submit_identity_result(
        &mut scenario,
        &clock,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
        kyc_signature(),
    );

    scenario.end();
    clock.destroy_for_testing();
}

#[test]
fun relayer_without_admin_cap_can_submit_signed_world_id_result() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_MS);
    let mut scenario = initialized_with_registered_member();
    add_identity_verifier_key(&mut scenario);

    submit_identity_result(
        &mut scenario,
        &clock,
        identity_registry::provider_world_id(),
        WORLD_ID_DUPLICATE_KEY_HASH,
        world_id_signature(),
    );

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = metadata_verifier::EInvalidSignature)]
fun invalid_identity_result_signature_is_rejected() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_MS);
    let mut scenario = initialized_with_registered_member();
    add_identity_verifier_key(&mut scenario);

    let mut signature = kyc_signature();
    *signature.borrow_mut(0) = 1;
    submit_identity_result(
        &mut scenario,
        &clock,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
        signature,
    );

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = metadata_verifier::EVerifierKeyDisabled)]
fun disabled_identity_verifier_key_is_rejected() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_MS);
    let mut scenario = initialized_with_registered_member();
    add_disabled_identity_verifier_key(&mut scenario);

    submit_identity_result(
        &mut scenario,
        &clock,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
        kyc_signature(),
    );

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = admin::EGlobalPaused)]
fun global_pause_blocks_signed_identity_update() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_MS);
    let mut scenario = initialized_with_registered_member();
    add_identity_verifier_key(&mut scenario);
    pause_global(&mut scenario);

    submit_identity_result(
        &mut scenario,
        &clock,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
        kyc_signature(),
    );

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = admin::ETargetPaused)]
fun identity_registry_target_pause_blocks_signed_identity_update() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_MS);
    let mut scenario = initialized_with_registered_member();
    add_identity_verifier_key(&mut scenario);
    let target_id = identity_registry_id(&mut scenario);
    pause_target(&mut scenario, identity_registry::target_kind_identity_registry(), target_id);

    submit_identity_result(
        &mut scenario,
        &clock,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
        kyc_signature(),
    );

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = admin::ETargetPaused)]
fun membership_registry_target_pause_blocks_signed_identity_update() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_MS);
    let mut scenario = initialized_with_registered_member();
    add_identity_verifier_key(&mut scenario);
    let target_id = membership_registry_id(&mut scenario);
    pause_target(&mut scenario, membership::target_kind_membership_registry(), target_id);

    submit_identity_result(
        &mut scenario,
        &clock,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
        kyc_signature(),
    );

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = admin::ETargetPaused)]
fun verifier_registry_target_pause_blocks_signed_identity_update() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_MS);
    let mut scenario = initialized_with_registered_member();
    add_identity_verifier_key(&mut scenario);
    let target_id = verifier_registry_id(&mut scenario);
    pause_target(&mut scenario, metadata_verifier::target_kind_verifier_registry(), target_id);

    submit_identity_result(
        &mut scenario,
        &clock,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
        kyc_signature(),
    );

    scenario.end();
    clock.destroy_for_testing();
}

fun initialized_with_registered_member(): test_scenario::Scenario {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());

    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut membership_registry = scenario.take_shared<membership::MembershipRegistry>();
        accessor::register_member(
            &pause_state,
            &mut membership_registry,
            617700169958293503,
            TERMS_VERSION,
            SIGNED_STATEMENT_HASH,
            scenario.ctx(),
        );
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(membership_registry);
    };

    scenario
}

fun add_identity_verifier_key(scenario: &mut test_scenario::Scenario) {
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        admin::add_verifier_key(
            &cap,
            &mut verifier_registry,
            metadata_verifier::verifier_family_identity(),
            metadata_verifier::verifier_version_v1(),
            identity_public_key(),
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(verifier_registry);
    };
}

fun add_disabled_identity_verifier_key(scenario: &mut test_scenario::Scenario) {
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        admin::add_verifier_key(
            &cap,
            &mut verifier_registry,
            metadata_verifier::verifier_family_identity(),
            metadata_verifier::verifier_version_v1(),
            identity_public_key(),
            scenario.ctx(),
        );
        admin::disable_verifier_key(
            &cap,
            &mut verifier_registry,
            identity_public_key(),
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(verifier_registry);
    };
}

fun pause_global(scenario: &mut test_scenario::Scenario) {
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pause_state = scenario.take_shared<admin::PauseState>();
        admin::pause_global(&cap, &mut pause_state, scenario.ctx());
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
    };
}

fun pause_target(scenario: &mut test_scenario::Scenario, target_kind: u8, target_id: ID) {
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pause_state = scenario.take_shared<admin::PauseState>();
        admin::pause_target(&cap, &mut pause_state, target_kind, target_id, scenario.ctx());
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
    };
}

fun identity_registry_id(scenario: &mut test_scenario::Scenario): ID {
    scenario.next_tx(ADMIN);
    {
        let registry = scenario.take_shared<identity_registry::IdentityRegistry>();
        let id = identity_registry::registry_id(&registry);
        test_scenario::return_shared(registry);
        id
    }
}

fun membership_registry_id(scenario: &mut test_scenario::Scenario): ID {
    scenario.next_tx(ADMIN);
    {
        let registry = scenario.take_shared<membership::MembershipRegistry>();
        let id = membership::registry_id(&registry);
        test_scenario::return_shared(registry);
        id
    }
}

fun verifier_registry_id(scenario: &mut test_scenario::Scenario): ID {
    scenario.next_tx(ADMIN);
    {
        let registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        let id = metadata_verifier::registry_id(&registry);
        test_scenario::return_shared(registry);
        id
    }
}

fun submit_identity_result(
    scenario: &mut test_scenario::Scenario,
    clock: &clock::Clock,
    provider: u8,
    duplicate_key_hash: vector<u8>,
    signature: vector<u8>,
) {
    scenario.next_tx(RELAYER);
    {
        assert!(!scenario.has_most_recent_for_sender<admin::AdminCap>());
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut identity_registry = scenario.take_shared<identity_registry::IdentityRegistry>();
        let membership_registry = scenario.take_shared<membership::MembershipRegistry>();
        let verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        let mut pass = test_scenario::take_from_address<membership::MembershipPass>(
            scenario,
            MEMBER,
        );
        let payload_bcs = identity_result_bcs(
            identity_registry::registry_id(&identity_registry),
            object::id(&pass),
            MEMBER,
            provider,
            duplicate_key_hash,
        );

        accessor::update_identity_verification(
            &pause_state,
            &mut identity_registry,
            &membership_registry,
            &verifier_registry,
            &mut pass,
            clock,
            payload_bcs,
            signature,
            identity_public_key(),
            scenario.ctx(),
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
        ) = membership::membership_pass_mvp_summary(&pass);
        assert!(identity_verified);
        assert!(identity_provider_mask == provider);
        assert!(identity_verified_at_ms == NOW_MS);
        assert!(identity_expires_at_ms == EXPIRES_AT_MS);
        assert!(terms_version == TERMS_VERSION);
        assert!(signed_statement_hash == SIGNED_STATEMENT_HASH);

        test_scenario::return_to_address(MEMBER, pass);
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(identity_registry);
        test_scenario::return_shared(membership_registry);
        test_scenario::return_shared(verifier_registry);
    };
}

fun identity_result_bcs(
    registry_id: ID,
    membership_id: ID,
    owner: address,
    provider: u8,
    duplicate_key_hash: vector<u8>,
): vector<u8> {
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
    let issued_at_ms = ISSUED_AT_MS;
    let expires_at_ms = EXPIRES_AT_MS;
    let terms_version = TERMS_VERSION;
    bytes.append(bcs::to_bytes(&issued_at_ms));
    bytes.append(bcs::to_bytes(&expires_at_ms));
    bytes.append(bcs::to_bytes(&terms_version));
    bytes.append(SIGNED_STATEMENT_HASH);
    bytes
}

fun identity_public_key(): vector<u8> {
    x"d48258c427f21c839d84d58b8599788a4327ee1a96ef8b2ecf29ca912fe24f43"
}

fun kyc_signature(): vector<u8> {
    x"825580c97380e0dd163cb5e713466491fcfd99c82cc5aa5e135e5babc20720fd2b1076236a1de3d50921d705fa743168b361af523b3f7cc43c54a00f7251ce04"
}

fun world_id_signature(): vector<u8> {
    x"7e392ec6d0702b6ae20611ccd23772b233a4548e7f1c4a4f7629ab097f667677b094b400bebe55b063a92493f5a5268404ede3394f30d9e7871cb25d70ce1b0c"
}
