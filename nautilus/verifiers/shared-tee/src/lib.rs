use ed25519_dalek::{Signer, SigningKey};
use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SignatureArtifact {
    pub algorithm: String,
    pub public_key: String,
    pub signature: String,
}

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

#[derive(Debug, Error, PartialEq, Eq)]
pub enum HexError {
    #[error("expected 0x-prefixed hex: {value}")]
    MissingPrefix { value: String },
    #[error("invalid hex: {value}")]
    InvalidHex { value: String },
    #[error("expected 32-byte hex: {value}")]
    InvalidLength { value: String },
}

pub fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

pub fn to_hex(data: &[u8]) -> String {
    format!("0x{}", hex::encode(data))
}

pub fn hex_to_32(value: &str) -> Result<[u8; 32], HexError> {
    let hex_value = value
        .strip_prefix("0x")
        .ok_or_else(|| HexError::MissingPrefix {
            value: value.to_owned(),
        })?;
    let bytes = hex::decode(hex_value).map_err(|_| HexError::InvalidHex {
        value: value.to_owned(),
    })?;
    bytes.try_into().map_err(|_| HexError::InvalidLength {
        value: value.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        LocalEd25519Signer, PayloadSigner, SignatureArtifact, hex_to_32, sha256_bytes, to_hex,
    };
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    #[test]
    fn digest_helper_uses_sha256() {
        assert_eq!(
            hex::encode(sha256_bytes(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
    }

    #[test]
    fn hex_helpers_keep_contract_format() {
        let bytes = [0x7a; 32];

        assert_eq!(
            to_hex(&bytes),
            "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a"
        );
        assert_eq!(hex_to_32(&to_hex(&bytes)).unwrap(), bytes);
        assert!(hex_to_32("7a").is_err());
        assert!(hex_to_32("0xzz").is_err());
        assert!(hex_to_32("0x7a").is_err());
    }

    #[test]
    fn local_ed25519_signer_returns_verifiable_artifact() {
        let signer = LocalEd25519Signer::new([7; 32]);
        let payload = b"sonari-payload";
        let artifact = signer.sign_payload(payload);

        assert_eq!(artifact.algorithm, "Ed25519");
        let public_key_bytes = hex_to_32(&artifact.public_key).unwrap();
        let signature_bytes = hex::decode(artifact.signature.strip_prefix("0x").unwrap()).unwrap();
        let verifying_key = VerifyingKey::from_bytes(&public_key_bytes).unwrap();
        let signature = Signature::try_from(signature_bytes.as_slice()).unwrap();

        verifying_key.verify(payload, &signature).unwrap();
    }

    #[test]
    fn signature_artifact_preserves_json_shape() {
        let artifact = SignatureArtifact {
            algorithm: "Ed25519".to_owned(),
            public_key: "0xpublic".to_owned(),
            signature: "0xsig".to_owned(),
        };

        assert_eq!(
            serde_json::to_value(artifact).unwrap(),
            serde_json::json!({
                "algorithm": "Ed25519",
                "public_key": "0xpublic",
                "signature": "0xsig",
            })
        );
    }
}
