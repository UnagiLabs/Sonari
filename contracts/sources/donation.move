module contracts::donation;

use contracts::campaign::{Self, Campaign};
use contracts::category_pool::{Self, CategoryPool};
use contracts::pools::{Self, MainPool, OperationsPool};
use std::string::{Self, String};
use sui::coin::{Self, Coin};
use sui::dynamic_field;
use sui::dynamic_object_field;
use sui::event;
use usdc::usdc::USDC;

const DONATION_TYPE_GENERAL: u8 = 1;
const DONATION_TYPE_CAMPAIGN: u8 = 2;
const DONATION_TYPE_OPERATIONS: u8 = 3;
const DONATION_TYPE_CATEGORY: u8 = 4;

const TIER_NONE: u8 = 0;
const TIER_BRONZE: u8 = 1;
const TIER_SILVER: u8 = 2;
const TIER_GOLD: u8 = 3;

const BRONZE_THRESHOLD_USDC: u64 = 1;
const SILVER_THRESHOLD_USDC: u64 = 1_000_000;
const GOLD_THRESHOLD_USDC: u64 = 10_000_000;

const COIN_TYPE_USDC: vector<u8> = b"USDC";
const REGISTRY_KIND_DONOR: u8 = 1;

const EZeroDonation: u64 = 0;
const EDonorPassOwnerMismatch: u64 = 1;
const EDonorPassAlreadyIssued: u64 = 2;
const EDonorPassNotIssued: u64 = 3;
const EDonorPassMismatch: u64 = 4;
const ECampaignClosed: u64 = 5;

// V2 split targets
const DONATION_TARGET_CAMPAIGN: u8 = 1;
const DONATION_TARGET_CATEGORY: u8 = 2;
const DONATION_TARGET_NONE: u8 = 3;

// V2 split BPS for category / general (campaign uses Campaign snapshot)
const SPLIT_CATEGORY_PRIMARY_BPS: u64 = 9_000;
const SPLIT_CATEGORY_OPS_BPS: u64 = 500;
const SPLIT_GENERAL_OPS_BPS: u64 = 500;
const BPS_DENOMINATOR: u64 = 10_000;

public struct DonationSplit has copy, drop {
    donation_target: u8,
    primary_pool_id: Option<ID>,
    main_pool_id: ID,
    ops_pool_id: ID,
    total_amount: u64,
    primary_amount: u64,
    main_amount: u64,
    ops_amount: u64,
    ops_cap_overflow_usdc: u64,
    after_donation_end: bool,
    donor: address,
}

public struct DonorRegistry has key {
    id: UID,
    issued_count: u64,
}

public struct RegistryCreated has copy, drop {
    registry_id: ID,
    registry_kind: u8,
    created_at_ms: u64,
    actor: address,
}

public struct DonorPass has key {
    id: UID,
    owner: address,
    donor_lineage_id: ID,
    total_donated_usdc: u64,
    donation_count: u64,
    first_donated_at_ms: u64,
    last_donated_at_ms: u64,
    tier: u8,
    tier_label: String,
}

public struct DonationRecord has key, store {
    id: UID,
    donation_index: u64,
    donation_type: u8,
    program_id: Option<ID>,
    campaign_id: Option<ID>,
    pool_id: ID,
    amount: u64,
    coin_type: vector<u8>,
    donated_at_ms: u64,
}

public struct GeneralDonationReceived has copy, drop {
    pool_id: ID,
    amount: u64,
    actor: address,
}

public struct OperationsDonationReceived has copy, drop {
    pool_id: ID,
    amount: u64,
    actor: address,
}

public struct DonorPassIssued has copy, drop {
    donor_pass_id: ID,
    owner: address,
    donor_lineage_id: ID,
    issued_at_ms: u64,
}

public struct DonationRecorded has copy, drop {
    donor_pass_id: ID,
    donation_index: u64,
    donation_type: u8,
    pool_id: ID,
    amount: u64,
    coin_type: vector<u8>,
    actor: address,
}

public struct DonorTierUpdated has copy, drop {
    donor_pass_id: ID,
    old_tier: u8,
    new_tier: u8,
    total_donated_usdc: u64,
    actor: address,
}

public(package) fun create_donor_registry(ctx: &mut TxContext): ID {
    let registry = DonorRegistry {
        id: object::new(ctx),
        issued_count: 0,
    };
    let registry_id = object::id(&registry);

    event::emit(RegistryCreated {
        registry_id,
        registry_kind: REGISTRY_KIND_DONOR,
        created_at_ms: ctx.epoch_timestamp_ms(),
        actor: ctx.sender(),
    });

    transfer::share_object(registry);
    registry_id
}

