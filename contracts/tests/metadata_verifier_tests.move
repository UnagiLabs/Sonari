#[test_only]
module contracts::metadata_verifier_tests;

use contracts::accessor;
use contracts::admin;
use contracts::membership;
use contracts::metadata_verifier;
use sui::clock;
use sui::event;
use sui::test_scenario;

const ADMIN: address = @0xA11CE;
const MEMBER: address = @0x51A;
const PAYOUT: address = @0xB0B;
const OTHER: address = @0xC0FFEE;

#[test]
fun verifier_registry_adds_and_disables_key_with_events() {
    let mut scenario = initialized();
    create_shared_registry(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        let public_key = valid_public_key();

        admin::add_verifier_key(
            &cap,
            &mut registry,
            metadata_verifier::verifier_family_residence(),
            metadata_verifier::verifier_version_v1(),
            public_key,
            scenario.ctx(),
        );
        admin::disable_verifier_key(&cap, &mut registry, public_key, scenario.ctx());

        scenario.return_to_sender(cap);
        test_scenario::return_shared(registry);
    };

    let added_events = event::events_by_type<metadata_verifier::VerifierKeyAdded>();
    assert!(added_events.length() == 1);
    let (registry_id, key, family, version, enabled, actor) =
        metadata_verifier::verifier_key_added_event_fields(*added_events.borrow(0));
    assert!(registry_id != object::id_from_address(@0x0));
    assert!(key == valid_public_key());
    assert!(family == metadata_verifier::verifier_family_residence());
    assert!(version == metadata_verifier::verifier_version_v1());
    assert!(enabled);
    assert!(actor == ADMIN);

    let disabled_events = event::events_by_type<metadata_verifier::VerifierKeyDisabled>();
    assert!(disabled_events.length() == 1);
    let (disabled_registry_id, disabled_key, disabled_actor) =
        metadata_verifier::verifier_key_disabled_event_fields(*disabled_events.borrow(0));
    assert!(disabled_registry_id == registry_id);
    assert!(disabled_key == valid_public_key());
    assert!(disabled_actor == ADMIN);

    scenario.end();
}

#[test, expected_failure(abort_code = metadata_verifier::EVerifierKeyAlreadyDisabled)]
fun disabling_already_disabled_key_is_rejected() {
    let (mut registry, pass, clock, mut ctx) = direct_initialized();
    metadata_verifier::add_verifier_key_for_testing(
        &mut registry,
        metadata_verifier::verifier_family_residence(),
        metadata_verifier::verifier_version_v1(),
        valid_public_key(),
        &mut ctx,
    );
    metadata_verifier::disable_verifier_key_for_testing(&mut registry, valid_public_key(), &mut ctx);
    metadata_verifier::disable_verifier_key_for_testing(&mut registry, valid_public_key(), &mut ctx);
    cleanup_direct(registry, pass, clock);
}

#[test, expected_failure(abort_code = metadata_verifier::EVerifierFamilyMismatch)]
fun unknown_verifier_family_registration_is_rejected() {
    let (mut registry, pass, clock, mut ctx) = direct_initialized();
    metadata_verifier::add_verifier_key_for_testing(
        &mut registry,
        99,
        metadata_verifier::verifier_version_v1(),
        valid_public_key(),
        &mut ctx,
    );
    cleanup_direct(registry, pass, clock);
}

#[test, expected_failure(abort_code = metadata_verifier::EVerifierVersionMismatch)]
fun unknown_verifier_version_registration_is_rejected() {
    let (mut registry, pass, clock, mut ctx) = direct_initialized();
    metadata_verifier::add_verifier_key_for_testing(
        &mut registry,
        metadata_verifier::verifier_family_residence(),
        99,
        valid_public_key(),
        &mut ctx,
    );
    cleanup_direct(registry, pass, clock);
}

