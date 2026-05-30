use std::io::{self, Read};

use clap::{Parser, Subcommand, ValueEnum};
use membership_tee::{
    CloudWorldIdVerifier, IdentityProcessingOutput, IdentityProcessingStatus, IdentityProvider,
    IdentityTeeResult, IdentityVerifyRequest, WORLD_ID_API_UNAVAILABLE,
    WORLD_ID_VERIFICATION_FAILED, WorldIdProofRequest, WorldIdVerificationStatus, WorldIdVerifier,
    encoding::identity_bcs::payload_bcs_bytes, process_identity_with_verifier,
};
use serde::Serialize;
use sonari_tee_core::{LocalEd25519Signer, SignatureArtifact, signing_key_seed_from_env, to_hex};
use std::time::{SystemTime, UNIX_EPOCH};

const PRODUCTION_SIGNING_KEY_SEED_ENV: &str = "SONARI_TEE_SIGNING_KEY_SEED";
const PRODUCTION_SIGNING_KEY_SEED_FILE_ENV: &str = "SONARI_TEE_SIGNING_KEY_SEED_FILE";

#[derive(Debug, Parser)]
#[command(name = "membership-tee")]
#[command(about = "Membership TEE verifier CLI")]
struct Cli {
    #[arg(long)]
    encode_only: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    Fixture(FixtureArgs),
    Production,
}

#[derive(Debug, Parser)]
struct FixtureArgs {
    #[arg(long)]
    signing_key_seed: Option<String>,
    #[arg(long, default_value = "app_staging_123")]
    world_app_id: String,
    #[arg(long, value_enum, default_value = "verified")]
    world_id_status: FixtureWorldIdStatus,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
#[value(rename_all = "kebab-case")]
enum FixtureWorldIdStatus {
    Verified,
    Rejected,
    PendingSource,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    if cli.encode_only {
        if cli.command.is_some() {
            return Err("membership-tee --encode-only cannot be combined with a subcommand".into());
        }
        return encode_only();
    }

    match cli.command {
        Some(Command::Fixture(args)) => {
            let result = fixture_result(args)?;
            println!("{}", serde_json::to_string_pretty(&result)?);
            Ok(())
        }
        Some(Command::Production) => {
            let result = production_result()?;
            println!("{}", serde_json::to_string_pretty(&result)?);
            Ok(())
        }
        None => Err("membership-tee requires a subcommand or --encode-only".into()),
    }
}

fn encode_only() -> Result<(), Box<dyn std::error::Error>> {
    let mut stdin = Vec::new();
    io::stdin().read_to_end(&mut stdin)?;
    let result: IdentityTeeResult = serde_json::from_slice(&stdin)?;
    if !result.verified {
        return Err("membership-tee --encode-only requires a verified result".into());
    }
    let payload_bcs_hex = to_hex(&payload_bcs_bytes(&result)?);

    println!(
        "{}",
        serde_json::to_string(&EncodeOnlyJson { payload_bcs_hex })?
    );
    Ok(())
}

fn fixture_result(args: FixtureArgs) -> Result<TeeJsonResult, Box<dyn std::error::Error>> {
    let mut stdin = Vec::new();
    io::stdin().read_to_end(&mut stdin)?;
    let request: IdentityVerifyRequest = serde_json::from_slice(&stdin)?;
    let issued_at_ms = if request.provider == IdentityProvider::WorldId {
        request
            .issued_at_ms
            .ok_or("membership-tee fixture requires issued_at_ms")?
    } else {
        request.issued_at_ms.unwrap_or(0)
    };
    let verifier = FixtureWorldIdVerifier {
        expected_app_id: args.world_app_id,
        status: args.world_id_status,
    };
    let seed = signing_key_seed_from_env(
        args.signing_key_seed,
        "SONARI_IDENTITY_TEE_SIGNING_KEY_SEED",
        "SONARI_IDENTITY_TEE_SIGNING_KEY_SEED_FILE",
        true,
    )?;
    let signer = LocalEd25519Signer::new(seed);
    let output = process_identity_with_verifier(request, &verifier, &signer, issued_at_ms)?;

    output_to_tee_json(output)
}

fn production_result() -> Result<TeeJsonResult, Box<dyn std::error::Error>> {
    let mut stdin = Vec::new();
    io::stdin().read_to_end(&mut stdin)?;
    let request: IdentityVerifyRequest = serde_json::from_slice(&stdin)?;
    let verifier = CloudWorldIdVerifier::from_env()?;
    let seed = signing_key_seed_from_env(
        None,
        PRODUCTION_SIGNING_KEY_SEED_ENV,
        PRODUCTION_SIGNING_KEY_SEED_FILE_ENV,
        false,
    )?;
    let signer = LocalEd25519Signer::new(seed);
    let issued_at_ms = current_unix_ms()?;

    production_result_with_verifier(request, &verifier, &signer, issued_at_ms)
}

fn production_result_with_verifier(
    mut request: IdentityVerifyRequest,
    verifier: &impl WorldIdVerifier,
    signer: &LocalEd25519Signer,
    issued_at_ms: u64,
) -> Result<TeeJsonResult, Box<dyn std::error::Error>> {
    request.issued_at_ms = None;
    request.validity_ms = None;
    let output = process_identity_with_verifier(request, verifier, signer, issued_at_ms)?;

    output_to_tee_json(output)
}

fn current_unix_ms() -> Result<u64, Box<dyn std::error::Error>> {
    let duration = SystemTime::now().duration_since(UNIX_EPOCH)?;

    Ok(duration.as_millis().try_into()?)
}

#[derive(Debug)]
struct FixtureWorldIdVerifier {
    expected_app_id: String,
    status: FixtureWorldIdStatus,
}

impl WorldIdVerifier for FixtureWorldIdVerifier {
    fn expected_app_id(&self) -> &str {
        &self.expected_app_id
    }