public(package) fun donate_general_usdc(
    registry: &mut DonorRegistry,
    main_pool: &mut MainPool,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
) {
    let (pool_id, amount) = deposit_general_usdc_and_emit(main_pool, coin, ctx);
    process_first_donation(
        registry,
        DONATION_TYPE_GENERAL,
        pool_id,
        amount,
        ctx,
    );
}

public(package) fun donate_general_usdc_with_pass(
    registry: &DonorRegistry,
    main_pool: &mut MainPool,
    pass: &mut DonorPass,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
) {
    assert_valid_registered_pass_owner(registry, pass, ctx.sender());

    let (pool_id, amount) = deposit_general_usdc_and_emit(main_pool, coin, ctx);
    process_with_pass_donation(
        pass,
        DONATION_TYPE_GENERAL,
        pool_id,
        amount,
        ctx,
    );
}

public(package) fun donate_operations_usdc(
    registry: &mut DonorRegistry,
    operations_pool: &mut OperationsPool,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
) {
    let (pool_id, amount) = deposit_operations_usdc_and_emit(operations_pool, coin, ctx);
    process_first_donation(
        registry,
        DONATION_TYPE_OPERATIONS,
        pool_id,
        amount,
        ctx,
    );
}

public(package) fun donate_operations_usdc_with_pass(
    registry: &DonorRegistry,
    operations_pool: &mut OperationsPool,
    pass: &mut DonorPass,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
) {
    assert_valid_registered_pass_owner(registry, pass, ctx.sender());

    let (pool_id, amount) = deposit_operations_usdc_and_emit(operations_pool, coin, ctx);
    process_with_pass_donation(
        pass,
        DONATION_TYPE_OPERATIONS,
        pool_id,
        amount,
        ctx,
    );
}

fun deposit_general_usdc_and_emit(
    main_pool: &mut MainPool,
    coin: Coin<USDC>,
    ctx: &TxContext,
): (ID, u64) {
    let amount = coin::value(&coin);
    assert!(amount > 0, EZeroDonation);

    let pool_id = pools::main_pool_id(main_pool);
    pools::deposit_main_usdc(main_pool, coin);
    event::emit(GeneralDonationReceived {
        pool_id,
        amount,
        actor: ctx.sender(),
    });

    (pool_id, amount)
}

fun deposit_operations_usdc_and_emit(
    operations_pool: &mut OperationsPool,
    coin: Coin<USDC>,
    ctx: &TxContext,
): (ID, u64) {
    let amount = coin::value(&coin);
    assert!(amount > 0, EZeroDonation);

    let pool_id = pools::operations_pool_id(operations_pool);
    pools::deposit_operations_usdc(operations_pool, coin);
    event::emit(OperationsDonationReceived {
        pool_id,
        amount,
        actor: ctx.sender(),
    });

    (pool_id, amount)
}

fun process_first_donation(
    registry: &mut DonorRegistry,
    donation_type: u8,
    pool_id: ID,
    amount: u64,
    ctx: &mut TxContext,
) {
    let mut pass = new_donor_pass(registry, ctx);
    record_donation(
        &mut pass,
        donation_type,
        option::none(),
        option::none(),
        pool_id,
        amount,
        ctx,
    );
    transfer::transfer(pass, ctx.sender());
}

fun process_with_pass_donation(
    pass: &mut DonorPass,
    donation_type: u8,
    pool_id: ID,
    amount: u64,
    ctx: &mut TxContext,
) {
    record_donation(
        pass,
        donation_type,
        option::none(),
        option::none(),
        pool_id,
        amount,
        ctx,
    );
}

fun new_donor_pass(registry: &mut DonorRegistry, ctx: &mut TxContext): DonorPass {
    let donor = ctx.sender();
    assert!(!dynamic_field::exists_with_type<address, ID>(&registry.id, donor), EDonorPassAlreadyIssued);

    let id = object::new(ctx);
    let donor_lineage_id = id.to_inner();
    let pass = DonorPass {
        id,
        owner: donor,
        donor_lineage_id,
        total_donated_usdc: 0,
        donation_count: 0,
        first_donated_at_ms: ctx.epoch_timestamp_ms(),
        last_donated_at_ms: ctx.epoch_timestamp_ms(),
        tier: TIER_NONE,
        tier_label: tier_label(TIER_NONE),
    };
    let donor_pass_id = object::id(&pass);
    dynamic_field::add(&mut registry.id, donor, donor_pass_id);
    registry.issued_count = registry.issued_count + 1;

    event::emit(DonorPassIssued {
        donor_pass_id,
        owner: donor,
        donor_lineage_id,
        issued_at_ms: ctx.epoch_timestamp_ms(),
    });

    pass
}

