use clap::{Parser, Subcommand};
use serde::Deserialize;
use sonari_tee_core::enclave::{
    EnclaveRegistrationMetadata, HttpRequest, ProcessDataHandler, ProcessOutput, TeeContext,
    VsockListener, enclave_attestation_response, error_response,
    generate_ephemeral_signing_key_seed, handle_connection, health_check_response,
};
use sonari_tee_core::registry::{
    EARTHQUAKE_ATTESTATION_PUBLIC_KEY_LABEL, EARTHQUAKE_VERIFIER_CONFIG_KEY,
};
use sonari_tee_core::{
    DEV_SIGNING_KEY_SEED_HEX, LocalEd25519Signer, PayloadSigner, parse_seed,
    signing_key_seed_from_env,
};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::thread;
use tee::server::{EGRESS_PROXY_URL_KEY, EarthquakeProcessHandler};
use tee::{
    DEFAULT_WALRUS_CLI_TIMEOUT_MS, OracleOutput, ResidenceTileConfig, UsgsOracleInput,
    WalrusCliSourceArchive, WalrusCliSourceArchiveConfig, canonical_json_bytes,
    grid_xml_from_artifact, parse_command_timeout_ms, parse_n_shards, process_usgs_with_signer,
    process_usgs_with_source_archive,
};

/// Byte string the enclave signs to derive its embedded attestation public key.
///
/// Sourced from the shared verifier registry so the label has a single
/// definition (see `sonari_tee_core::registry`); the registry's uniqueness
/// tests guarantee it does not collide with another verifier's label.
const ATTESTATION_PUBLIC_KEY_LABEL: &[u8] = EARTHQUAKE_ATTESTATION_PUBLIC_KEY_LABEL;

#[derive(Debug, Parser)]
#[command(about = "Generate deterministic Sonari USGS oracle artifacts")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    #[arg(long)]
    case_id: Option<String>,
    #[arg(long)]
    detail: Option<PathBuf>,
    #[arg(long)]
    grid: Option<PathBuf>,
    #[arg(long)]
    raw_detail_uri: Option<String>,
    #[arg(long)]
    raw_grid_uri: Option<String>,
    #[arg(long)]
    raw_data_uri: Option<String>,
    #[arg(long)]
    affected_cells_uri: Option<String>,
    #[arg(long)]
    signing_key_seed: Option<String>,
    #[arg(long)]
    output_dir: Option<PathBuf>,
    #[arg(long)]
    walrus_archive: bool,
    #[arg(long)]
    walrus_cli: Option<PathBuf>,
    #[arg(long)]
    walrus_n_shards: Option<u32>,
    #[arg(long)]
    walrus_timeout_ms: Option<u64>,
}

#[derive(Debug, Subcommand)]
enum Command {
    Fixture(FixtureArgs),
    Production(ProductionArgs),
    Server(ServerArgs),
}

#[derive(Debug, Parser)]
struct FixtureArgs {
    #[arg(long)]
    case: String,
    #[arg(long)]
    fixtures_dir: PathBuf,
    #[arg(long)]
    sign_dev: bool,
    #[arg(long)]
    signing_key_seed: Option<String>,
    #[arg(long)]
    write_expected: bool,
}

#[derive(Debug, Parser)]
struct ProductionArgs {
    #[arg(long)]
    input: Option<PathBuf>,
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

struct RunConfig {
    input: UsgsOracleInput,
    output_dir: Option<PathBuf>,
    signing_key_seed: [u8; 32],
    walrus_archive: Option<WalrusCliSourceArchiveConfig>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let run = match cli.command {
        Some(Command::Fixture(args)) => fixture_input(args)?,
        Some(Command::Production(args)) => {
            let result = production_result(args)?;
            println!("{}", serde_json::to_string_pretty(&result)?);
            return Ok(());
        }
        Some(Command::Server(args)) => {
            run_nautilus_server(args)?;
            return Ok(());
        }
        None => low_level_input(cli)?,
    };
    let signer = LocalEd25519Signer::new(run.signing_key_seed);
    let output = if let Some(config) = run.walrus_archive {
        let archive = WalrusCliSourceArchive::new(config)?;
        process_usgs_with_source_archive(run.input, &archive, &signer)?
    } else {
        process_usgs_with_signer(run.input, &signer)?
    };

    if let Some(output_dir) = run.output_dir {
        write_output(&output_dir, &output)?;
    } else {
        println!("{}", serde_json::to_string_pretty(&output.result)?);
    }

