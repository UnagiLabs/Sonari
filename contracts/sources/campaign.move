#[allow(unused_const, unused_field)]
module contracts::campaign;

use contracts::category_pool::{Self, CategoryPool, CategoryRegistry};
use sui::balance::{Self, Balance};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::event;
use usdc::usdc::USDC;

// ---------------------------------------------------------------
// constants
// ---------------------------------------------------------------

const VERSION: u64 = 1;
const HAZARD_TYPE_EARTHQUAKE: u8 = 1;
const BAND_COUNT: u64 = 3;
const BAND_1_TARGET_USDC: u64 = 50_000_000;
const BAND_2_TARGET_USDC: u64 = 150_000_000;
const BAND_3_TARGET_USDC: u64 = 300_000_000;
const ROUND_CAP_MULTIPLIER: u64 = 3;
const FLOOR_TARGET_RATIO_BPS: u64 = 5_000;
const MIN_CLAIM_BAND: u8 = 1;
const SPLIT_CAMPAIGN_BPS: u64 = 9_000;
const SPLIT_MAIN_BPS: u64 = 500;
const SPLIT_OPS_BPS: u64 = 500;
const CAMPAIGN_OPS_CAP_USDC: u64 = 50_000_000_000;
const DONATION_PERIOD_MS: u64 = 2_592_000_000;
const CLAIM_PERIOD_MS: u64 = 1_814_400_000;
const ROUND_INTERVAL_MS: u64 = 7_776_000_000;
const MIN_PAYOUT_PER_RECIPIENT_USDC: u64 = 1_000_000;
const CATEGORY_ANNUAL_EVENT_DIVISOR: u64 = 5;
const FLOOR_MAIN_SHARE_BPS: u64 = 2_000;
const BPS_DENOMINATOR: u64 = 10_000;

const EVersionMismatch: u64 = 0;
const ECampaignPaused: u64 = 1;
const EInvalidBandCount: u64 = 2;

// ---------------------------------------------------------------
// structs
// ---------------------------------------------------------------

public struct Campaign has key {
    id: UID,
    version: u64,
    // DisasterEvent / CategoryPool との紐付け（作成時固定）
    disaster_event_id: ID,
    event_uid: vector<u8>,
    event_revision: u32,
    category: u8,
    category_pool_id: ID,
    // 本払い資金（Round 1 以降）
    balance: Balance<USDC>,
    // 床払い escrow（Round 0）
    floor_balance: Balance<USDC>,
    floor_from_category_usdc: u64,
    floor_from_main_usdc: u64,
    // センサス確定値
    census_set: bool,
    registered_members_by_band: vector<u64>,
    max_liability_usdc: u64,
    floor_ratio_bps: u64,
    floor_amount_by_band: vector<u64>,
    floor_paid_count: u64,
    floor_total_paid_usdc: u64,
    floor_budget_returned: bool,
    // リアルタイム表示用
    total_donated_usdc: u64,
    total_paid_usdc: u64,
    ops_withheld_usdc: u64,
    // 作成時スナップショット（以後不変）
    band_target_usdc: vector<u64>,
    round_cap_multiplier: u64,
    floor_target_ratio_bps: u64,
    min_claim_band: u8,
    split_campaign_bps: u64,
    split_main_bps: u64,
    split_ops_bps: u64,
    campaign_ops_cap_usdc: u64,
    round_interval_ms: u64,
    min_payout_per_recipient_usdc: u64,
    category_annual_event_divisor: u64,
    floor_main_share_bps: u64,
    // 締切
    created_at_ms: u64,
    donation_end_ms: u64,
    claim_end_ms: u64,
    // 申請状態
    applied_count_by_band: vector<u64>,
    verified_count_by_band: vector<u64>,
    // 本払いラウンド状態
    current_round: u64,
    round_finalized_at_ms: u64,
    round_payout_by_band: vector<u64>,
    round_paid_count: u64,
    round_eligible_count: u64,
    closed: bool,
    // 運用
    paused: bool,
}

public struct ClaimApplication has copy, drop, store {
    band: u8,
    applied_at_ms: u64,
    verified: bool,
    verified_in_round: u64,
    floor_claimed: bool,
    excluded: bool,
}

public struct PayoutKey has copy, drop, store {
    pass_lineage_id: ID,
    round: u64,
}

public struct CampaignCreated has copy, drop {
    campaign_id: ID,
    disaster_event_id: ID,
    event_uid: vector<u8>,
    event_revision: u32,
    category: u8,
    category_pool_id: ID,
    band_target_usdc: vector<u64>,
    floor_target_ratio_bps: u64,
    min_claim_band: u8,
    split_campaign_bps: u64,
    split_main_bps: u64,
    split_ops_bps: u64,
    campaign_ops_cap_usdc: u64,
    donation_end_ms: u64,
    claim_end_ms: u64,
    created_at_ms: u64,
    actor: address,
}