#[test]
fun valid_residence_update_only_updates_residence_metadata() {
    let (mut registry, mut pass, clock, mut ctx) = direct_initialized();
    let message = valid_residence_message(&registry, &pass, 1);

    metadata_verifier::add_verifier_key_for_testing(
        &mut registry,
        metadata_verifier::verifier_family_residence(),
        metadata_verifier::verifier_version_v1(),
        valid_public_key(),
        &mut ctx,
    );
    metadata_verifier::verify_and_update_residence_metadata(
        &registry,
        &mut pass,
        &clock,
        message,
        valid_residence_signature(),
        valid_public_key(),
        &ctx,
    );

    let (
        residence_update_id,
        residence_cell,
        residence_confidence,
        residence_risk_bucket,
        residence_evidence_hash,
        residence_issued_at_ms,
        residence_expires_at_ms,
        residence_version,
    ) = membership::residence_metadata_summary(&pass);
    assert!(residence_update_id == 1);
    assert!(residence_cell == b"9q8yy");
    assert!(residence_confidence == 9300);
    assert!(residence_risk_bucket == 2);
    assert!(residence_evidence_hash == b"residence-evidence-hash");
    assert!(residence_issued_at_ms == 900);
    assert!(residence_expires_at_ms == 2_000);
    assert!(residence_version == metadata_verifier::verifier_version_v1());

    let (student_update_id, _, _, _, _, _, _, _, _) = membership::student_metadata_summary(&pass);
    assert!(student_update_id == 0);

    let events = event::events_by_type<membership::PassMetadataUpdated>();
    assert!(events.length() == 1);
    let (pass_id, lineage_id, owner, metadata_kind, update_id, family, version, actor) =
        membership::pass_metadata_updated_event_fields(*events.borrow(0));
    assert!(pass_id == object::id(&pass));
    assert!(lineage_id == membership::membership_pass_lineage_id(&pass));
    assert!(owner == MEMBER);
    assert!(metadata_kind == membership::metadata_kind_residence());
    assert!(update_id == 1);
    assert!(family == metadata_verifier::verifier_family_residence());
    assert!(version == metadata_verifier::verifier_version_v1());
    assert!(actor == @0x0);

    cleanup_direct(registry, pass, clock);
}

#[test]
fun valid_student_update_only_updates_student_metadata() {
    let (mut registry, mut pass, clock, mut ctx) = direct_initialized();
    let message = valid_student_message(&registry, &pass, 1);

    metadata_verifier::add_verifier_key_for_testing(
        &mut registry,
        metadata_verifier::verifier_family_student(),
        metadata_verifier::verifier_version_v1(),
        valid_student_public_key(),
        &mut ctx,
    );
    metadata_verifier::verify_and_update_student_metadata(
        &registry,
        &mut pass,
        &clock,
        message,
        valid_student_signature(),
        valid_student_public_key(),
        &ctx,
    );

    let (residence_update_id, _, _, _, _, _, _, _) = membership::residence_metadata_summary(&pass);
    assert!(residence_update_id == 0);

    let (
        student_update_id,
        school_region_hash,
        student_status,
        student_confidence,
        student_risk_bucket,
        student_evidence_hash,
        student_issued_at_ms,
        student_expires_at_ms,
        student_version,
    ) = membership::student_metadata_summary(&pass);
    assert!(student_update_id == 1);
    assert!(school_region_hash == b"school-region-hash");
    assert!(student_status == 1);
    assert!(student_confidence == 9100);
    assert!(student_risk_bucket == 3);
    assert!(student_evidence_hash == b"student-evidence-hash");
    assert!(student_issued_at_ms == 900);
    assert!(student_expires_at_ms == 2_000);
    assert!(student_version == metadata_verifier::verifier_version_v1());

    cleanup_direct(registry, pass, clock);
}

