#[test_only]
module contracts::identity_verification_tests;

use contracts::accessor;
use contracts::admin;
use contracts::allowed_residence_cell;
use contracts::identity_registry;
use contracts::identity_result_v1;
use contracts::membership;
use contracts::metadata_verifier;
use contracts::reader;
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
const INSTANCE_EXPIRES_AT_MS: u64 = 1_900_000_000_000;
const INSTANCE_EXPIRED_AT_MS: u64 = 1_700_000_000_000;
const HOME_CELL: u64 = 608_819_013_597_790_207;
const GEO_RESOLUTION: u8 = 7;
const ALLOWLIST_VERSION: u64 = 1;
const TERMS_VERSION: u64 = 7;
const KYC_DUPLICATE_KEY_HASH: vector<u8> =
    x"4444444444444444444444444444444444444444444444444444444444444444";
const WORLD_ID_DUPLICATE_KEY_HASH: vector<u8> =
    x"9999999999999999999999999999999999999999999999999999999999999999";
const EVIDENCE_HASH: vector<u8> =
    x"5555555555555555555555555555555555555555555555555555555555555555";
const SIGNED_STATEMENT_HASH: vector<u8> =
    x"6666666666666666666666666666666666666666666666666666666666666666";
const REGISTRY_ID_OFFSET: u64 = 49;
const MEMBERSHIP_ID_OFFSET: u64 = 81;
const OWNER_OFFSET: u64 = 144;
const PROVIDER_OFFSET: u64 = 145;
const VERIFIED_OFFSET: u64 = 146;

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

#[test]
fun rust_fixture_signed_world_id_result_updates_identity_registry_record() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_MS);
    let mut scenario = initialized_with_registered_member();
    add_identity_enclave_instance_with_public_key(&mut scenario, rust_fixture_public_key());

    scenario.next_tx(RELAYER);
    {
        assert!(!scenario.has_most_recent_for_sender<admin::AdminCap>());
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut identity_registry = scenario.take_shared<identity_registry::IdentityRegistry>();
        let membership_registry = scenario.take_shared<membership::MembershipRegistry>();
        let verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        // pass は payload 構築用の object::id(&pass) を取得するためだけに take する。accessor には渡さない。
        let pass = test_scenario::take_from_address<membership::MembershipPass>(
            &scenario,
            MEMBER,
        );

        accessor::update_identity_verification(
            &pause_state,
            &mut identity_registry,
            &membership_registry,
            &verifier_registry,
            &clock,
            rust_fixture_payload_bcs(),
            rust_fixture_signature(),
            rust_fixture_public_key(),
            scenario.ctx(),
        );

        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);
        let (owner, provider_mask, verified_at_ms, expires_at_ms, terms_version, signed_statement_hash) =
            identity_registry::identity_verification_record_for_testing(
                &identity_registry,
                pass_lineage_id,
            );
        assert!(owner == MEMBER);
        assert!(provider_mask == identity_registry::provider_world_id());
        assert!(verified_at_ms == NOW_MS);
        assert!(expires_at_ms == EXPIRES_AT_MS);
        assert!(terms_version == TERMS_VERSION);
        assert!(signed_statement_hash == SIGNED_STATEMENT_HASH);
        identity_registry::assert_duplicate_key_bound_to_pass(
            &identity_registry,
            pass_lineage_id,
            identity_registry::provider_world_id(),
            rust_fixture_world_id_duplicate_key_hash(),
        );

        test_scenario::return_to_address(MEMBER, pass);
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(identity_registry);
        test_scenario::return_shared(membership_registry);
        test_scenario::return_shared(verifier_registry);
    };

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

#[test, expected_failure(abort_code = identity_result_v1::EExpiredResult)]
fun signed_identity_result_expired_is_rejected_at_public_accessor() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(EXPIRES_AT_MS);
    let mut scenario = initialized_with_registered_member();
    add_step5_identity_verifier_key(&mut scenario);

    submit_identity_result_for_key(
        &mut scenario,
        &clock,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
        step5_kyc_signature(),
        step5_public_key(),
    );

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = identity_registry::EIdentityRegistryMismatch)]
fun signed_identity_result_wrong_registry_is_rejected_at_public_accessor() {
    submit_mutated_step5_kyc_result(REGISTRY_ID_OFFSET, 0x76, step5_wrong_registry_signature());
}