/// DonorPass を発行して戻り値として返す。registry への登録もここで行う。
/// transfer はしない（PTB の次コマンドで `&mut` 参照できるように return 形にする）。
public(package) fun issue_donor_pass(
    registry: &mut DonorRegistry,
    ctx: &mut TxContext,
): DonorPass {
    new_donor_pass(registry, ctx)
}

/// 発行直後の DonorPass を sender へ soulbound 転送する。
/// DonorPass は `store` を持たないため、モジュール内 `transfer::transfer` 経由でのみ送れる。
public(package) fun transfer_donor_pass(pass: DonorPass, ctx: &TxContext) {
    transfer::transfer(pass, ctx.sender());
}

fun assert_registered_pass(registry: &DonorRegistry, pass: &DonorPass, donor: address) {
    assert!(dynamic_field::exists_with_type<address, ID>(&registry.id, donor), EDonorPassNotIssued);
    let donor_pass_id = dynamic_field::borrow<address, ID>(&registry.id, donor);
    assert!(*donor_pass_id == object::id(pass), EDonorPassMismatch);
}

fun assert_valid_registered_pass_owner(
    registry: &DonorRegistry,
    pass: &DonorPass,
    donor: address,
) {
    assert!(pass.owner == donor, EDonorPassOwnerMismatch);
    assert_registered_pass(registry, pass, donor);
}

fun record_donation(
    pass: &mut DonorPass,
    donation_type: u8,
    program_id: Option<ID>,
    campaign_id: Option<ID>,
    pool_id: ID,
    amount: u64,
    ctx: &mut TxContext,
) {
    let donation_index = pass.donation_count;
    let donated_at_ms = ctx.epoch_timestamp_ms();
    let record = DonationRecord {
        id: object::new(ctx),
        donation_index,
        donation_type,
        program_id,
        campaign_id,
        pool_id,
        amount,
        coin_type: COIN_TYPE_USDC,
        donated_at_ms,
    };
    dynamic_object_field::add(&mut pass.id, donation_index, record);

    if (pass.donation_count == 0) {
        pass.first_donated_at_ms = donated_at_ms;
    };

    pass.donation_count = pass.donation_count + 1;
    pass.total_donated_usdc = pass.total_donated_usdc + amount;
    pass.last_donated_at_ms = donated_at_ms;

    event::emit(DonationRecorded {
        donor_pass_id: object::id(pass),
        donation_index,
        donation_type,
        pool_id,
        amount,
        coin_type: COIN_TYPE_USDC,
        actor: ctx.sender(),
    });

    let old_tier = pass.tier;
    let new_tier = tier_for_total(pass.total_donated_usdc);
    if (old_tier != new_tier) {
        pass.tier = new_tier;
        pass.tier_label = tier_label(new_tier);
        event::emit(DonorTierUpdated {
            donor_pass_id: object::id(pass),
            old_tier,
            new_tier,
            total_donated_usdc: pass.total_donated_usdc,
            actor: ctx.sender(),
        });
    };
}

fun tier_for_total(total_donated_usdc: u64): u8 {
    if (total_donated_usdc >= GOLD_THRESHOLD_USDC) {
        TIER_GOLD
    } else if (total_donated_usdc >= SILVER_THRESHOLD_USDC) {
        TIER_SILVER
    } else if (total_donated_usdc >= BRONZE_THRESHOLD_USDC) {
        TIER_BRONZE
    } else {
        TIER_NONE
    }
}

fun tier_label(tier: u8): String {
    if (tier == TIER_NONE) {
        string::utf8(b"None")
    } else if (tier == TIER_BRONZE) {
        string::utf8(b"Bronze")
    } else if (tier == TIER_SILVER) {
        string::utf8(b"Silver")
    } else if (tier == TIER_GOLD) {
        string::utf8(b"Gold")
    } else {
        string::utf8(b"Unknown")
    }
}

