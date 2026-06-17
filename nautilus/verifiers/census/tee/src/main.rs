use std::io::{self, Read};
use std::thread;

use census_tee::encoding::census_bcs::payload_bcs_bytes;
use census_tee::server::{
    CensusProcessHandler, census_result_json, finalize_process_output, parse_process_data_envelope,
};
use census_tee::{
    ATTESTATION_PUBLIC_KEY_LABEL, CensusInputBundle, TRUSTED_VALIDATOR_COMMITTEE_DIGEST_ENV,
    process_floor_census_bundle_with_trust,
};
use clap::{Parser, Subcommand};
use serde::Deserialize;
use sonari_tee_core::{
    HttpRequest, LocalEd25519Signer, PayloadSigner, ProcessDataHandler, TeeContext, VsockListener,
    enclave_attestation_response, error_response, generate_ephemeral_signing_key_seed,
    handle_connection, health_check_response, signing_key_seed_from_env,
};

#[derive(Debug, Parser)]
#[command(name = "census-tee")]
#[command(about = "Census TEE verifier CLI")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Fixture(FixtureArgs),
    Server(ServerArgs),
}

#[derive(Debug, Parser)]
struct FixtureArgs {
    #[arg(long)]
    signing_key_seed: Option<String>,
}

#[derive(Debug, Parser)]
struct ServerArgs {
    #[arg(long, default_value_t = 3000)]
    port: u32,
    #[arg(long, default_value_t = 7777)]
    bootstrap_port: u32,
    #[arg(long)]
    skip_bootstrap: bool,
}

#[derive(Clone)]
struct EnclaveState {
    signing_key_seed: [u8; 32],
    ctx: TeeContext,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    match cli.command {
        Command::Fixture(args) => {
            let result = fixture_result(args)?;
            println!("{}", serde_json::to_string_pretty(&result)?);
            Ok(())
        }
        Command::Server(args) => run_nautilus_server(args),
    }
}

fn fixture_result(args: FixtureArgs) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let mut stdin = Vec::new();
    io::stdin().read_to_end(&mut stdin)?;
    let bundle: CensusInputBundle = serde_json::from_slice(&stdin)?;
    let trusted_validator_committee_digest = std::env::var(TRUSTED_VALIDATOR_COMMITTEE_DIGEST_ENV)?;
    let payload =
        process_floor_census_bundle_with_trust(&bundle, &trusted_validator_committee_digest)?;
    let payload_bcs = payload_bcs_bytes(&payload)?;
    let seed = signing_key_seed_from_env(
        args.signing_key_seed,
        "SONARI_CENSUS_TEE_SIGNING_KEY_SEED",
        "SONARI_CENSUS_TEE_SIGNING_KEY_SEED_FILE",
        true,
    )?;
    let signer = LocalEd25519Signer::new(seed);
    let signature = signer.sign_payload(&payload_bcs);

    Ok(census_result_json(
        &payload,
        &payload_bcs,
        &signature.signature,
        &signature.public_key,
    ))
}

fn run_nautilus_server(args: ServerArgs) -> Result<(), Box<dyn std::error::Error>> {
    let signing_key_seed = generate_ephemeral_signing_key_seed()?;
    if !args.skip_bootstrap {
        receive_bootstrap_config(args.bootstrap_port)?;
    }
    let state = EnclaveState {
        signing_key_seed,
        ctx: census_tee_context()?,
    };
    let listener = VsockListener::bind(args.port)?;
    eprintln!(
        "sonari census nautilus server listening on vsock port {}",
        args.port
    );
    loop {
        let stream = listener.accept()?;
        let state = state.clone();
        thread::spawn(move || {
            if let Err(error) = handle_connection(stream, |request| route_request(request, &state))
            {
                eprintln!("sonari census nautilus request failed: {error}");
            }
        });
    }
}

fn census_tee_context() -> Result<TeeContext, Box<dyn std::error::Error>> {
    Ok(TeeContext::with_env([(
        TRUSTED_VALIDATOR_COMMITTEE_DIGEST_ENV,
        std::env::var(TRUSTED_VALIDATOR_COMMITTEE_DIGEST_ENV)?,
    )]))
}

fn route_request(
    request: HttpRequest,
    state: &EnclaveState,
) -> Result<(u16, serde_json::Value), Box<dyn std::error::Error>> {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/health_check") => Ok((200, health_check_response())),
        ("GET", "/get_attestation") => {
            let signer = LocalEd25519Signer::new(state.signing_key_seed);
            Ok((
                200,
                enclave_attestation_response(&signer, ATTESTATION_PUBLIC_KEY_LABEL)?,
            ))
        }
        ("POST", "/process_data") => {
            let envelope = parse_process_data_envelope(&request.body)?;
            let handler = CensusProcessHandler;
            let output = handler
                .process(&serde_json::to_vec(&envelope.payload)?, &state.ctx)
                .map_err(|error| -> Box<dyn std::error::Error> { error.to_string().into() })?;
            let signer = LocalEd25519Signer::new(state.signing_key_seed);
            Ok((
                200,
                finalize_process_output(output, &signer, Some(envelope.registration_metadata))?,
            ))
        }
        _ => Ok((
            404,
            error_response("AWS_RUNNER_PROCESS_FAILED", "not found"),
        )),
    }
}

fn receive_bootstrap_config(port: u32) -> Result<(), Box<dyn std::error::Error>> {
    let listener = VsockListener::bind(port)?;
    eprintln!("waiting for sonari census bootstrap config on vsock port {port}");
    let mut stream = listener.accept()?;
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes)?;
    let config: BootstrapConfig = serde_json::from_slice(&bytes)?;
    set_env_before_server(
        TRUSTED_VALIDATOR_COMMITTEE_DIGEST_ENV,
        &config.trusted_validator_committee_digest,
    );
    Ok(())
}

#[derive(Debug, Deserialize)]
struct BootstrapConfig {
    #[serde(rename = "d")]
    trusted_validator_committee_digest: String,
}

fn set_env_before_server(name: &str, value: &str) {
    // The server is not accepting requests yet, so no other Rust thread is reading
    // the process environment when bootstrap values are installed.
    unsafe {
        std::env::set_var(name, value);
    }
}
