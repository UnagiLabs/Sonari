use crate::types::OracleError;
use serde::Serialize;

pub fn canonical_json_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, OracleError> {
    // Canonical artifact JSON relies on Rust struct field order matching schema order.
    serde_json::to_vec(value).map_err(OracleError::from)
}