public(package) fun donation_record_summary(
    pass: &DonorPass,
    donation_index: u64,
): (u64, u8, Option<ID>, Option<ID>, ID, u64, vector<u8>, u64) {
    let record = dynamic_object_field::borrow<u64, DonationRecord>(&pass.id, donation_index);
    (
        record.donation_index,
        record.donation_type,
        record.program_id,
        record.campaign_id,
        record.pool_id,
        record.amount,
        record.coin_type,
        record.donated_at_ms,
    )
}

public(package) fun donor_pass_owner(pass: &DonorPass): address {
    pass.owner
}

public(package) fun donor_pass_total_donated_usdc(pass: &DonorPass): u64 {
    pass.total_donated_usdc
}

public(package) fun donor_pass_donation_count(pass: &DonorPass): u64 {
    pass.donation_count
}

public(package) fun donor_pass_tier(pass: &DonorPass): u8 {
    pass.tier
}

public(package) fun donor_pass_tier_label(pass: &DonorPass): String {
    pass.tier_label
}

public(package) fun donation_type_general(): u8 {
    DONATION_TYPE_GENERAL
}

public(package) fun donation_type_campaign(): u8 {
    DONATION_TYPE_CAMPAIGN
}

public(package) fun donation_type_category(): u8 {
    DONATION_TYPE_CATEGORY
}

public(package) fun donation_type_operations(): u8 {
    DONATION_TYPE_OPERATIONS
}

public(package) fun tier_none(): u8 {
    TIER_NONE
}

public(package) fun tier_bronze(): u8 {
    TIER_BRONZE
}

public(package) fun tier_silver(): u8 {
    TIER_SILVER
}

public(package) fun tier_gold(): u8 {
    TIER_GOLD
}

public(package) fun bronze_threshold_usdc(): u64 {
    BRONZE_THRESHOLD_USDC
}

public(package) fun silver_threshold_usdc(): u64 {
    SILVER_THRESHOLD_USDC
}

public(package) fun gold_threshold_usdc(): u64 {
    GOLD_THRESHOLD_USDC
}

public(package) fun coin_type_usdc(): vector<u8> {
    COIN_TYPE_USDC
}

public(package) fun registry_id(registry: &DonorRegistry): ID {
    object::id(registry)
}

public(package) fun registry_kind_donor(): u8 {
    REGISTRY_KIND_DONOR
}

// ---------------------------------------------------------------
// V2: split donation functions
// ---------------------------------------------------------------

/// bps（万分率）から金額を計算する。総額 * bps / 10_000 を u128 で計算し u64 に戻す。
fun bps_amount(total: u64, bps: u64): u64 {
    ((total as u128) * (bps as u128) / (BPS_DENOMINATOR as u128)) as u64
}

/// 按分済みの main / ops コインを deposit し、DonorPass に総額を記録し、
/// DonationSplit イベントを emit する。按分・記録ロジックの唯一の置き場。
/// destination 固有の deposit（campaign / category）は呼び出し側の薄い entry で行う。
fun split_and_record(
    pass: &mut DonorPass,
    main_pool: &mut MainPool,
    ops_pool: &mut OperationsPool,
    main_coin: Coin<USDC>,
    ops_coin: Coin<USDC>,
    donation_target: u8,
    donation_type: u8,
    campaign_id: Option<ID>,
    primary_pool_id: Option<ID>,
    total: u64,
    reported_primary: u64,
    reported_main: u64,
    ops_amount: u64,
    ops_cap_overflow_usdc: u64,
    after_donation_end: bool,
    ctx: &mut TxContext,
) {
    let main_pool_id = pools::main_pool_id(main_pool);
    let ops_pool_id = pools::operations_pool_id(ops_pool);

    pools::deposit_main_usdc(main_pool, main_coin);
    pools::deposit_operations_usdc(ops_pool, ops_coin);

    // 記録の pool_id は主送付先（campaign / category）。general は main を使う。
    let record_pool_id = if (primary_pool_id.is_some()) {
        *primary_pool_id.borrow()
    } else {
        main_pool_id
    };
    record_donation(
        pass,
        donation_type,
        option::none(),
        campaign_id,
        record_pool_id,
        total,
        ctx,
    );

    event::emit(DonationSplit {
        donation_target,
        primary_pool_id,
        main_pool_id,
        ops_pool_id,
        total_amount: total,
        primary_amount: reported_primary,
        main_amount: reported_main,
        ops_amount,
        ops_cap_overflow_usdc,
        after_donation_end,
        donor: ctx.sender(),
    });
}

