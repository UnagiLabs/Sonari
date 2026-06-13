#[allow(unused_const, unused_field)]
module contracts::campaign;

use contracts::affected_cell::{Self, AffectedCellLeaf, ProofStep};
use contracts::category_pool::{Self, CategoryPool, CategoryRegistry};
use contracts::census_result::{Self, FloorCensusResult};
use contracts::identity_registry::{Self, IdentityRegistry};
use contracts::membership::{Self, MembershipRegistry, MembershipPass};
use contracts::pools::{Self, MainPool};
use sui::balance::{Self, Balance};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::dynamic_field;
use sui::event;
use usdc::usdc::USDC;

// ---------------------------------------------------------------
// constants
// ---------------------------------------------------------------

const VERSION: u64 = 1;
const HAZARD_TYPE_EARTHQUAKE: u8 = 1;
const CLAIM_KIND_FLOOR: u8 = 0;
const CLAIM_KIND_PAYOUT: u8 = 1;
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
const EClaimWindowClosed: u64 = 3;
const EDisasterEventMismatch: u64 = 4;
const EInvalidAffectedCellProof: u64 = 5;
const EClaimBandTooLow: u64 = 6;
const EAccountCreatedAfterCutoff: u64 = 7;
const EHomeCellRegisteredAfterCutoff: u64 = 8;
const EResidenceCellMismatch: u64 = 9;
// 10 (EDuplicateApplication) / 11 (EClaimAlreadyVerified) は claim 統合で不要になり削除
const EClaimAlreadyExcluded: u64 = 12;
const ECampaignClosed: u64 = 13;
const EFloorCensusAlreadySet: u64 = 14;
const EFloorCensusNotSet: u64 = 15;
const EFloorBudgetAlreadyReturned: u64 = 16;
const EDonationPeriodNotOver: u64 = 17;
const ECampaignCategoryPoolMismatch: u64 = 18;
const EFloorCensusBindingMismatch: u64 = 19;
const EClaimApplicationNotFound: u64 = 20;
const EClaimNotVerified: u64 = 21;
// 22 (EFloorAlreadyClaimed) は claim 統合で ENothingToClaim に集約され削除
const EClaimExcluded: u64 = 23;
const EFloorCensusAfterDonationEnd: u64 = 24;
const EAlreadyClosed: u64 = 25;
// 26 (ERoundNotStarted) は claim 統合で ENothingToClaim に集約され削除
const ERoundTooEarly: u64 = 27;
// 28 (ERoundNotEligible) / 29 (EDuplicatePayout) は claim 統合で ENothingToClaim に集約され削除
const ESweepNotEligible: u64 = 30;
const EFloorBudgetNotReturned: u64 = 31;
const EApplicationNotVerified: u64 = 32;
const ENothingToClaim: u64 = 33;
const EClaimLeafRequired: u64 = 34;

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
    category_pool_id: ID,
    // 本払い資金（Round 1 以降）
    balance: Balance<USDC>,
    // 床払い escrow（Round 0）
    floor_balance: Balance<USDC>,
    floor_from_category_usdc: u64,
    floor_from_main_usdc: u64,
    // センサス確定値
    census_set: bool,
    floor_amount_by_band: vector<u64>,
    floor_budget_returned: bool,
    // リアルタイム表示用
    total_donated_usdc: u64,
    total_paid_usdc: u64,
    ops_withheld_usdc: u64,
    // 作成時スナップショット（以後不変）
    terms: CampaignTerms,
    // 締切
    donation_end_ms: u64,
    claim_end_ms: u64,
    // 申請状態
    verified_count_by_band: vector<u64>,
    // 本払いラウンド状態
    current_round: u64,
    round_finalized_at_ms: u64,
    round_payout_by_band: vector<u64>,
    closed: bool,
    sweep_eligible: bool,
    // 運用
    paused: bool,
}

public struct CampaignTerms has store {
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

public struct ClaimReceipt has key {
    id: UID,
    campaign_id: ID,
    pass_lineage_id: ID,
    round: u64,
    band: u8,
    amount_usdc: u64,
    claimed_at_ms: u64,
    kind: u8,
}

public struct FloorCensusSet has copy, drop {
    campaign_id: ID,
    registered_members_by_band: vector<u64>,
    max_liability_usdc: u64,
    floor_ratio_bps: u64,
    floor_amount_by_band: vector<u64>,
    draw_category_usdc: u64,
    draw_main_usdc: u64,
}

public struct FloorPaid has copy, drop {
    campaign_id: ID,
    pass_lineage_id: ID,
    band: u8,
    amount_usdc: u64,
    recipient: address,
    paid_at_ms: u64,
}

public struct FloorBudgetReturned has copy, drop {
    campaign_id: ID,
    returned_to_category_usdc: u64,
    returned_to_main_usdc: u64,
}

public struct ClaimSubmitted has copy, drop {
    campaign_id: ID,
    pass_lineage_id: ID,
    band: u8,
    applied_at_ms: u64,
    applicant: address,
}

public struct ClaimVerified has copy, drop {
    campaign_id: ID,
    pass_lineage_id: ID,
    band: u8,
    verified_at_ms: u64,
    verifier: address,
}

// PayoutReceipt は ClaimReceipt に統合された（kind=CLAIM_KIND_PAYOUT）

public struct RoundFinalized has copy, drop {
    campaign_id: ID,
    round: u64,
    liability: u64,
    campaign_available: u64,
    band_payout: vector<u64>,
    eligible_count: u64,
    finalized_at_ms: u64,
}

public struct PayoutClaimed has copy, drop {
    campaign_id: ID,
    round: u64,
    pass_lineage_id: ID,
    band: u8,
    amount_usdc: u64,
    recipient: address,
}

public struct ResidualSweep has copy, drop {
    campaign_id: ID,
    amount_usdc: u64,
    final_round: u64,
}

public struct RecipientExcluded has copy, drop {
    campaign_id: ID,
    pass_lineage_id: ID,
    reason_code: u8,
    round: u64,
    actor: address,
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

