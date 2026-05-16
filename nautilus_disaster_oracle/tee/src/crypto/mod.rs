// Cryptographic hashing and signing helpers.
use crate::core::artifacts::SignatureArtifact;
use crate::core::types::OracleError;
use ed25519_dalek::{Signer, SigningKey};
use sha3::{Digest, Sha3_256};

pub trait PayloadSigner {
    fn sign_payload(&self, payload: &[u8]) -> SignatureArtifact;
}

#[derive(Debug, Clone, Copy)]
pub struct LocalEd25519Signer {
    seed: [u8; 32],
}

impl LocalEd25519Signer {
    pub const fn new(seed: [u8; 32]) -> Self {
        Self { seed }
    }
}

impl PayloadSigner for LocalEd25519Signer {
    fn sign_payload(&self, payload: &[u8]) -> SignatureArtifact {
        let signing_key = SigningKey::from_bytes(&self.seed);
        let verifying_key = signing_key.verifying_key();
        let signature = signing_key.sign(payload);
        SignatureArtifact {
            algorithm: "Ed25519".to_owned(),
            public_key: to_hex(&verifying_key.to_bytes()),
            signature: to_hex(&signature.to_bytes()),
        }
    }
}

pub fn sha3_256_bytes(data: &[u8]) -> [u8; 32] {
    Sha3_256::digest(data).into()
}

pub(crate) fn to_hex(data: &[u8]) -> String {
    format!("0x{}", hex::encode(data))
}

pub(crate) fn hex_to_32(value: &str) -> Result<[u8; 32], OracleError> {
    let hex_value = value.strip_prefix("0x").ok_or_else(|| {
        OracleError::InvalidGridPoint(format!("expected 0x-prefixed hex: {value}"))
    })?;
    let bytes = hex::decode(hex_value)
        .map_err(|_| OracleError::InvalidGridPoint(format!("invalid hex: {value}")))?;
    bytes
        .try_into()
        .map_err(|_| OracleError::InvalidGridPoint(format!("expected 32-byte hex: {value}")))
}
