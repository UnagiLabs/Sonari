use crate::IdentityError;
use serde::Serialize;

pub const WORLD_ID_PROOF_MODE_ENV: &str = "SONARI_WORLD_ID_PROOF_MODE";
pub const SUI_NETWORK_ENV: &str = "SONARI_SUI_NETWORK";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolvedWorldIdVerifierMode {
    Real,
    Dummy,
}

/// enclave 起動時に受信した proof_mode/network と解決済みの verifier mode をまとめた観測値。
///
/// この観測値は診断専用。network/proof_mode は host が bootstrap で渡す入力であり、
/// 観測値はその echo に過ぎない。dev 判定（network ベースの redact）はセキュリティ境界では
/// なく、本番での情報露出を避けるための hygiene。実際の fail-closed 安全装置は
/// `resolve_world_id_verifier_mode` 側にある。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorldIdModeObservation {
    /// 解決した verifier mode（"real" / "dummy"）。mainnet でも公開して問題ない確定値。
    pub resolved_mode: &'static str,
    /// bootstrap から受信した生の proof_mode。dev(testnet/devnet)限定。非 dev では None。
    pub received_proof_mode: Option<String>,
    /// bootstrap から受信した生の network。dev 限定。非 dev では None。
    pub received_network: Option<String>,
    /// 非 dev ネットワークで生値を伏せたとき true。
    pub redacted: bool,
}

/// bootstrap から受信した proof_mode/network と解決済み verifier mode から観測値を組み立てる。
///
/// この観測値は診断専用。network/proof_mode は host が bootstrap で渡す入力であり、
/// 観測値はその echo に過ぎない。dev 判定（network ベースの redact）はセキュリティ境界では
/// なく、本番での情報露出を避けるための hygiene。実際の fail-closed 安全装置は
/// `resolve_world_id_verifier_mode` 側にある。
pub fn world_id_mode_observation(
    proof_mode: Option<&str>,
    network: Option<&str>,
    resolved: ResolvedWorldIdVerifierMode,
) -> WorldIdModeObservation {
    let resolved_mode = match resolved {
        ResolvedWorldIdVerifierMode::Real => "real",
        ResolvedWorldIdVerifierMode::Dummy => "dummy",
    };
    let is_dev = network
        .map(str::trim)
        .map(|n| n == "testnet" || n == "devnet")
        .unwrap_or(false);

    if is_dev {
        WorldIdModeObservation {
            resolved_mode,
            received_proof_mode: proof_mode.map(str::to_owned),
            received_network: network.map(str::to_owned),
            redacted: false,
        }
    } else {
        WorldIdModeObservation {
            resolved_mode,
            received_proof_mode: None,
            received_network: None,
            redacted: true,
        }
    }
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

    // --- world_id_mode_observation ---

    #[test]
    fn observation_dummy_testnet_exposes_raw_values() {
        let obs = world_id_mode_observation(
            Some("dummy"),
            Some("testnet"),
            ResolvedWorldIdVerifierMode::Dummy,
        );
        assert_eq!(obs.resolved_mode, "dummy");
        assert_eq!(obs.received_proof_mode, Some("dummy".to_owned()));
        assert_eq!(obs.received_network, Some("testnet".to_owned()));
        assert!(!obs.redacted);
    }

    #[test]
    fn observation_real_mainnet_redacts_raw_values() {
        let obs = world_id_mode_observation(
            Some("real"),
            Some("mainnet"),
            ResolvedWorldIdVerifierMode::Real,
        );
        assert_eq!(obs.resolved_mode, "real");
        assert_eq!(obs.received_proof_mode, None);
        assert_eq!(obs.received_network, None);
        assert!(obs.redacted);
    }

    #[test]
    fn observation_dummy_devnet_exposes_raw_values() {
        let obs = world_id_mode_observation(
            Some("dummy"),
            Some("devnet"),
            ResolvedWorldIdVerifierMode::Dummy,
        );
        assert_eq!(obs.resolved_mode, "dummy");
        assert_eq!(obs.received_proof_mode, Some("dummy".to_owned()));
        assert_eq!(obs.received_network, Some("devnet".to_owned()));
        assert!(!obs.redacted);
    }

    #[test]
    fn observation_none_network_redacts() {
        let obs = world_id_mode_observation(None, None, ResolvedWorldIdVerifierMode::Real);
        assert_eq!(obs.resolved_mode, "real");
        assert_eq!(obs.received_proof_mode, None);
        assert_eq!(obs.received_network, None);
        assert!(obs.redacted);
    }

    #[test]
    fn observation_empty_proof_mode_on_dev_network_echoes_empty_string() {
        // 空文字 proof_mode でも dev ネットワークなら received_proof_mode=Some("") が載る。
        // 空文字と未設定を診断で区別できることを確認する。
        let obs =
            world_id_mode_observation(Some(""), Some("testnet"), ResolvedWorldIdVerifierMode::Real);
        assert!(!obs.redacted);
        assert_eq!(obs.received_proof_mode, Some("".to_owned()));
        assert_eq!(obs.received_network, Some("testnet".to_owned()));
    }

    // 未知 network（dev でない）では生値を伏せる。dev 判定は testnet/devnet 限定なので、
    // 想定外の network 文字列が来ても観測値が host 入力を漏らさないことを担保する。
    #[test]
    fn observation_redacts_on_unknown_network() {
        let obs = world_id_mode_observation(
            Some("dummy"),
            Some("staging"),
            ResolvedWorldIdVerifierMode::Real,
        );
        assert!(obs.redacted);
        assert_eq!(obs.received_proof_mode, None);
        assert_eq!(obs.received_network, None);
    }

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
