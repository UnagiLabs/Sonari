use crate::artifacts::SignatureArtifact;
use crate::crypto::to_hex;
use ed25519_dalek::{Signer, SigningKey};

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

#[cfg(test)]
mod tests {
    use super::{LocalEd25519Signer, PayloadSigner};
    use crate::crypto::hex_to_32;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

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
}