    let terms = CampaignTerms {
        band_target_usdc: vector[BAND_1_TARGET_USDC, BAND_2_TARGET_USDC, BAND_3_TARGET_USDC],
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
    };

    let campaign = Campaign {
        id: object::new(ctx),
        version: VERSION,
        disaster_event_id,
        event_uid,
        event_revision,
        category_pool_id: pool_id,
        balance: balance::zero(),
        floor_balance: balance::zero(),
        floor_from_category_usdc: 0,
        floor_from_main_usdc: 0,
        census_set: false,
        floor_amount_by_band: vector[0, 0, 0],
        floor_budget_returned: false,
        total_donated_usdc: 0,
        total_paid_usdc: 0,
        ops_withheld_usdc: 0,
        terms,
        donation_end_ms,
        claim_end_ms,
        verified_count_by_band: vector[0, 0, 0],
        current_round: 0,
        round_finalized_at_ms: 0,
        round_payout_by_band: vector[0, 0, 0],
        closed: false,
        sweep_eligible: false,
        paused: false,
    };

    let campaign_id = object::id(&campaign);

    event::emit(CampaignCreated {
        campaign_id,
        disaster_event_id: campaign.disaster_event_id,
        event_uid: campaign.event_uid,
        event_revision: campaign.event_revision,
        category,
        category_pool_id: campaign.category_pool_id,
        band_target_usdc: campaign.terms.band_target_usdc,
        floor_target_ratio_bps: campaign.terms.floor_target_ratio_bps,
        min_claim_band: campaign.terms.min_claim_band,
        split_campaign_bps: campaign.terms.split_campaign_bps,
        split_main_bps: campaign.terms.split_main_bps,
        split_ops_bps: campaign.terms.split_ops_bps,
        campaign_ops_cap_usdc: campaign.terms.campaign_ops_cap_usdc,
        donation_end_ms: campaign.donation_end_ms,
        claim_end_ms: campaign.claim_end_ms,
        created_at_ms,
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

public(package) fun campaign_category_pool_id(c: &Campaign): ID {
    c.category_pool_id
}

public(package) fun campaign_census_set(c: &Campaign): bool {
    c.census_set
}

public(package) fun campaign_floor_target_ratio_bps(c: &Campaign): u64 {
    c.terms.floor_target_ratio_bps
}

public(package) fun campaign_donation_end_ms(c: &Campaign): u64 {
    c.donation_end_ms
}

public(package) fun campaign_claim_end_ms(c: &Campaign): u64 {
    c.claim_end_ms
}

public(package) fun campaign_min_claim_band(c: &Campaign): u8 {
    c.terms.min_claim_band
}

public(package) fun campaign_band_target_usdc(c: &Campaign): vector<u64> {
    c.terms.band_target_usdc
}

public(package) fun campaign_paused(c: &Campaign): bool {
    c.paused
}

public(package) fun campaign_closed(c: &Campaign): bool {
    c.closed
}

public(package) fun campaign_split_campaign_bps(c: &Campaign): u64 {
    c.terms.split_campaign_bps
}

public(package) fun campaign_split_main_bps(c: &Campaign): u64 {
    c.terms.split_main_bps
}

public(package) fun campaign_split_ops_bps(c: &Campaign): u64 {
    c.terms.split_ops_bps
}

public(package) fun campaign_ops_cap_usdc(c: &Campaign): u64 {
    c.terms.campaign_ops_cap_usdc
}

public(package) fun campaign_ops_withheld_usdc(c: &Campaign): u64 {
    c.ops_withheld_usdc
}

public(package) fun campaign_total_donated_usdc(c: &Campaign): u64 {
    c.total_donated_usdc
}

public(package) fun campaign_total_paid_usdc(c: &Campaign): u64 {
    c.total_paid_usdc
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
// floor census
// ---------------------------------------------------------------

public(package) fun apply_floor_census(
    campaign: &mut Campaign,
    result: &FloorCensusResult,
    disaster_event_uid: vector<u8>,
    disaster_event_revision: u32,
    disaster_event_affected_cells_root: vector<u8>,
    category_pool: &mut CategoryPool,
    main_pool: &mut MainPool,
    now_ms: u64,
    ctx: &mut TxContext,
) {
    assert!(!campaign.census_set, EFloorCensusAlreadySet);
    assert!(now_ms < campaign.donation_end_ms, EFloorCensusAfterDonationEnd);
    assert!(
        category_pool::category_pool_id(category_pool) == campaign.category_pool_id,
        ECampaignCategoryPoolMismatch,
    );
    // census が campaign 自身の DisasterEvent に紐付いていることを検証する
    assert!(campaign.event_uid == disaster_event_uid, EFloorCensusBindingMismatch);
    assert!(campaign.event_revision == disaster_event_revision, EFloorCensusBindingMismatch);
    assert!(census_result::event_uid(result) == disaster_event_uid, EFloorCensusBindingMismatch);
    assert!(
        census_result::event_revision(result) == disaster_event_revision,
        EFloorCensusBindingMismatch,
    );
    assert!(
        census_result::affected_cells_root(result) == disaster_event_affected_cells_root,
        EFloorCensusBindingMismatch,
    );

    let registered = census_result::registered_members_by_band(result);
    let band_targets = campaign.terms.band_target_usdc;

    let mut max_liability: u128 = 0;
    let mut i = 0;
    while (i < BAND_COUNT) {
        max_liability = max_liability
            + (*registered.borrow(i) as u128) * (*band_targets.borrow(i) as u128);
        i = i + 1;
    };

    let campaign_id = object::id(campaign);

    if (max_liability == 0) {
        campaign.census_set = true;
        event::emit(FloorCensusSet {
            campaign_id,
            registered_members_by_band: registered,
            max_liability_usdc: 0,
            floor_ratio_bps: 0,
            floor_amount_by_band: vector[0, 0, 0],
            draw_category_usdc: 0,
            draw_main_usdc: 0,
        });
        return
    };

    let floor_target = ((max_liability * (FLOOR_TARGET_RATIO_BPS as u128)) / (BPS_DENOMINATOR as u128)) as u64;

    let cat_balance = category_pool::category_pool_balance_usdc(category_pool);
    let cat_available = cat_balance / campaign.terms.category_annual_event_divisor;
    let draw_category = if (floor_target <= cat_available) { floor_target } else { cat_available };

    let rem = floor_target - draw_category;
    let main_disposable = pools::main_pool_disposable_floor_usdc(main_pool);
    let main_share =
        ((main_disposable as u128 * (campaign.terms.floor_main_share_bps as u128)) / (BPS_DENOMINATOR as u128)) as u64;
    let draw_main = if (rem <= main_share) { rem } else { main_share };

    let floor_budget = draw_category + draw_main;
    let ratio = ((floor_budget as u128) * (BPS_DENOMINATOR as u128) / max_liability) as u64;
    let floor_ratio_bps = if (ratio <= FLOOR_TARGET_RATIO_BPS) { ratio } else { FLOOR_TARGET_RATIO_BPS };

    let floor_amount_by_band = vector::tabulate!(BAND_COUNT, |b| {
        *band_targets.borrow(b) * floor_ratio_bps / BPS_DENOMINATOR
    });

    if (draw_category > 0) {
        let cat_coin = category_pool::fund_floor_from_category(category_pool, draw_category, ctx);
        balance::join(&mut campaign.floor_balance, coin::into_balance(cat_coin));
    };
    if (draw_main > 0) {
        let main_coin = pools::fund_floor_from_main(main_pool, draw_main, ctx);
        balance::join(&mut campaign.floor_balance, coin::into_balance(main_coin));
    };

    campaign.census_set = true;
    campaign.floor_amount_by_band = floor_amount_by_band;
    campaign.floor_from_category_usdc = draw_category;
    campaign.floor_from_main_usdc = draw_main;

    event::emit(FloorCensusSet {
        campaign_id,
        registered_members_by_band: registered,
        max_liability_usdc: max_liability as u64,
        floor_ratio_bps,
        floor_amount_by_band: campaign.floor_amount_by_band,
        draw_category_usdc: draw_category,
        draw_main_usdc: draw_main,
    });
}

// ---------------------------------------------------------------
// claim floor
// ---------------------------------------------------------------

public(package) fun add_claim_application(
    campaign: &mut Campaign,
    pass_lineage_id: ID,
    band: u8,
    now_ms: u64,
) {
    dynamic_field::add(
        &mut campaign.id,
        pass_lineage_id,
        ClaimApplication {
            band,
            applied_at_ms: now_ms,
            verified: false,
            verified_in_round: 0,
            floor_claimed: false,
            excluded: false,
        },
    );
}

public(package) fun set_claim_verified(
    campaign: &mut Campaign,
    pass_lineage_id: ID,
    round: u64,
) {
    let app = dynamic_field::borrow_mut<ID, ClaimApplication>(&mut campaign.id, pass_lineage_id);
    app.verified = true;
    app.verified_in_round = round;
    let band_idx = (app.band as u64) - 1;
    let count = campaign.verified_count_by_band.borrow_mut(band_idx);
    *count = *count + 1;
}

// ---------------------------------------------------------------
// pay_claim: 床払い・本払い共通の「コイン送出 + ClaimReceipt 発行 + イベント発行」
// ---------------------------------------------------------------

fun pay_claim(
    campaign: &mut Campaign,
    kind: u8,
    amount: u64,
    round: u64,
    band: u8,
    pass_lineage_id: ID,
    recipient: address,
    now_ms: u64,
    ctx: &mut TxContext,
) {
    let campaign_id = object::id(campaign);

    // kind に応じて balance を取り出す
    let coin = if (kind == CLAIM_KIND_FLOOR) {
        coin::from_balance(campaign.floor_balance.split(amount), ctx)
    } else {
        coin::from_balance(campaign.balance.split(amount), ctx)
    };
    transfer::public_transfer(coin, recipient);

    let receipt = ClaimReceipt {
        id: object::new(ctx),
        campaign_id,
        pass_lineage_id,
        round,
        band,
        amount_usdc: amount,
        claimed_at_ms: now_ms,
        kind,
    };
    transfer::transfer(receipt, recipient);

    // イベントは種別に応じて従来のまま emit する（dapp が型文字列を購読しているため変更禁止）
    if (kind == CLAIM_KIND_FLOOR) {
        event::emit(FloorPaid {
            campaign_id,
            pass_lineage_id,
            band,
            amount_usdc: amount,
            recipient,
            paid_at_ms: now_ms,
        });
    } else {
        event::emit(PayoutClaimed {
            campaign_id,
            round,
            pass_lineage_id,
            band,
            amount_usdc: amount,
            recipient,
        });
    };
}

// ---------------------------------------------------------------
// return floor budget
// ---------------------------------------------------------------

public(package) fun return_floor_budget(
    campaign: &mut Campaign,
    category_pool: &mut CategoryPool,
    main_pool: &mut MainPool,
    now_ms: u64,
    ctx: &mut TxContext,
) {
    assert!(now_ms >= campaign.donation_end_ms, EDonationPeriodNotOver);
    assert!(campaign.census_set, EFloorCensusNotSet);
    assert!(!campaign.floor_budget_returned, EFloorBudgetAlreadyReturned);
    assert!(
        category_pool::category_pool_id(category_pool) == campaign.category_pool_id,
        ECampaignCategoryPoolMismatch,
    );

    campaign.floor_budget_returned = true;

    let remaining = campaign.floor_balance.value();
    let campaign_id = object::id(campaign);

    let (returned_to_category, returned_to_main) = if (remaining == 0) {
        (0u64, 0u64)
    } else {
        let total_funded = campaign.floor_from_category_usdc + campaign.floor_from_main_usdc;
        if (total_funded == 0) {
            (remaining, 0u64)
        } else {
            let return_to_main = ((remaining as u128)
                * (campaign.floor_from_main_usdc as u128)
                / (total_funded as u128)) as u64;
            (remaining - return_to_main, return_to_main)
        }
    };

    if (returned_to_category > 0) {
        let cat_coin = coin::from_balance(campaign.floor_balance.split(returned_to_category), ctx);
        category_pool::receive_returned_floor(category_pool, cat_coin);
    };
    if (returned_to_main > 0) {
        let main_coin = coin::from_balance(campaign.floor_balance.split(returned_to_main), ctx);
        pools::receive_swept_to_main(main_pool, main_coin);
    };

    event::emit(FloorBudgetReturned {
        campaign_id,
        returned_to_category_usdc: returned_to_category,
        returned_to_main_usdc: returned_to_main,
    });
}

// ---------------------------------------------------------------
// test-only helpers
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// claim: 受け取りの単一入口（初回の資格確立・床払い・本払い・lazy finalize を内包）
// ---------------------------------------------------------------

/// ラウンドを進める時間境界に達しているかを返す。
/// finalize_round_v2 の時間ガードと同一の条件で判定する。
fun round_boundary_reached(campaign: &Campaign, now_ms: u64): bool {
    if (campaign.current_round == 0) {
        now_ms >= campaign.donation_end_ms
    } else {
        now_ms >= campaign.round_finalized_at_ms + campaign.terms.round_interval_ms
    }
}

/// 被災者の受け取り単一入口。
/// - 初回（申請未登録）: submit_claim + verify_claim 相当の検証を 1 回で行い、資格を確立する。
/// - 既申請: 検証済みかつ未除外であることを確認する。leaf/proof が来ても破棄する。
/// - lazy finalize: 時間境界を跨いでいればラウンドを確定する（独立 finalize 入口の代替）。
/// - 床払い・本払い: 受給可能ならそれぞれ pay_claim で支払う。
/// お金の計算ルールは旧 claim_floor_payment / claim_payout_v2 と一切変えない。
public(package) fun claim(
    campaign: &mut Campaign,
    disaster_event_id: ID,
    disaster_event_uid: vector<u8>,
    disaster_event_revision: u32,
    disaster_event_affected_cells_root: vector<u8>,
    disaster_event_occurred_at_ms: u64,
    identity_registry: &IdentityRegistry,
    membership_registry: &MembershipRegistry,
    pass: &MembershipPass,
    identity_provider: u8,
    duplicate_key_hash: vector<u8>,
    leaf: option::Option<AffectedCellLeaf>,
    proof: vector<ProofStep>,
    now_ms: u64,
    ctx: &mut TxContext,
) {
    // 先頭ガード
    assert!(campaign.version == VERSION, EVersionMismatch);
    assert!(!campaign.paused, ECampaignPaused);
    assert!(!campaign.closed, ECampaignClosed);

    // SBT precheck（全経路共通）
    membership::assert_current_pass_precheck(membership_registry, pass, ctx.sender());
    let pass_lineage_id = membership::membership_pass_lineage_id(pass);
    let pass_owner = membership::membership_pass_owner(pass);

    let is_first_time =
        !dynamic_field::exists_with_type<ID, ClaimApplication>(&campaign.id, pass_lineage_id);

    // 床払い可否（センサス確定済み・予算未返却・未受給）を先に判定する。
    let floor_already_claimed = if (is_first_time) {
        false
    } else {
        let app = dynamic_field::borrow<ID, ClaimApplication>(&campaign.id, pass_lineage_id);
        app.floor_claimed
    };
    let will_pay_floor =
        !floor_already_claimed && campaign.census_set && !campaign.floor_budget_returned;

    // 本人確認は初回の資格確立（旧 verify_claim）と床払い（旧 claim_floor_payment）で必須。
    // 本払いのみ（旧 claim_payout_v2）は従来どおり本人確認を要求しない。
    if (is_first_time || will_pay_floor) {
        identity_registry::assert_identity_verified(
            identity_registry,
            pass_lineage_id,
            ctx.sender(),
            identity_provider,
            now_ms,
        );
        identity_registry::assert_duplicate_key_bound_to_pass(
            identity_registry,
            pass_lineage_id,
            identity_provider,
            duplicate_key_hash,
        );
    };

    if (is_first_time) {
        // 初回: submit_claim + verify_claim の検証を 1 回で実施する。
        assert!(now_ms < campaign.claim_end_ms, EClaimWindowClosed);
        assert!(leaf.is_some(), EClaimLeafRequired);
        let leaf_val = leaf.destroy_some();

        // Disaster event binding
        assert!(campaign.disaster_event_id == disaster_event_id, EDisasterEventMismatch);
        assert!(affected_cell::event_uid(&leaf_val) == disaster_event_uid, EDisasterEventMismatch);
        assert!(
            affected_cell::event_revision(&leaf_val) == disaster_event_revision,
            EDisasterEventMismatch,
        );

        // Merkle proof
        assert!(
            affected_cell::verify_proof(&leaf_val, proof, disaster_event_affected_cells_root),
            EInvalidAffectedCellProof,
        );

        // Band check
        let cell_band = affected_cell::cell_band(&leaf_val);
        assert!(cell_band >= campaign.terms.min_claim_band, EClaimBandTooLow);

        // Time cutoff
        let (account_created_at_ms, home_cell, home_cell_registered_at_ms, _, _) =
            membership::membership_pass_mvp_summary(pass);
        assert!(account_created_at_ms < disaster_event_occurred_at_ms, EAccountCreatedAfterCutoff);
        assert!(
            home_cell_registered_at_ms < disaster_event_occurred_at_ms,
            EHomeCellRegisteredAfterCutoff,
        );

        // Area check
        assert!(home_cell == affected_cell::h3_index(&leaf_val), EResidenceCellMismatch);

        // Register + mark verified
        add_claim_application(campaign, pass_lineage_id, cell_band, now_ms);
        let current_round = campaign.current_round;
        set_claim_verified(campaign, pass_lineage_id, current_round);

        let campaign_id = object::id(campaign);
        event::emit(ClaimSubmitted {
            campaign_id,
            pass_lineage_id,
            band: cell_band,
            applied_at_ms: now_ms,
            applicant: ctx.sender(),
        });
        event::emit(ClaimVerified {
            campaign_id,
            pass_lineage_id,
            band: cell_band,
            verified_at_ms: now_ms,
            verifier: ctx.sender(),
        });
    } else {
        // 既申請: 検証済みかつ未除外を要求する。
        let app = dynamic_field::borrow<ID, ClaimApplication>(&campaign.id, pass_lineage_id);
        assert!(app.verified, EClaimNotVerified);
        assert!(!app.excluded, EClaimExcluded);
    };

    // lazy finalize: 時間境界を跨いでいればラウンドを確定する。
    if (round_boundary_reached(campaign, now_ms)) {
        finalize_round_v2(campaign, now_ms);
    };

    let mut paid_something = false;

    // 床払い（Round 0 escrow）
    if (will_pay_floor) {
        let band = {
            let app = dynamic_field::borrow_mut<ID, ClaimApplication>(&mut campaign.id, pass_lineage_id);
            app.floor_claimed = true;
            app.band
        };
        let band_idx = (band as u64) - 1;
        let amount = *campaign.floor_amount_by_band.borrow(band_idx);
        campaign.total_paid_usdc = campaign.total_paid_usdc + amount;
        pay_claim(campaign, CLAIM_KIND_FLOOR, amount, 0, band, pass_lineage_id, pass_owner, now_ms, ctx);
        paid_something = true;
    };

    // 本払い（Round 1 以降）
    let current_round = campaign.current_round;
    if (current_round >= 1) {
        let (verified_in_round, band) = {
            let app = dynamic_field::borrow<ID, ClaimApplication>(&campaign.id, pass_lineage_id);
            (app.verified_in_round, app.band)
        };
        if (verified_in_round < current_round) {
            let payout_key = PayoutKey { pass_lineage_id, round: current_round };
            if (!dynamic_field::exists_with_type<PayoutKey, bool>(&campaign.id, payout_key)) {
                let band_idx = (band as u64) - 1;
                let amount = *campaign.round_payout_by_band.borrow(band_idx);
                dynamic_field::add(&mut campaign.id, payout_key, true);
                campaign.total_paid_usdc = campaign.total_paid_usdc + amount;
                pay_claim(
                    campaign,
                    CLAIM_KIND_PAYOUT,
                    amount,
                    current_round,
                    band,
                    pass_lineage_id,
                    pass_owner,
                    now_ms,
                    ctx,
                );
                paid_something = true;
            };
        };
    };

    // 受け取りは必ず前進すること。初回登録か、何らかの支払いが発生していなければ拒否する。
    assert!(is_first_time || paid_something, ENothingToClaim);
}

// ---------------------------------------------------------------
// finalize_round / claim_payout / sweep_residual / exclude_recipient
// ---------------------------------------------------------------

fun sum_vec(v: &vector<u64>): u64 {
    let mut total = 0u64;
    let mut i = 0u64;
    while (i < v.length()) {
        total = total + *v.borrow(i);
        i = i + 1;
    };
    total
}

public(package) fun finalize_round_v2(
    campaign: &mut Campaign,
    now_ms: u64,
) {
    assert!(campaign.version == VERSION, EVersionMismatch);
    assert!(!campaign.paused, ECampaignPaused);
    assert!(!campaign.closed, EAlreadyClosed);

    // Time guard: Round 1 waits for donation period; Round N waits for round interval
    if (campaign.current_round == 0) {
        assert!(now_ms >= campaign.donation_end_ms, ERoundTooEarly);
    } else {
        assert!(
            now_ms >= campaign.round_finalized_at_ms + campaign.terms.round_interval_ms,
            ERoundTooEarly,
        );
    };

    let eligible_count_by_band = campaign.verified_count_by_band;
    let total_eligible = sum_vec(&eligible_count_by_band);

    // Compute liability (u128 for overflow safety)
    let mut liability128: u128 = 0;
    let mut b = 0u64;
    while (b < BAND_COUNT) {
        let members = (*eligible_count_by_band.borrow(b) as u128);
        let target = (*campaign.terms.band_target_usdc.borrow(b) as u128);
        liability128 = liability128 + members * target;
        b = b + 1;
    };

    let campaign_av = campaign.balance.value();

    // Termination check: balance per recipient too small
    if (total_eligible > 0
        && (campaign_av as u128)
            < (campaign.terms.min_payout_per_recipient_usdc as u128) * (total_eligible as u128)) {
        campaign.sweep_eligible = true;
        return
    };

    // Compute per-band payouts
    let mut band_payout = vector[0u64, 0u64, 0u64];
    if (liability128 > 0) {
        // 適格受給者が存在するため sweep フラグを必ずリセットする
        campaign.sweep_eligible = false;
        let cap128 = liability128 * (campaign.terms.round_cap_multiplier as u128);
        let effective_av128 = if ((campaign_av as u128) > cap128) { cap128 } else { campaign_av as u128 };
        let mut b2 = 0u64;
        while (b2 < BAND_COUNT) {
            let target128 = (*campaign.terms.band_target_usdc.borrow(b2) as u128);
            let payout = target128 * effective_av128 / liability128;
            *band_payout.borrow_mut(b2) = payout as u64;
            b2 = b2 + 1;
        };
    } else {
        // liability == 0: no eligible recipients → sweep is possible
        campaign.sweep_eligible = true;
    };

    let round = campaign.current_round + 1;
    campaign.current_round = round;
    campaign.round_finalized_at_ms = now_ms;
    campaign.round_payout_by_band = band_payout;

    let campaign_id = object::id(campaign);
    let liability = (liability128 as u64);
    event::emit(RoundFinalized {
        campaign_id,
        round,
        liability,
        campaign_available: campaign_av,
        band_payout,
        eligible_count: total_eligible,
        finalized_at_ms: now_ms,
    });
}

public(package) fun sweep_residual_v2(
    campaign: &mut Campaign,
    main_pool: &mut MainPool,
    now_ms: u64,
    ctx: &mut TxContext,
) {
    assert!(campaign.version == VERSION, EVersionMismatch);
    assert!(!campaign.closed, EAlreadyClosed);
    assert!(campaign.floor_budget_returned, EFloorBudgetNotReturned);

    // 回収条件: finalize が立てた sweep_eligible フラグ、またはタイムアウト経過。
    // タイムアウトは finalize の実行有無に依存させず、資金が永久に stuck するのを防ぐ。
    // - Round 0（finalize 未実行）: donation_end_ms を基準にする。
    // - Round >=1（finalize 済みだが誰も claim しない）: 直近 finalize 時刻を基準にする。
    let timeout_base_ms = if (campaign.current_round == 0) {
        campaign.donation_end_ms
    } else {
        campaign.round_finalized_at_ms
    };
    let timeout_reached = now_ms >= timeout_base_ms + campaign.terms.round_interval_ms;
    assert!(campaign.sweep_eligible || timeout_reached, ESweepNotEligible);

    let amount = campaign.balance.value();
    let final_round = campaign.current_round;
    let campaign_id = object::id(campaign);

    campaign.closed = true;

    if (amount > 0) {
        let sweep_coin = coin::from_balance(campaign.balance.split(amount), ctx);
        pools::receive_swept_to_main(main_pool, sweep_coin);
    };

    event::emit(ResidualSweep {
        campaign_id,
        amount_usdc: amount,
        final_round,
    });
}

public(package) fun exclude_recipient_internal(
    campaign: &mut Campaign,
    pass_lineage_id: ID,
    reason_code: u8,
    now_ms: u64,
    ctx: &TxContext,
) {
    assert!(campaign.version == VERSION, EVersionMismatch);
    assert!(!campaign.closed, EAlreadyClosed);
    assert!(
        dynamic_field::exists_with_type<ID, ClaimApplication>(&campaign.id, pass_lineage_id),
        EClaimApplicationNotFound,
    );
    let app = dynamic_field::borrow_mut<ID, ClaimApplication>(&mut campaign.id, pass_lineage_id);
    assert!(!app.excluded, EClaimAlreadyExcluded);

    app.excluded = true;
    // Decrement verified count so next finalize_round reflects the exclusion
    if (app.verified && app.band >= 1) {
        let band_idx = (app.band as u64) - 1;
        let count = campaign.verified_count_by_band.borrow_mut(band_idx);
        *count = *count - 1;
    };

    let campaign_id = object::id(campaign);
    event::emit(RecipientExcluded {
        campaign_id,
        pass_lineage_id,
        reason_code,
        round: campaign.current_round,
        actor: ctx.sender(),
    });
    let _ = now_ms;
}

// ---------------------------------------------------------------
// floor census / floor pay error code exports (for test expected_failure)
// ---------------------------------------------------------------

public(package) fun e_floor_census_already_set(): u64 { EFloorCensusAlreadySet }
public(package) fun e_floor_census_not_set(): u64 { EFloorCensusNotSet }
public(package) fun e_floor_budget_already_returned(): u64 { EFloorBudgetAlreadyReturned }
public(package) fun e_donation_period_not_over(): u64 { EDonationPeriodNotOver }
public(package) fun e_campaign_category_pool_mismatch(): u64 { ECampaignCategoryPoolMismatch }
public(package) fun e_floor_census_binding_mismatch(): u64 { EFloorCensusBindingMismatch }
public(package) fun e_claim_application_not_found(): u64 { EClaimApplicationNotFound }
public(package) fun e_claim_not_verified(): u64 { EClaimNotVerified }
public(package) fun e_floor_census_after_donation_end(): u64 { EFloorCensusAfterDonationEnd }
public(package) fun e_claim_window_closed(): u64 { EClaimWindowClosed }
public(package) fun e_disaster_event_mismatch(): u64 { EDisasterEventMismatch }
public(package) fun e_invalid_affected_cell_proof(): u64 { EInvalidAffectedCellProof }
public(package) fun e_claim_band_too_low(): u64 { EClaimBandTooLow }
public(package) fun e_account_created_after_cutoff(): u64 { EAccountCreatedAfterCutoff }
public(package) fun e_home_cell_registered_after_cutoff(): u64 { EHomeCellRegisteredAfterCutoff }
public(package) fun e_residence_cell_mismatch(): u64 { EResidenceCellMismatch }
public(package) fun e_claim_already_excluded(): u64 { EClaimAlreadyExcluded }
public(package) fun e_already_closed(): u64 { EAlreadyClosed }
public(package) fun e_round_too_early(): u64 { ERoundTooEarly }
public(package) fun e_sweep_not_eligible(): u64 { ESweepNotEligible }
public(package) fun e_floor_budget_not_returned(): u64 { EFloorBudgetNotReturned }
public(package) fun e_application_not_verified(): u64 { EApplicationNotVerified }
public(package) fun e_nothing_to_claim(): u64 { ENothingToClaim }
public(package) fun e_claim_leaf_required(): u64 { EClaimLeafRequired }

// ---------------------------------------------------------------
// accessor read-only helpers for tests
// ---------------------------------------------------------------

public(package) fun campaign_floor_census_fields(
    c: &Campaign,
): (bool, vector<u64>, u64, u64, u64, bool) {
    (
        c.census_set,
        c.floor_amount_by_band,
        c.floor_from_category_usdc,
        c.floor_from_main_usdc,
        c.floor_balance.value(),
        c.floor_budget_returned,
    )
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
public fun campaign_terms_fields_for_testing(
    c: &Campaign,
): (vector<u64>, u64, u64, u8, u64, u64, u64, u64, u64, u64, u64, u64) {
    (
        c.terms.band_target_usdc,
        c.terms.round_cap_multiplier,
        c.terms.floor_target_ratio_bps,
        c.terms.min_claim_band,
        c.terms.split_campaign_bps,
        c.terms.split_main_bps,
        c.terms.split_ops_bps,
        c.terms.campaign_ops_cap_usdc,
        c.terms.round_interval_ms,
        c.terms.min_payout_per_recipient_usdc,
        c.terms.category_annual_event_divisor,
        c.terms.floor_main_share_bps,
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

#[test_only]
public fun add_claim_application_for_testing(
    campaign: &mut Campaign,
    pass_lineage_id: ID,
    band: u8,
    verified: bool,
    floor_claimed: bool,
    excluded: bool,
    now_ms: u64,
) {
    dynamic_field::add(
        &mut campaign.id,
        pass_lineage_id,
        ClaimApplication {
            band,
            applied_at_ms: now_ms,
            verified,
            verified_in_round: 0,
            floor_claimed,
            excluded,
        },
    );
}

#[test_only]
public fun floor_census_set_event_fields(
    event: FloorCensusSet,
): (ID, vector<u64>, u64, u64, vector<u64>, u64, u64) {
    let FloorCensusSet {
        campaign_id,
        registered_members_by_band,
        max_liability_usdc,
        floor_ratio_bps,
        floor_amount_by_band,
        draw_category_usdc,
        draw_main_usdc,
    } = event;
    (
        campaign_id,
        registered_members_by_band,
        max_liability_usdc,
        floor_ratio_bps,
        floor_amount_by_band,
        draw_category_usdc,
        draw_main_usdc,
    )
}

#[test_only]
public fun floor_paid_event_fields(
    event: FloorPaid,
): (ID, ID, u8, u64, address, u64) {
    let FloorPaid { campaign_id, pass_lineage_id, band, amount_usdc, recipient, paid_at_ms } = event;
    (campaign_id, pass_lineage_id, band, amount_usdc, recipient, paid_at_ms)
}

#[test_only]
public fun floor_budget_returned_event_fields(
    event: FloorBudgetReturned,
): (ID, u64, u64) {
    let FloorBudgetReturned { campaign_id, returned_to_category_usdc, returned_to_main_usdc } = event;
    (campaign_id, returned_to_category_usdc, returned_to_main_usdc)
}

#[test_only]
public fun claim_receipt_fields(
    receipt: ClaimReceipt,
): (ID, ID, u64, u8, u64, u64, u8) {
    let ClaimReceipt { id, campaign_id, pass_lineage_id, round, band, amount_usdc, claimed_at_ms, kind } = receipt;
    id.delete();
    (campaign_id, pass_lineage_id, round, band, amount_usdc, claimed_at_ms, kind)
}

#[test_only]
public fun claim_kind_floor(): u8 { CLAIM_KIND_FLOOR }

#[test_only]
public fun claim_kind_payout(): u8 { CLAIM_KIND_PAYOUT }

#[test_only]
public fun set_donation_end_ms_for_testing(c: &mut Campaign, donation_end_ms: u64) {
    c.donation_end_ms = donation_end_ms;
}

#[test_only]
public fun set_claim_end_ms_for_testing(c: &mut Campaign, claim_end_ms: u64) {
    c.claim_end_ms = claim_end_ms;
}

#[test_only]
public fun campaign_has_claim_application(c: &Campaign, pass_lineage_id: ID): bool {
    dynamic_field::exists_with_type<ID, ClaimApplication>(&c.id, pass_lineage_id)
}

#[test_only]
public fun campaign_claim_application_fields(
    c: &Campaign,
    pass_lineage_id: ID,
): (u8, u64, bool, bool, bool) {
    let app = dynamic_field::borrow<ID, ClaimApplication>(&c.id, pass_lineage_id);
    (app.band, app.applied_at_ms, app.verified, app.floor_claimed, app.excluded)
}

#[test_only]
public fun claim_submitted_event_fields(
    event: ClaimSubmitted,
): (ID, ID, u8, u64, address) {
    let ClaimSubmitted { campaign_id, pass_lineage_id, band, applied_at_ms, applicant } = event;
    (campaign_id, pass_lineage_id, band, applied_at_ms, applicant)
}

#[test_only]
public fun claim_verified_event_fields(
    event: ClaimVerified,
): (ID, ID, u8, u64, address) {
    let ClaimVerified { campaign_id, pass_lineage_id, band, verified_at_ms, verifier } = event;
    (campaign_id, pass_lineage_id, band, verified_at_ms, verifier)
}

// payout_receipt_fields は ClaimReceipt 統合により claim_receipt_fields に置き換えられた

#[test_only]
public fun round_finalized_event_fields(
    event: RoundFinalized,
): (ID, u64, u64, u64, vector<u64>, u64, u64) {
    let RoundFinalized {
        campaign_id,
        round,
        liability,
        campaign_available,
        band_payout,
        eligible_count,
        finalized_at_ms,
    } = event;
    (campaign_id, round, liability, campaign_available, band_payout, eligible_count, finalized_at_ms)
}

#[test_only]
public fun payout_claimed_event_fields(
    event: PayoutClaimed,
): (ID, u64, ID, u8, u64, address) {
    let PayoutClaimed { campaign_id, round, pass_lineage_id, band, amount_usdc, recipient } = event;
    (campaign_id, round, pass_lineage_id, band, amount_usdc, recipient)
}

#[test_only]
public fun residual_sweep_event_fields(
    event: ResidualSweep,
): (ID, u64, u64) {
    let ResidualSweep { campaign_id, amount_usdc, final_round } = event;
    (campaign_id, amount_usdc, final_round)
}

#[test_only]
public fun recipient_excluded_event_fields(
    event: RecipientExcluded,
): (ID, ID, u8, u64, address) {
    let RecipientExcluded { campaign_id, pass_lineage_id, reason_code, round, actor } = event;
    (campaign_id, pass_lineage_id, reason_code, round, actor)
}

#[test_only]
public fun campaign_payout_round_fields(
    c: &Campaign,
): (u64, u64, vector<u64>, bool, bool) {
    (
        c.current_round,
        c.round_finalized_at_ms,
        c.round_payout_by_band,
        c.closed,
        c.sweep_eligible,
    )
}

#[test_only]
public fun campaign_verified_count_by_band(c: &Campaign): vector<u64> {
    c.verified_count_by_band
}

#[test_only]
public fun fund_campaign_for_testing(c: &mut Campaign, amount: u64, ctx: &mut TxContext) {
    let coin = sui::coin::mint_for_testing<usdc::usdc::USDC>(amount, ctx);
    c.balance.join(coin.into_balance());
}

#[test_only]
public fun campaign_balance_value(c: &Campaign): u64 {
    c.balance.value()
}