#[test, expected_failure(abort_code = identity_registry::EMembershipIdMismatch)]
fun signed_identity_result_wrong_membership_is_rejected_at_public_accessor() {
    submit_mutated_step5_kyc_result(MEMBERSHIP_ID_OFFSET, 0x73, step5_wrong_membership_signature());
}

#[test, expected_failure(abort_code = membership::ERegistryRecordNotFound)]
fun signed_identity_result_wrong_owner_is_rejected_at_public_accessor() {
    // owner 改ざん → owner から lineage を引けず ERegistryRecordNotFound で abort
    submit_mutated_step5_kyc_result(OWNER_OFFSET, 0x1b, step5_wrong_owner_signature());
}

#[test, expected_failure(abort_code = identity_result_v1::EUnsupportedProvider)]
fun signed_identity_result_wrong_provider_is_rejected_at_public_accessor() {
    submit_mutated_step5_kyc_result(PROVIDER_OFFSET, 3, step5_wrong_provider_signature());
}

#[test, expected_failure(abort_code = identity_result_v1::EUnverifiedResult)]
fun signed_identity_result_verified_false_is_rejected_at_public_accessor() {
    submit_mutated_step5_kyc_result(VERIFIED_OFFSET, 0, step5_verified_false_signature());
}

// terms_mismatch / statement_hash_mismatch テストは STEP3 設計で削除:
// 新設計では payload 値をそのまま registry record に記録し、register 値との照合を行わない。

#[test, expected_failure(abort_code = identity_registry::EIdentityProviderReplay)]
fun signed_identity_result_replay_is_rejected_at_public_accessor() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_MS);
    let mut scenario = initialized_with_registered_member();
    add_step5_identity_verifier_key(&mut scenario);

    submit_identity_result_for_key(
        &mut scenario,
        &clock,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
        step5_kyc_signature(),
        step5_public_key(),
    );
    submit_identity_result_for_key(
        &mut scenario,
        &clock,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY_HASH,
        step5_kyc_signature(),
        step5_public_key(),
    );

    scenario.end();
    clock.destroy_for_testing();
}

#[test, expected_failure(abort_code = metadata_verifier::EEnclaveInstanceDisabled)]
fun disabled_identity_enclave_instance_is_rejected() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_MS);
    let mut scenario = initialized_with_registered_member();
    add_disabled_identity_enclave_instance(&mut scenario);

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

#[test, expected_failure(abort_code = metadata_verifier::EEnclaveInstanceNotRegistered)]
fun unregistered_identity_enclave_instance_is_rejected() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_MS);
    let mut scenario = initialized_with_registered_member();
    create_identity_config(&mut scenario);

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

#[test, expected_failure(abort_code = metadata_verifier::EEnclaveInstanceConfigMismatch)]
fun stale_identity_enclave_instance_after_config_update_is_rejected() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_MS);
    let mut scenario = initialized_with_registered_member();
    create_identity_config(&mut scenario);
    add_identity_instance(&mut scenario, identity_public_key());
    update_identity_config_pcrs(&mut scenario);

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

#[test, expected_failure(abort_code = metadata_verifier::EVerifierConfigAlreadyDisabled)]
fun disabled_identity_config_is_rejected_at_public_accessor() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_MS);
    let mut scenario = initialized_with_registered_member();
    create_identity_config(&mut scenario);
    add_identity_instance(&mut scenario, identity_public_key());
    disable_identity_config(&mut scenario);

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

