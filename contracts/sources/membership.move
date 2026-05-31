module contracts::membership;

use std::string::{Self, String};
use sui::dynamic_field;
use sui::event;

const STATUS_ACTIVE: u8 = 1;
const STATUS_SUSPENDED: u8 = 2;
const STATUS_REVOKED: u8 = 3;
const STATUS_MIGRATED: u8 = 4;
const REGISTRY_KIND_MEMBERSHIP: u8 = 2;
const TARGET_KIND_MEMBERSHIP_REGISTRY: u8 = 7;
const IDENTITY_PROVIDER_KYC: u8 = 1;
const IDENTITY_PROVIDER_WORLD_ID: u8 = 2;

const EMembershipPassNotActive: u64 = 2;
const EClaimantNotAuthorized: u64 = 3;
const EMembershipPassAlreadyIssued: u64 = 5;
const ERegistryRecordNotFound: u64 = 6;
const ERegistryPassMismatch: u64 = 7;
const ERegistryOwnerMismatch: u64 = 8;
const ERegistryRecordNotActive: u64 = 10;
const EUnknownIdentityProvider: u64 = 11;
const EIdentityProviderReplay: u64 = 12;
const EIdentityTermsVersionMismatch: u64 = 13;
const EIdentitySignedStatementHashMismatch: u64 = 14;

public struct MembershipRegistry has key {
    id: UID,
    issued_count: u64,
}

public struct MembershipRecord has copy, drop, store {
    pass_lineage_id: ID,
    current_pass_id: ID,
    current_owner: address,
    status: u8,
    issued_at_ms: u64,
    updated_at_ms: u64,
}

public struct MembershipPass has key {
    id: UID,
    owner: address,
    pass_lineage_id: ID,
    status: u8,
    status_label: String,
    issued_at_ms: u64,
    account_created_at_ms: u64,
    home_cell: u64,
    home_cell_registered_at_ms: u64,
    identity_verified: bool,
    identity_provider_mask: u8,
    provider_label: String,
    identity_verified_at_ms: u64,
    identity_expires_at_ms: u64,
    terms_version: u64,
    signed_statement_hash: vector<u8>,
}

public struct MembershipPassIssued has copy, drop {
    registry_id: ID,
    pass_id: ID,
    owner: address,
    pass_lineage_id: ID,
    issued_at_ms: u64,
    actor: address,
}

public struct RegistryCreated has copy, drop {
    registry_id: ID,
    registry_kind: u8,
    created_at_ms: u64,
    actor: address,
}

public(package) fun register_member(
    registry: &mut MembershipRegistry,
    home_cell: u64,
    terms_version: u64,
    signed_statement_hash: vector<u8>,
    ctx: &mut TxContext,
) {
    assert!(
        !dynamic_field::exists_with_type<address, ID>(&registry.id, ctx.sender()),
        EMembershipPassAlreadyIssued,
    );

    let id = object::new(ctx);
    let pass_lineage_id = id.to_inner();
    let issued_at_ms = ctx.epoch_timestamp_ms();
    let mut pass = MembershipPass {
        id,
        owner: ctx.sender(),
        pass_lineage_id,
        status: STATUS_ACTIVE,
        status_label: status_label(STATUS_ACTIVE),
        issued_at_ms,
        account_created_at_ms: issued_at_ms,
        home_cell: 0,
        home_cell_registered_at_ms: 0,
        identity_verified: false,
        identity_provider_mask: 0,
        provider_label: provider_label(0),
        identity_verified_at_ms: 0,
        identity_expires_at_ms: 0,
        terms_version,
        signed_statement_hash,
    };
    set_home_cell(&mut pass, home_cell, issued_at_ms);
    let pass_id = object::id(&pass);
    let registry_id = object::id(registry);
    let record = MembershipRecord {
        pass_lineage_id,
        current_pass_id: pass_id,
        current_owner: pass.owner,
        status: STATUS_ACTIVE,
        issued_at_ms,
        updated_at_ms: issued_at_ms,
    };

    dynamic_field::add(&mut registry.id, ctx.sender(), pass_lineage_id);
    dynamic_field::add(&mut registry.id, pass_lineage_id, record);
    registry.issued_count = registry.issued_count + 1;

    event::emit(MembershipPassIssued {
        registry_id,
        pass_id,
        owner: pass.owner,
        pass_lineage_id,
        issued_at_ms,
        actor: ctx.sender(),
    });

    transfer::transfer(pass, ctx.sender());
}