#[test]
fun residence_and_student_update_ids_are_separate_series() {
    let (mut registry, mut pass, clock, mut ctx) = direct_initialized();

    metadata_verifier::add_verifier_key_for_testing(
        &mut registry,
        metadata_verifier::verifier_family_residence(),
        metadata_verifier::verifier_version_v1(),
        valid_public_key(),
        &mut ctx,
    );
    metadata_verifier::add_verifier_key_for_testing(
        &mut registry,
        metadata_verifier::verifier_family_student(),
        metadata_verifier::verifier_version_v1(),
        valid_student_public_key(),
        &mut ctx,
    );

    let residence_message = valid_residence_message(&registry, &pass, 1);
    metadata_verifier::verify_and_update_residence_metadata(
        &registry,
        &mut pass,
        &clock,
        residence_message,
        valid_residence_signature(),
        valid_public_key(),
        &ctx,
    );
    let student_message = valid_student_message(&registry, &pass, 1);
    metadata_verifier::verify_and_update_student_metadata(
        &registry,
        &mut pass,
        &clock,
        student_message,
        valid_student_signature(),
        valid_student_public_key(),
        &ctx,
    );

    let (residence_update_id, _, _, _, _, _, _, _) = membership::residence_metadata_summary(&pass);
    let (student_update_id, _, _, _, _, _, _, _, _) = membership::student_metadata_summary(&pass);
    assert!(residence_update_id == 1);
    assert!(student_update_id == 1);

    cleanup_direct(registry, pass, clock);
}

#[test]
fun signed_metadata_update_bcs_bytes_are_fixed() {
    let (registry, pass, clock, _ctx) = direct_initialized();
    let residence_message = valid_residence_message(&registry, &pass, 1);
    let student_message = valid_student_message(&registry, &pass, 1);

    assert!(
        metadata_verifier::residence_update_message_bcs(&residence_message) ==
            x"23534f4e4152495f5245534944454e43455f4d455441444154415f5550444154455f5631010100000000000000381dd9078c322a4663c392761a0211b527c127b29583851217f948d62131f409eefed4f2b7f6ad5f65d6ea2eef50b4f1d1e98c39ca8eecbc9736da801b8387e6000000000000000000000000000000000000000000000000000000000000051a01000000000000008403000000000000d007000000000000053971387979542400000000000002177265736964656e63652d65766964656e63652d68617368",
    );
    assert!(
        metadata_verifier::student_update_message_bcs(&student_message) ==
            x"21534f4e4152495f53545544454e545f4d455441444154415f5550444154455f5631020100000000000000381dd9078c322a4663c392761a0211b527c127b29583851217f948d62131f409eefed4f2b7f6ad5f65d6ea2eef50b4f1d1e98c39ca8eecbc9736da801b8387e6000000000000000000000000000000000000000000000000000000000000051a01000000000000008403000000000000d007000000000000127363686f6f6c2d726567696f6e2d68617368018c23000000000000031573747564656e742d65766964656e63652d68617368",
    );

    cleanup_direct(registry, pass, clock);
}

#[test, expected_failure(abort_code = metadata_verifier::EInvalidSignature)]
fun invalid_signature_is_rejected() {
    let (mut registry, mut pass, clock, mut ctx) = direct_initialized();
    metadata_verifier::add_verifier_key_for_testing(
        &mut registry,
        metadata_verifier::verifier_family_residence(),
        metadata_verifier::verifier_version_v1(),
        valid_public_key(),
        &mut ctx,
    );
    let message = valid_residence_message(&registry, &pass, 1);
    metadata_verifier::verify_and_update_residence_metadata(
        &registry,
        &mut pass,
        &clock,
        message,
        invalid_signature(),
        valid_public_key(),
        &ctx,
    );
    cleanup_direct(registry, pass, clock);
}

#[test, expected_failure(abort_code = metadata_verifier::EInvalidSignatureLength)]
fun invalid_signature_length_is_rejected() {
    let (mut registry, mut pass, clock, mut ctx) = direct_initialized();
    metadata_verifier::add_verifier_key_for_testing(
        &mut registry,
        metadata_verifier::verifier_family_residence(),
        metadata_verifier::verifier_version_v1(),
        valid_public_key(),
        &mut ctx,
    );
    let message = valid_residence_message(&registry, &pass, 1);
    metadata_verifier::verify_and_update_residence_metadata(
        &registry,
        &mut pass,
        &clock,
        message,
        x"01",
        valid_public_key(),
        &ctx,
    );
    cleanup_direct(registry, pass, clock);
}

#[test, expected_failure(abort_code = metadata_verifier::EInvalidPublicKeyLength)]
fun invalid_public_key_length_is_rejected() {
    let (registry, mut pass, clock, ctx) = direct_initialized();
    let message = valid_residence_message(&registry, &pass, 1);
    metadata_verifier::verify_and_update_residence_metadata(
        &registry,
        &mut pass,
        &clock,
        message,
        valid_residence_signature(),
        x"01",
        &ctx,
    );
    cleanup_direct(registry, pass, clock);
}