#[test, expected_failure(abort_code = metadata_verifier::EEnclaveInstanceExpired)]
fun expired_identity_enclave_instance_is_rejected_at_public_accessor() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_MS);
    let mut scenario = initialized_with_registered_member();
    create_identity_config(&mut scenario);
    add_expired_identity_instance(&mut scenario, identity_public_key());

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
    pause_target(&mut scenario, reader::target_kind_identity_registry(), target_id);

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
    pause_target(&mut scenario, reader::target_kind_membership_registry(), target_id);

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
    pause_target(&mut scenario, reader::target_kind_verifier_registry(), target_id);

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

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut residence_registry =
            scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();
        admin::update_allowed_residence_cell_root(
            &cap,
            &mut residence_registry,
            residence_root(),
            GEO_RESOLUTION,
            ALLOWLIST_VERSION,
            source_hash(),
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(residence_registry);
    };

    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut membership_registry = scenario.take_shared<membership::MembershipRegistry>();
        let residence_registry =
            scenario.take_shared<allowed_residence_cell::AllowedResidenceCellRegistry>();
        accessor::register_member(
            &pause_state,
            &mut membership_registry,
            &residence_registry,
            HOME_CELL,
            residence_proof(),
            TERMS_VERSION,
            SIGNED_STATEMENT_HASH,
            scenario.ctx(),
        );
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(membership_registry);
        test_scenario::return_shared(residence_registry);
    };

    scenario
}

fun residence_proof(): vector<allowed_residence_cell::ProofStep> {
    vector[
        accessor::new_residence_proof_step_left(
            x"07985a56b782bd13b8ec079d4c243c8c2399605872223fc86066f59f4ae37569",
        ),
        accessor::new_residence_proof_step_right(
            x"8f8a501ba455071229e715f5eccb4322190440fa2ecb6b72d123378648b60ec7",
        ),
    ]
}

fun residence_root(): vector<u8> {
    x"a26a12dc49754fde5b90e6bff69d1bc8b51fb8a3de07aa9122a9a2958bb75020"
}

fun source_hash(): vector<u8> {
    x"1111111111111111111111111111111111111111111111111111111111111111"
}

fun add_identity_verifier_key(scenario: &mut test_scenario::Scenario) {
    add_identity_enclave_instance_with_public_key(scenario, identity_public_key());
}

fun add_step5_identity_verifier_key(scenario: &mut test_scenario::Scenario) {
    add_identity_enclave_instance_with_public_key(scenario, step5_public_key());
}

fun add_identity_enclave_instance_with_public_key(
    scenario: &mut test_scenario::Scenario,
    public_key: vector<u8>,
) {
    create_identity_config(scenario);
    add_identity_instance(scenario, public_key);
}

fun create_identity_config(scenario: &mut test_scenario::Scenario) {
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        metadata_verifier::create_identity_verifier_config_for_testing(
            &mut verifier_registry,
            identity_pcr0(),
            identity_pcr1(),
            identity_pcr2(),
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(verifier_registry);
    };
}

fun add_identity_instance(scenario: &mut test_scenario::Scenario, public_key: vector<u8>) {
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        metadata_verifier::add_enclave_instance_for_config_for_testing(
            &mut verifier_registry,
            metadata_verifier::identity_v1_config_key(),
            public_key,
            INSTANCE_EXPIRES_AT_MS,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(verifier_registry);
    };
}

fun add_expired_identity_instance(
    scenario: &mut test_scenario::Scenario,
    public_key: vector<u8>,
) {
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        metadata_verifier::add_enclave_instance_for_config_for_testing(
            &mut verifier_registry,
            metadata_verifier::identity_v1_config_key(),
            public_key,
            INSTANCE_EXPIRED_AT_MS,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(verifier_registry);
    };
}

fun disable_identity_config(scenario: &mut test_scenario::Scenario) {
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        admin::disable_identity_verifier_config(
            &cap,
            &mut verifier_registry,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(verifier_registry);
    };
}

fun update_identity_config_pcrs(scenario: &mut test_scenario::Scenario) {
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        metadata_verifier::update_identity_verifier_config_pcrs_for_testing(
            &mut verifier_registry,
            updated_identity_pcr0(),
            identity_pcr1(),
            identity_pcr2(),
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(verifier_registry);
    };
}

