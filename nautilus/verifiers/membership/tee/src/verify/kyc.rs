pub const KYC_UNSUPPORTED: &str = "KYC_UNSUPPORTED";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KycVerificationStatus {
    Unsupported { error_code: String },
}

pub fn verify_kyc_unsupported() -> KycVerificationStatus {
    KycVerificationStatus::Unsupported {
        error_code: KYC_UNSUPPORTED.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::{KYC_UNSUPPORTED, KycVerificationStatus, verify_kyc_unsupported};

    #[test]
    fn kyc_verifier_returns_explicit_unsupported_status() {
        assert_eq!(
            verify_kyc_unsupported(),
            KycVerificationStatus::Unsupported {
                error_code: KYC_UNSUPPORTED.to_owned()
            }
        );
    }
}
