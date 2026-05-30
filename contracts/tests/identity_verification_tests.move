#[test_only]
module contracts::identity_verification_tests;

use contracts::accessor;
use contracts::admin;
use contracts::identity_registry;
use contracts::identity_result_v1;
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
const REGISTRY_ID_OFFSET: u64 = 49;
const MEMBERSHIP_ID_OFFSET: u64 = 81;
const OWNER_OFFSET: u64 = 144;
const PROVIDER_OFFSET: u64 = 145;
const VERIFIED_OFFSET: u64 = 146;
const TERMS_VERSION_OFFSET: u64 = 227;
const SIGNED_STATEMENT_HASH_OFFSET: u64 = 235;

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
fun rust_fixture_signed_world_id_result_updates_identity_pass() {
    let mut clock = clock::create_for_testing(&mut tx_context::dummy());
    clock.set_for_testing(NOW_MS);
    let mut scenario = initialized_with_registered_member();
    add_identity_verifier_key_with_public_key(&mut scenario, rust_fixture_public_key());

    scenario.next_tx(RELAYER);
    {
        assert!(!scenario.has_most_recent_for_sender<admin::AdminCap>());
        let pause_state = scenario.take_shared<admin::PauseState>();
        let mut identity_registry = scenario.take_shared<identity_registry::IdentityRegistry>();
        let membership_registry = scenario.take_shared<membership::MembershipRegistry>();
        let verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        let mut pass = test_scenario::take_from_address<membership::MembershipPass>(
            &scenario,
            MEMBER,
        );

        accessor::update_identity_verification(
            &pause_state,
            &mut identity_registry,
            &membership_registry,
            &verifier_registry,
            &mut pass,
            &clock,
            rust_fixture_payload_bcs(),
            rust_fixture_signature(),
            rust_fixture_public_key(),
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
        assert!(identity_provider_mask == identity_registry::provider_world_id());
        assert!(identity_verified_at_ms == NOW_MS);
        assert!(identity_expires_at_ms == EXPIRES_AT_MS);
        assert!(terms_version == TERMS_VERSION);
        assert!(signed_statement_hash == SIGNED_STATEMENT_HASH);
        identity_registry::assert_duplicate_key_bound_to_pass(
            &identity_registry,
            &pass,
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

#[test, expected_failure(abort_code = identity_registry::EOwnerMismatch)]
fun signed_identity_result_wrong_owner_is_rejected_at_public_accessor() {
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

#[test, expected_failure(abort_code = membership::EIdentityTermsVersionMismatch)]
fun signed_identity_result_terms_mismatch_is_rejected_at_public_accessor() {
    submit_mutated_step5_kyc_result(TERMS_VERSION_OFFSET, 8, step5_terms_mismatch_signature());
}

#[test, expected_failure(abort_code = membership::EIdentitySignedStatementHashMismatch)]
fun signed_identity_result_statement_hash_mismatch_is_rejected_at_public_accessor() {
    submit_mutated_step5_kyc_result(
        SIGNED_STATEMENT_HASH_OFFSET,
        0x77,
        step5_statement_hash_mismatch_signature(),
    );
}

#[test, expected_failure(abort_code = membership::EIdentityProviderReplay)]
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
    add_identity_verifier_key_with_public_key(scenario, identity_public_key());
}

fun add_step5_identity_verifier_key(scenario: &mut test_scenario::Scenario) {
    add_identity_verifier_key_with_public_key(scenario, step5_public_key());
}

fun add_identity_verifier_key_with_public_key(
    scenario: &mut test_scenario::Scenario,
    public_key: vector<u8>,
) {
    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut verifier_registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        admin::add_verifier_key(
            &cap,
            &mut verifier_registry,
            metadata_verifier::verifier_family_identity(),
            metadata_verifier::verifier_version_v1(),
            public_key,
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
            public_key,
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
        let mut pass = test_scenario::take_from_address<membership::MembershipPass>(
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
            &mut pass,
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
    x"d48258c427f21c839d84d58b8599788a4327ee1a96ef8b2ecf29ca912fe24f43"
}

fun kyc_signature(): vector<u8> {
    x"825580c97380e0dd163cb5e713466491fcfd99c82cc5aa5e135e5babc20720fd2b1076236a1de3d50921d705fa743168b361af523b3f7cc43c54a00f7251ce04"
}

fun world_id_signature(): vector<u8> {
    x"7e392ec6d0702b6ae20611ccd23772b233a4548e7f1c4a4f7629ab097f667677b094b400bebe55b063a92493f5a5268404ede3394f30d9e7871cb25d70ce1b0c"
}

fun step5_public_key(): vector<u8> {
    x"9df8f695ea4e0815a362d3969ee9afbb80bc5b9982620ff8390f99a2ddd1469e"
}

fun rust_fixture_payload_bcs(): vector<u8> {
    x"1f534f4e4152495f4944454e544954595f564552494649434154494f4e5f5631086964656e74697479010000000000000075b6758a05e5945c492eb147dcfe2e58df886a71ff36c25b2ad07bec42cd407ad726ecf6f7036ee3557cd6c7b93a49b231070e8eecada9cfa157e40e3f02e5d3000000000000000000000000000000000000000000000000000000000000051a0201b9dabcfc937c5422b28ddd2db18466a02c1f9fadb5637d120a3a455e23e88a7468893c4e14f913225e4883e1f2f6c2768a0f2673f5ef253386bec3ffda2ac84f00505c18a3010000007c0d70aa01000007000000000000006666666666666666666666666666666666666666666666666666666666666666"
}

fun rust_fixture_signature(): vector<u8> {
    x"ad78ca7d3b21c21b2a701d9c22cb63a59307ecb1eb971ddb3fdd927962caed355752e835e11cf474804f2791f88b4bb821fbf62659736cb1648f555bf23c9607"
}

fun rust_fixture_public_key(): vector<u8> {
    x"ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c"
}

fun rust_fixture_world_id_duplicate_key_hash(): vector<u8> {
    x"b9dabcfc937c5422b28ddd2db18466a02c1f9fadb5637d120a3a455e23e88a74"
}

fun step5_kyc_signature(): vector<u8> {
    x"4d191346dbe3f8cf401bcd16f4776f095c4daea6f68e86cf09d9b6b909075b4c89cc58f14ddfa026ada4bfe593e455a4892ec988d540e4c7e30059121221900b"
}

fun step5_wrong_registry_signature(): vector<u8> {
    x"4eb2b252788ebb3c389653438ea258948920cc01afc4ac1748a14f55bcf2a5d90f39724a70ec116b119fb32f46b2ea01bc8ca0d0d7455a4f44b36ada28ffba04"
}

fun step5_wrong_membership_signature(): vector<u8> {
    x"7dc6f174a34c447d6c6c4bf836b9b64685d163e699e56fb2e3690953ed98f9f77bcf4c4a0e60573d10b7edd4ae59e2f374e009fd889964d4a96d84cc643e4a07"
}

fun step5_wrong_owner_signature(): vector<u8> {
    x"63546403a829e9a9a4a6ae177bd8ca812c5df2284a3d3bf70cb18a7ec23ff4382985d85daa62efb5c89c183ebc69253d30dffc999aad89995157009acd6e510b"
}

fun step5_wrong_provider_signature(): vector<u8> {
    x"c2f0af7079e6ca034e6b1685d01cb4f7d1ecc6b30099ccb0337e2883de710cdcdd5e61b33ecf077290ac5badee03c552d5d3ac72ba91d11f5a20b846ce29d50d"
}

fun step5_verified_false_signature(): vector<u8> {
    x"c6b4f3c7935717c206cacf12035877da61766b75182481a95f16c79b0539be23a229ddc119c6240ee8cfb31705794c543fa393fd853f64b2929699787ef4c804"
}

fun step5_terms_mismatch_signature(): vector<u8> {
    x"d57720c7491dbaba36042747669a5c0a7836371496a3a72a8bb6666e0fc13f75219915ec79bf1411a454e2057622ebc495467f0ff02a111d45f9c29ad0451b00"
}

fun step5_statement_hash_mismatch_signature(): vector<u8> {
    x"b90f6dea69f75c9976edec07516581088f378a3374b3a90f5ac27fdd463f2b83e6d627a81d985e6632931b3174a5f705296603dcffb605f6437e08eb98e5080a"
}
