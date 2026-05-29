use ed25519_dalek::{Signer, SigningKey};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{env, fs, io};
use thiserror::Error;

pub const DEV_SIGNING_KEY_SEED_HEX: &str =
    "0x0707070707070707070707070707070707070707070707070707070707070707";

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

#[derive(Debug, Error)]
pub enum SeedError {
    #[error("signing key seed is required: set {env} or {file_env}")]
    MissingSeed { env: String, file_env: String },
    #[error("invalid signing key seed hex: {source}")]
    InvalidHex { source: hex::FromHexError },
    #[error("signing key seed must be 32 bytes")]
    InvalidLength,
    #[error("failed to read signing key seed file {path}: {source}")]
    FileRead { path: String, source: io::Error },
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

pub fn parse_seed(value: &str) -> Result<[u8; 32], SeedError> {
    let hex_value = value.strip_prefix("0x").unwrap_or(value);
    let bytes = hex::decode(hex_value).map_err(|source| SeedError::InvalidHex { source })?;
    bytes.try_into().map_err(|_| SeedError::InvalidLength)
}

pub fn non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub fn signing_key_seed_from_env(
    explicit: Option<String>,
    env_name: &str,
    file_env_name: &str,
    allow_dev: bool,
) -> Result<[u8; 32], SeedError> {
    if let Some(seed) = explicit {
        return parse_seed(&seed);
    }
    if let Some(seed) = non_empty_env(env_name) {
        return parse_seed(&seed);
    }
    if let Some(path) = non_empty_env(file_env_name) {
        let seed = fs::read_to_string(&path).map_err(|source| SeedError::FileRead {
            path: path.clone(),
            source,
        })?;
        return parse_seed(seed.trim());
    }
    if allow_dev {
        return parse_seed(DEV_SIGNING_KEY_SEED_HEX);
    }
    Err(SeedError::MissingSeed {
        env: env_name.to_owned(),
        file_env: file_env_name.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        DEV_SIGNING_KEY_SEED_HEX, LocalEd25519Signer, PayloadSigner, SignatureArtifact, hex_to_32,
        parse_seed, sha256_bytes, signing_key_seed_from_env, to_hex,
    };
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

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

    #[test]
    fn parse_seed_accepts_prefixed_or_plain_32_byte_hex() {
        let expected = [7; 32];

        assert_eq!(parse_seed(DEV_SIGNING_KEY_SEED_HEX).unwrap(), expected);
        assert_eq!(
            parse_seed(DEV_SIGNING_KEY_SEED_HEX.strip_prefix("0x").unwrap()).unwrap(),
            expected
        );
        assert!(parse_seed("0x07").is_err());
        assert!(parse_seed("0xzz").is_err());
    }

    #[test]
    fn signing_key_seed_prefers_explicit_then_env_then_file_then_dev() {
        let explicit = "0x0101010101010101010101010101010101010101010101010101010101010101";
        let env_seed = "0x0202020202020202020202020202020202020202020202020202020202020202";
        let file_seed = "0x0303030303030303030303030303030303030303030303030303030303030303";
        let env_name = unique_env_name("SEED");
        let file_env_name = unique_env_name("SEED_FILE");
        let seed_path = unique_seed_path("seed-precedence");

        fs::write(&seed_path, file_seed).unwrap();
        set_env(&env_name, env_seed);
        set_env(&file_env_name, seed_path.to_str().unwrap());

        assert_eq!(
            signing_key_seed_from_env(Some(explicit.to_owned()), &env_name, &file_env_name, true)
                .unwrap(),
            [1; 32]
        );
        assert_eq!(
            signing_key_seed_from_env(None, &env_name, &file_env_name, true).unwrap(),
            [2; 32]
        );

        remove_env(&env_name);
        assert_eq!(
            signing_key_seed_from_env(None, &env_name, &file_env_name, true).unwrap(),
            [3; 32]
        );

        remove_env(&file_env_name);
        assert_eq!(
            signing_key_seed_from_env(None, &env_name, &file_env_name, true).unwrap(),
            [7; 32]
        );

        let _ = fs::remove_file(seed_path);
    }

    #[test]
    fn signing_key_seed_fails_closed_without_dev_fallback() {
        let env_name = unique_env_name("MISSING_SEED");
        let file_env_name = unique_env_name("MISSING_SEED_FILE");
        remove_env(&env_name);
        remove_env(&file_env_name);

        assert!(signing_key_seed_from_env(None, &env_name, &file_env_name, false).is_err());
    }

    #[test]
    fn signing_key_seed_rejects_invalid_env_or_file_values() {
        let env_name = unique_env_name("BAD_SEED");
        let file_env_name = unique_env_name("BAD_SEED_FILE");
        let seed_path = unique_seed_path("bad-seed");

        set_env(&env_name, "0xzz");
        assert!(signing_key_seed_from_env(None, &env_name, &file_env_name, true).is_err());

        remove_env(&env_name);
        fs::write(&seed_path, "0x07").unwrap();
        set_env(&file_env_name, seed_path.to_str().unwrap());
        assert!(signing_key_seed_from_env(None, &env_name, &file_env_name, true).is_err());

        remove_env(&file_env_name);
        let _ = fs::remove_file(seed_path);
    }

    fn unique_env_name(suffix: &str) -> String {
        format!(
            "SONARI_TEE_CORE_TEST_{}_{}_{}",
            suffix,
            std::process::id(),
            monotonic_nanos()
        )
    }

    fn unique_seed_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "sonari-tee-core-{name}-{}-{}.txt",
            std::process::id(),
            monotonic_nanos()
        ))
    }

    fn monotonic_nanos() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    fn set_env(name: &str, value: &str) {
        unsafe {
            std::env::set_var(name, value);
        }
    }

    fn remove_env(name: &str) {
        unsafe {
            std::env::remove_var(name);
        }
    }
}