#[test, expected_failure(abort_code = metadata_verifier::EExpiredUpdate)]
fun expired_update_is_rejected() {
    let (mut registry, mut pass, clock, mut ctx) = direct_initialized();
    metadata_verifier::add_verifier_key_for_testing(
        &mut registry,
        metadata_verifier::verifier_family_residence(),
        metadata_verifier::verifier_version_v1(),
        valid_public_key(),
        &mut ctx,
    );
    let message = expired_residence_message(&registry, &pass);
    metadata_verifier::verify_and_update_residence_metadata(
        &registry,
        &mut pass,
        &clock,
        message,
        expired_residence_signature(),
        valid_public_key(),
        &ctx,
    );
    cleanup_direct(registry, pass, clock);
}

#[test, expected_failure(abort_code = metadata_verifier::EInvalidTimeRange)]
fun expires_not_after_issued_is_rejected() {
    let (registry, mut pass, clock, ctx) = direct_initialized();
    let message = residence_message_with_time(&registry, &pass, 1_000, 1_000);
    metadata_verifier::verify_and_update_residence_metadata(
        &registry,
        &mut pass,
        &clock,
        message,
        valid_residence_signature(),
        valid_public_key(),
        &ctx,
    );
    cleanup_direct(registry, pass, clock);
}

#[test, expected_failure(abort_code = metadata_verifier::EFutureIssuedAt)]
fun issued_at_beyond_allowed_clock_skew_is_rejected() {
    let (registry, mut pass, clock, ctx) = direct_initialized();
    assert!(metadata_verifier::allowed_clock_skew_ms() == 300_000);
    let message = residence_message_with_time(
        &registry,
        &pass,
        1_000 + metadata_verifier::allowed_clock_skew_ms() + 1,
        2_000_000,
    );
    metadata_verifier::verify_and_update_residence_metadata(
        &registry,
        &mut pass,
        &clock,
        message,
        valid_residence_signature(),
        valid_public_key(),
        &ctx,
    );
    cleanup_direct(registry, pass, clock);
}

#[test, expected_failure(abort_code = membership::EStaleMetadataUpdate)]
fun replayed_update_is_rejected() {
    let (mut registry, mut pass, clock, mut ctx) = direct_initialized();
    metadata_verifier::add_verifier_key_for_testing(
        &mut registry,
        metadata_verifier::verifier_family_residence(),
        metadata_verifier::verifier_version_v1(),
        valid_public_key(),
        &mut ctx,
    );
    let message = valid_residence_message(&registry, &pass, 1);
    metadata_verifier::verify_and_update_residence_metadata(
        &registry,
        &mut pass,
        &clock,
        message,
        valid_residence_signature(),
        valid_public_key(),
        &ctx,
    );
    let replay_message = valid_residence_message(&registry, &pass, 1);
    metadata_verifier::verify_and_update_residence_metadata(
        &registry,
        &mut pass,
        &clock,
        replay_message,
        valid_residence_signature(),
        valid_public_key(),
        &ctx,
    );
    cleanup_direct(registry, pass, clock);
}

#[test, expected_failure(abort_code = metadata_verifier::EVerifierFamilyMismatch)]
fun wrong_family_is_rejected() {
    let (mut registry, mut pass, clock, mut ctx) = direct_initialized();
    metadata_verifier::add_verifier_key_for_testing(
        &mut registry,
        metadata_verifier::verifier_family_student(),
        metadata_verifier::verifier_version_v1(),
        valid_public_key(),
        &mut ctx,
    );
    let message = valid_residence_message(&registry, &pass, 1);
    metadata_verifier::verify_and_update_residence_metadata(
        &registry,
        &mut pass,
        &clock,
        message,
        valid_residence_signature(),
        valid_public_key(),
        &ctx,
    );
    cleanup_direct(registry, pass, clock);
}

