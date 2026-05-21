module contracts::donation;

use contracts::pools::{Self, DesignatedPool, MainPool, OperationsPool};
use sui::coin::{Self, Coin};
use sui::dynamic_field;
use sui::dynamic_object_field;
use sui::event;
use usdc::usdc::USDC;

const DONATION_TYPE_GENERAL: u8 = 1;
const DONATION_TYPE_DESIGNATED: u8 = 2;
const DONATION_TYPE_OPERATIONS: u8 = 3;

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

public struct DesignatedDonationReceived has copy, drop {
    main_pool_id: ID,
    designated_pool_id: ID,
    amount: u64,
    main_amount: u64,
    designated_amount: u64,
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

public(package) fun donate_designated_usdc(
    registry: &mut DonorRegistry,
    main_pool: &mut MainPool,
    designated_pool: &mut DesignatedPool,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
) {
    let (designated_pool_id, amount) =
        deposit_designated_usdc_and_emit(main_pool, designated_pool, coin, ctx);
    process_first_donation(
        registry,
        DONATION_TYPE_DESIGNATED,
        designated_pool_id,
        amount,
        ctx,
    );
}

public(package) fun donate_designated_usdc_with_pass(
    registry: &DonorRegistry,
    main_pool: &mut MainPool,
    designated_pool: &mut DesignatedPool,
    pass: &mut DonorPass,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
) {
    assert_valid_registered_pass_owner(registry, pass, ctx.sender());

    let (designated_pool_id, amount) =
        deposit_designated_usdc_and_emit(main_pool, designated_pool, coin, ctx);
    process_with_pass_donation(
        pass,
        DONATION_TYPE_DESIGNATED,
        designated_pool_id,
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

fun deposit_designated_usdc_and_emit(
    main_pool: &mut MainPool,
    designated_pool: &mut DesignatedPool,
    coin: Coin<USDC>,
    ctx: &mut TxContext,
): (ID, u64) {
    let amount = coin::value(&coin);
    assert!(amount > 0, EZeroDonation);

    let (main_coin, designated_coin, main_amount, designated_amount) =
        split_designated_usdc(coin, amount, ctx);
    let main_pool_id = pools::main_pool_id(main_pool);
    let designated_pool_id = pools::designated_pool_id(designated_pool);

    pools::deposit_main_usdc(main_pool, main_coin);
    pools::deposit_designated_usdc(designated_pool, designated_coin);
    event::emit(DesignatedDonationReceived {
        main_pool_id,
        designated_pool_id,
        amount,
        main_amount,
        designated_amount,
        actor: ctx.sender(),
    });

    (designated_pool_id, amount)
}

fun split_designated_usdc(
    coin: Coin<USDC>,
    amount: u64,
    ctx: &mut TxContext,
): (Coin<USDC>, Coin<USDC>, u64, u64) {
    let main_amount = amount / 2;
    let designated_amount = amount - main_amount;
    let mut main_coin = coin;
    let designated_coin = coin::split(&mut main_coin, designated_amount, ctx);

    (main_coin, designated_coin, main_amount, designated_amount)
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

public(package) fun donation_type_general(): u8 {
    DONATION_TYPE_GENERAL
}

public(package) fun donation_type_designated(): u8 {
    DONATION_TYPE_DESIGNATED
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

public fun registry_id(registry: &DonorRegistry): ID {
    object::id(registry)
}

public fun registry_kind_donor(): u8 {
    REGISTRY_KIND_DONOR
}

#[test_only]
public fun general_donation_received_event_fields(
    event: GeneralDonationReceived,
): (ID, u64, address) {
    let GeneralDonationReceived { pool_id, amount, actor } = event;
    (pool_id, amount, actor)
}

#[test_only]
public fun designated_donation_received_event_fields(
    event: DesignatedDonationReceived,
): (ID, ID, u64, u64, u64, address) {
    let DesignatedDonationReceived {
        main_pool_id,
        designated_pool_id,
        amount,
        main_amount,
        designated_amount,
        actor,
    } = event;
    (
        main_pool_id,
        designated_pool_id,
        amount,
        main_amount,
        designated_amount,
        actor,
    )
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
