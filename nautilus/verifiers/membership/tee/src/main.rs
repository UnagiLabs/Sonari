use std::io::{self, Read};
use std::time::{SystemTime, UNIX_EPOCH};

use clap::{Parser, Subcommand, ValueEnum};
use membership_tee::{
    CloudWorldIdVerifier, IdentityProcessingOutput, IdentityProcessingStatus, IdentityTeeCliResult,
    IdentityTeeResult, IdentityVerifyRequest, WORLD_ID_API_UNAVAILABLE,
    WORLD_ID_VERIFICATION_FAILED, WorldIdProofRequest, WorldIdVerificationStatus, WorldIdVerifier,
    encoding::identity_bcs::payload_bcs_bytes, process_identity_with_verifier,
};
use serde::Serialize;
use sonari_tee_core::{LocalEd25519Signer, signing_key_seed_from_env, to_hex};

const SIGNING_KEY_SEED_ENV: &str = "SONARI_TEE_SIGNING_KEY_SEED";
const SIGNING_KEY_SEED_FILE_ENV: &str = "SONARI_TEE_SIGNING_KEY_SEED_FILE";
const FIXTURE_DEFAULT_ISSUED_AT_MS: u64 = 1_800_000_000_000;

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
    Production(ProductionArgs),
}

#[derive(Debug, Parser)]
struct FixtureArgs {
    #[arg(long, value_enum, default_value_t = FixtureWorldIdStatus::Verified)]
    world_id_status: FixtureWorldIdStatus,
    #[arg(long)]
    signing_key_seed: Option<String>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum FixtureWorldIdStatus {
    Verified,
    Rejected,
    PendingSource,
}

#[derive(Debug, Parser)]
struct ProductionArgs {}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    if cli.encode_only {
        let result = encode_only_result()?;
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }

    let command = cli.command.ok_or_else(|| {
        membership_tee::IdentityError::Request(
            "subcommand is required unless --encode-only is set".to_owned(),
        )
    })?;
    let result = match command {
        Command::Fixture(args) => fixture_result(args)?,
        Command::Production(args) => production_result(args)?,
    };
    println!("{}", serde_json::to_string(&result)?);

    Ok(())
}

#[derive(Debug, Serialize)]
struct EncodeOnlyResult {
    payload_bcs_hex: String,
}

fn encode_only_result() -> Result<EncodeOnlyResult, Box<dyn std::error::Error>> {
    let mut stdin = String::new();
    io::stdin().read_to_string(&mut stdin)?;
    let result: IdentityTeeResult = serde_json::from_str(&stdin)?;
    if !result.verified {
        return Err(membership_tee::IdentityError::Request(
            "--encode-only requires a verified identity payload".to_owned(),
        )
        .into());
    }

    Ok(EncodeOnlyResult {
        payload_bcs_hex: to_hex(&payload_bcs_bytes(&result)?),
    })
}

fn fixture_result(args: FixtureArgs) -> Result<IdentityTeeCliResult, Box<dyn std::error::Error>> {
    let request = read_stdin_request()?;
    let issued_at_ms = request.issued_at_ms.unwrap_or(FIXTURE_DEFAULT_ISSUED_AT_MS);
    let expected_app_id = request
        .world_id
        .as_ref()
        .map(|proof| proof.world_app_id.clone())
        .unwrap_or_else(|| "app_staging_123".to_owned());
    let verifier = FixtureWorldIdVerifier {
        expected_app_id,
        status: args.world_id_status,
    };
    let seed = signing_key_seed_from_env(
        args.signing_key_seed,
        SIGNING_KEY_SEED_ENV,
        SIGNING_KEY_SEED_FILE_ENV,
        true,
    )?;
    let signer = LocalEd25519Signer::new(seed);
    let output = process_identity_with_verifier(request, &verifier, &signer, issued_at_ms)?;

    output_to_cli_result(output).map_err(Into::into)
}

fn production_result(
    _args: ProductionArgs,
) -> Result<IdentityTeeCliResult, Box<dyn std::error::Error>> {
    let mut request = read_stdin_request()?;
    request.issued_at_ms = None;
    request.validity_ms = None;
    let seed =
        signing_key_seed_from_env(None, SIGNING_KEY_SEED_ENV, SIGNING_KEY_SEED_FILE_ENV, false)?;
    let verifier = CloudWorldIdVerifier::from_env()?;
    let signer = LocalEd25519Signer::new(seed);
    let output =
        process_identity_with_verifier(request, &verifier, &signer, current_unix_time_ms()?)?;

    output_to_cli_result(output).map_err(Into::into)
}

fn read_stdin_request() -> Result<IdentityVerifyRequest, Box<dyn std::error::Error>> {
    let mut stdin = String::new();
    io::stdin().read_to_string(&mut stdin)?;
    Ok(serde_json::from_str(&stdin)?)
}

fn output_to_cli_result(
    output: IdentityProcessingOutput,
) -> Result<IdentityTeeCliResult, membership_tee::IdentityError> {
    match output.status {
        IdentityProcessingStatus::Verified => {
            let result = output.result.ok_or_else(|| {
                membership_tee::IdentityError::Request(
                    "verified output is missing payload result".to_owned(),
                )
            })?;
            let payload = output.unsigned_bcs_payload.ok_or_else(|| {
                membership_tee::IdentityError::Request(
                    "verified output is missing BCS payload".to_owned(),
                )
            })?;
            let signature = output.signature.ok_or_else(|| {
                membership_tee::IdentityError::Request(
                    "verified output is missing signature".to_owned(),
                )
            })?;
            Ok(IdentityTeeCliResult::Verified {
                payload_bcs_hex: to_hex(&payload),
                signature: signature.signature,
                public_key: signature.public_key,
                duplicate_key_hash: result.duplicate_key_hash,
                expires_at_ms: result.expires_at_ms,
            })
        }
        IdentityProcessingStatus::Rejected => Ok(IdentityTeeCliResult::Rejected {
            error_code: required_error_code(output.error_code, "rejected")?,
        }),
        IdentityProcessingStatus::PendingSource => Ok(IdentityTeeCliResult::PendingSource {
            error_code: required_error_code(output.error_code, "pending_source")?,
        }),
        IdentityProcessingStatus::Unsupported => Ok(IdentityTeeCliResult::Unsupported {
            error_code: required_error_code(output.error_code, "unsupported")?,
        }),
    }
}

fn required_error_code(
    error_code: Option<String>,
    status: &str,
) -> Result<String, membership_tee::IdentityError> {
    error_code.ok_or_else(|| {
        membership_tee::IdentityError::Request(format!("{status} output is missing error_code"))
    })
}

fn current_unix_time_ms() -> Result<u64, Box<dyn std::error::Error>> {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH)?;
    Ok(elapsed
        .as_secs()
        .checked_mul(1_000)
        .and_then(|millis| millis.checked_add(u64::from(elapsed.subsec_millis())))
        .ok_or("current time is outside u64 millisecond range")?)
}

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