#[test, expected_failure(abort_code = metadata_verifier::EVerifierVersionMismatch)]
fun wrong_version_is_rejected() {
    let (mut registry, mut pass, clock, mut ctx) = direct_initialized();
    metadata_verifier::add_verifier_key_for_testing(
        &mut registry,
        metadata_verifier::verifier_family_residence(),
        metadata_verifier::verifier_version_v1(),
        valid_public_key(),
        &mut ctx,
    );
    let message = residence_message_with_version(&registry, &pass, 99);
    metadata_verifier::verify_and_update_residence_metadata(
        &registry,
        &mut pass,
        &clock,
        message,
        valid_residence_signature(),
        valid_public_key(),
        &ctx,
    );
    cleanup_direct(registry, pass, clock);
}

#[test, expected_failure(abort_code = metadata_verifier::EInvalidIntent)]
fun wrong_intent_is_rejected() {
    let (registry, mut pass, clock, ctx) = direct_initialized();
    let message = wrong_intent_residence_message(&registry, &pass);
    metadata_verifier::verify_and_update_residence_metadata(
        &registry,
        &mut pass,
        &clock,
        message,
        valid_residence_signature(),
        valid_public_key(),
        &ctx,
    );
    cleanup_direct(registry, pass, clock);
}

#[test, expected_failure(abort_code = metadata_verifier::EVerifierKeyDisabled)]
fun disabled_key_is_rejected() {
    let (mut registry, mut pass, clock, mut ctx) = direct_initialized();
    metadata_verifier::add_verifier_key_for_testing(
        &mut registry,
        metadata_verifier::verifier_family_residence(),
        metadata_verifier::verifier_version_v1(),
        valid_public_key(),
        &mut ctx,
    );
    metadata_verifier::disable_verifier_key_for_testing(&mut registry, valid_public_key(), &mut ctx);
    let message = valid_residence_message(&registry, &pass, 1);
    metadata_verifier::verify_and_update_residence_metadata(
        &registry,
        &mut pass,
        &clock,
        message,
        valid_residence_signature(),
        valid_public_key(),
        &ctx,
    );
    cleanup_direct(registry, pass, clock);
}

#[test, expected_failure(abort_code = metadata_verifier::EPassLineageMismatch)]
fun pass_lineage_mismatch_is_rejected() {
    let (registry, mut pass, clock, ctx) = direct_initialized();
    metadata_verifier::verify_and_update_residence_metadata(
        &registry,
        &mut pass,
        &clock,
        wrong_lineage_residence_message(&registry),
        valid_residence_signature(),
        valid_public_key(),
        &ctx,
    );
    cleanup_direct(registry, pass, clock);
}

#[test, expected_failure(abort_code = metadata_verifier::EOwnerMismatch)]
fun owner_mismatch_is_rejected() {
    let (registry, mut pass, clock, ctx) = direct_initialized();
    let message = owner_mismatch_residence_message(&registry, &pass);
    metadata_verifier::verify_and_update_residence_metadata(
        &registry,
        &mut pass,
        &clock,
        message,
        valid_residence_signature(),
        valid_public_key(),
        &ctx,
    );
    cleanup_direct(registry, pass, clock);
}

#[test, expected_failure(abort_code = admin::EGlobalPaused)]
fun global_pause_blocks_metadata_update_accessor() {
    let mut scenario = initialized();
    create_shared_registry(&mut scenario);
    let clock = clock::create_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pause_state = scenario.take_shared<admin::PauseState>();
        admin::pause_global(&cap, &mut pause_state, scenario.ctx());
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
    };

    let mut pass = membership::create_pass_for_testing(MEMBER, PAYOUT, scenario.ctx());
    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        let message = valid_residence_message(&registry, &pass, 1);
        accessor::update_residence_metadata(
            &pause_state,
            &registry,
            &mut pass,
            &clock,
            message,
            invalid_signature(),
            valid_public_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
    };

    membership::destroy_pass_for_testing(pass);
    clock.destroy_for_testing();
    scenario.end();
}

