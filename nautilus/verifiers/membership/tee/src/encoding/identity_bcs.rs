use crate::{
    INTENT, IdentityError, IdentityProvider, IdentityTeeResult, PROVIDER_KYC, PROVIDER_WORLD_ID,
    VERIFIER_FAMILY, VERIFIER_VERSION,
};
use serde::Serialize;
use sonari_tee_core::hex_to_32;

#[derive(Serialize)]
struct IdentityPayloadBcs {
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

pub fn payload_bcs_bytes(result: &IdentityTeeResult) -> Result<Vec<u8>, IdentityError> {
    validate_contract_constants(result)?;

    bcs::to_bytes(&IdentityPayloadBcs {
        intent: result.intent.as_bytes().to_vec(),
        verifier_family: result.verifier_family.as_bytes().to_vec(),
        verifier_version: result.verifier_version,
        registry_id: hex_to_32(&result.registry_id)?,
        membership_id: hex_to_32(&result.membership_id)?,
        owner: hex_to_32(&result.owner)?,
        provider: provider_bcs_value(result.provider),
        verified: result.verified,
        duplicate_key_hash: hex_to_32(&result.duplicate_key_hash)?,
        evidence_hash: hex_to_32(&result.evidence_hash)?,
        issued_at_ms: result.issued_at_ms,
        expires_at_ms: result.expires_at_ms,
        terms_version: result.terms_version,
        signed_statement_hash: hex_to_32(&result.signed_statement_hash)?,
    })
    .map_err(IdentityError::from)
}

fn validate_contract_constants(result: &IdentityTeeResult) -> Result<(), IdentityError> {
    if result.intent != INTENT {
        return invalid_payload("intent must match the identity verification contract");
    }
    if result.verifier_family != VERIFIER_FAMILY {
        return invalid_payload("verifier_family must match the identity verification contract");
    }
    if result.verifier_version != VERIFIER_VERSION {
        return invalid_payload("verifier_version must match the identity verification contract");
    }
    Ok(())
}

fn provider_bcs_value(provider: IdentityProvider) -> u8 {
    match provider {
        IdentityProvider::Kyc => PROVIDER_KYC,
        IdentityProvider::WorldId => PROVIDER_WORLD_ID,
    }
}

fn invalid_payload<T>(message: &str) -> Result<T, IdentityError> {
    Err(IdentityError::Request(format!(
        "invalid identity BCS payload: {message}"
    )))
}
