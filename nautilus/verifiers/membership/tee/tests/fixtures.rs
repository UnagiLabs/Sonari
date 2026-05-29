use membership_tee::{
    IdentityProvider, IdentityTeeResult, compute_identity_evidence_hash,
    encoding::identity_bcs::payload_bcs_bytes,
};

#[test]
fn world_id_success_fixture_uses_computed_evidence_hash() {
    let fixture: IdentityTeeResult = serde_json::from_str(include_str!(
        "../../fixtures/identity/world_id_success.json"
    ))
    .expect("world_id_success fixture should parse");
    let evidence_hash = compute_identity_evidence_hash(
        IdentityProvider::WorldId,
        &fixture.duplicate_key_hash,
        "orb",
        fixture.issued_at_ms,
    )
    .expect("fixture evidence hash inputs should be valid");

    assert_eq!(fixture.evidence_hash, evidence_hash);
    assert!(payload_bcs_bytes(&fixture).is_ok());
}