#[test, expected_failure(abort_code = admin::ETargetPaused)]
fun registry_target_pause_blocks_metadata_update_accessor() {
    let mut scenario = initialized();
    create_shared_registry(&mut scenario);
    let registry_id = shared_registry_id(&mut scenario);
    let clock = clock::create_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut pause_state = scenario.take_shared<admin::PauseState>();
        admin::pause_target(
            &cap,
            &mut pause_state,
            metadata_verifier::target_kind_verifier_registry(),
            registry_id,
            scenario.ctx(),
        );
        scenario.return_to_sender(cap);
        test_scenario::return_shared(pause_state);
    };

    let mut pass = membership::create_pass_for_testing(MEMBER, PAYOUT, scenario.ctx());
    scenario.next_tx(MEMBER);
    {
        let pause_state = scenario.take_shared<admin::PauseState>();
        let registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
        let message = valid_residence_message(&registry, &pass, 1);
        accessor::update_residence_metadata(
            &pause_state,
            &registry,
            &mut pass,
            &clock,
            message,
            invalid_signature(),
            valid_public_key(),
            scenario.ctx(),
        );
        test_scenario::return_shared(pause_state);
        test_scenario::return_shared(registry);
    };

    membership::destroy_pass_for_testing(pass);
    clock.destroy_for_testing();
    scenario.end();
}

fun initialized(): test_scenario::Scenario {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);
    scenario
}

fun create_shared_registry(scenario: &mut test_scenario::Scenario) {
    let cap = scenario.take_from_sender<admin::AdminCap>();
    admin::create_verifier_registry(&cap, scenario.ctx());
    scenario.return_to_sender(cap);
}

fun shared_registry_id(scenario: &mut test_scenario::Scenario): object::ID {
    scenario.next_tx(ADMIN);
    let registry = scenario.take_shared<metadata_verifier::VerifierRegistry>();
    let registry_id = metadata_verifier::registry_id(&registry);
    test_scenario::return_shared(registry);
    registry_id
}

fun direct_initialized(): (
    metadata_verifier::VerifierRegistry,
    membership::MembershipPass,
    clock::Clock,
    tx_context::TxContext,
) {
    let mut ctx = tx_context::dummy();
    let registry = metadata_verifier::create_verifier_registry_for_testing(&mut ctx);
    let pass = membership::create_pass_for_testing(MEMBER, PAYOUT, &mut ctx);
    let mut clock = clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1_000);
    (registry, pass, clock, ctx)
}

fun cleanup_direct(
    registry: metadata_verifier::VerifierRegistry,
    pass: membership::MembershipPass,
    clock: clock::Clock,
) {
    metadata_verifier::destroy_verifier_registry_for_testing(registry);
    membership::destroy_pass_for_testing(pass);
    clock.destroy_for_testing();
}

fun valid_residence_message(
    registry: &metadata_verifier::VerifierRegistry,
    pass: &membership::MembershipPass,
    update_id: u64,
): metadata_verifier::ResidenceMetadataUpdateMessage {
    residence_message(
        b"SONARI_RESIDENCE_METADATA_UPDATE_V1",
        registry,
        membership::membership_pass_lineage_id(pass),
        MEMBER,
        update_id,
        900,
        2_000,
    )
}

fun expired_residence_message(
    registry: &metadata_verifier::VerifierRegistry,
    pass: &membership::MembershipPass,
): metadata_verifier::ResidenceMetadataUpdateMessage {
    residence_message(
        b"SONARI_RESIDENCE_METADATA_UPDATE_V1",
        registry,
        membership::membership_pass_lineage_id(pass),
        MEMBER,
        1,
        100,
        999,
    )
}

fun residence_message_with_time(
    registry: &metadata_verifier::VerifierRegistry,
    pass: &membership::MembershipPass,
    issued_at_ms: u64,
    expires_at_ms: u64,
): metadata_verifier::ResidenceMetadataUpdateMessage {
    residence_message(
        b"SONARI_RESIDENCE_METADATA_UPDATE_V1",
        registry,
        membership::membership_pass_lineage_id(pass),
        MEMBER,
        1,
        issued_at_ms,
        expires_at_ms,
    )
}

