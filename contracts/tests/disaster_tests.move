#[test_only]
module contracts::disaster_tests;

use contracts::admin;
use contracts::affected_cell;
use contracts::disaster_event;
use contracts::payload_v1;
use sui::event;
use sui::test_scenario;

const ADMIN: address = @0xA11CE;

const NOW_BEFORE_FRESHNESS_DEADLINE_MS: u64 = 1_704_170_000_000;
const EVENT_REVISION: u32 = 1;
const H3_INDEX: u64 = 608_819_013_597_790_207;
const GEO_RESOLUTION: u8 = 7;
const CELL_METRIC_USGS_MMI: u8 = 1;
const INTENSITY_VALUE: u16 = 723;
const INTENSITY_SCALE_MMI_X100: u8 = 1;
const CELL_BAND: u8 = 1;
const CELLS_GENERATION_METHOD: u8 = 1;
const ORACLE_VERSION: u64 = 1;

#[test]
fun affected_cell_leaf_hash_and_merkle_proof_match_fixture_vectors() {
    let leaf = affected_cell::new_leaf(
        event_uid(),
        EVENT_REVISION,
        H3_INDEX,
        GEO_RESOLUTION,
        CELL_METRIC_USGS_MMI,
        INTENSITY_VALUE,
        INTENSITY_SCALE_MMI_X100,
        CELL_BAND,
        CELLS_GENERATION_METHOD,
        ORACLE_VERSION,
    );
    let hash = affected_cell::leaf_hash(&leaf);
    assert!(
        hash == x"1dd74699033a94f1a4946edd673d3d7cbcda82412c782d2aedbb28a3bc9392f6",
    );

    let proof = vector[
        affected_cell::new_proof_step_left(
            x"954d0c90f737aa6e9015cf4d33a1ff98997bb6ebe2006e200d91bdecb1ba8ba0",
        ),
    ];
    assert!(affected_cell::verify_proof(&leaf, proof, affected_cells_root()));
}

#[test]
fun finalized_disaster_payload_decodes_and_creates_disaster_event() {
    let payload = payload_v1::decode_finalized(
        finalized_payload_bcs(),
        NOW_BEFORE_FRESHNESS_DEADLINE_MS,
    );
    let (
        intent,
        oracle_version,
        event_uid,
        hazard_type,
        status,
        event_revision,
        affected_cells_root,
        affected_cell_count,
        min_claim_band,
    ) = payload_v1::payload_summary(&payload);

    assert!(intent == payload_v1::intent_disaster_oracle_payload_v1());
    assert!(oracle_version == ORACLE_VERSION);
    assert!(event_uid == event_uid());
    assert!(hazard_type == payload_v1::hazard_type_earthquake());
    assert!(status == payload_v1::status_finalized());
    assert!(event_revision == EVENT_REVISION);
    assert!(affected_cells_root == affected_cells_root());
    assert!(affected_cell_count == 2);
    assert!(min_claim_band == 1);

    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        disaster_event::create_disaster_registry(&cap, scenario.ctx());
        scenario.return_to_sender(cap);
    };

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        disaster_event::create_from_payload(&cap, &mut registry, payload, scenario.ctx());
        scenario.return_to_sender(cap);
        test_scenario::return_shared(registry);
    };

    let events = event::events_by_type<disaster_event::DisasterEventCreated>();
    assert!(events.length() == 1);
    let (event_uid, revision, affected_root, affected_count, actor) =
        disaster_event::disaster_event_created_event_fields(*events.borrow(0));
    assert!(event_uid == event_uid());
    assert!(revision == EVENT_REVISION);
    assert!(affected_root == affected_cells_root());
    assert!(affected_count == 2);
    assert!(actor == ADMIN);

    scenario.end();
}

#[test, expected_failure(abort_code = payload_v1::EExpiredFreshness)]
fun expired_disaster_payload_is_rejected() {
    payload_v1::decode_finalized(
        finalized_payload_bcs(),
        1_704_172_800_000,
    );
}

#[test, expected_failure(abort_code = disaster_event::EDuplicateDisasterEvent)]
fun duplicate_disaster_event_uid_and_revision_is_rejected() {
    let payload = payload_v1::decode_finalized(
        finalized_payload_bcs(),
        NOW_BEFORE_FRESHNESS_DEADLINE_MS,
    );
    let duplicate = payload_v1::decode_finalized(
        finalized_payload_bcs(),
        NOW_BEFORE_FRESHNESS_DEADLINE_MS,
    );
    let mut scenario = test_scenario::begin(ADMIN);
    admin::init_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        disaster_event::create_disaster_registry(&cap, scenario.ctx());
        scenario.return_to_sender(cap);
    };

    scenario.next_tx(ADMIN);
    {
        let cap = scenario.take_from_sender<admin::AdminCap>();
        let mut registry = scenario.take_shared<disaster_event::DisasterRegistry>();
        disaster_event::create_from_payload(&cap, &mut registry, payload, scenario.ctx());
        disaster_event::create_from_payload(&cap, &mut registry, duplicate, scenario.ctx());
        scenario.return_to_sender(cap);
        test_scenario::return_shared(registry);
    };

    scenario.end();
}

fun event_uid(): vector<u8> {
    x"eef4db66cd5fb2f612f5295553d192ed3b9754ed75ec58fec0f814a85a13437f"
}

fun affected_cells_root(): vector<u8> {
    x"56e5b1020cb655fa99cec324da2fbf79e03dcfe84d3eee72e163111d3b01f6af"
}

fun finalized_payload_bcs(): vector<u8> {
    x"010100000000000000eef4db66cd5fb2f612f5295553d192ed3b9754ed75ec58fec0f814a85a13437f01030100000000f451c28c01000000b153c78c01000000b153c78c0100000102d905a14141efb9b0a8f23dbb01bdb9b537182faf5038d1fa76d9acfe2af298a72c051b491e6f2da3e7d193071bcdf2748f3c077a1eb1f94ffd03cfbe976c2efd3a697066733a2f2f736f6e6172692f6578616d706c65732f757337303030736f6e6172692f7261775f646174615f6d616e69666573742e6a736f6e56e5b1020cb655fa99cec324da2fbf79e03dcfe84d3eee72e163111d3b01f6af37697066733a2f2f736f6e6172692f6578616d706c65732f757337303030736f6e6172692f61666665637465645f63656c6c732e6a736f6e86a82292fbdc1381c58742d53c02fd0534d49bd6f8858e24219f9f3d57b3df2507010101010202000000000000000100489dc88c010000"
}
