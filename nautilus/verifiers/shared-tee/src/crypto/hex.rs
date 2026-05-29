use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum HexError {
    #[error("expected 0x-prefixed hex: {value}")]
    MissingPrefix { value: String },
    #[error("invalid hex: {value}")]
    InvalidHex { value: String },
    #[error("expected 32-byte hex: {value}")]
    InvalidLength { value: String },
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
    use super::{hex_to_32, to_hex};

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
}
