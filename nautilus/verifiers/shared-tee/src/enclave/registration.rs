use serde::{Deserialize, Serialize};

/// On-chain registration metadata injected into a finalized enclave result.
///
/// The enclave does not derive these values; the worker supplies them on the
/// `process_data` request and the shared server echoes them back into the
/// finalized output so the relayer can bind the result to the registered
/// verifier config and enclave instance.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EnclaveRegistrationMetadata {
    pub verifier_config_key: u64,
    pub verifier_config_version: u64,
    pub enclave_instance_public_key: String,
}

#[cfg(test)]
mod tests {
    use super::EnclaveRegistrationMetadata;

    #[test]
    fn registration_metadata_roundtrips_through_json() {
        let metadata = EnclaveRegistrationMetadata {
            verifier_config_key: 1,
            verifier_config_version: 10,
            enclave_instance_public_key: format!("0x{}", "77".repeat(32)),
        };

        let value = serde_json::to_value(&metadata).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "verifier_config_key": 1,
                "verifier_config_version": 10,
                "enclave_instance_public_key": format!("0x{}", "77".repeat(32)),
            })
        );

        let decoded: EnclaveRegistrationMetadata = serde_json::from_value(value).unwrap();
        assert_eq!(decoded.verifier_config_key, 1);
        assert_eq!(decoded.verifier_config_version, 10);
    }
}