    Ok(())
}

fn production_result(
    args: ProductionArgs,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let request_json: serde_json::Value =
        serde_json::from_slice(&production_request_bytes(args.input)?)?;
    if request_json.get("action").is_some() {
        return production_action_result(request_json, args.signing_key_seed);
    }
    let seed = strict_signing_key_seed(args.signing_key_seed)?;
    // Validate the raw worker request shape before any network fetch so callers
    // get the same early errors as before delegating to the handler.
    let _ = tee::WorkerToTeeRequest::from_json_value(request_json.clone())?;
    let handler = earthquake_handler_from_env();
    let output = handler
        .process(&serde_json::to_vec(&request_json)?, &tee_context_from_env())
        .map_err(|error| -> Box<dyn std::error::Error> { error.to_string().into() })?;
    let signer = LocalEd25519Signer::new(seed);
    finalize_process_output(output, &signer, None)
}

#[derive(Clone)]
struct EnclaveState {
    signing_key_seed: [u8; 32],
    ctx: TeeContext,
    archive_config: Option<WalrusCliSourceArchiveConfig>,
    residence_tile_config: Option<ResidenceTileConfig>,
}

fn run_nautilus_server(args: ServerArgs) -> Result<(), Box<dyn std::error::Error>> {
    let signing_key_seed = generate_ephemeral_signing_key_seed()?;
    if !args.skip_bootstrap {
        receive_bootstrap_config(args.bootstrap_port)?;
    }
    // Resolve env-derived configuration once at startup (orchestration layer)
    // so per-request handlers never read the process environment.
    let state = EnclaveState {
        signing_key_seed,
        ctx: tee_context_from_env(),
        archive_config: WalrusCliSourceArchiveConfig::from_env().ok(),
        residence_tile_config: ResidenceTileConfig::from_env().ok(),
    };
    let listener = VsockListener::bind(args.port)?;
    eprintln!(
        "sonari earthquake nautilus server listening on vsock port {}",
        args.port
    );
    loop {
        let stream = listener.accept()?;
        let state = state.clone();
        thread::spawn(move || {
            if let Err(error) = handle_connection(stream, |request| route_request(request, &state))
            {
                eprintln!("sonari earthquake nautilus request failed: {error}");
            }
        });
    }
}

/// Builds the dependency-injection context from the bootstrap-populated env.
///
/// The handler resolves the egress proxy through this context instead of
/// reading the process environment directly.
fn tee_context_from_env() -> TeeContext {
    match non_empty_env(EGRESS_PROXY_URL_KEY) {
        Some(proxy) => TeeContext::with_env([(EGRESS_PROXY_URL_KEY, proxy)]),
        None => TeeContext::new(),
    }
}

/// Builds an earthquake handler with the Walrus archive configuration resolved
/// from the bootstrap-populated environment in this orchestration layer.
///
/// Reading the environment here (rather than inside the handler's `process`
/// path) keeps env access confined to bootstrap/orchestration. The config is
/// only required to finalize a request; if it cannot be resolved (e.g. the
/// shard count is absent on a non-finalized path) the handler is built without
/// it and fails closed only when a finalized result actually needs to archive.
fn earthquake_handler_from_env() -> EarthquakeProcessHandler {
    match (
        WalrusCliSourceArchiveConfig::from_env(),
        ResidenceTileConfig::from_env(),
    ) {
        (Ok(archive_config), Ok(residence_tile_config)) => {
            EarthquakeProcessHandler::with_runtime_configs(archive_config, residence_tile_config)
        }
        (Ok(config), Err(_)) => EarthquakeProcessHandler::with_archive_config(config),
        _ => EarthquakeProcessHandler::new(),
    }
}

/// Routes a single enclave request, owning signing, attestation, and
/// registration-metadata injection so the handler stays domain-only.
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
            let handler = match (
                state.archive_config.clone(),
                state.residence_tile_config.clone(),
            ) {
                (Some(archive_config), Some(residence_tile_config)) => {
                    EarthquakeProcessHandler::with_runtime_configs(
                        archive_config,
                        residence_tile_config,
                    )
                }
                (Some(config), None) => EarthquakeProcessHandler::with_archive_config(config),
                _ => EarthquakeProcessHandler::new(),
            };
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

/// Action tag the worker sets on the `/process_data` request body.
const PROCESS_DATA_ACTION: &str = "process_data";

/// Worker-supplied `process_data` request envelope.
///
/// The outer body wire shape is `{action, payload, registration_metadata}`
/// (see `scripts/aws/shared.ts::buildEarthquakeWrapperInput`). `deny_unknown_fields`
/// rejects any extra field and a missing `action` is rejected by serde, so the
/// route fails closed on malformed envelopes instead of silently dropping
/// unexpected input.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProcessDataEnvelope {
    action: String,
    payload: serde_json::Value,
    registration_metadata: EnclaveRegistrationMetadata,
}

/// Parses and validates the `/process_data` request body, rejecting unknown
/// fields, any `action` other than [`PROCESS_DATA_ACTION`], and any registration
/// metadata whose `verifier_config_key` is not the earthquake family key
/// (fail-closed). Mirrors the identity verifier's family check so a worker-supplied
/// foreign config_key can never be injected into a signed earthquake output.
fn parse_process_data_envelope(
    body: &[u8],
) -> Result<ProcessDataEnvelope, Box<dyn std::error::Error>> {
    let envelope: ProcessDataEnvelope = serde_json::from_slice(body)?;
    if envelope.action != PROCESS_DATA_ACTION {
        return Err(format!(
            "unexpected /process_data action `{}`; expected `{PROCESS_DATA_ACTION}`",
            envelope.action
        )
        .into());
    }
    verify_earthquake_config_key(&envelope.registration_metadata)?;
    Ok(envelope)
}

/// Fails closed unless the registration metadata's `verifier_config_key` is the
/// earthquake family key, so the orchestration layer never signs a result whose
/// injected config_key belongs to another verifier family.
fn verify_earthquake_config_key(
    metadata: &EnclaveRegistrationMetadata,
) -> Result<(), Box<dyn std::error::Error>> {
    let config_key = metadata.verifier_config_key;
    if config_key != EARTHQUAKE_VERIFIER_CONFIG_KEY {
        return Err(format!(
            "registration metadata verifier_config_key {config_key} does not match the earthquake \
             family key {EARTHQUAKE_VERIFIER_CONFIG_KEY}"
        )
        .into());
    }
    Ok(())
}

