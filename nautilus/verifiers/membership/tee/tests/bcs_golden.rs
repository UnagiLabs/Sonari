use membership_tee::{
    INTENT, IdentityTeeResult, PROVIDER_KYC, PROVIDER_WORLD_ID, VERIFIER_FAMILY, VERIFIER_VERSION,
    encoding::identity_bcs::payload_bcs_bytes,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct IdentityResultVectors {
    field_order: Vec<String>,
    provider_enum: ProviderEnum,
    vectors: Vec<IdentityResultVector>,
}

#[derive(Deserialize)]
struct ProviderEnum {
    kyc: u8,
    world_id: u8,
}

#[derive(Deserialize)]
struct IdentityResultVector {
    case_id: String,
    source_fixture: String,
    result: IdentityTeeResult,
    payload_bcs_hex: String,
}

#[test]
fn pins_bcs_numeric_enums_to_typescript_contract() {
    assert_eq!(INTENT, "SONARI_IDENTITY_VERIFICATION_V1");
    assert_eq!(VERIFIER_FAMILY, "identity");
    assert_eq!(VERIFIER_VERSION, 1);
    assert_eq!(PROVIDER_KYC, 1);
    assert_eq!(PROVIDER_WORLD_ID, 2);
}

#[test]
fn bcs_golden_matches_typescript_reference() {
    let vectors = identity_result_vectors();
    assert_eq!(
        vectors.field_order,
        [
            "intent",
            "verifier_family",
            "verifier_version",
            "registry_id",
            "membership_id",
            "owner",
            "provider",
            "verified",
            "duplicate_key_hash",
            "evidence_hash",
            "issued_at_ms",
            "expires_at_ms",
            "terms_version",
            "signed_statement_hash",
        ]
    );
    assert_eq!(vectors.provider_enum.kyc, PROVIDER_KYC);
    assert_eq!(vectors.provider_enum.world_id, PROVIDER_WORLD_ID);

    let world_id_success = vectors
        .vectors
        .iter()
        .find(|vector| vector.case_id == "world_id_success_v1")
        .expect("world_id_success_v1 vector should exist");
    let fixture: IdentityTeeResult = serde_json::from_str(include_str!(
        "../../fixtures/identity/world_id_success.json"
    ))
    .expect("world_id_success fixture should parse");

    assert_eq!(
        world_id_success.source_fixture,
        "nautilus/verifiers/membership/fixtures/identity/world_id_success.json"
    );
    assert_eq!(world_id_success.result, fixture);

    for vector in vectors.vectors {
        let encoded =
            payload_bcs_bytes(&vector.result).expect("identity payload BCS should encode");

        assert_eq!(
            format!("0x{}", hex::encode(encoded)),
            vector.payload_bcs_hex,
            "{} vector payload hex drifted from result fields",
            vector.case_id
        );
    }
}

fn identity_result_vectors() -> IdentityResultVectors {
    serde_json::from_str(include_str!(
        "../../../../../schemas/examples/identity_result_vectors.json"
    ))
    .expect("identity result vectors should parse")
}
