module contracts::membership;

use contracts::pools::{Self, OperationsPool};
use sui::coin::{Self, Coin};
use sui::dynamic_field;
use sui::event;
use usdc::usdc::USDC;

const STATUS_ACTIVE: u8 = 1;
const STATUS_SUSPENDED: u8 = 2;
const STATUS_REVOKED: u8 = 3;
const STATUS_MIGRATED: u8 = 4;
const REGISTRY_KIND_MEMBERSHIP: u8 = 2;
const TARGET_KIND_MEMBERSHIP_REGISTRY: u8 = 7;

const EZeroVerificationFee: u64 = 0;
const EInvalidPayoutAddress: u64 = 1;
const EMembershipPassNotActive: u64 = 2;
const EClaimantNotAuthorized: u64 = 3;
const EStaleMetadataUpdate: u64 = 4;
const EMembershipPassAlreadyIssued: u64 = 5;
const ERegistryRecordNotFound: u64 = 6;
const ERegistryPassMismatch: u64 = 7;
const ERegistryOwnerMismatch: u64 = 8;
const ERegistryPayoutMismatch: u64 = 9;
const ERegistryRecordNotActive: u64 = 10;

const METADATA_KIND_RESIDENCE: u8 = 1;
const METADATA_KIND_STUDENT: u8 = 2;

public struct MembershipRegistry has key {
    id: UID,
    issued_count: u64,
}

public struct MembershipRecord has copy, drop, store {
    pass_lineage_id: ID,
    current_pass_id: ID,
    current_owner: address,
    current_payout_address: address,
    status: u8,
    issued_at_ms: u64,
    updated_at_ms: u64,
}

public struct MembershipPass has key {
    id: UID,
    owner: address,
    payout_address: address,
    pass_lineage_id: ID,
    status: u8,
    issued_at_ms: u64,
    last_metadata_update_ms: u64,
    residence_last_update_id: u64,
    residence_cell: vector<u8>,
    residence_confidence: u64,
    residence_risk_bucket: u8,
    residence_evidence_snapshot_hash: vector<u8>,
    residence_issued_at_ms: u64,
    residence_expires_at_ms: u64,
    residence_verifier_version: u64,
    student_last_update_id: u64,
    school_region_hash: vector<u8>,
    student_status: u8,
    student_confidence: u64,
    student_risk_bucket: u8,
    student_evidence_snapshot_hash: vector<u8>,
    student_issued_at_ms: u64,
    student_expires_at_ms: u64,
    student_verifier_version: u64,
}

public struct MembershipPassIssued has copy, drop {
    registry_id: ID,
    pass_id: ID,
    owner: address,
    payout_address: address,
    pass_lineage_id: ID,
    operations_pool_id: ID,
    fee_amount: u64,
    issued_at_ms: u64,
    actor: address,
}

public struct RegistryCreated has copy, drop {
    registry_id: ID,
    registry_kind: u8,
    created_at_ms: u64,
    actor: address,
}

public struct PassMetadataUpdated has copy, drop {
    pass_id: ID,
    pass_lineage_id: ID,
    owner: address,
    metadata_kind: u8,
    update_id: u64,
    verifier_family: u8,
    verifier_version: u64,
    issued_at_ms: u64,
    expires_at_ms: u64,
    updated_at_ms: u64,
    actor: address,
}