fun disable_identity_instance(scenario: &mut test_scenario::Scenario, public_key: vector<u8>) {
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        metadata_verifier::disable_enclave_instance_for_testing(
            &mut verifier_registry,
            public_key,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(verifier_registry);
    };
}

fun add_disabled_identity_enclave_instance(scenario: &mut test_scenario::Scenario) {
    create_identity_config(scenario);
    add_identity_instance(scenario, identity_public_key());
    disable_identity_instance(scenario, identity_public_key());
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
    submit_identity_result_for_key(
        scenario,
        clock,
        provider,
        duplicate_key_hash,
        signature,
        identity_public_key(),
    );
}

fun submit_identity_result_for_key(
    scenario: &mut test_scenario::Scenario,
    clock: &clock::Clock,
    provider: u8,
    duplicate_key_hash: vector<u8>,
    signature: vector<u8>,
    public_key: vector<u8>,
) {
    scenario.next_tx(RELAYER);
    {
        assert!(!scenario.has_most_recent_for_sender<admin::AdminCap>());
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut identity_registry = scenario.take_shared<identity_registry::IdentityRegistry>();
        let membership_registry = scenario.take_shared<membership::MembershipRegistry>();
        let verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        // pass は payload 構築（membership_id 取得）のためだけに take する。accessor には渡さない。
        let pass = test_scenario::take_from_address<membership::MembershipPass>(
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
            clock,
            payload_bcs,
            signature,
            public_key,
            scenario.ctx(),
        );

        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);
        let (_, provider_mask, verified_at_ms, expires_at_ms, terms_version, signed_statement_hash) =
            identity_registry::identity_verification_record_for_testing(
                &identity_registry,
                pass_lineage_id,
            );
        assert!(provider_mask == provider);
        assert!(verified_at_ms == NOW_MS);
        assert!(expires_at_ms == EXPIRES_AT_MS);
        assert!(terms_version == TERMS_VERSION);
        assert!(signed_statement_hash == SIGNED_STATEMENT_HASH);

        test_scenario::return_to_address(MEMBER, pass);
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(identity_registry);
        test_scenario::return_shared(membership_registry);
        test_scenario::return_shared(verifier_registry);
    };
}

fun submit_mutated_step5_kyc_result(offset: u64, value: u8, signature: vector<u8>) {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_MS);
    let mut scenario = initialized_with_registered_member();
    add_step5_identity_verifier_key(&mut scenario);

    submit_mutated_identity_result_for_key(
        &mut scenario,
        &clock,
        offset,
        value,
        signature,
        step5_public_key(),
    );

    scenario.end();
    clock.destroy_for_testing();
}

