module contracts::reader;

use contracts::donation::{Self, DonorPass};
use contracts::identity_registry;
use contracts::membership;
use contracts::metadata_verifier;
use contracts::pools;
use contracts::program;

public fun donation_record_summary(
    pass: &DonorPass,
    donation_index: u64,
): (u64, u8, Option<ID>, Option<ID>, ID, u64, vector<u8>, u64) {
    donation::donation_record_summary(pass, donation_index)
}

public fun identity_provider_kyc(): u8 {
    identity_registry::provider_kyc()
}

public fun identity_provider_world_id(): u8 {
    identity_registry::provider_world_id()
}

public fun target_kind_program(): u8 {
    program::target_kind_program()
}

public fun target_kind_campaign(): u8 {
    program::target_kind_campaign()
}

public fun target_kind_membership_registry(): u8 {
    membership::target_kind_membership_registry()
}

public fun target_kind_identity_registry(): u8 {
    identity_registry::target_kind_identity_registry()
}

public fun target_kind_verifier_registry(): u8 {
    metadata_verifier::target_kind_verifier_registry()
}

public fun target_kind_main_pool(): u8 {
    pools::target_kind_main_pool()
}

public fun target_kind_designated_pool(): u8 {
    pools::target_kind_designated_pool()
}

public fun target_kind_operations_pool(): u8 {
    pools::target_kind_operations_pool()
}

public fun verifier_family_earthquake_oracle(): u8 {
    metadata_verifier::verifier_family_earthquake_oracle()
}

public fun verifier_family_identity(): u8 {
    metadata_verifier::verifier_family_identity()
}

public fun verifier_version_v1(): u64 {
    metadata_verifier::verifier_version_v1()
}