public(package) fun register_member_usdc(
    registry: &mut MembershipRegistry,
    operations_pool: &mut OperationsPool,
    fee: Coin<USDC>,
    payout_address: address,
    ctx: &mut TxContext,
) {
    let fee_amount = coin::value(&fee);
    assert!(fee_amount > 0, EZeroVerificationFee);
    assert!(payout_address != @0x0, EInvalidPayoutAddress);
    assert!(
        !dynamic_field::exists_with_type<address, ID>(&registry.id, ctx.sender()),
        EMembershipPassAlreadyIssued,
    );

    let id = object::new(ctx);
    let pass_lineage_id = id.to_inner();
    let issued_at_ms = ctx.epoch_timestamp_ms();
    let pass = MembershipPass {
        id,
        owner: ctx.sender(),
        payout_address,
        pass_lineage_id,
        status: STATUS_ACTIVE,
        issued_at_ms,
        last_metadata_update_ms: issued_at_ms,
        residence_last_update_id: 0,
        residence_cell: vector[],
        residence_confidence: 0,
        residence_risk_bucket: 0,
        residence_evidence_snapshot_hash: vector[],
        residence_issued_at_ms: 0,
        residence_expires_at_ms: 0,
        residence_verifier_version: 0,
        student_last_update_id: 0,
        school_region_hash: vector[],
        student_status: 0,
        student_confidence: 0,
        student_risk_bucket: 0,
        student_evidence_snapshot_hash: vector[],
        student_issued_at_ms: 0,
        student_expires_at_ms: 0,
        student_verifier_version: 0,
    };
    let pass_id = object::id(&pass);
    let registry_id = object::id(registry);
    let operations_pool_id = pools::operations_pool_id(operations_pool);
    let record = MembershipRecord {
        pass_lineage_id,
        current_pass_id: pass_id,
        current_owner: pass.owner,
        current_payout_address: payout_address,
        status: STATUS_ACTIVE,
        issued_at_ms,
        updated_at_ms: issued_at_ms,
    };

    pools::deposit_operations_usdc(operations_pool, fee);
    dynamic_field::add(&mut registry.id, ctx.sender(), pass_lineage_id);
    dynamic_field::add(&mut registry.id, pass_lineage_id, record);
    registry.issued_count = registry.issued_count + 1;

    event::emit(MembershipPassIssued {
        registry_id,
        pass_id,
        owner: pass.owner,
        payout_address,
        pass_lineage_id,
        operations_pool_id,
        fee_amount,
        issued_at_ms,
        actor: ctx.sender(),
    });

    transfer::transfer(pass, ctx.sender());
}

public(package) fun create_membership_registry(ctx: &mut TxContext): ID {
    let registry = MembershipRegistry {
        id: object::new(ctx),
        issued_count: 0,
    };
    let registry_id = object::id(&registry);
    event::emit(RegistryCreated {
        registry_id,
        registry_kind: REGISTRY_KIND_MEMBERSHIP,
        created_at_ms: ctx.epoch_timestamp_ms(),
        actor: ctx.sender(),
    });
    transfer::share_object(registry);
    registry_id
}

// Caller must pass a trusted claimant, typically ctx.sender(), not an unchecked user-supplied address.
public fun assert_claim_precheck(pass: &MembershipPass, claimant: address) {
    assert!(pass.status == STATUS_ACTIVE, EMembershipPassNotActive);
    assert!(
        claimant == pass.owner || claimant == pass.payout_address,
        EClaimantNotAuthorized,
    );
}

public fun assert_current_pass_precheck(
    registry: &MembershipRegistry,
    pass: &MembershipPass,
    claimant: address,
) {
    assert_claim_precheck(pass, claimant);
    let record = current_record(registry, pass.pass_lineage_id);
    assert!(record.status == STATUS_ACTIVE, ERegistryRecordNotActive);
    assert!(record.current_pass_id == object::id(pass), ERegistryPassMismatch);
    assert!(record.current_owner == pass.owner, ERegistryOwnerMismatch);
    assert!(
        record.current_payout_address == pass.payout_address,
        ERegistryPayoutMismatch,
    );
}

public fun assert_metadata_update_precheck(pass: &MembershipPass) {
    assert!(pass.status == STATUS_ACTIVE, EMembershipPassNotActive);
}

public fun duplicate_claim_key(pass: &MembershipPass, campaign_id: ID): (ID, ID) {
    (pass.pass_lineage_id, campaign_id)
}

public fun registry_id(registry: &MembershipRegistry): ID {
    object::id(registry)
}