/// Server-owned finalization: signs a [`ProcessOutput::Signable`] payload and
/// injects the registration metadata into the result envelope, preserving byte
/// order. [`ProcessOutput::Unsigned`] envelopes are returned verbatim.
///
/// The handler emits the [`ProcessOutput::Signable`] variant for finalized
/// results with empty `signature` / `public_key` placeholders; overwriting those
/// existing keys keeps their canonical position because `serde_json` preserves
/// key order. Registration metadata is appended last, matching the historical
/// flattened layout. A finalized result that lacks a non-empty signable payload
/// is rejected upstream in `process_output_from_oracle`, so a signable result
/// always carries signing bytes here (fail-closed).
fn finalize_process_output<S: PayloadSigner>(
    output: ProcessOutput,
    signer: &S,
    registration_metadata: Option<EnclaveRegistrationMetadata>,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    match output {
        ProcessOutput::Unsigned { result_json } => Ok(result_json),
        ProcessOutput::Signable {
            payload_bcs,
            mut result_json,
        } => {
            if payload_bcs.is_empty() {
                return Err(
                    "signable process output must carry non-empty BCS payload to sign".into(),
                );
            }
            let object = result_json
                .as_object_mut()
                .ok_or("signable process output result must be a JSON object")?;
            let signature = signer.sign_payload(&payload_bcs);
            object.insert(
                "signature".to_owned(),
                serde_json::Value::String(signature.signature),
            );
            object.insert(
                "public_key".to_owned(),
                serde_json::Value::String(signature.public_key),
            );
            if let Some(metadata) = registration_metadata {
                inject_registration_metadata(object, &metadata);
            }
            Ok(result_json)
        }
    }
}

fn inject_registration_metadata(
    object: &mut serde_json::Map<String, serde_json::Value>,
    metadata: &EnclaveRegistrationMetadata,
) {
    object.insert(
        "verifier_config_key".to_owned(),
        serde_json::Value::from(metadata.verifier_config_key),
    );
    object.insert(
        "verifier_config_version".to_owned(),
        serde_json::Value::from(metadata.verifier_config_version),
    );
    object.insert(
        "enclave_instance_public_key".to_owned(),
        serde_json::Value::String(metadata.enclave_instance_public_key.clone()),
    );
}

