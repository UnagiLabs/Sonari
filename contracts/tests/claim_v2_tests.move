#[test_only]
module contracts::claim_v2_tests;

use contracts::admin;
use contracts::affected_cell;
use contracts::campaign;
use contracts::category_pool;
use contracts::identity_registry;
use contracts::membership;
use sui::clock;
use sui::event;
use sui::test_scenario;

const ADMIN: address = @0xA11CE;
const MEMBER: address = @0xBEEF;

// campaign created at this time (clock value in setup)
const NOW_MS: u64 = 1_704_170_000_000;

// DisasterEvent mock values (matching create_campaign_in_scenario)
// event_uid must be 32 bytes
const EVENT_UID: vector<u8> = x"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EVENT_REVISION: u32 = 1u32;

// occurred_at_ms for the disaster; account/home cell timestamps default to 0
// so the cutoff checks (< occurred_at_ms) pass automatically
const OCCURRED_AT_MS: u64 = 1_704_067_200_000;

const KYC_DUPLICATE_KEY: vector<u8> =
    x"4444444444444444444444444444444444444444444444444444444444444444";

// DONATION_PERIOD_MS = 2_592_000_000
const DONATION_END_MS: u64 = NOW_MS + 2_592_000_000;

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------

// admin init (MainPool + OperationsPool) + CategoryRegistry + CategoryPool
fun setup(): test_scenario::Scenario {
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);

    let registry_id = category_pool::create_category_registry_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);

    let cap = scenario.take_from_sender<admin::AdminCap>();
    let mut registry = scenario.take_shared_by_id<category_pool::CategoryRegistry>(registry_id);
    admin::create_category_pool(
        &cap,
        &mut registry,
        category_pool::category_earthquake(),
        scenario.ctx(),
    );
    test_scenario::return_shared(registry);
    scenario.return_to_sender(cap);
    scenario.next_tx(ADMIN);

    scenario
}

fun create_campaign_in_scenario(scenario: &mut test_scenario::Scenario) {
    let cat_registry = scenario.take_shared<category_pool::CategoryRegistry>();
    let cat_pool = scenario.take_shared<category_pool::CategoryPool>();
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(NOW_MS);

    let disaster_event_id = object::id_from_address(@0xDEAD);
    campaign::create_campaign(
        &cat_registry,
        &cat_pool,
        disaster_event_id,
        EVENT_UID,
        EVENT_REVISION,
        campaign::hazard_type_earthquake_for_testing(),
        3u8,
        &clock,
        scenario.ctx(),
    );

    test_scenario::return_shared(cat_registry);
    test_scenario::return_shared(cat_pool);
    clock.destroy_for_testing();
}

// Creates an AffectedCellLeaf whose h3_index matches home_cell=0
fun make_leaf(cell_band: u8): affected_cell::AffectedCellLeaf {
    affected_cell::new_leaf(
        EVENT_UID,
        EVENT_REVISION,
        /* h3_index */ 0u64,
        /* geo_resolution */ 3u8,
        /* cell_metric */ 1u8,
        /* intensity_value */ 100u16,
        /* intensity_scale */ 1u8,
        cell_band,
        /* cells_generation_method */ 0u8,
        /* oracle_version */ 1u64,
    )
}

// Creates a MembershipPass for MEMBER with home_cell=0 and times=0 (< OCCURRED_AT_MS)
fun make_pass(
    scenario: &mut test_scenario::Scenario,
): (membership::MembershipRegistry, membership::MembershipPass) {
    membership::create_registry_and_pass_for_testing(MEMBER, 1, b"", scenario.ctx())
}

// Creates an identity registry with KYC binding and verification for pass_lineage_id
fun make_verified_identity(
    scenario: &mut test_scenario::Scenario,
    pass_lineage_id: ID,
): identity_registry::IdentityRegistry {
    let mut id_registry = identity_registry::create_identity_registry_for_testing(scenario.ctx());
    identity_registry::bind_duplicate_key(
        &mut id_registry,
        pass_lineage_id,
        identity_registry::provider_kyc(),
        KYC_DUPLICATE_KEY,
    );
    identity_registry::record_identity_verification(
        &mut id_registry,
        pass_lineage_id,
        MEMBER,
        identity_registry::provider_kyc(),
        NOW_MS,
        DONATION_END_MS + 1_000_000_000,
        1,
        b"",
    );
    id_registry
}