public fun registry_kind_membership(): u8 {
    REGISTRY_KIND_MEMBERSHIP
}

public fun target_kind_membership_registry(): u8 {
    TARGET_KIND_MEMBERSHIP_REGISTRY
}

public fun membership_registry_issued_count(registry: &MembershipRegistry): u64 {
    registry.issued_count
}

public fun membership_owner_lineage_id(
    registry: &MembershipRegistry,
    owner: address,
): ID {
    assert!(
        dynamic_field::exists_with_type<address, ID>(&registry.id, owner),
        ERegistryRecordNotFound,
    );
    *dynamic_field::borrow<address, ID>(&registry.id, owner)
}

public fun membership_record_summary(
    registry: &MembershipRegistry,
    pass_lineage_id: ID,
): (ID, ID, address, address, u8, u64, u64) {
    let record = current_record(registry, pass_lineage_id);
    (
        record.pass_lineage_id,
        record.current_pass_id,
        record.current_owner,
        record.current_payout_address,
        record.status,
        record.issued_at_ms,
        record.updated_at_ms,
    )
}

fun current_record(
    registry: &MembershipRegistry,
    pass_lineage_id: ID,
): &MembershipRecord {
    assert!(
        dynamic_field::exists_with_type<ID, MembershipRecord>(&registry.id, pass_lineage_id),
        ERegistryRecordNotFound,
    );
    dynamic_field::borrow<ID, MembershipRecord>(&registry.id, pass_lineage_id)
}

public fun membership_pass_owner(pass: &MembershipPass): address {
    pass.owner
}

public fun membership_pass_payout_address(pass: &MembershipPass): address {
    pass.payout_address
}

public fun membership_pass_lineage_id(pass: &MembershipPass): ID {
    pass.pass_lineage_id
}

public fun membership_pass_status(pass: &MembershipPass): u8 {
    pass.status
}

public fun membership_pass_issued_at_ms(pass: &MembershipPass): u64 {
    pass.issued_at_ms
}

public fun membership_pass_last_metadata_update_ms(pass: &MembershipPass): u64 {
    pass.last_metadata_update_ms
}

public fun metadata_kind_residence(): u8 {
    METADATA_KIND_RESIDENCE
}

public fun metadata_kind_student(): u8 {
    METADATA_KIND_STUDENT
}

public fun residence_metadata_summary(
    pass: &MembershipPass,
): (u64, vector<u8>, u64, u8, vector<u8>, u64, u64, u64) {
    (
        pass.residence_last_update_id,
        pass.residence_cell,
        pass.residence_confidence,
        pass.residence_risk_bucket,
        pass.residence_evidence_snapshot_hash,
        pass.residence_issued_at_ms,
        pass.residence_expires_at_ms,
        pass.residence_verifier_version,
    )
}

public fun student_metadata_summary(
    pass: &MembershipPass,
): (u64, vector<u8>, u8, u64, u8, vector<u8>, u64, u64, u64) {
    (
        pass.student_last_update_id,
        pass.school_region_hash,
        pass.student_status,
        pass.student_confidence,
        pass.student_risk_bucket,
        pass.student_evidence_snapshot_hash,
        pass.student_issued_at_ms,
        pass.student_expires_at_ms,
        pass.student_verifier_version,
    )
}

