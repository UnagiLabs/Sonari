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
    let canonical_nullifier = canonical_world_id_nullifier(nullifier)?;
    compute_duplicate_key_hash(&[
        WORLD_ID_DUPLICATE_KEY_PREFIX,
        app_id,
        action,
        &canonical_nullifier,
    ])
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

pub fn canonical_world_id_nullifier(nullifier: &str) -> Result<String, IdentityError> {
    if nullifier.is_empty() || nullifier.contains('\0') {
        return Err(IdentityError::Request(
            "World ID nullifier must be a non-empty decimal or 0x-prefixed hex string without NUL"
                .to_owned(),
        ));
    }

    if let Some(hex) = nullifier
        .strip_prefix("0x")
        .or_else(|| nullifier.strip_prefix("0X"))
    {
        return hex_to_decimal_string(hex);
    }

    if !nullifier.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(IdentityError::Request(
            "World ID nullifier must be a decimal or 0x-prefixed hex string".to_owned(),
        ));
    }

    Ok(trim_decimal_leading_zeroes(nullifier).to_owned())
}

fn hex_to_decimal_string(hex: &str) -> Result<String, IdentityError> {
    if hex.is_empty() || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(IdentityError::Request(
            "World ID nullifier hex must contain at least one hex digit".to_owned(),
        ));
    }

    let mut decimal = "0".to_owned();
    for byte in hex.bytes() {
        let digit = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            b'A'..=b'F' => byte - b'A' + 10,
            _ => {
                return Err(IdentityError::Request(
                    "World ID nullifier hex contains non-hex input".to_owned(),
                ));
            }
        };
        decimal = decimal_mul_small_add(&decimal, 16, digit);
    }

    Ok(decimal)
}

fn decimal_mul_small_add(decimal: &str, multiplier: u8, addend: u8) -> String {
    let mut carry = addend as u16;
    let mut output = Vec::with_capacity(decimal.len() + 1);
    for byte in decimal.bytes().rev() {
        let value = ((byte - b'0') as u16 * multiplier as u16) + carry;
        output.push((value % 10) as u8 + b'0');
        carry = value / 10;
    }
    while carry > 0 {
        output.push((carry % 10) as u8 + b'0');
        carry /= 10;
    }
    output.reverse();

    String::from_utf8(output).expect("decimal digits are valid UTF-8")
}

fn trim_decimal_leading_zeroes(decimal: &str) -> &str {
    let trimmed = decimal.trim_start_matches('0');
    if trimmed.is_empty() { "0" } else { trimmed }
}

#[cfg(test)]
mod tests {
    use crate::{
        IdentityError, canonical_world_id_nullifier, compute_kyc_duplicate_key_hash,
        compute_world_id_duplicate_key_hash,
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

    #[test]
    fn world_id_duplicate_key_canonicalizes_equivalent_nullifier_formats() {
        let decimal = compute_world_id_duplicate_key_hash(
            "app_staging_123",
            "sonari_membership_register_v1",
            "12345678901234567890",
        )
        .unwrap();
        let decimal_with_zeroes = compute_world_id_duplicate_key_hash(
            "app_staging_123",
            "sonari_membership_register_v1",
            "00012345678901234567890",
        )
        .unwrap();
        let hex = compute_world_id_duplicate_key_hash(
            "app_staging_123",
            "sonari_membership_register_v1",
            "0xAB54A98CEB1F0AD2",
        )
        .unwrap();

        assert_eq!(decimal, decimal_with_zeroes);
        assert_eq!(decimal, hex);
        assert_eq!(
            canonical_world_id_nullifier("0xAB54A98CEB1F0AD2").unwrap(),
            "12345678901234567890"
        );
    }

    fn assert_request_error(result: Result<String, IdentityError>) {
        assert!(matches!(result, Err(IdentityError::Request(_))));
    }
}