/// 一般寄付。main / ops へ按分し、DonorPass に総額を記録する。
public(package) fun donate_general(
    registry: &DonorRegistry,
    pass: &mut DonorPass,
    main_pool: &mut MainPool,
    ops_pool: &mut OperationsPool,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
) {
    assert_valid_registered_pass_owner(registry, pass, ctx.sender());

    let total = coin::value(&coin);
    assert!(total > 0, EZeroDonation);

    let ops_calc = bps_amount(total, SPLIT_GENERAL_OPS_BPS);
    let main_calc = total - ops_calc;

    let mut remaining = coin;
    let ops_coin = coin::split(&mut remaining, ops_calc, ctx);

    split_and_record(
        pass,
        main_pool,
        ops_pool,
        remaining,
        ops_coin,
        DONATION_TARGET_NONE,
        DONATION_TYPE_GENERAL,
        option::none(),
        option::none(),
        total,
        0,
        main_calc,
        ops_calc,
        0,
        false,
        ctx,
    );
}

/// campaign 寄付。config 由来の bps で campaign / main / ops へ按分する。
/// ops_cap を超えた分は main へ、donation_end 経過後は campaign 分を main へ回す。
/// DonorPass に総額を記録する。
public(package) fun donate_to_campaign(
    registry: &DonorRegistry,
    pass: &mut DonorPass,
    camp: &mut Campaign,
    main_pool: &mut MainPool,
    ops_pool: &mut OperationsPool,
    coin: Coin<USDC>,
    now_ms: u64,
    ctx: &mut TxContext,
) {
    assert_valid_registered_pass_owner(registry, pass, ctx.sender());

    let total = coin::value(&coin);
    assert!(total > 0, EZeroDonation);
    assert!(!campaign::campaign_closed(camp), ECampaignClosed);

    let primary_bps = campaign::campaign_split_campaign_bps(camp);
    let ops_bps = campaign::campaign_split_ops_bps(camp);

    let primary_calc = bps_amount(total, primary_bps);
    let ops_calc = bps_amount(total, ops_bps);

    // ops_cap check
    let ops_cap = campaign::campaign_ops_cap_usdc(camp);
    let ops_withheld = campaign::campaign_ops_withheld_usdc(camp);
    let ops_cap_remaining = if (ops_cap > ops_withheld) { ops_cap - ops_withheld } else { 0 };
    let (ops_actual, overflow) = if (ops_cap_remaining < ops_calc) {
        (ops_cap_remaining, ops_calc - ops_cap_remaining)
    } else {
        (ops_calc, 0)
    };

    // after donation end: campaign portion goes to main
    let donation_end = campaign::campaign_donation_end_ms(camp);
    let after_donation_end = now_ms >= donation_end;
    let (primary_to_campaign, main_total) = if (after_donation_end) {
        (0u64, total - ops_actual)
    } else {
        let mt = total - primary_calc - ops_actual;
        (primary_calc, mt)
    };

    // split coin
    let mut remaining = coin;
    let ops_coin = coin::split(&mut remaining, ops_actual, ctx);
    let campaign_coin = if (primary_to_campaign > 0) {
        let c = coin::split(&mut remaining, primary_to_campaign, ctx);
        option::some(c)
    } else {
        option::none()
    };

    // destination 固有の deposit（campaign）
    if (campaign_coin.is_some()) {
        let c = campaign_coin.destroy_some();
        campaign::deposit_campaign_usdc(camp, c);
        campaign::update_total_donated(camp, primary_to_campaign);
    } else {
        campaign_coin.destroy_none();
    };
    campaign::update_ops_withheld(camp, ops_actual);

    let campaign_id_val = campaign::campaign_id(camp);
    // reported primary_amount is the calculated portion (before after_end redirect)
    let reported_main = if (after_donation_end) {
        total - ops_actual
    } else {
        main_total
    };

    split_and_record(
        pass,
        main_pool,
        ops_pool,
        remaining,
        ops_coin,
        DONATION_TARGET_CAMPAIGN,
        DONATION_TYPE_CAMPAIGN,
        option::some(campaign_id_val),
        option::some(campaign_id_val),
        total,
        primary_calc,
        reported_main,
        ops_actual,
        overflow,
        after_donation_end,
        ctx,
    );
}