public(package) fun apply_residence_metadata_update(
    pass: &mut MembershipPass,
    update_id: u64,
    verified_residence_cell: vector<u8>,
    residence_confidence: u64,
    risk_bucket: u8,
    evidence_snapshot_hash: vector<u8>,
    issued_at_ms: u64,
    expires_at_ms: u64,
    verifier_family: u8,
    verifier_version: u64,
    updated_at_ms: u64,
    ctx: &TxContext,
) {
    assert_metadata_update_precheck(pass);
    assert!(update_id > pass.residence_last_update_id, EStaleMetadataUpdate);

    pass.residence_last_update_id = update_id;
    pass.residence_cell = verified_residence_cell;
    pass.residence_confidence = residence_confidence;
    pass.residence_risk_bucket = risk_bucket;
    pass.residence_evidence_snapshot_hash = evidence_snapshot_hash;
    pass.residence_issued_at_ms = issued_at_ms;
    pass.residence_expires_at_ms = expires_at_ms;
    pass.residence_verifier_version = verifier_version;
    pass.last_metadata_update_ms = updated_at_ms;

    event::emit(PassMetadataUpdated {
        pass_id: object::id(pass),
        pass_lineage_id: pass.pass_lineage_id,
        owner: pass.owner,
        metadata_kind: METADATA_KIND_RESIDENCE,
        update_id,
        verifier_family,
        verifier_version,
        issued_at_ms,
        expires_at_ms,
        updated_at_ms,
        actor: ctx.sender(),
    });
}

public(package) fun apply_student_metadata_update(
    pass: &mut MembershipPass,
    update_id: u64,
    school_region_hash: vector<u8>,
    student_status: u8,
    student_confidence: u64,
    risk_bucket: u8,
    evidence_snapshot_hash: vector<u8>,
    issued_at_ms: u64,
    expires_at_ms: u64,
    verifier_family: u8,
    verifier_version: u64,
    updated_at_ms: u64,
    ctx: &TxContext,
) {
    assert_metadata_update_precheck(pass);
    assert!(update_id > pass.student_last_update_id, EStaleMetadataUpdate);

    pass.student_last_update_id = update_id;
    pass.school_region_hash = school_region_hash;
    pass.student_status = student_status;
    pass.student_confidence = student_confidence;
    pass.student_risk_bucket = risk_bucket;
    pass.student_evidence_snapshot_hash = evidence_snapshot_hash;
    pass.student_issued_at_ms = issued_at_ms;
    pass.student_expires_at_ms = expires_at_ms;
    pass.student_verifier_version = verifier_version;
    pass.last_metadata_update_ms = updated_at_ms;

    event::emit(PassMetadataUpdated {
        pass_id: object::id(pass),
        pass_lineage_id: pass.pass_lineage_id,
        owner: pass.owner,
        metadata_kind: METADATA_KIND_STUDENT,
        update_id,
        verifier_family,
        verifier_version,
        issued_at_ms,
        expires_at_ms,
        updated_at_ms,
        actor: ctx.sender(),
    });
}

public fun status_active(): u8 {
    STATUS_ACTIVE
}

public fun status_suspended(): u8 {
    STATUS_SUSPENDED
}

public fun status_revoked(): u8 {
    STATUS_REVOKED
}

public fun status_migrated(): u8 {
    STATUS_MIGRATED
}

#[test_only]
public fun set_status_for_testing(pass: &mut MembershipPass, status: u8) {
    pass.status = status;
}

#[test_only]
public fun remove_membership_record_for_testing(
    registry: &mut MembershipRegistry,
    pass_lineage_id: ID,
) {
    let _ = dynamic_field::remove<ID, MembershipRecord>(&mut registry.id, pass_lineage_id);
}

#[test_only]
public fun set_current_pass_id_for_testing(
    registry: &mut MembershipRegistry,
    pass_lineage_id: ID,
    current_pass_id: ID,
) {
    let record = current_record_mut(registry, pass_lineage_id);
    record.current_pass_id = current_pass_id;
}

#[test_only]
public fun set_current_owner_for_testing(
    registry: &mut MembershipRegistry,
    pass_lineage_id: ID,
    current_owner: address,
) {
    let record = current_record_mut(registry, pass_lineage_id);
    record.current_owner = current_owner;
}

#[test_only]
public fun set_current_payout_address_for_testing(
    registry: &mut MembershipRegistry,
    pass_lineage_id: ID,
    current_payout_address: address,
) {
    let record = current_record_mut(registry, pass_lineage_id);
    record.current_payout_address = current_payout_address;
}