// ---------------------------------------------------------------
// constructor
// ---------------------------------------------------------------

public(package) fun create_campaign(
    category_registry: &CategoryRegistry,
    category_pool: &CategoryPool,
    disaster_event_id: ID,
    event_uid: vector<u8>,
    event_revision: u32,
    hazard_type: u8,
    severity_band: u8,
    clock: &Clock,
    ctx: &mut TxContext,
): option::Option<ID> {
    if (severity_band < MIN_CLAIM_BAND) {
        return option::none()
    };

    let category = if (hazard_type == HAZARD_TYPE_EARTHQUAKE) {
        category_pool::category_earthquake()
    } else {
        hazard_type // fallback: use hazard_type as category
    };

    let pool_id = category_pool::category_pool_id(category_pool);
    category_pool::assert_category_registered(category_registry, category, pool_id);

    let created_at_ms = clock::timestamp_ms(clock);
    let donation_end_ms = created_at_ms + DONATION_PERIOD_MS;
    let claim_end_ms = created_at_ms + CLAIM_PERIOD_MS;

    let band_target_usdc = vector[BAND_1_TARGET_USDC, BAND_2_TARGET_USDC, BAND_3_TARGET_USDC];

    let campaign = Campaign {
        id: object::new(ctx),
        version: VERSION,
        disaster_event_id,
        event_uid,
        event_revision,
        category,
        category_pool_id: pool_id,
        balance: balance::zero(),
        floor_balance: balance::zero(),
        floor_from_category_usdc: 0,
        floor_from_main_usdc: 0,
        census_set: false,
        registered_members_by_band: vector[0, 0, 0],
        max_liability_usdc: 0,
        floor_ratio_bps: 0,
        floor_amount_by_band: vector[0, 0, 0],
        floor_paid_count: 0,
        floor_total_paid_usdc: 0,
        floor_budget_returned: false,
        total_donated_usdc: 0,
        total_paid_usdc: 0,
        ops_withheld_usdc: 0,
        band_target_usdc,
        round_cap_multiplier: ROUND_CAP_MULTIPLIER,
        floor_target_ratio_bps: FLOOR_TARGET_RATIO_BPS,
        min_claim_band: MIN_CLAIM_BAND,
        split_campaign_bps: SPLIT_CAMPAIGN_BPS,
        split_main_bps: SPLIT_MAIN_BPS,
        split_ops_bps: SPLIT_OPS_BPS,
        campaign_ops_cap_usdc: CAMPAIGN_OPS_CAP_USDC,
        round_interval_ms: ROUND_INTERVAL_MS,
        min_payout_per_recipient_usdc: MIN_PAYOUT_PER_RECIPIENT_USDC,
        category_annual_event_divisor: CATEGORY_ANNUAL_EVENT_DIVISOR,
        floor_main_share_bps: FLOOR_MAIN_SHARE_BPS,
        created_at_ms,
        donation_end_ms,
        claim_end_ms,
        applied_count_by_band: vector[0, 0, 0],
        verified_count_by_band: vector[0, 0, 0],
        current_round: 0,
        round_finalized_at_ms: 0,
        round_payout_by_band: vector[0, 0, 0],
        round_paid_count: 0,
        round_eligible_count: 0,
        closed: false,
        paused: false,
    };

    let campaign_id = object::id(&campaign);

    event::emit(CampaignCreated {
        campaign_id,
        disaster_event_id: campaign.disaster_event_id,
        event_uid: campaign.event_uid,
        event_revision: campaign.event_revision,
        category: campaign.category,
        category_pool_id: campaign.category_pool_id,
        band_target_usdc: campaign.band_target_usdc,
        floor_target_ratio_bps: campaign.floor_target_ratio_bps,
        min_claim_band: campaign.min_claim_band,
        split_campaign_bps: campaign.split_campaign_bps,
        split_main_bps: campaign.split_main_bps,
        split_ops_bps: campaign.split_ops_bps,
        campaign_ops_cap_usdc: campaign.campaign_ops_cap_usdc,
        donation_end_ms: campaign.donation_end_ms,
        claim_end_ms: campaign.claim_end_ms,
        created_at_ms: campaign.created_at_ms,
        actor: ctx.sender(),
    });

    transfer::share_object(campaign);

    option::some(campaign_id)
}

// ---------------------------------------------------------------
// accessors
// ---------------------------------------------------------------