    fn verify_world_id(&self, _proof: &WorldIdProofRequest) -> WorldIdVerificationStatus {
        match self.status {
            FixtureWorldIdStatus::Verified => WorldIdVerificationStatus::Verified,
            FixtureWorldIdStatus::Rejected => WorldIdVerificationStatus::Rejected {
                error_code: WORLD_ID_VERIFICATION_FAILED.to_owned(),
            },
            FixtureWorldIdStatus::PendingSource => WorldIdVerificationStatus::PendingSource {
                error_code: WORLD_ID_API_UNAVAILABLE.to_owned(),
            },
        }
    }
}

#[derive(Debug, Serialize)]
struct EncodeOnlyJson {
    payload_bcs_hex: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum TeeJsonResult {
    Verified {
        #[serde(flatten)]
        payload: Box<IdentityTeeResult>,
        payload_bcs_hex: String,
        signature: String,
        public_key: String,
    },
    Rejected {
        error_code: String,
    },
    PendingSource {
        error_code: String,
    },
    Unsupported {
        error_code: String,
    },
}

fn output_to_tee_json(
    output: IdentityProcessingOutput,
) -> Result<TeeJsonResult, Box<dyn std::error::Error>> {
    match output.status {
        IdentityProcessingStatus::Verified => {
            let payload = output.result.ok_or("verified output is missing payload")?;
            let payload_bcs_hex = to_hex(
                &output
                    .unsigned_bcs_payload
                    .ok_or("verified output is missing BCS payload")?,
            );
            let SignatureArtifact {
                signature,
                public_key,
                ..
            } = output
                .signature
                .ok_or("verified output is missing signature")?;
            Ok(TeeJsonResult::Verified {
                payload: Box::new(payload),
                payload_bcs_hex,
                signature,
                public_key,
            })
        }
        IdentityProcessingStatus::Rejected => Ok(TeeJsonResult::Rejected {
            error_code: output
                .error_code
                .ok_or("rejected output is missing error code")?,
        }),
        IdentityProcessingStatus::PendingSource => Ok(TeeJsonResult::PendingSource {
            error_code: output
                .error_code
                .ok_or("pending_source output is missing error code")?,
        }),
        IdentityProcessingStatus::Unsupported => Ok(TeeJsonResult::Unsupported {
            error_code: output
                .error_code
                .ok_or("unsupported output is missing error code")?,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::{PRODUCTION_SIGNING_KEY_SEED_ENV, TeeJsonResult, production_result_with_verifier};
    use membership_tee::{
        INTENT, IdentityProvider, IdentityVerifyRequest, VERIFIER_FAMILY, VERIFIER_VERSION,
        WORLD_ID_ACTION, WORLD_ID_API_UNAVAILABLE, WORLD_ID_VERIFICATION_FAILED,
        WorldIdProofRequest, WorldIdVerificationStatus, WorldIdVerifier,
    };
    use sonari_tee_core::{LocalEd25519Signer, signing_key_seed_from_env};

    const DEFAULT_IDENTITY_RESULT_TTL_MS: u64 = 31_536_000_000;

    #[test]
    fn production_verified_output_uses_tee_issued_at_ms() {
        let signer = test_signer();
        let result = production_result_with_verifier(
            world_id_request(Some(1_800_000_000_000)),
            &MockWorldIdVerifier {
                status: WorldIdVerificationStatus::Verified,
            },
            &signer,
            1_900_000_000_000,
        )
        .unwrap();

        match result {
            TeeJsonResult::Verified { payload, .. } => {
                assert_eq!(payload.intent, INTENT);
                assert_eq!(payload.verifier_family, VERIFIER_FAMILY);
                assert_eq!(payload.verifier_version, VERIFIER_VERSION);
                assert_eq!(payload.issued_at_ms, 1_900_000_000_000);
                assert_eq!(
                    payload.expires_at_ms,
                    1_900_000_000_000 + DEFAULT_IDENTITY_RESULT_TTL_MS
                );
            }
            other => panic!("expected verified output, got {other:?}"),
        }
    }

    #[test]
    fn production_verified_output_ignores_request_validity_ms() {
        let signer = test_signer();
        let mut request = world_id_request(None);
        request.validity_ms = Some(u64::MAX - 1);
        let result = production_result_with_verifier(
            request,
            &MockWorldIdVerifier {
                status: WorldIdVerificationStatus::Verified,
            },
            &signer,
            1_900_000_000_000,
        )
        .unwrap();

        match result {
            TeeJsonResult::Verified { payload, .. } => {
                assert_eq!(
                    payload.expires_at_ms,
                    1_900_000_000_000 + DEFAULT_IDENTITY_RESULT_TTL_MS
                );
            }
            other => panic!("expected verified output, got {other:?}"),
        }
    }

    #[test]
    fn production_status_only_output_maps_verifier_pending_source() {
        let signer = test_signer();
        let result = production_result_with_verifier(
            world_id_request(None),
            &MockWorldIdVerifier {
                status: WorldIdVerificationStatus::PendingSource {
                    error_code: WORLD_ID_API_UNAVAILABLE.to_owned(),
                },
            },
            &signer,
            1_900_000_000_000,
        )
        .unwrap();

        match result {
            TeeJsonResult::PendingSource { error_code } => {
                assert_eq!(error_code, WORLD_ID_API_UNAVAILABLE);
            }
            other => panic!("expected pending_source output, got {other:?}"),
        }
    }

    #[test]
    fn production_uses_issue_signing_key_env_without_dev_fallback() {
        assert_eq!(
            PRODUCTION_SIGNING_KEY_SEED_ENV,
            "SONARI_TEE_SIGNING_KEY_SEED"
        );
    }

    struct MockWorldIdVerifier {
        status: WorldIdVerificationStatus,
    }

    impl WorldIdVerifier for MockWorldIdVerifier {
        fn expected_app_id(&self) -> &str {
            "app_staging_123"
        }

        fn verify_world_id(&self, _proof: &WorldIdProofRequest) -> WorldIdVerificationStatus {
            self.status.clone()
        }
    }

    fn test_signer() -> LocalEd25519Signer {
        let seed = signing_key_seed_from_env(
            Some("0x0707070707070707070707070707070707070707070707070707070707070707".to_owned()),
            "unused",
            "unused_file",
            false,
        )
        .unwrap();
        LocalEd25519Signer::new(seed)
    }

    fn world_id_request(issued_at_ms: Option<u64>) -> IdentityVerifyRequest {
        IdentityVerifyRequest {
            registry_id: "0x1111111111111111111111111111111111111111111111111111111111111111"
                .to_owned(),
            membership_id: "0x2222222222222222222222222222222222222222222222222222222222222222"
                .to_owned(),
            owner: "0x3333333333333333333333333333333333333333333333333333333333333333".to_owned(),
            provider: IdentityProvider::WorldId,
            issued_at_ms,
            validity_ms: Some(31_536_000),
            terms_version: 1,
            signed_statement_hash:
                "0x6666666666666666666666666666666666666666666666666666666666666666".to_owned(),
            world_id: Some(WorldIdProofRequest {
                world_app_id: "app_staging_123".to_owned(),
                nullifier_hash: "12345678901234567890".to_owned(),
                merkle_root: "987654321".to_owned(),
                proof: "0xproof".to_owned(),
                verification_level: "orb".to_owned(),
                action: WORLD_ID_ACTION.to_owned(),
                signal_hash: "0x34b7cb40efe9b84ed3c26b036f2691f75c3bb1ecbfa695baf147a372aa2e3268"
                    .to_owned(),
            }),
        }
    }

    #[test]
    fn production_status_only_output_maps_verifier_rejection() {
        let signer = test_signer();
        let result = production_result_with_verifier(
            world_id_request(None),
            &MockWorldIdVerifier {
                status: WorldIdVerificationStatus::Rejected {
                    error_code: WORLD_ID_VERIFICATION_FAILED.to_owned(),
                },
            },
            &signer,
            1_900_000_000_000,
        )
        .unwrap();

        match result {
            TeeJsonResult::Rejected { error_code } => {
                assert_eq!(error_code, WORLD_ID_VERIFICATION_FAILED);
            }
            other => panic!("expected rejected output, got {other:?}"),
        }
    }
}