#[test_only]
public fun set_membership_record_status_for_testing(
    registry: &mut MembershipRegistry,
    pass_lineage_id: ID,
    status: u8,
) {
    let record = current_record_mut(registry, pass_lineage_id);
    record.status = status;
}

#[test_only]
fun current_record_mut(
    registry: &mut MembershipRegistry,
    pass_lineage_id: ID,
): &mut MembershipRecord {
    assert!(
        dynamic_field::exists_with_type<ID, MembershipRecord>(&registry.id, pass_lineage_id),
        ERegistryRecordNotFound,
    );
    dynamic_field::borrow_mut<ID, MembershipRecord>(&mut registry.id, pass_lineage_id)
}

#[test_only]
public fun create_pass_for_testing(
    owner: address,
    payout_address: address,
    ctx: &mut TxContext,
): MembershipPass {
    let id = object::new(ctx);
    let pass_lineage_id = id.to_inner();
    let issued_at_ms = ctx.epoch_timestamp_ms();
    MembershipPass {
        id,
        owner,
        payout_address,
        pass_lineage_id,
        status: STATUS_ACTIVE,
        issued_at_ms,
        last_metadata_update_ms: issued_at_ms,
        residence_last_update_id: 0,
        residence_cell: vector[],
        residence_confidence: 0,
        residence_risk_bucket: 0,
        residence_evidence_snapshot_hash: vector[],
        residence_issued_at_ms: 0,
        residence_expires_at_ms: 0,
        residence_verifier_version: 0,
        student_last_update_id: 0,
        school_region_hash: vector[],
        student_status: 0,
        student_confidence: 0,
        student_risk_bucket: 0,
        student_evidence_snapshot_hash: vector[],
        student_issued_at_ms: 0,
        student_expires_at_ms: 0,
        student_verifier_version: 0,
    }
}

#[test_only]
public fun destroy_pass_for_testing(pass: MembershipPass) {
    let MembershipPass {
        id,
        owner: _,
        payout_address: _,
        pass_lineage_id: _,
        status: _,
        issued_at_ms: _,
        last_metadata_update_ms: _,
        residence_last_update_id: _,
        residence_cell: _,
        residence_confidence: _,
        residence_risk_bucket: _,
        residence_evidence_snapshot_hash: _,
        residence_issued_at_ms: _,
        residence_expires_at_ms: _,
        residence_verifier_version: _,
        student_last_update_id: _,
        school_region_hash: _,
        student_status: _,
        student_confidence: _,
        student_risk_bucket: _,
        student_evidence_snapshot_hash: _,
        student_issued_at_ms: _,
        student_expires_at_ms: _,
        student_verifier_version: _,
    } = pass;
    id.delete();
}

#[test_only]
public fun membership_pass_issued_event_fields(
    event: MembershipPassIssued,
): (ID, ID, address, address, ID, ID, u64, u64, address) {
    let MembershipPassIssued {
        registry_id,
        pass_id,
        owner,
        payout_address,
        pass_lineage_id,
        operations_pool_id,
        fee_amount,
        issued_at_ms,
        actor,
    } = event;
    (
        registry_id,
        pass_id,
        owner,
        payout_address,
        pass_lineage_id,
        operations_pool_id,
        fee_amount,
        issued_at_ms,
        actor,
    )
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
public fun pass_metadata_updated_event_fields(
    event: PassMetadataUpdated,
): (ID, ID, address, u8, u64, u8, u64, address) {
    let PassMetadataUpdated {
        pass_id,
        pass_lineage_id,
        owner,
        metadata_kind,
        update_id,
        verifier_family,
        verifier_version,
        issued_at_ms: _,
        expires_at_ms: _,
        updated_at_ms: _,
        actor,
    } = event;
    (
        pass_id,
        pass_lineage_id,
        owner,
        metadata_kind,
        update_id,
        verifier_family,
        verifier_version,
        actor,
    )
}