// ---------------------------------------------------------------
// 1. happy path: submit_claim creates ClaimApplication and event
// ---------------------------------------------------------------

#[test]
fun submit_claim_creates_application_and_event() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (mem_registry, pass) = make_pass(&mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);

        let leaf = make_leaf(2u8);
        let root = affected_cell::leaf_hash(&leaf);

        campaign::submit_claim(
            &mut c,
            object::id_from_address(@0xDEAD),
            EVENT_UID,
            EVENT_REVISION,
            root,
            OCCURRED_AT_MS,
            &mem_registry,
            &pass,
            leaf,
            vector[],
            NOW_MS,
            scenario.ctx(),
        );

        assert!(campaign::campaign_has_claim_application(&c, pass_lineage_id));
        let (band, applied_at_ms, verified, floor_claimed, excluded) =
            campaign::campaign_claim_application_fields(&c, pass_lineage_id);
        assert!(band == 2u8);
        assert!(applied_at_ms == NOW_MS);
        assert!(!verified);
        assert!(!floor_claimed);
        assert!(!excluded);

        let events = event::events_by_type<campaign::ClaimSubmitted>();
        assert!(events.length() == 1);
        let (_, ev_lineage, ev_band, ev_at, ev_applicant) =
            campaign::claim_submitted_event_fields(*events.borrow(0));
        assert!(ev_lineage == pass_lineage_id);
        assert!(ev_band == 2u8);
        assert!(ev_at == NOW_MS);
        assert!(ev_applicant == MEMBER);

        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 2. happy path: verify_claim marks application verified and emits event
// ---------------------------------------------------------------

