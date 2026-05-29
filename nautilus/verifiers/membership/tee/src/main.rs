use std::io::{self, Read};

use clap::{Parser, Subcommand};
use membership_tee::{
    IdentityProcessingOutput, IdentityProcessingStatus, IdentityTeeResult, IdentityVerifyRequest,
    WorldIdProofRequest, WorldIdVerificationStatus, WorldIdVerifier,
    process_identity_with_verifier,
};
use serde::Serialize;
use sonari_tee_core::{LocalEd25519Signer, SignatureArtifact, signing_key_seed_from_env, to_hex};

#[derive(Debug, Parser)]
#[command(name = "membership-tee")]
#[command(about = "Membership TEE verifier CLI")]
struct Cli {
    #[command(subcommand)]
    command: Command,
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
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    match cli.command {
        Command::Fixture(args) => {
            let result = fixture_result(args)?;
            println!("{}", serde_json::to_string_pretty(&result)?);
            Ok(())
        }
        Command::Production => unsupported("production"),
    }
}

fn fixture_result(args: FixtureArgs) -> Result<TeeJsonResult, Box<dyn std::error::Error>> {
    let mut stdin = Vec::new();
    io::stdin().read_to_end(&mut stdin)?;
    let request: IdentityVerifyRequest = serde_json::from_slice(&stdin)?;
    let issued_at_ms = request
        .issued_at_ms
        .ok_or("membership-tee fixture requires issued_at_ms")?;
    let proof = request
        .world_id
        .as_ref()
        .ok_or("membership-tee fixture requires world_id")?;
    let verifier = FixtureWorldIdVerifier {
        expected_app_id: proof.world_app_id.clone(),
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

#[derive(Debug)]
struct FixtureWorldIdVerifier {
    expected_app_id: String,
}

impl WorldIdVerifier for FixtureWorldIdVerifier {
    fn expected_app_id(&self) -> &str {
        &self.expected_app_id
    }

    fn verify_world_id(&self, _proof: &WorldIdProofRequest) -> WorldIdVerificationStatus {
        WorldIdVerificationStatus::Verified
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum TeeJsonResult {
    Verified {
        payload: IdentityTeeResult,
        payload_bcs_hex: String,
        signature: String,
        public_key: String,
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
                payload,
                payload_bcs_hex,
                signature,
                public_key,
            })
        }
        _ => Err("membership-tee fixture currently only supports verified output".into()),
    }
}

fn unsupported(command: &str) -> Result<(), Box<dyn std::error::Error>> {
    Err(format!("membership-tee {command} is not implemented yet").into())
}