fn receive_bootstrap_config(port: u32) -> Result<(), Box<dyn std::error::Error>> {
    let listener = VsockListener::bind(port)?;
    eprintln!("waiting for sonari earthquake bootstrap config on vsock port {port}");
    let mut stream = listener.accept()?;
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes)?;
    let config: BootstrapConfig = serde_json::from_slice(&bytes)?;
    set_env_before_server("SONARI_WALRUS_CLI", &config.walrus_cli);
    set_env_before_server(
        "SONARI_WALRUS_N_SHARDS",
        &config.walrus_n_shards.to_string(),
    );
    set_env_before_server(
        "SONARI_EARTHQUAKE_EGRESS_PROXY_URL",
        &config.egress_proxy_url,
    );
    set_env_before_server(
        "SONARI_RESIDENCE_R2_BASE_URL",
        &config.residence_r2_base_url,
    );
    set_env_before_server(
        "SONARI_RESIDENCE_TILE_MANIFEST_KEY",
        &config.residence_tile_manifest_key,
    );
    set_env_before_server(
        "SONARI_RESIDENCE_TILE_MANIFEST_SHA256",
        &config.residence_tile_manifest_sha256,
    );
    set_env_before_server(
        "SONARI_RESIDENCE_R2_OBJECT_PREFIX",
        &config.residence_r2_object_prefix,
    );
    set_env_before_server("SONARI_RESIDENCE_R2_BUCKET", &config.residence_r2_bucket);
    set_env_before_server(
        "SONARI_RESIDENCE_ALLOWLIST_VERSION",
        &config.residence_allowlist_version,
    );
    set_env_before_server("SONARI_GEO_RESOLUTION", &config.geo_resolution);
    set_env_before_server("SONARI_RESIDENCE_ROOT", &config.residence_root);
    if let Some(source_hash) = config
        .residence_source_hash
        .as_ref()
        .filter(|value| !value.is_empty())
    {
        set_env_before_server("SONARI_RESIDENCE_SOURCE_HASH", source_hash);
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct BootstrapConfig {
    #[serde(rename = "w", alias = "walrus_cli")]
    walrus_cli: String,
    #[serde(rename = "n", alias = "walrus_n_shards")]
    walrus_n_shards: u32,
    #[serde(rename = "p", alias = "egress_proxy_url")]
    egress_proxy_url: String,
    #[serde(rename = "b", alias = "SONARI_RESIDENCE_R2_BASE_URL")]
    residence_r2_base_url: String,
    #[serde(rename = "m", alias = "SONARI_RESIDENCE_TILE_MANIFEST_KEY")]
    residence_tile_manifest_key: String,
    #[serde(rename = "s", alias = "SONARI_RESIDENCE_TILE_MANIFEST_SHA256")]
    residence_tile_manifest_sha256: String,
    #[serde(rename = "o", alias = "SONARI_RESIDENCE_R2_OBJECT_PREFIX")]
    residence_r2_object_prefix: String,
    #[serde(rename = "k", alias = "SONARI_RESIDENCE_R2_BUCKET")]
    residence_r2_bucket: String,
    #[serde(rename = "v", alias = "SONARI_RESIDENCE_ALLOWLIST_VERSION")]
    residence_allowlist_version: String,
    #[serde(rename = "g", alias = "SONARI_GEO_RESOLUTION")]
    geo_resolution: String,
    #[serde(rename = "r", alias = "SONARI_RESIDENCE_ROOT")]
    residence_root: String,
    #[serde(rename = "h", alias = "SONARI_RESIDENCE_SOURCE_HASH")]
    residence_source_hash: Option<String>,
}

fn set_env_before_server(name: &str, value: &str) {
    // The server is not accepting requests yet, so no other Rust thread is reading
    // the process environment when bootstrap values are installed.
    unsafe {
        env::set_var(name, value);
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum ProductionAction {
    HealthCheck,
    GetAttestation,
    ProcessData {
        payload: serde_json::Value,
        registration_metadata: EnclaveRegistrationMetadata,
    },
}

fn production_action_result(
    request_json: serde_json::Value,
    signing_key_seed: Option<String>,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    match serde_json::from_value::<ProductionAction>(request_json)? {
        ProductionAction::HealthCheck => Ok(serde_json::json!({
            "status": "healthy",
            "external_sources_reachable": true,
        })),
        ProductionAction::GetAttestation => {
            let seed = strict_signing_key_seed(signing_key_seed)?;
            let document = non_empty_env("SONARI_TEE_ATTESTATION_DOCUMENT_HEX")
                .ok_or("SONARI_TEE_ATTESTATION_DOCUMENT_HEX is required for get_attestation")?;
            let signer = LocalEd25519Signer::new(seed);
            let signature = signer.sign_payload(ATTESTATION_PUBLIC_KEY_LABEL);
            let public_key =
                non_empty_env("SONARI_TEE_ATTESTATION_PUBLIC_KEY").unwrap_or(signature.public_key);
            Ok(serde_json::json!({
                "attestation_document_hex": document,
                "public_key": public_key,
            }))
        }
        ProductionAction::ProcessData {
            payload,
            registration_metadata,
        } => {
            verify_earthquake_config_key(&registration_metadata)?;
            let seed = strict_signing_key_seed(signing_key_seed)?;
            let handler = earthquake_handler_from_env();
            let output = handler
                .process(&serde_json::to_vec(&payload)?, &tee_context_from_env())
                .map_err(|error| -> Box<dyn std::error::Error> { error.to_string().into() })?;
            let signer = LocalEd25519Signer::new(seed);
            finalize_process_output(output, &signer, Some(registration_metadata))
        }
    }
}

fn production_request_bytes(input: Option<PathBuf>) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    if let Some(path) = input {
        return Ok(fs::read(path)?);
    }

    let mut bytes = Vec::new();
    io::stdin().read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn strict_signing_key_seed(
    explicit_seed: Option<String>,
) -> Result<[u8; 32], Box<dyn std::error::Error>> {
    Ok(signing_key_seed_from_env(
        explicit_seed,
        "SONARI_TEE_SIGNING_KEY_SEED",
        "SONARI_TEE_SIGNING_KEY_SEED_FILE",
        false,
    )?)
}

fn low_level_input(cli: Cli) -> Result<RunConfig, Box<dyn std::error::Error>> {
    let walrus_archive = walrus_archive_config(&cli)?;
    let signing_key_seed = signing_key_seed(false, cli.signing_key_seed)?;
    let detail_path = required(cli.detail, "--detail")?;
    let detail_json = fs::read(detail_path)?;
    let observed_at_ms = detail_updated_at_ms(&detail_json)?;
    let grid = grid_input(cli.grid, cli.raw_grid_uri)?;
    Ok(RunConfig {
        input: UsgsOracleInput {
            case_id: required(cli.case_id, "--case-id")?,
            detail_json,
            grid_xml: grid.grid_xml,
            raw_grid_bytes: grid.raw_grid_bytes,
            observed_at_ms,
            raw_detail_uri: required(cli.raw_detail_uri, "--raw-detail-uri")?,
            raw_grid_uri: grid.raw_grid_uri,
        },
        output_dir: cli.output_dir,
        signing_key_seed,
        walrus_archive,
    })
}

fn fixture_input(args: FixtureArgs) -> Result<RunConfig, Box<dyn std::error::Error>> {
    let case_dir = args.fixtures_dir.join(&args.case);
    let input_dir = case_dir.join("input");
    let detail_path = input_dir.join("usgs_detail.json");
    let detail_json = fs::read(&detail_path)?;
    let observed_at_ms = detail_updated_at_ms(&detail_json)?;
    let grid_path = input_dir.join("usgs_grid.xml");
    let output_dir = args.write_expected.then(|| case_dir.join("expected"));
    let signing_key_seed = signing_key_seed(args.sign_dev, args.signing_key_seed)?;
    let grid = if grid_path.exists() {
        grid_input(Some(grid_path), None)?
    } else {
        GridInput::default()
    };

    Ok(RunConfig {
        input: UsgsOracleInput {
            case_id: args.case,
            detail_json,
            grid_xml: grid.grid_xml,
            raw_grid_bytes: grid.raw_grid_bytes,
            observed_at_ms,
            raw_detail_uri: display_path(&detail_path),
            raw_grid_uri: grid.raw_grid_uri,
        },
        output_dir,
        signing_key_seed,
        walrus_archive: None,
    })
}

fn detail_updated_at_ms(detail_json: &[u8]) -> Result<u64, Box<dyn std::error::Error>> {
    let detail: serde_json::Value = serde_json::from_slice(detail_json)?;
    detail
        .get("properties")
        .and_then(|properties| properties.get("updated"))
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "USGS detail properties.updated must be an integer".into())
}

#[derive(Debug, Default)]
struct GridInput {
    grid_xml: Option<Vec<u8>>,
    raw_grid_bytes: Option<Vec<u8>>,
    raw_grid_uri: Option<String>,
}

fn grid_input(
    grid_path: Option<PathBuf>,
    raw_grid_uri: Option<String>,
) -> Result<GridInput, Box<dyn std::error::Error>> {
    let Some(grid_path) = grid_path else {
        return Ok(GridInput::default());
    };

    let raw_grid_uri = raw_grid_uri.unwrap_or_else(|| display_path(&grid_path));
    let grid_bytes = fs::read(&grid_path)?;
    let grid_xml = grid_xml_from_artifact(&raw_grid_uri, &grid_bytes)?;
    Ok(GridInput {
        grid_xml: Some(grid_xml),
        raw_grid_bytes: Some(grid_bytes),
        raw_grid_uri: Some(raw_grid_uri),
    })
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().trim_start_matches("./").to_owned()
}

fn required<T>(value: Option<T>, name: &str) -> Result<T, Box<dyn std::error::Error>> {
    value.ok_or_else(|| format!("{name} is required unless a subcommand is used").into())
}

fn walrus_archive_config(
    cli: &Cli,
) -> Result<Option<WalrusCliSourceArchiveConfig>, Box<dyn std::error::Error>> {
    if !cli.walrus_archive {
        return Ok(None);
    }

    let n_shards = match cli
        .walrus_n_shards
        .map(Ok)
        .or_else(|| non_empty_env("SONARI_WALRUS_N_SHARDS").map(|value| parse_n_shards(&value)))
    {
        Some(n_shards) => n_shards?,
        None => {
            return Err("SONARI_WALRUS_N_SHARDS is required when --walrus-archive is used".into());
        }
    };
    let command_timeout_ms = if let Some(timeout_ms) = cli.walrus_timeout_ms {
        parse_command_timeout_ms(&timeout_ms.to_string())?
    } else {
        match env::var("SONARI_WALRUS_CLI_TIMEOUT_MS") {
            Ok(value) => parse_command_timeout_ms(&value)?,
            Err(env::VarError::NotPresent) => DEFAULT_WALRUS_CLI_TIMEOUT_MS,
            Err(error) => {
                return Err(format!("invalid SONARI_WALRUS_CLI_TIMEOUT_MS: {error}").into());
            }
        }
    };

    Ok(Some(WalrusCliSourceArchiveConfig {
        cli_path: cli
            .walrus_cli
            .clone()
            .or_else(|| env::var_os("SONARI_WALRUS_CLI").map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("walrus")),
        n_shards,
        command_timeout_ms,
        egress_proxy_url: non_empty_env("SONARI_EARTHQUAKE_EGRESS_PROXY_URL"),
    }))
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn signing_key_seed(
    _sign_dev: bool,
    signing_key_seed: Option<String>,
) -> Result<[u8; 32], Box<dyn std::error::Error>> {
    let seed = signing_key_seed.unwrap_or_else(|| DEV_SIGNING_KEY_SEED_HEX.to_owned());
    Ok(parse_seed(&seed)?)
}

fn write_output(
    output_dir: &Path,
    output: &OracleOutput,
) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(output_dir)?;
    write_pretty(output_dir.join("result.json"), &output.result)?;

    if let Some(source_manifest) = &output.source_manifest {
        fs::write(
            output_dir.join("source_manifest.json"),
            canonical_json_bytes(source_manifest)?,
        )?;
    }
    if let Some(raw_data_manifest) = &output.raw_data_manifest {
        fs::write(
            output_dir.join("raw_data_manifest.json"),
            canonical_json_bytes(raw_data_manifest)?,
        )?;
    }
    if let Some(evidence_manifest) = &output.evidence_manifest {
        fs::write(
            output_dir.join("evidence_manifest.json"),
            canonical_json_bytes(evidence_manifest)?,
        )?;
    }
    if let Some(affected_cells) = &output.affected_cells {
        fs::write(
            output_dir.join("affected_cells.json"),
            canonical_json_bytes(affected_cells)?,
        )?;
    }
    if let Some(unsigned_payload) = &output.unsigned_payload {
        fs::write(
            output_dir.join("unsigned_payload.json"),
            canonical_json_bytes(unsigned_payload)?,
        )?;
    }
    if let Some(expected_hashes) = &output.expected_hashes {
        write_pretty(output_dir.join("expected_hashes.json"), expected_hashes)?;
    }
    if let Some(sample_proof) = &output.sample_proof {
        write_pretty(output_dir.join("sample_proof.json"), sample_proof)?;
    }
    if let Some(signature) = &output.signature {
        write_pretty(output_dir.join("signature.json"), signature)?;
    }

    Ok(())
}

fn write_pretty(
    path: PathBuf,
    value: &impl serde::Serialize,
) -> Result<(), Box<dyn std::error::Error>> {
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(value)?))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tee::server::TeeJsonResult;

    fn sample_unsigned_payload() -> tee::UnsignedPayload {
        tee::UnsignedPayload {
            intent: 1,
            oracle_version: 1,
            event_uid: format!("0x{}", "11".repeat(32)),
            event_revision: 1,
            source_event_id: "us7000abcd".to_owned(),
            title: "M 7.1 - Sonari Fixture Earthquake".to_owned(),
            region: "Sonari Fixture Region".to_owned(),
            occurred_at_ms: 1_700_000_000_000,
            hazard_type: 1,
            status: 3,
            severity_band: 3,
            affected_cells_root: format!("0x{}", "44".repeat(32)),
            affected_cell_count: 1,
            evidence_manifest_uri: "walrus://blob/manifest-blob".to_owned(),
            evidence_manifest_hash: format!("0x{}", "55".repeat(32)),
            verified_at_ms: 1_700_000_100_000,
            freshness_deadline_ms: 1_700_021_700_000,
        }
    }

    fn sample_affected_cells() -> tee::AffectedCellsArtifact {
        tee::AffectedCellsArtifact {
            event_uid: format!("0x{}", "11".repeat(32)),
            event_revision: 1,
            oracle_version: 1,
            geo_resolution: 7,
            cells_generation_method: "shakemap_gridxml_h3_grid_point_p90_v1".to_owned(),
            cell_metric: "USGS_MMI".to_owned(),
            cell_aggregation: "GRID_POINT_P90".to_owned(),
            intensity_scale: "MMI_X100".to_owned(),
            affected_cells: Vec::new(),
        }
    }

    fn sample_evidence_manifest() -> tee::EvidenceManifest {
        tee::EvidenceManifest {
            schema_version: 1,
            oracle_version: 1,
            event_uid: format!("0x{}", "11".repeat(32)),
            event_revision: 1,
            hazard_type: "EARTHQUAKE".to_owned(),
            source_event_id: "us7000abcd".to_owned(),
            sources: Vec::new(),
            earthquake: tee::EarthquakeEvidence {
                title: "M 7.1 - Sonari Fixture Earthquake".to_owned(),
                region: "Sonari Fixture Region".to_owned(),
                occurred_at_ms: 1_700_000_000_000,
                magnitude_x100: 710,
                source_updated_at_ms: 1_700_000_050_000,
            },
            affected_cells: tee::EvidenceAffectedCells {
                uri: "walrus://blob/affected-blob".to_owned(),
                hash: format!("0x{}", "66".repeat(32)),
                root: format!("0x{}", "44".repeat(32)),
                count: 1,
                total_cell_count: 1,
                land_cell_count: 1,
                water_cell_count: 0,
                land_allowlist_version: 0,
                land_allowlist_root: format!("0x{}", "00".repeat(32)),
                land_allowlist_source_hash: None,
                land_classifier: "all_affected_cells_land_compat_v1".to_owned(),
                geo_resolution: 7,
            },
        }
    }

    fn finalized_process_output() -> ProcessOutput {
        let result = TeeJsonResult::Finalized {
            payload: Box::new(sample_unsigned_payload()),
            payload_bcs_hex: "0x01".to_owned(),
            signature: tee::server::UNSIGNED_PLACEHOLDER.to_owned(),
            public_key: tee::server::UNSIGNED_PLACEHOLDER.to_owned(),
            raw_data_manifest: tee::RawDataManifest {
                oracle_version: 1,
                entries: Vec::new(),
            },
            affected_cells: Box::new(sample_affected_cells()),
            evidence_manifest: Box::new(sample_evidence_manifest()),
            affected_cells_ref: None,
            evidence_manifest_ref: None,
        };
        ProcessOutput::signable(vec![0x01], serde_json::to_value(&result).unwrap())
    }

    #[test]
    fn tee_json_result_preserves_payload_field_order_after_value_conversion() {
        let value = serde_json::to_value(TeeJsonResult::Finalized {
            payload: Box::new(sample_unsigned_payload()),
            payload_bcs_hex: "0x01".to_owned(),
            signature: format!("0x{}", "66".repeat(64)),
            public_key: format!("0x{}", "77".repeat(32)),
            raw_data_manifest: tee::RawDataManifest {
                oracle_version: 1,
                entries: Vec::new(),
            },
            affected_cells: Box::new(sample_affected_cells()),
            evidence_manifest: Box::new(sample_evidence_manifest()),
            affected_cells_ref: None,
            evidence_manifest_ref: None,
        })
        .expect("TEE result should serialize");
        let payload = value
            .get("payload")
            .and_then(serde_json::Value::as_object)
            .expect("payload should be a JSON object");

        let keys = payload.keys().map(String::as_str).collect::<Vec<_>>();
        assert_eq!(
            keys,
            [
                "intent",
                "oracle_version",
                "event_uid",
                "event_revision",
                "source_event_id",
                "title",
                "region",
                "occurred_at_ms",
                "hazard_type",
                "status",
                "severity_band",
                "affected_cells_root",
                "affected_cell_count",
                "evidence_manifest_uri",
                "evidence_manifest_hash",
                "verified_at_ms",
                "freshness_deadline_ms",
            ]
        );
    }

    #[test]
    fn finalize_process_output_signs_payload_and_keeps_canonical_key_order() {
        let signer = LocalEd25519Signer::new([7u8; 32]);
        let metadata = EnclaveRegistrationMetadata {
            verifier_config_key: 1,
            verifier_config_version: 10,
            enclave_instance_public_key: format!("0x{}", "77".repeat(32)),
        };

        let value = finalize_process_output(finalized_process_output(), &signer, Some(metadata))
            .expect("signable output should finalize");

        let object = value.as_object().expect("result should be an object");
        // signature / public_key keep their canonical position (no reordering);
        // registration metadata is appended last like the historical flatten.
        let keys = object.keys().map(String::as_str).collect::<Vec<_>>();
        assert_eq!(
            keys,
            [
                "status",
                "payload",
                "payload_bcs_hex",
                "signature",
                "public_key",
                "raw_data_manifest",
                "affected_cells",
                "evidence_manifest",
                "verifier_config_key",
                "verifier_config_version",
                "enclave_instance_public_key",
            ]
        );
        let expected = signer.sign_payload(&[0x01]);
        assert_eq!(object["signature"], expected.signature);
        assert_eq!(object["public_key"], expected.public_key);
        assert_eq!(object["verifier_config_key"], 1);
        assert_eq!(object["verifier_config_version"], 10);
    }

    #[test]
    fn finalize_process_output_leaves_non_finalized_result_unsigned() {
        let signer = LocalEd25519Signer::new([7u8; 32]);
        let output = ProcessOutput::unsigned(serde_json::json!({
            "status": "pending_source",
            "source_event_id": "us7000abcd",
            "error_code": "USGS_DETAIL_UNAVAILABLE",
        }));

        let value =
            finalize_process_output(output, &signer, None).expect("unsigned output is verbatim");

        assert_eq!(value["status"], "pending_source");
        assert!(value.get("signature").is_none());
    }

    #[test]
    fn finalize_process_output_rejects_signable_output_with_empty_payload() {
        let signer = LocalEd25519Signer::new([7u8; 32]);
        // A signable output with no bytes to sign is a contract violation; the
        // server must fail closed rather than emit an unsigned 200.
        let output = ProcessOutput::signable(
            Vec::new(),
            serde_json::json!({
                "status": "finalized",
                "signature": "",
                "public_key": "",
            }),
        );

        let error = finalize_process_output(output, &signer, None)
            .expect_err("empty signable payload must fail closed");

        assert!(
            error.to_string().contains("non-empty BCS payload"),
            "error: {error}"
        );
    }

    /// Mirrors the real wire body produced by
    /// `scripts/aws/shared.ts::buildEarthquakeWrapperInput`.
    fn process_data_wire_body() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "action": "process_data",
            "payload": {
                "source_event_id": "us7000sonari",
                "event_revision": 1,
                "hazard_type": 1,
                "primary_source": 1,
                "geo_resolution": 7,
            },
            "registration_metadata": {
                "verifier_config_key": 1,
                "verifier_config_version": 10,
                "enclave_instance_public_key": format!("0x{}", "77".repeat(32)),
            },
        }))
        .unwrap()
    }

    #[test]
    fn attestation_public_key_label_matches_the_registry_value() {
        // The legacy GetAttestation path must sign the registry-sourced label, not
        // a divergent literal, so the embedded public key stays consistent with the
        // server path. The byte value is unchanged (registry aggregation only).
        assert_eq!(
            ATTESTATION_PUBLIC_KEY_LABEL,
            sonari_tee_core::registry::EARTHQUAKE_ATTESTATION_PUBLIC_KEY_LABEL
        );
        assert_eq!(
            ATTESTATION_PUBLIC_KEY_LABEL,
            b"sonari-earthquake-attestation-public-key"
        );
    }

    #[test]
    fn parse_process_data_envelope_accepts_real_wire_body() {
        let envelope = parse_process_data_envelope(&process_data_wire_body())
            .expect("the real wire body must be accepted unchanged");

        assert_eq!(envelope.action, "process_data");
        assert_eq!(envelope.payload["source_event_id"], "us7000sonari");
        assert_eq!(envelope.registration_metadata.verifier_config_key, 1);
        assert_eq!(envelope.registration_metadata.verifier_config_version, 10);
    }

    #[test]
    fn parse_process_data_envelope_rejects_unknown_field() {
        let mut body: serde_json::Value =
            serde_json::from_slice(&process_data_wire_body()).unwrap();
        body.as_object_mut()
            .unwrap()
            .insert("rogue".to_owned(), serde_json::json!("x"));

        let error = parse_process_data_envelope(&serde_json::to_vec(&body).unwrap())
            .expect_err("unknown outer field must be rejected");

        assert!(
            error.to_string().contains("rogue") || error.to_string().contains("unknown field"),
            "error: {error}"
        );
    }

    #[test]
    fn parse_process_data_envelope_rejects_missing_action() {
        let mut body: serde_json::Value =
            serde_json::from_slice(&process_data_wire_body()).unwrap();
        body.as_object_mut().unwrap().remove("action");

        let error = parse_process_data_envelope(&serde_json::to_vec(&body).unwrap())
            .expect_err("missing action must be rejected");

        assert!(error.to_string().contains("action"), "error: {error}");
    }

    #[test]
    fn parse_process_data_envelope_rejects_wrong_action() {
        let mut body: serde_json::Value =
            serde_json::from_slice(&process_data_wire_body()).unwrap();
        body.as_object_mut()
            .unwrap()
            .insert("action".to_owned(), serde_json::json!("get_attestation"));

        let error = parse_process_data_envelope(&serde_json::to_vec(&body).unwrap())
            .expect_err("an unexpected action must be rejected");

        assert!(
            error
                .to_string()
                .contains("unexpected /process_data action"),
            "error: {error}"
        );
    }

    #[test]
    fn parse_process_data_envelope_rejects_foreign_verifier_config_key_family() {
        let mut body: serde_json::Value =
            serde_json::from_slice(&process_data_wire_body()).unwrap();
        // The identity family key (2) must be rejected: a worker-supplied foreign
        // config_key must never be injected into a signed earthquake output.
        body["registration_metadata"]["verifier_config_key"] = serde_json::json!(2);

        let error = parse_process_data_envelope(&serde_json::to_vec(&body).unwrap())
            .expect_err("a non-earthquake verifier_config_key must be rejected");

        assert!(
            error
                .to_string()
                .contains("does not match the earthquake family key"),
            "error: {error}"
        );
    }

    #[test]
    fn production_action_process_data_rejects_foreign_verifier_config_key_family() {
        let mut body: serde_json::Value =
            serde_json::from_slice(&process_data_wire_body()).unwrap();
        body["registration_metadata"]["verifier_config_key"] = serde_json::json!(2);

        let error = production_action_result(
            body,
            Some("0x0707070707070707070707070707070707070707070707070707070707070707".to_owned()),
        )
        .expect_err("a non-earthquake verifier_config_key must be rejected on the action path");

        assert!(
            error
                .to_string()
                .contains("does not match the earthquake family key"),
            "error: {error}"
        );
    }

    const E2E_SEED: [u8; 32] = [7u8; 32];
    const E2E_FIXTURE_DIR: &str = "../fixtures/usgs/finalized_minimal";

    fn e2e_finalized_input() -> tee::UsgsOracleInput {
        let detail_json = fs::read(format!("{E2E_FIXTURE_DIR}/input/usgs_detail.json"))
            .expect("fixture detail should be readable");
        let observed_at_ms = serde_json::from_slice::<serde_json::Value>(&detail_json)
            .unwrap()
            .get("properties")
            .and_then(|p| p.get("updated"))
            .and_then(serde_json::Value::as_u64)
            .unwrap();
        let grid = fs::read(format!("{E2E_FIXTURE_DIR}/input/usgs_grid.xml"))
            .expect("fixture grid should be readable");
        tee::UsgsOracleInput {
            case_id: "usgs/finalized_minimal".to_owned(),
            detail_json,
            grid_xml: Some(grid.clone()),
            raw_grid_bytes: Some(grid),
            observed_at_ms,
            raw_detail_uri:
                "nautilus/verifiers/earthquake/fixtures/usgs/finalized_minimal/input/usgs_detail.json"
                    .to_owned(),
            raw_grid_uri: Some(
                "nautilus/verifiers/earthquake/fixtures/usgs/finalized_minimal/input/usgs_grid.xml"
                    .to_owned(),
            ),
        }
    }

    fn e2e_registration_metadata() -> EnclaveRegistrationMetadata {
        EnclaveRegistrationMetadata {
            verifier_config_key: 1,
            verifier_config_version: 10,
            enclave_instance_public_key: format!("0x{}", "77".repeat(32)),
        }
    }

    /// Drives the new handler+server finalization path end-to-end (fixture
    /// detail/grid, fixed seed, fixed registration metadata) and pins the exact
    /// serialized JSON bytes so any future wire drift in the
    /// `process_output_from_oracle` -> `finalize_process_output` path is caught.
    #[test]
    fn finalized_server_path_serialized_bytes_are_byte_stable() {
        let oracle_output =
            tee::process_usgs(e2e_finalized_input()).expect("fixture should finalize");
        let process_output = tee::server::process_output_from_oracle(oracle_output)
            .expect("finalized conversion should succeed");
        let signer = LocalEd25519Signer::new(E2E_SEED);

        let value =
            finalize_process_output(process_output, &signer, Some(e2e_registration_metadata()))
                .expect("finalized output should sign");
        let serialized = serde_json::to_string(&value).expect("result should serialize");

        let golden = include_str!("testdata/finalized_server_path.golden.json").trim_end();
        assert_eq!(
            serialized, golden,
            "finalized server-path bytes drifted from golden vector"
        );
    }

    /// Pins the `get_attestation` response JSON for a fixed seed and document so
    /// the route's wire shape, key order, and seed-derived public key stay
    /// byte-stable across refactors.
    #[test]
    fn get_attestation_response_bytes_are_byte_stable_for_fixed_seed() {
        let document = [0xABu8, 0xCD, 0xEF];
        let signer = LocalEd25519Signer::new(E2E_SEED);
        let signature = signer.sign_payload(ATTESTATION_PUBLIC_KEY_LABEL);
        let value =
            sonari_tee_core::enclave::attestation_response_json(&document, &signature.public_key);
        let serialized = serde_json::to_string(&value).expect("attestation should serialize");

        let golden = include_str!("testdata/get_attestation.golden.json").trim_end();
        assert_eq!(
            serialized, golden,
            "get_attestation bytes drifted from golden vector"
        );
    }
}
