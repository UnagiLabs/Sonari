use crate::IdentityError;
use sonari_tee_core::{sha256_bytes, to_hex};

const KYC_DUPLICATE_KEY_PREFIX: &str = "sonari:kyc:v1";
const WORLD_ID_DUPLICATE_KEY_PREFIX: &str = "sonari:world_id:v1";

pub fn compute_kyc_duplicate_key_hash(
    provider_id: &str,
    unique_id: &str,
) -> Result<String, IdentityError> {
    compute_duplicate_key_hash(&[KYC_DUPLICATE_KEY_PREFIX, provider_id, unique_id])
}

pub fn compute_world_id_duplicate_key_hash(
    app_id: &str,
    action: &str,
    nullifier: &str,
) -> Result<String, IdentityError> {
    compute_duplicate_key_hash(&[WORLD_ID_DUPLICATE_KEY_PREFIX, app_id, action, nullifier])
}

fn compute_duplicate_key_hash(parts: &[&str]) -> Result<String, IdentityError> {
    let joined = join_duplicate_key_parts(parts)?;

    Ok(to_hex(&sha256_bytes(joined.as_bytes())))
}

fn join_duplicate_key_parts(parts: &[&str]) -> Result<String, IdentityError> {
    for part in parts {
        if part.is_empty() || part.contains('\0') {
            return Err(IdentityError::Request(
                "duplicate key input parts must be non-empty strings without NUL".to_owned(),
            ));
        }
    }

    Ok(parts.join("\0"))
}

#[cfg(test)]
mod tests {
    use crate::{
        IdentityError, compute_kyc_duplicate_key_hash, compute_world_id_duplicate_key_hash,
    };

    #[test]
    fn duplicate_key_hashes_match_typescript_vectors_from_crate_root() {
        let kyc = compute_kyc_duplicate_key_hash("sumsub", "applicant-123").unwrap();
        let world_id = compute_world_id_duplicate_key_hash(
            "app_staging_123",
            "sonari_membership_register_v1",
            "12345678901234567890",
        )
        .unwrap();

        assert_eq!(
            kyc,
            "0x4957d2bb4adcf6295386f9bb1563b95ee9d34555c47604f6dc1e64614007ec66"
        );
        assert_eq!(
            world_id,
            "0xb9dabcfc937c5422b28ddd2db18466a02c1f9fadb5637d120a3a455e23e88a74"
        );
    }

    #[test]
    fn kyc_duplicate_key_rejects_empty_parts() {
        assert_request_error(compute_kyc_duplicate_key_hash("", "applicant-123"));
        assert_request_error(compute_kyc_duplicate_key_hash("sumsub", ""));
    }

    #[test]
    fn kyc_duplicate_key_rejects_nul_parts() {
        assert_request_error(compute_kyc_duplicate_key_hash("sum\0sub", "applicant-123"));
        assert_request_error(compute_kyc_duplicate_key_hash("sumsub", "applicant\0-123"));
    }

    #[test]
    fn world_id_duplicate_key_rejects_empty_parts() {
        assert_request_error(compute_world_id_duplicate_key_hash(
            "",
            "sonari_membership_register_v1",
            "12345678901234567890",
        ));
        assert_request_error(compute_world_id_duplicate_key_hash(
            "app_staging_123",
            "",
            "12345678901234567890",
        ));
        assert_request_error(compute_world_id_duplicate_key_hash(
            "app_staging_123",
            "sonari_membership_register_v1",
            "",
        ));
    }

    #[test]
    fn world_id_duplicate_key_rejects_nul_parts() {
        assert_request_error(compute_world_id_duplicate_key_hash(
            "app\0_staging_123",
            "sonari_membership_register_v1",
            "12345678901234567890",
        ));
        assert_request_error(compute_world_id_duplicate_key_hash(
            "app_staging_123",
            "sonari\0membership_register_v1",
            "12345678901234567890",
        ));
        assert_request_error(compute_world_id_duplicate_key_hash(
            "app_staging_123",
            "sonari_membership_register_v1",
            concat!("12345", "\0", "67890"),
        ));
    }

    fn assert_request_error(result: Result<String, IdentityError>) {
        assert!(matches!(result, Err(IdentityError::Request(_))));
    }
}