public(package) fun update_home_cell(
    registry: &MembershipRegistry,
    pass: &mut MembershipPass,
    claimant: address,
    home_cell: u64,
    registered_at_ms: u64,
) {
    assert_current_pass_precheck(registry, pass, claimant);
    set_home_cell(pass, home_cell, registered_at_ms);
}

fun set_home_cell(
    pass: &mut MembershipPass,
    home_cell: u64,
    registered_at_ms: u64,
) {
    pass.home_cell = home_cell;
    pass.home_cell_registered_at_ms = registered_at_ms;
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
    assert!(claimant == pass.owner, EClaimantNotAuthorized);
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
}

public fun duplicate_claim_key(pass: &MembershipPass, campaign_id: ID): (ID, ID) {
    (pass.pass_lineage_id, campaign_id)
}

public(package) fun apply_identity_verification(
    pass: &mut MembershipPass,
    provider: u8,
    verified_at_ms: u64,
    expires_at_ms: u64,
    terms_version: u64,
    signed_statement_hash: vector<u8>,
) {
    assert!(terms_version == pass.terms_version, EIdentityTermsVersionMismatch);
    assert!(
        signed_statement_hash == pass.signed_statement_hash,
        EIdentitySignedStatementHashMismatch,
    );
    let provider_bit = identity_provider_bit(provider);
    assert!(
        pass.identity_provider_mask & provider_bit == 0,
        EIdentityProviderReplay,
    );

    pass.identity_verified = true;
    pass.identity_provider_mask = pass.identity_provider_mask + provider_bit;
    pass.provider_label = provider_label(pass.identity_provider_mask);
    pass.identity_verified_at_ms = verified_at_ms;
    pass.identity_expires_at_ms = expires_at_ms;
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
): (ID, ID, address, u8, u64, u64) {
    let record = current_record(registry, pass_lineage_id);
    (
        record.pass_lineage_id,
        record.current_pass_id,
        record.current_owner,
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

fun identity_provider_bit(provider: u8): u8 {
    assert!(
        provider == IDENTITY_PROVIDER_KYC || provider == IDENTITY_PROVIDER_WORLD_ID,
        EUnknownIdentityProvider,
    );
    provider
}

fun status_label(status: u8): String {
    if (status == STATUS_ACTIVE) {
        string::utf8(b"Active")
    } else if (status == STATUS_SUSPENDED) {
        string::utf8(b"Suspended")
    } else if (status == STATUS_REVOKED) {
        string::utf8(b"Revoked")
    } else if (status == STATUS_MIGRATED) {
        string::utf8(b"Migrated")
    } else {
        string::utf8(b"Unknown")
    }
}

fun provider_label(provider_mask: u8): String {
    if (provider_mask == 0) {
        string::utf8(b"Unverified")
    } else if (provider_mask == IDENTITY_PROVIDER_KYC) {
        string::utf8(b"KYC")
    } else if (provider_mask == IDENTITY_PROVIDER_WORLD_ID) {
        string::utf8(b"World ID")
    } else if (provider_mask == IDENTITY_PROVIDER_KYC + IDENTITY_PROVIDER_WORLD_ID) {
        string::utf8(b"KYC + World ID")
    } else {
        string::utf8(b"Unknown")
    }
}

public fun membership_pass_owner(pass: &MembershipPass): address {
    pass.owner
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

public fun membership_pass_display_labels(pass: &MembershipPass): (String, String) {
    (pass.status_label, pass.provider_label)
}

public fun membership_pass_mvp_summary(
    pass: &MembershipPass,
): (u64, u64, u64, bool, u8, u64, u64, u64, vector<u8>) {
    (
        pass.account_created_at_ms,
        pass.home_cell,
        pass.home_cell_registered_at_ms,
        pass.identity_verified,
        pass.identity_provider_mask,
        pass.identity_verified_at_ms,
        pass.identity_expires_at_ms,
        pass.terms_version,
        pass.signed_statement_hash,
    )
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
    pass.status_label = status_label(status);
}

#[test_only]
public fun set_account_created_at_ms_for_testing(pass: &mut MembershipPass, account_created_at_ms: u64) {
    pass.account_created_at_ms = account_created_at_ms;
}

#[test_only]
public fun set_home_cell_registered_at_ms_for_testing(
    pass: &mut MembershipPass,
    home_cell_registered_at_ms: u64,
) {
    pass.home_cell_registered_at_ms = home_cell_registered_at_ms;
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
    ctx: &mut TxContext,
): MembershipPass {
    let id = object::new(ctx);
    let pass_lineage_id = id.to_inner();
    let issued_at_ms = ctx.epoch_timestamp_ms();
    MembershipPass {
        id,
        owner,
        pass_lineage_id,
        status: STATUS_ACTIVE,
        status_label: status_label(STATUS_ACTIVE),
        issued_at_ms,
        account_created_at_ms: issued_at_ms,
        home_cell: 0,
        home_cell_registered_at_ms: issued_at_ms,
        identity_verified: false,
        identity_provider_mask: 0,
        provider_label: provider_label(0),
        identity_verified_at_ms: 0,
        identity_expires_at_ms: 0,
        terms_version: 0,
        signed_statement_hash: vector[],
    }
}

#[test_only]
public fun create_registry_and_pass_for_testing(
    owner: address,
    terms_version: u64,
    signed_statement_hash: vector<u8>,
    ctx: &mut TxContext,
): (MembershipRegistry, MembershipPass) {
    let mut registry = MembershipRegistry {
        id: object::new(ctx),
        issued_count: 0,
    };
    let id = object::new(ctx);
    let pass_lineage_id = id.to_inner();
    let issued_at_ms = ctx.epoch_timestamp_ms();
    let pass = MembershipPass {
        id,
        owner,
        pass_lineage_id,
        status: STATUS_ACTIVE,
        status_label: status_label(STATUS_ACTIVE),
        issued_at_ms,
        account_created_at_ms: issued_at_ms,
        home_cell: 0,
        home_cell_registered_at_ms: issued_at_ms,
        identity_verified: false,
        identity_provider_mask: 0,
        provider_label: provider_label(0),
        identity_verified_at_ms: 0,
        identity_expires_at_ms: 0,
        terms_version,
        signed_statement_hash,
    };
    let record = MembershipRecord {
        pass_lineage_id,
        current_pass_id: object::id(&pass),
        current_owner: owner,
        status: STATUS_ACTIVE,
        issued_at_ms,
        updated_at_ms: issued_at_ms,
    };

    dynamic_field::add(&mut registry.id, owner, pass_lineage_id);
    dynamic_field::add(&mut registry.id, pass_lineage_id, record);
    registry.issued_count = 1;
    (registry, pass)
}

#[test_only]
public fun destroy_membership_registry_for_testing(
    registry: MembershipRegistry,
    owner: address,
    pass_lineage_id: ID,
) {
    let MembershipRegistry { mut id, issued_count } = registry;
    assert!(issued_count == 1);
    let owner_lineage_id = dynamic_field::remove<address, ID>(&mut id, owner);
    assert!(owner_lineage_id == pass_lineage_id);
    let record = dynamic_field::remove<ID, MembershipRecord>(&mut id, pass_lineage_id);
    assert!(record.pass_lineage_id == pass_lineage_id);
    id.delete();
}

#[test_only]
public fun destroy_pass_for_testing(pass: MembershipPass) {
    let MembershipPass {
        id,
        owner: _,
        pass_lineage_id: _,
        status: _,
        status_label: _,
        issued_at_ms: _,
        account_created_at_ms: _,
        home_cell: _,
        home_cell_registered_at_ms: _,
        identity_verified: _,
        identity_provider_mask: _,
        provider_label: _,
        identity_verified_at_ms: _,
        identity_expires_at_ms: _,
        terms_version: _,
        signed_statement_hash: _,
    } = pass;
    id.delete();
}

#[test_only]
public fun membership_pass_issued_event_fields(
    event: MembershipPassIssued,
): (ID, ID, address, ID, u64, address) {
    let MembershipPassIssued {
        registry_id,
        pass_id,
        owner,
        pass_lineage_id,
        issued_at_ms,
        actor,
    } = event;
    (
        registry_id,
        pass_id,
        owner,
        pass_lineage_id,
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