fun submit_mutated_identity_result_for_key(
    scenario: &mut test_scenario::Scenario,
    clock: &clock::Clock,
    offset: u64,
    value: u8,
    signature: vector<u8>,
    public_key: vector<u8>,
) {
    scenario.next_tx(RELAYER);
    {
        assert!(!scenario.has_most_recent_for_sender<admin::AdminCap>());
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut identity_registry = scenario.take_shared<identity_registry::IdentityRegistry>();
        let membership_registry = scenario.take_shared<membership::MembershipRegistry>();
        let verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        // pass は payload 構築（membership_id 取得）のためだけに take する。accessor には渡さない。
        let pass = test_scenario::take_from_address<membership::MembershipPass>(
            scenario,
            MEMBER,
        );
        let mut payload_bcs = identity_result_bcs(
            identity_registry::registry_id(&identity_registry),
            object::id(&pass),
            MEMBER,
            identity_registry::provider_kyc(),
            KYC_DUPLICATE_KEY_HASH,
        );
        *payload_bcs.borrow_mut(offset) = value;

        accessor::update_identity_verification(
            &pause_state,
            &mut identity_registry,
            &membership_registry,
            &verifier_registry,
            clock,
            payload_bcs,
            signature,
            public_key,
            scenario.ctx(),
        );

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
    x"ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c"
}

fun identity_pcr0(): vector<u8> {
    x"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f30"
}

fun identity_pcr1(): vector<u8> {
    x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}

fun identity_pcr2(): vector<u8> {
    x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}

fun updated_identity_pcr0(): vector<u8> {
    x"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
}

fun kyc_signature(): vector<u8> {
    x"f6c12dbcaed89937c9b276951850f90eedf1593b8b3b618d1b3d6a065d18943c516c6ece9b4d2d26424707bdd0c8291a1c60a95329730a35ce25ccd8a279d500"
}

fun world_id_signature(): vector<u8> {
    x"eef110e95cec52b011f2a2de48c4eb388fd63feb7b5c6cbbb4f9de0bc9aff4849e3164d2d67f3ab39053271d4800503c094457cbd7b8c77c31108dfbc1ad690b"
}

fun step5_public_key(): vector<u8> {
    x"ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c"
}

fun rust_fixture_payload_bcs(): vector<u8> {
    x"1f534f4e4152495f4944454e544954595f564552494649434154494f4e5f5631086964656e74697479010000000000000075b6758a05e5945c492eb147dcfe2e58df886a71ff36c25b2ad07bec42cd407adba72804cc9504a82bbaa13ed4a83a0e2c6219d7e45125cf57fd10cbab957a97000000000000000000000000000000000000000000000000000000000000051a0201e0b489ec33cad56128dd39a060f165edc65c69f5c6dba23cd0b44d8dd4476878555555555555555555555555555555555555555555555555555555555555555500505c18a3010000007c0d70aa01000007000000000000006666666666666666666666666666666666666666666666666666666666666666"
}

fun rust_fixture_signature(): vector<u8> {
    x"ec87741cbc79be139ba04726b1a20fc487ef2ec94dc4dda34049ed851ebfc4ee751e4641dd070f2debef9581928827382dccc6e9d2f5d1c17ddf917963ef4407"
}

fun rust_fixture_public_key(): vector<u8> {
    x"ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c"
}

fun rust_fixture_world_id_duplicate_key_hash(): vector<u8> {
    x"e0b489ec33cad56128dd39a060f165edc65c69f5c6dba23cd0b44d8dd4476878"
}

fun step5_kyc_signature(): vector<u8> {
    x"f6c12dbcaed89937c9b276951850f90eedf1593b8b3b618d1b3d6a065d18943c516c6ece9b4d2d26424707bdd0c8291a1c60a95329730a35ce25ccd8a279d500"
}

fun step5_wrong_registry_signature(): vector<u8> {
    x"6bc6fcc7b91c995f9a9e590492d37ee9ac2f31e06bf2926b1f6b57ae647f4ee591db8ade0ac0567b1929801588468a0485325eb14b262e2b4a9b4e250801e101"
}

fun step5_wrong_membership_signature(): vector<u8> {
    x"709b6893d0da161d661e9885b6a79c4f77ed56a9f7ff82e15a94a0c488a1d083e71577de5f9c67834281218ed0644b96732a1282c2c00661fac16e9dc2224b06"
}

fun step5_wrong_owner_signature(): vector<u8> {
    x"b86fa62a4c0c2fef97bfda1b72b1d35a2751fca431a037e466d9e128beb5b96a71d2e8bdcd59fc979783985ab5fd11f007491117f794dd2a73cc7c35de422e0b"
}

fun step5_wrong_provider_signature(): vector<u8> {
    x"3b1ba2788bf1560bd10764e4928ac4c94d6b48b3f4cb52673f474067be62ef574950f026e7c5c24bce8ff3b763fe1d590b7beea78559de587aeaccf7fc7b0101"
}

fun step5_verified_false_signature(): vector<u8> {
    x"c87b5c04fe879623dc884af9975061b4884aa6041ff1c3e8e510c46269050c520e0873ae68cf96d0d5b4c6c89dadd997796fad150946567e3c13c7b5363bbe06"
}
