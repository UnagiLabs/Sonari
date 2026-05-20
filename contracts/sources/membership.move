module contracts::membership;

use contracts::pools::{Self, OperationsPool};
use sui::coin::{Self, Coin};
use sui::event;
use usdc::usdc::USDC;

const STATUS_ACTIVE: u8 = 1;
const STATUS_SUSPENDED: u8 = 2;
const STATUS_REVOKED: u8 = 3;
const STATUS_MIGRATED: u8 = 4;

const EZeroVerificationFee: u64 = 0;
const EInvalidPayoutAddress: u64 = 1;
const EMembershipPassNotActive: u64 = 2;
const EClaimantNotAuthorized: u64 = 3;

public struct MembershipPass has key {
    id: UID,
    owner: address,
    payout_address: address,
    pass_lineage_id: ID,
    status: u8,
    issued_at_ms: u64,
    last_metadata_update_ms: u64,
}

public struct MembershipPassIssued has copy, drop {
    pass_id: ID,
    owner: address,
    payout_address: address,
    pass_lineage_id: ID,
    operations_pool_id: ID,
    fee_amount: u64,
    issued_at_ms: u64,
    actor: address,
}

public(package) fun register_member_usdc(
    operations_pool: &mut OperationsPool,
    fee: Coin<USDC>,
    payout_address: address,
    ctx: &mut TxContext,
) {
    let fee_amount = coin::value(&fee);
    assert!(fee_amount > 0, EZeroVerificationFee);
    assert!(payout_address != @0x0, EInvalidPayoutAddress);

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
    };
    let pass_id = object::id(&pass);
    let operations_pool_id = pools::operations_pool_id(operations_pool);

    pools::deposit_operations_usdc(operations_pool, fee);
    event::emit(MembershipPassIssued {
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

// Caller must pass a trusted claimant, typically ctx.sender(), not an unchecked user-supplied address.
public fun assert_claim_precheck(pass: &MembershipPass, claimant: address) {
    assert!(pass.status == STATUS_ACTIVE, EMembershipPassNotActive);
    assert!(
        claimant == pass.owner || claimant == pass.payout_address,
        EClaimantNotAuthorized,
    );
}

public fun duplicate_claim_key(pass: &MembershipPass, campaign_id: ID): (ID, ID) {
    (pass.pass_lineage_id, campaign_id)
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
public fun membership_pass_issued_event_fields(
    event: MembershipPassIssued,
): (ID, address, address, ID, ID, u64, u64, address) {
    let MembershipPassIssued {
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