/// category 寄付。category / main / ops へ 90 / 5 / 5 で按分し、DonorPass に総額を記録する。
public(package) fun donate_to_category(
    registry: &DonorRegistry,
    pass: &mut DonorPass,
    cat_pool: &mut CategoryPool,
    main_pool: &mut MainPool,
    ops_pool: &mut OperationsPool,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
) {
    assert_valid_registered_pass_owner(registry, pass, ctx.sender());

    let total = coin::value(&coin);
    assert!(total > 0, EZeroDonation);

    let primary_calc = bps_amount(total, SPLIT_CATEGORY_PRIMARY_BPS);
    let ops_calc = bps_amount(total, SPLIT_CATEGORY_OPS_BPS);
    let main_calc = total - primary_calc - ops_calc;

    let mut remaining = coin;
    let ops_coin = coin::split(&mut remaining, ops_calc, ctx);
    let category_coin = coin::split(&mut remaining, primary_calc, ctx);
    // remaining is main

    let category_pool_id = category_pool::category_pool_id(cat_pool);
    category_pool::deposit_category_usdc(cat_pool, category_coin);

    split_and_record(
        pass,
        main_pool,
        ops_pool,
        remaining,
        ops_coin,
        DONATION_TARGET_CATEGORY,
        DONATION_TYPE_CATEGORY,
        option::none(),
        option::some(category_pool_id),
        total,
        primary_calc,
        main_calc,
        ops_calc,
        0,
        false,
        ctx,
    );
}

public(package) fun donation_target_campaign(): u8 {
    DONATION_TARGET_CAMPAIGN
}

public(package) fun donation_target_category(): u8 {
    DONATION_TARGET_CATEGORY
}

public(package) fun donation_target_none(): u8 {
    DONATION_TARGET_NONE
}

#[test_only]
public fun general_donation_received_event_fields(
    event: GeneralDonationReceived,
): (ID, u64, address) {
    let GeneralDonationReceived { pool_id, amount, actor } = event;
    (pool_id, amount, actor)
}

#[test_only]
public fun operations_donation_received_event_fields(
    event: OperationsDonationReceived,
): (ID, u64, address) {
    let OperationsDonationReceived { pool_id, amount, actor } = event;
    (pool_id, amount, actor)
}

#[test_only]
public fun donation_recorded_event_fields(
    event: DonationRecorded,
): (ID, u64, u8, ID, u64, vector<u8>, address) {
    let DonationRecorded {
        donor_pass_id,
        donation_index,
        donation_type,
        pool_id,
        amount,
        coin_type,
        actor,
    } = event;
    (
        donor_pass_id,
        donation_index,
        donation_type,
        pool_id,
        amount,
        coin_type,
        actor,
    )
}

#[test_only]
public fun donor_tier_updated_event_fields(
    event: DonorTierUpdated,
): (ID, u8, u8, u64, address) {
    let DonorTierUpdated {
        donor_pass_id,
        old_tier,
        new_tier,
        total_donated_usdc,
        actor,
    } = event;
    (donor_pass_id, old_tier, new_tier, total_donated_usdc, actor)
}

#[test_only]
public fun registry_created_event_fields(
    event: RegistryCreated,
): (ID, u8, u64, address) {
    let RegistryCreated {
        registry_id,
        registry_kind,
        created_at_ms,
        actor,
    } = event;
    (registry_id, registry_kind, created_at_ms, actor)
}

#[test_only]
public fun donation_split_event_fields(
    event: DonationSplit,
): (u8, Option<ID>, u64, u64, u64, u64, u64, bool, address) {
    let DonationSplit {
        donation_target,
        primary_pool_id,
        main_pool_id: _,
        ops_pool_id: _,
        total_amount,
        primary_amount,
        main_amount,
        ops_amount,
        ops_cap_overflow_usdc,
        after_donation_end,
        donor,
    } = event;
    (
        donation_target,
        primary_pool_id,
        total_amount,
        primary_amount,
        main_amount,
        ops_amount,
        ops_cap_overflow_usdc,
        after_donation_end,
        donor,
    )
}

#[test_only]
public fun donation_record_fields_for_testing(
    pass: &DonorPass,
    donation_index: u64,
): (u64, u8, Option<ID>, Option<ID>, u64, vector<u8>, u64) {
    let record = dynamic_object_field::borrow<u64, DonationRecord>(&pass.id, donation_index);
    (
        record.donation_index,
        record.donation_type,
        record.program_id,
        record.campaign_id,
        record.amount,
        record.coin_type,
        record.donated_at_ms,
    )
}