public(package) fun campaign_id(c: &Campaign): ID {
    object::id(c)
}

public(package) fun campaign_version(c: &Campaign): u64 {
    c.version
}

public(package) fun campaign_disaster_event_id(c: &Campaign): ID {
    c.disaster_event_id
}

public(package) fun campaign_event_uid(c: &Campaign): vector<u8> {
    c.event_uid
}

public(package) fun campaign_event_revision(c: &Campaign): u32 {
    c.event_revision
}

public(package) fun campaign_category(c: &Campaign): u8 {
    c.category
}

public(package) fun campaign_category_pool_id(c: &Campaign): ID {
    c.category_pool_id
}

public(package) fun campaign_census_set(c: &Campaign): bool {
    c.census_set
}

public(package) fun campaign_floor_target_ratio_bps(c: &Campaign): u64 {
    c.floor_target_ratio_bps
}

public(package) fun campaign_donation_end_ms(c: &Campaign): u64 {
    c.donation_end_ms
}

public(package) fun campaign_claim_end_ms(c: &Campaign): u64 {
    c.claim_end_ms
}

public(package) fun campaign_created_at_ms(c: &Campaign): u64 {
    c.created_at_ms
}

public(package) fun campaign_min_claim_band(c: &Campaign): u8 {
    c.min_claim_band
}

public(package) fun campaign_band_target_usdc(c: &Campaign): vector<u64> {
    c.band_target_usdc
}

public(package) fun campaign_paused(c: &Campaign): bool {
    c.paused
}

public(package) fun campaign_closed(c: &Campaign): bool {
    c.closed
}

public(package) fun campaign_split_campaign_bps(c: &Campaign): u64 {
    c.split_campaign_bps
}

public(package) fun campaign_split_main_bps(c: &Campaign): u64 {
    c.split_main_bps
}

public(package) fun campaign_split_ops_bps(c: &Campaign): u64 {
    c.split_ops_bps
}

public(package) fun campaign_ops_cap_usdc(c: &Campaign): u64 {
    c.campaign_ops_cap_usdc
}

public(package) fun campaign_ops_withheld_usdc(c: &Campaign): u64 {
    c.ops_withheld_usdc
}

public(package) fun campaign_total_donated_usdc(c: &Campaign): u64 {
    c.total_donated_usdc
}

public(package) fun deposit_campaign_usdc(c: &mut Campaign, coin: Coin<USDC>) {
    balance::join(&mut c.balance, coin::into_balance(coin));
}

public(package) fun update_ops_withheld(c: &mut Campaign, delta: u64) {
    c.ops_withheld_usdc = c.ops_withheld_usdc + delta;
}

public(package) fun update_total_donated(c: &mut Campaign, delta: u64) {
    c.total_donated_usdc = c.total_donated_usdc + delta;
}

public(package) fun assert_campaign_version(c: &Campaign) {
    assert!(c.version == VERSION, EVersionMismatch);
}

public(package) fun version(): u64 {
    VERSION
}

public(package) fun min_claim_band(): u8 {
    MIN_CLAIM_BAND
}

// ---------------------------------------------------------------
// test-only helpers
// ---------------------------------------------------------------

#[test_only]
public fun campaign_created_event_fields(
    event: CampaignCreated,
): (ID, ID, u8, u64, u64, u64, address) {
    let CampaignCreated {
        campaign_id,
        disaster_event_id,
        category,
        donation_end_ms,
        claim_end_ms,
        created_at_ms,
        actor,
        event_uid: _,
        event_revision: _,
        category_pool_id: _,
        band_target_usdc: _,
        floor_target_ratio_bps: _,
        min_claim_band: _,
        split_campaign_bps: _,
        split_main_bps: _,
        split_ops_bps: _,
        campaign_ops_cap_usdc: _,
    } = event;
    (campaign_id, disaster_event_id, category, donation_end_ms, claim_end_ms, created_at_ms, actor)
}

#[test_only]
public fun campaign_snapshot_fields_for_testing(
    c: &Campaign,
): (u64, u64, u8, u64, u64, u64) {
    (
        c.round_cap_multiplier,
        c.floor_target_ratio_bps,
        c.min_claim_band,
        c.campaign_ops_cap_usdc,
        c.category_annual_event_divisor,
        c.floor_main_share_bps,
    )
}

#[test_only]
public fun hazard_type_earthquake_for_testing(): u8 {
    HAZARD_TYPE_EARTHQUAKE
}

#[test_only]
public fun set_ops_withheld_for_testing(c: &mut Campaign, value: u64) {
    c.ops_withheld_usdc = value;
}