fun residence_message_with_version(
    registry: &metadata_verifier::VerifierRegistry,
    pass: &membership::MembershipPass,
    verifier_version: u64,
): metadata_verifier::ResidenceMetadataUpdateMessage {
    metadata_verifier::new_residence_metadata_update_message(
        b"SONARI_RESIDENCE_METADATA_UPDATE_V1",
        metadata_verifier::verifier_family_residence(),
        verifier_version,
        metadata_verifier::registry_id(registry),
        membership::membership_pass_lineage_id(pass),
        MEMBER,
        1,
        900,
        2_000,
        b"9q8yy",
        9300,
        2,
        b"residence-evidence-hash",
    )
}

fun wrong_intent_residence_message(
    registry: &metadata_verifier::VerifierRegistry,
    pass: &membership::MembershipPass,
): metadata_verifier::ResidenceMetadataUpdateMessage {
    residence_message(
        b"WRONG_INTENT",
        registry,
        membership::membership_pass_lineage_id(pass),
        MEMBER,
        1,
        900,
        2_000,
    )
}

fun wrong_lineage_residence_message(
    registry: &metadata_verifier::VerifierRegistry,
): metadata_verifier::ResidenceMetadataUpdateMessage {
    residence_message(
        b"SONARI_RESIDENCE_METADATA_UPDATE_V1",
        registry,
        object::id_from_address(@0xBAD),
        MEMBER,
        1,
        900,
        2_000,
    )
}

fun owner_mismatch_residence_message(
    registry: &metadata_verifier::VerifierRegistry,
    pass: &membership::MembershipPass,
): metadata_verifier::ResidenceMetadataUpdateMessage {
    residence_message(
        b"SONARI_RESIDENCE_METADATA_UPDATE_V1",
        registry,
        membership::membership_pass_lineage_id(pass),
        OTHER,
        1,
        900,
        2_000,
    )
}

fun residence_message(
    intent: vector<u8>,
    registry: &metadata_verifier::VerifierRegistry,
    pass_lineage_id: object::ID,
    owner: address,
    update_id: u64,
    issued_at_ms: u64,
    expires_at_ms: u64,
): metadata_verifier::ResidenceMetadataUpdateMessage {
    metadata_verifier::new_residence_metadata_update_message(
        intent,
        metadata_verifier::verifier_family_residence(),
        metadata_verifier::verifier_version_v1(),
        metadata_verifier::registry_id(registry),
        pass_lineage_id,
        owner,
        update_id,
        issued_at_ms,
        expires_at_ms,
        b"9q8yy",
        9300,
        2,
        b"residence-evidence-hash",
    )
}

fun valid_student_message(
    registry: &metadata_verifier::VerifierRegistry,
    pass: &membership::MembershipPass,
    update_id: u64,
): metadata_verifier::StudentMetadataUpdateMessage {
    metadata_verifier::new_student_metadata_update_message(
        b"SONARI_STUDENT_METADATA_UPDATE_V1",
        metadata_verifier::verifier_family_student(),
        metadata_verifier::verifier_version_v1(),
        metadata_verifier::registry_id(registry),
        membership::membership_pass_lineage_id(pass),
        MEMBER,
        update_id,
        900,
        2_000,
        b"school-region-hash",
        1,
        9100,
        3,
        b"student-evidence-hash",
    )
}

fun valid_public_key(): vector<u8> {
    x"95faf5df49c416e1070f77ff0a06853f4bc12a4eb4b96f2dfc0d11e441b0cd7f"
}

fun valid_student_public_key(): vector<u8> {
    x"4910d3e0d493df5cfdef381263c8f351fa9e8996be6b1c99684a13aaa8b97745"
}

fun valid_residence_signature(): vector<u8> {
    x"d4e57cb41ba51ab2e00bb57b242f91bc37d321d969e7401e78dcede157e68c864c4d0f63278cf13b4e1a86b84f5c07fefbec5ef909e66f7c68f38e3921e47607"
}

fun expired_residence_signature(): vector<u8> {
    valid_residence_signature()
}

fun valid_student_signature(): vector<u8> {
    x"2fc8ca44d731348b08bbedcc080d26ece443dee26a862bcd62c8d1cbdc3ceb49c5cf893d8f2ce4a7b0ddca3b7ba425ebdcb709324c8bf5d344edda181d5a2f04"
}

fun invalid_signature(): vector<u8> {
    x"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
}