#[test]
fun verify_claim_marks_verified_and_emits_event() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (mem_registry, pass) = make_pass(&mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);
        let mut id_registry = make_verified_identity(&mut scenario, pass_lineage_id);

        let leaf = make_leaf(2u8);
        let root = affected_cell::leaf_hash(&leaf);

        campaign::submit_claim(
            &mut c,
            object::id_from_address(@0xDEAD),
            EVENT_UID,
            EVENT_REVISION,
            root,
            OCCURRED_AT_MS,
            &mem_registry,
            &pass,
            leaf,
            vector[],
            NOW_MS,
            scenario.ctx(),
        );

        campaign::verify_claim(
            &mut c,
            &id_registry,
            &mem_registry,
            &pass,
            identity_registry::provider_kyc(),
            KYC_DUPLICATE_KEY,
            NOW_MS,
            scenario.ctx(),
        );

        let (_, _, verified, _, _) =
            campaign::campaign_claim_application_fields(&c, pass_lineage_id);
        assert!(verified);

        let events = event::events_by_type<campaign::ClaimVerified>();
        assert!(events.length() == 1);
        let (_, ev_lineage, ev_band, _, ev_verifier) =
            campaign::claim_verified_event_fields(*events.borrow(0));
        assert!(ev_lineage == pass_lineage_id);
        assert!(ev_band == 2u8);
        assert!(ev_verifier == MEMBER);

        identity_registry::remove_binding_for_testing(
            &mut id_registry,
            identity_registry::provider_kyc(),
            KYC_DUPLICATE_KEY,
        );
        identity_registry::destroy_identity_registry_for_testing(id_registry);
        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 3. reject: claim window closed (now_ms >= claim_end_ms)
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EClaimWindowClosed)]
fun submit_claim_rejects_after_window_closed() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        // Expire the claim window
        campaign::set_claim_end_ms_for_testing(&mut c, NOW_MS);
        let (mem_registry, pass) = make_pass(&mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);

        let leaf = make_leaf(2u8);
        let root = affected_cell::leaf_hash(&leaf);

        campaign::submit_claim(
            &mut c,
            object::id_from_address(@0xDEAD),
            EVENT_UID,
            EVENT_REVISION,
            root,
            OCCURRED_AT_MS,
            &mem_registry,
            &pass,
            leaf,
            vector[],
            NOW_MS,
            scenario.ctx(),
        );

        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 4. reject: disaster event id mismatch
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EDisasterEventMismatch)]
fun submit_claim_rejects_wrong_disaster_event_id() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (mem_registry, pass) = make_pass(&mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);

        let leaf = make_leaf(2u8);
        let root = affected_cell::leaf_hash(&leaf);

        campaign::submit_claim(
            &mut c,
            object::id_from_address(@0x1234), // wrong ID
            EVENT_UID,
            EVENT_REVISION,
            root,
            OCCURRED_AT_MS,
            &mem_registry,
            &pass,
            leaf,
            vector[],
            NOW_MS,
            scenario.ctx(),
        );

        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 5. reject: invalid Merkle proof (wrong affected_cells_root)
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EInvalidAffectedCellProof)]
fun submit_claim_rejects_invalid_merkle_proof() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (mem_registry, pass) = make_pass(&mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);

        let leaf = make_leaf(2u8);
        let wrong_root =
            x"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

        campaign::submit_claim(
            &mut c,
            object::id_from_address(@0xDEAD),
            EVENT_UID,
            EVENT_REVISION,
            wrong_root,
            OCCURRED_AT_MS,
            &mem_registry,
            &pass,
            leaf,
            vector[],
            NOW_MS,
            scenario.ctx(),
        );

        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 6. reject: cell band below min_claim_band (band=0 < MIN_CLAIM_BAND=1)
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EClaimBandTooLow)]
fun submit_claim_rejects_band_too_low() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (mem_registry, pass) = make_pass(&mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);

        let leaf = make_leaf(0u8); // band=0 < MIN_CLAIM_BAND=1
        let root = affected_cell::leaf_hash(&leaf);

        campaign::submit_claim(
            &mut c,
            object::id_from_address(@0xDEAD),
            EVENT_UID,
            EVENT_REVISION,
            root,
            OCCURRED_AT_MS,
            &mem_registry,
            &pass,
            leaf,
            vector[],
            NOW_MS,
            scenario.ctx(),
        );

        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 7. reject: account created after disaster occurred_at_ms
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EAccountCreatedAfterCutoff)]
fun submit_claim_rejects_account_created_after_cutoff() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (mem_registry, mut pass) = make_pass(&mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);
        // Set account_created_at_ms to after occurred_at_ms
        membership::set_account_created_at_ms_for_testing(&mut pass, OCCURRED_AT_MS + 1);

        let leaf = make_leaf(2u8);
        let root = affected_cell::leaf_hash(&leaf);

        campaign::submit_claim(
            &mut c,
            object::id_from_address(@0xDEAD),
            EVENT_UID,
            EVENT_REVISION,
            root,
            OCCURRED_AT_MS,
            &mem_registry,
            &pass,
            leaf,
            vector[],
            NOW_MS,
            scenario.ctx(),
        );

        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 8. reject: home cell registered after disaster occurred_at_ms
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EHomeCellRegisteredAfterCutoff)]
fun submit_claim_rejects_home_cell_registered_after_cutoff() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (mem_registry, mut pass) = make_pass(&mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);
        // Set home_cell_registered_at_ms to after occurred_at_ms
        membership::set_home_cell_registered_at_ms_for_testing(&mut pass, OCCURRED_AT_MS + 1);

        let leaf = make_leaf(2u8);
        let root = affected_cell::leaf_hash(&leaf);

        campaign::submit_claim(
            &mut c,
            object::id_from_address(@0xDEAD),
            EVENT_UID,
            EVENT_REVISION,
            root,
            OCCURRED_AT_MS,
            &mem_registry,
            &pass,
            leaf,
            vector[],
            NOW_MS,
            scenario.ctx(),
        );

        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 9. reject: residence cell mismatch (leaf.h3_index != pass.home_cell)
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EResidenceCellMismatch)]
fun submit_claim_rejects_residence_cell_mismatch() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (mem_registry, pass) = make_pass(&mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);

        // Leaf with h3_index=999 but pass.home_cell=0
        let leaf = affected_cell::new_leaf(
            EVENT_UID,
            EVENT_REVISION,
            999u64, // mismatch with home_cell=0
            3u8,
            1u8,
            100u16,
            1u8,
            2u8,
            0u8,
            1u64,
        );
        let root = affected_cell::leaf_hash(&leaf);

        campaign::submit_claim(
            &mut c,
            object::id_from_address(@0xDEAD),
            EVENT_UID,
            EVENT_REVISION,
            root,
            OCCURRED_AT_MS,
            &mem_registry,
            &pass,
            leaf,
            vector[],
            NOW_MS,
            scenario.ctx(),
        );

        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 10. reject: duplicate application (submit twice with same pass)
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EDuplicateApplication)]
fun submit_claim_rejects_duplicate_application() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (mem_registry, pass) = make_pass(&mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);

        let leaf = make_leaf(2u8);
        let root = affected_cell::leaf_hash(&leaf);

        campaign::submit_claim(
            &mut c,
            object::id_from_address(@0xDEAD),
            EVENT_UID,
            EVENT_REVISION,
            root,
            OCCURRED_AT_MS,
            &mem_registry,
            &pass,
            leaf,
            vector[],
            NOW_MS,
            scenario.ctx(),
        );

        // Second submit with same pass → EDuplicateApplication
        campaign::submit_claim(
            &mut c,
            object::id_from_address(@0xDEAD),
            EVENT_UID,
            EVENT_REVISION,
            root,
            OCCURRED_AT_MS,
            &mem_registry,
            &pass,
            leaf,
            vector[],
            NOW_MS,
            scenario.ctx(),
        );

        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 11. reject: claim already verified (verify twice)
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EClaimAlreadyVerified)]
fun verify_claim_rejects_already_verified() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (mem_registry, pass) = make_pass(&mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);
        let mut id_registry = make_verified_identity(&mut scenario, pass_lineage_id);

        let leaf = make_leaf(2u8);
        let root = affected_cell::leaf_hash(&leaf);

        campaign::submit_claim(
            &mut c,
            object::id_from_address(@0xDEAD),
            EVENT_UID,
            EVENT_REVISION,
            root,
            OCCURRED_AT_MS,
            &mem_registry,
            &pass,
            leaf,
            vector[],
            NOW_MS,
            scenario.ctx(),
        );

        campaign::verify_claim(
            &mut c,
            &id_registry,
            &mem_registry,
            &pass,
            identity_registry::provider_kyc(),
            KYC_DUPLICATE_KEY,
            NOW_MS,
            scenario.ctx(),
        );

        // Second verify → EClaimAlreadyVerified
        campaign::verify_claim(
            &mut c,
            &id_registry,
            &mem_registry,
            &pass,
            identity_registry::provider_kyc(),
            KYC_DUPLICATE_KEY,
            NOW_MS,
            scenario.ctx(),
        );

        identity_registry::remove_binding_for_testing(
            &mut id_registry,
            identity_registry::provider_kyc(),
            KYC_DUPLICATE_KEY,
        );
        identity_registry::destroy_identity_registry_for_testing(id_registry);
        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}

