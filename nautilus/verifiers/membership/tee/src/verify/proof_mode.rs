use crate::IdentityError;

pub const WORLD_ID_PROOF_MODE_ENV: &str = "SONARI_WORLD_ID_PROOF_MODE";
pub const SUI_NETWORK_ENV: &str = "SONARI_SUI_NETWORK";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolvedWorldIdVerifierMode {
    Real,
    Dummy,
}

pub fn resolve_world_id_verifier_mode(
    proof_mode: Option<&str>,
    network: Option<&str>,
) -> Result<ResolvedWorldIdVerifierMode, IdentityError> {
    let mode = proof_mode.map(str::trim).unwrap_or("");

    if mode.is_empty() || mode == "real" {
        return Ok(ResolvedWorldIdVerifierMode::Real);
    }

    if mode == "dummy" {
        let net = network.map(str::trim).unwrap_or("");
        return match net {
            "testnet" | "devnet" => Ok(ResolvedWorldIdVerifierMode::Dummy),
            "mainnet" => Err(IdentityError::Request(
                "dummy World ID proof mode is only allowed on testnet or devnet, not mainnet"
                    .to_owned(),
            )),
            _ => Err(IdentityError::Request(format!(
                "dummy World ID proof mode requires network to be testnet or devnet; \
                 got {:?} — refusing to allow dummy on unknown or unset network (fail-closed)",
                network
            ))),
        };
    }

    Err(IdentityError::Request(format!(
        "unknown SONARI_WORLD_ID_PROOF_MODE value {:?}; expected \"real\" or \"dummy\" (fail-closed)",
        proof_mode
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    // env キー定数値が期待文字列であること
    #[test]
    fn env_key_constants_have_correct_values() {
        assert_eq!(WORLD_ID_PROOF_MODE_ENV, "SONARI_WORLD_ID_PROOF_MODE");
        assert_eq!(SUI_NETWORK_ENV, "SONARI_SUI_NETWORK");
    }

    // (dummy, testnet) → Ok(Dummy)
    #[test]
    fn dummy_testnet_is_allowed() {
        let result = resolve_world_id_verifier_mode(Some("dummy"), Some("testnet"));
        assert_eq!(result.unwrap(), ResolvedWorldIdVerifierMode::Dummy);
    }

    // (dummy, devnet) → Ok(Dummy)
    #[test]
    fn dummy_devnet_is_allowed() {
        let result = resolve_world_id_verifier_mode(Some("dummy"), Some("devnet"));
        assert_eq!(result.unwrap(), ResolvedWorldIdVerifierMode::Dummy);
    }

    // (dummy, mainnet) → Err
    #[test]
    fn dummy_mainnet_is_rejected() {
        let result = resolve_world_id_verifier_mode(Some("dummy"), Some("mainnet"));
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("mainnet"),
            "error message should mention mainnet: {msg}"
        );
    }

    // (dummy, None) → Err
    #[test]
    fn dummy_no_network_is_rejected() {
        let result = resolve_world_id_verifier_mode(Some("dummy"), None);
        assert!(result.is_err());
    }

    // (dummy, "unknown") のような未知 network → Err
    #[test]
    fn dummy_unknown_network_is_rejected() {
        let result = resolve_world_id_verifier_mode(Some("dummy"), Some("unknown"));
        assert!(result.is_err());
    }

    // (real, mainnet) → Ok(Real)（real は network 不問）
    #[test]
    fn real_mainnet_is_allowed() {
        let result = resolve_world_id_verifier_mode(Some("real"), Some("mainnet"));
        assert_eq!(result.unwrap(), ResolvedWorldIdVerifierMode::Real);
    }

    // (real, None) → Ok(Real)
    #[test]
    fn real_no_network_is_allowed() {
        let result = resolve_world_id_verifier_mode(Some("real"), None);
        assert_eq!(result.unwrap(), ResolvedWorldIdVerifierMode::Real);
    }

    // (None, None) → Ok(Real)（proof_mode 未指定はデフォルト real）
    #[test]
    fn none_proof_mode_defaults_to_real() {
        let result = resolve_world_id_verifier_mode(None, None);
        assert_eq!(result.unwrap(), ResolvedWorldIdVerifierMode::Real);
    }

    // ("", mainnet) → Ok(Real)（空文字も未指定扱い）
    #[test]
    fn empty_proof_mode_defaults_to_real() {
        let result = resolve_world_id_verifier_mode(Some(""), Some("mainnet"));
        assert_eq!(result.unwrap(), ResolvedWorldIdVerifierMode::Real);
    }

    // ("bogus", testnet) のような未知 proof_mode → Err
    #[test]
    fn unknown_proof_mode_is_rejected() {
        let result = resolve_world_id_verifier_mode(Some("bogus"), Some("testnet"));
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("unknown SONARI_WORLD_ID_PROOF_MODE"),
            "error message should mention env key: {msg}"
        );
    }

    // 空白トリムが効いているか確認（" dummy " と " testnet " でも通るべき）
    #[test]
    fn whitespace_is_trimmed() {
        let result = resolve_world_id_verifier_mode(Some("  dummy  "), Some("  testnet  "));
        assert_eq!(result.unwrap(), ResolvedWorldIdVerifierMode::Dummy);
    }
}
