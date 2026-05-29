use std::{env, fs, io};
use thiserror::Error;

pub const DEV_SIGNING_KEY_SEED_HEX: &str =
    "0x0707070707070707070707070707070707070707070707070707070707070707";

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
    use super::{DEV_SIGNING_KEY_SEED_HEX, parse_seed, signing_key_seed_from_env};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

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