// ---------------------------------------------------------------
// 12. reject: verify_claim without prior submit → EClaimApplicationNotFound
// ---------------------------------------------------------------

#[test, expected_failure(abort_code = campaign::EClaimApplicationNotFound)]
fun verify_claim_rejects_when_no_application_exists() {
    let mut scenario = setup();
    create_campaign_in_scenario(&mut scenario);

    scenario.next_tx(MEMBER);
    {
        let mut c = scenario.take_shared<campaign::Campaign>();
        let (mem_registry, pass) = make_pass(&mut scenario);
        let pass_lineage_id = membership::membership_pass_lineage_id(&pass);
        let mut id_registry = make_verified_identity(&mut scenario, pass_lineage_id);

        campaign::verify_claim(
            &mut c,
            &id_registry,
            &mem_registry,
            &pass,
            identity_registry::provider_kyc(),
            KYC_DUPLICATE_KEY,
            NOW_MS,
            scenario.ctx(),
        );

        identity_registry::remove_binding_for_testing(
            &mut id_registry,
            identity_registry::provider_kyc(),
            KYC_DUPLICATE_KEY,
        );
        identity_registry::destroy_identity_registry_for_testing(id_registry);
        membership::destroy_membership_registry_for_testing(mem_registry, MEMBER, pass_lineage_id);
        membership::destroy_pass_for_testing(pass);
        test_scenario::return_shared(c);
    };
    scenario.end();
}
