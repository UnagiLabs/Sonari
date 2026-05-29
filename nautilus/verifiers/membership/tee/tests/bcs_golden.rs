use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use membership_tee::{
    INTENT, IdentityProvider, IdentityTeeResult, IdentityVerifyRequest, PROVIDER_KYC,
    PROVIDER_WORLD_ID, VERIFIER_FAMILY, VERIFIER_VERSION, WORLD_ID_ACTION, WorldIdProofRequest,
    WorldIdVerificationStatus, WorldIdVerifier, compute_world_id_signal_hash,
    encoding::identity_bcs::payload_bcs_bytes, process_identity_with_verifier,
};
use serde::Deserialize;
use sonari_tee_core::{LocalEd25519Signer, hex_to_32};

#[derive(Debug, Deserialize)]
struct DecodedIdentityPayload {
    intent: Vec<u8>,
    verifier_family: Vec<u8>,
    verifier_version: u64,
    registry_id: [u8; 32],
    membership_id: [u8; 32],
    owner: [u8; 32],
    provider: u8,
    verified: bool,
    duplicate_key_hash: [u8; 32],
    evidence_hash: [u8; 32],
    issued_at_ms: u64,
    expires_at_ms: u64,
    terms_version: u64,
    signed_statement_hash: [u8; 32],
}

struct VerifiedWorldIdVerifier;

impl WorldIdVerifier for VerifiedWorldIdVerifier {
    fn expected_app_id(&self) -> &str {
        "app_staging_123"
    }

    fn verify_world_id(&self, _proof: &WorldIdProofRequest) -> WorldIdVerificationStatus {
        WorldIdVerificationStatus::Verified
    }
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
    let result = IdentityTeeResult {
        intent: INTENT.to_owned(),
        verifier_family: VERIFIER_FAMILY.to_owned(),
        verifier_version: VERIFIER_VERSION,
        registry_id: "0x1111111111111111111111111111111111111111111111111111111111111111"
            .to_owned(),
        membership_id: "0x2222222222222222222222222222222222222222222222222222222222222222"
            .to_owned(),
        owner: "0x3333333333333333333333333333333333333333333333333333333333333333".to_owned(),
        provider: IdentityProvider::WorldId,
        verified: true,
        duplicate_key_hash: "0x4444444444444444444444444444444444444444444444444444444444444444"
            .to_owned(),
        evidence_hash: "0x5555555555555555555555555555555555555555555555555555555555555555"
            .to_owned(),
        issued_at_ms: 1_800_000_000_000,
        expires_at_ms: 1_831_536_000_000,
        terms_version: 1,
        signed_statement_hash: "0x6666666666666666666666666666666666666666666666666666666666666666"
            .to_owned(),
    };

    let encoded = payload_bcs_bytes(&result).expect("identity payload BCS should encode");

    assert_eq!(
        format!("0x{}", hex::encode(encoded)),
        "0x1f534f4e4152495f4944454e544954595f564552494649434154494f4e5f5631086964656e74697479010000000000000011111111111111111111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222333333333333333333333333333333333333333333333333333333333333333302014444444444444444444444444444444444444444444444444444444444444444555555555555555555555555555555555555555555555555555555555555555500505c18a3010000007c0d70aa01000001000000000000006666666666666666666666666666666666666666666666666666666666666666"
    );
}

#[test]
fn verified_request_round_trips_bcs_and_signs_payload_bytes() {
    let request = world_id_request();
    let signer = LocalEd25519Signer::new([7; 32]);
    let output =
        process_identity_with_verifier(request.clone(), &VerifiedWorldIdVerifier, &signer, 0)
            .expect("verified request should process");

    let result = output.result.as_ref().expect("verified result");
    let payload = output
        .unsigned_bcs_payload
        .as_ref()
        .expect("verified BCS payload");
    let signature = output.signature.as_ref().expect("verified signature");
    let decoded: DecodedIdentityPayload =
        bcs::from_bytes(payload).expect("payload should decode with contract field order");

    assert_eq!(String::from_utf8(decoded.intent).unwrap(), INTENT);
    assert_eq!(
        String::from_utf8(decoded.verifier_family).unwrap(),
        VERIFIER_FAMILY
    );
    assert_eq!(decoded.verifier_version, VERIFIER_VERSION);
    assert_eq!(
        decoded.registry_id,
        hex_to_32(&request.registry_id).unwrap()
    );
    assert_eq!(
        decoded.membership_id,
        hex_to_32(&request.membership_id).unwrap()
    );
    assert_eq!(decoded.owner, hex_to_32(&request.owner).unwrap());
    assert_eq!(decoded.provider, PROVIDER_WORLD_ID);
    assert!(decoded.verified);
    assert_eq!(decoded.issued_at_ms, request.issued_at_ms.unwrap());
    assert_eq!(
        decoded.expires_at_ms,
        request.issued_at_ms.unwrap() + request.validity_ms.unwrap()
    );
    assert!(decoded.expires_at_ms > decoded.issued_at_ms);
    assert_eq!(decoded.terms_version, request.terms_version);
    assert_eq!(
        decoded.signed_statement_hash,
        hex_to_32(&request.signed_statement_hash).unwrap()
    );
    assert_eq!(
        decoded.duplicate_key_hash,
        hex_to_32(&result.duplicate_key_hash).unwrap()
    );
    assert_eq!(
        decoded.evidence_hash,
        hex_to_32(&result.evidence_hash).unwrap()
    );

    let public_key = VerifyingKey::from_bytes(&hex_to_32(&signature.public_key).unwrap())
        .expect("public key should decode");
    let signature_bytes =
        hex::decode(signature.signature.trim_start_matches("0x")).expect("signature should be hex");
    let signature = Signature::try_from(signature_bytes.as_slice()).expect("signature length");

    public_key
        .verify(payload, &signature)
        .expect("signature should verify over payload BCS bytes");
}

fn world_id_request() -> IdentityVerifyRequest {
    let owner = "0x3333333333333333333333333333333333333333333333333333333333333333";
    let membership_id = "0x2222222222222222222222222222222222222222222222222222222222222222";
    let signed_statement_hash =
        "0x6666666666666666666666666666666666666666666666666666666666666666";
    let signal_hash =
        compute_world_id_signal_hash(owner, membership_id, signed_statement_hash).unwrap();

    IdentityVerifyRequest {
        registry_id: "0x1111111111111111111111111111111111111111111111111111111111111111"
            .to_owned(),
        membership_id: membership_id.to_owned(),
        owner: owner.to_owned(),
        provider: IdentityProvider::WorldId,
        terms_version: 1,
        signed_statement_hash: signed_statement_hash.to_owned(),
        issued_at_ms: Some(1_800_000_000_000),
        validity_ms: Some(3_600_000),
        world_id: Some(WorldIdProofRequest {
            world_app_id: "app_staging_123".to_owned(),
            nullifier_hash: "12345678901234567890".to_owned(),
            merkle_root: "987654321".to_owned(),
            proof: "0xproof".to_owned(),
            verification_level: "orb".to_owned(),
            action: WORLD_ID_ACTION.to_owned(),
            signal_hash,
        }),
    }
}
