use clap::{Parser, Subcommand};
use nsm_api::api::{Request as NsmRequest, Response as NsmResponse};
use nsm_api::driver;
use serde::{Deserialize, Serialize};
use sonari_tee_core::{
    DEV_SIGNING_KEY_SEED_HEX, PayloadSigner, parse_seed, signing_key_seed_from_env,
};
use std::env;
use std::fs;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{FromRawFd, RawFd};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tee::{
    DEFAULT_WALRUS_CLI_TIMEOUT_MS, LocalEd25519Signer, OracleOutput, UsgsOracleInput,
    WalrusCliSourceArchive, WalrusCliSourceArchiveConfig, canonical_json_bytes,
    grid_xml_from_artifact, parse_command_timeout_ms, parse_n_shards,
    process_usgs_from_worker_request, process_usgs_with_signer, process_usgs_with_source_archive,
};

const PRODUCTION_FETCH_TIMEOUT_MS: u64 = 30_000;

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
    let request = tee::WorkerToTeeRequest::from_json_value(request_json)?;
    production_worker_request_result(request, seed, None)
}

#[derive(Clone)]
struct EnclaveState {
    signing_key_seed: [u8; 32],
}

fn run_nautilus_server(args: ServerArgs) -> Result<(), Box<dyn std::error::Error>> {
    let signing_key_seed = generate_ephemeral_signing_key_seed()?;
    let state = EnclaveState { signing_key_seed };
    if !args.skip_bootstrap {
        receive_bootstrap_config(args.bootstrap_port)?;
    }
    let listener = VsockListener::bind(args.port)?;
    eprintln!(
        "sonari earthquake nautilus server listening on vsock port {}",
        args.port
    );
    loop {
        let stream = listener.accept()?;
        let state = state.clone();
        thread::spawn(move || {
            if let Err(error) = handle_vsock_http_connection(stream, state) {
                eprintln!("sonari earthquake nautilus request failed: {error}");
            }
        });
    }
}

fn generate_ephemeral_signing_key_seed() -> Result<[u8; 32], Box<dyn std::error::Error>> {
    let mut file = File::open("/dev/urandom")?;
    let mut seed = [0u8; 32];
    file.read_exact(&mut seed)?;
    Ok(seed)
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
    Ok(())
}

#[derive(Debug, Deserialize)]
struct BootstrapConfig {
    walrus_cli: String,
    walrus_n_shards: u32,
    egress_proxy_url: String,
}

fn set_env_before_server(name: &str, value: &str) {
    // The server is not accepting requests yet, so no other Rust thread is reading
    // the process environment when bootstrap values are installed.
    unsafe {
        env::set_var(name, value);
    }
}

fn handle_vsock_http_connection(
    mut stream: File,
    state: EnclaveState,
) -> Result<(), Box<dyn std::error::Error>> {
    let request = read_http_request(&mut stream)?;
    let (status_code, body) = handle_vsock_http_request(request, state);
    write_http_json_response(&mut stream, status_code, &body)?;
    Ok(())
}

fn handle_vsock_http_request(
    request: HttpRequest,
    state: EnclaveState,
) -> (u16, serde_json::Value) {
    match catch_unwind(AssertUnwindSafe(|| {
        route_vsock_http_request(request, state)
    })) {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => (
            500,
            serde_json::json!({
                "error_code": "AWS_RUNNER_PROCESS_FAILED",
                "message": error.to_string(),
            }),
        ),
        Err(payload) => (
            500,
            serde_json::json!({
                "error_code": "AWS_RUNNER_PROCESS_FAILED",
                "message": panic_message(payload),
            }),
        ),
    }
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return format!("panic: {message}");
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return format!("panic: {message}");
    }
    "panic: unknown payload".to_owned()
}

fn route_vsock_http_request(
    request: HttpRequest,
    state: EnclaveState,
) -> Result<(u16, serde_json::Value), Box<dyn std::error::Error>> {
    let (status_code, body) = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/health_check") => (
            200,
            serde_json::json!({
                "status": "healthy",
                "external_sources_reachable": true,
            }),
        ),
        ("GET", "/get_attestation") => (200, enclave_attestation_response(&state)?),
        ("POST", "/process_data") => {
            let request_json: serde_json::Value = serde_json::from_slice(&request.body)?;
            (
                200,
                production_action_result(request_json, Some(to_hex_seed(&state.signing_key_seed)))?,
            )
        }
        _ => (
            404,
            serde_json::json!({
                "error_code": "AWS_RUNNER_PROCESS_FAILED",
                "message": "not found",
            }),
        ),
    };
    Ok((status_code, body))
}

fn enclave_attestation_response(
    state: &EnclaveState,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let signer = LocalEd25519Signer::new(state.signing_key_seed);
    let signature = signer.sign_payload(b"sonari-earthquake-attestation-public-key");
    let public_key_bytes = hex::decode(signature.public_key.trim_start_matches("0x"))?;
    let fd = driver::nsm_init();
    let request = NsmRequest::Attestation {
        user_data: None,
        nonce: None,
        public_key: Some(serde_bytes::ByteBuf::from(public_key_bytes)),
    };
    let response = driver::nsm_process_request(fd, request);
    driver::nsm_exit(fd);
    match response {
        NsmResponse::Attestation { document } => Ok(serde_json::json!({
            "attestation_document_hex": format!("0x{}", hex::encode(document)),
            "public_key": signature.public_key,
        })),
        _ => Err("unexpected NSM attestation response".into()),
    }
}

fn to_hex_seed(seed: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(seed))
}

struct HttpRequest {
    method: String,
    path: String,
    body: Vec<u8>,
}

fn read_http_request(stream: &mut File) -> Result<HttpRequest, Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    let header_end;
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            return Err("connection closed before HTTP headers".into());
        }
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(index) = find_header_end(&bytes) {
            header_end = index;
            break;
        }
        if bytes.len() > 1024 * 1024 {
            return Err("HTTP headers exceeded max size".into());
        }
    }
    let header_text = std::str::from_utf8(&bytes[..header_end])?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().ok_or("missing HTTP request line")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or("missing HTTP method")?.to_owned();
    let path = parts.next().ok_or("missing HTTP path")?.to_owned();
    let content_length = lines
        .filter_map(|line| line.split_once(':'))
        .find_map(|(name, value)| {
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);
    let body_start = header_end + 4;
    while bytes.len() < body_start + content_length {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            return Err("connection closed before HTTP body".into());
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    Ok(HttpRequest {
        method,
        path,
        body: bytes[body_start..body_start + content_length].to_vec(),
    })
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn write_http_json_response(
    stream: &mut File,
    status_code: u16,
    body: &serde_json::Value,
) -> Result<(), Box<dyn std::error::Error>> {
    let body_bytes = serde_json::to_vec(body)?;
    let reason = if status_code == 200 { "OK" } else { "Error" };
    write!(
        stream,
        "HTTP/1.1 {status_code} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body_bytes.len()
    )?;
    stream.write_all(&body_bytes)?;
    Ok(())
}

struct VsockListener {
    fd: RawFd,
}

impl VsockListener {
    fn bind(port: u32) -> Result<Self, Box<dyn std::error::Error>> {
        let fd = unsafe { libc::socket(AF_VSOCK, libc::SOCK_STREAM, 0) };
        if fd < 0 {
            return Err(io::Error::last_os_error().into());
        }
        let addr = SockAddrVm {
            svm_family: AF_VSOCK as libc::sa_family_t,
            svm_reserved1: 0,
            svm_port: port,
            svm_cid: VMADDR_CID_ANY,
            svm_zero: [0; 4],
        };
        let bind_result = unsafe {
            libc::bind(
                fd,
                (&addr as *const SockAddrVm).cast::<libc::sockaddr>(),
                std::mem::size_of::<SockAddrVm>() as libc::socklen_t,
            )
        };
        if bind_result < 0 {
            let error = io::Error::last_os_error();
            unsafe {
                libc::close(fd);
            }
            return Err(error.into());
        }
        let listen_result = unsafe { libc::listen(fd, 128) };
        if listen_result < 0 {
            let error = io::Error::last_os_error();
            unsafe {
                libc::close(fd);
            }
            return Err(error.into());
        }
        Ok(Self { fd })
    }

    fn accept(&self) -> Result<File, Box<dyn std::error::Error>> {
        let fd = unsafe { libc::accept(self.fd, std::ptr::null_mut(), std::ptr::null_mut()) };
        if fd < 0 {
            return Err(io::Error::last_os_error().into());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}

impl Drop for VsockListener {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.fd);
        }
    }
}

const AF_VSOCK: libc::c_int = 40;
const VMADDR_CID_ANY: u32 = 0xFFFF_FFFF;

#[repr(C)]
struct SockAddrVm {
    svm_family: libc::sa_family_t,
    svm_reserved1: u16,
    svm_port: u32,
    svm_cid: u32,
    svm_zero: [u8; 4],
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

#[derive(Debug, Clone, Deserialize, Serialize)]
struct EnclaveRegistrationMetadata {
    verifier_config_key: u64,
    verifier_config_version: u64,
    enclave_instance_public_key: String,
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
            let signature = signer.sign_payload(b"sonari-earthquake-attestation-public-key");
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
            let seed = strict_signing_key_seed(signing_key_seed)?;
            let request = tee::WorkerToTeeRequest::from_json_value(payload)?;
            production_worker_request_result(request, seed, Some(registration_metadata))
        }
    }
}

fn production_worker_request_result(
    request: tee::WorkerToTeeRequest,
    seed: [u8; 32],
    registration_metadata: Option<EnclaveRegistrationMetadata>,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let detail_url = usgs_detail_url(&request.source_event_id);
    let client = production_http_client()?;
    let detail_json = match client.get(&detail_url).send().and_then(|response| {
        if response.status().is_success() {
            response.bytes()
        } else {
            Err(response.error_for_status().unwrap_err())
        }
    }) {
        Ok(bytes) => bytes.to_vec(),
        Err(_) => {
            return Ok(serde_json::to_value(TeeJsonResult::PendingSource {
                source_event_id: request.source_event_id,
                error_code: "USGS_DETAIL_UNAVAILABLE",
            })?);
        }
    };
    let detail_value: serde_json::Value = match serde_json::from_slice(&detail_json) {
        Ok(value) => value,
        Err(_) => {
            return Ok(serde_json::to_value(TeeJsonResult::PendingSource {
                source_event_id: request.source_event_id,
                error_code: "USGS_DETAIL_UNAVAILABLE",
            })?);
        }
    };
    let Some(canonical_source_event_id) =
        canonical_usgs_detail_id_for_request(&detail_value, &request.source_event_id)
    else {
        return Ok(serde_json::to_value(TeeJsonResult::PendingSource {
            source_event_id: request.source_event_id,
            error_code: "USGS_DETAIL_UNAVAILABLE",
        })?);
    };

    let grid = match preferred_grid_uri_from_detail(&detail_value) {
        Some(uri) => match fetch_grid(&client, &uri) {
            Ok(grid) => Some(grid),
            Err(_) => {
                return Ok(serde_json::to_value(TeeJsonResult::PendingSource {
                    source_event_id: request.source_event_id,
                    error_code: "SHAKEMAP_GRID_UNAVAILABLE",
                })?);
            }
        },
        None => None,
    };
    let source_event_id = canonical_source_event_id.to_owned();
    let observed_at_ms = current_unix_time_ms()?;
    let parts = ProductionInputParts {
        source_event_id,
        detail_json,
        grid_xml: grid.as_ref().map(|item| item.grid_xml.clone()),
        raw_grid_bytes: grid.as_ref().map(|item| item.raw_grid_bytes.clone()),
        raw_grid_uri: grid.as_ref().map(|item| item.raw_grid_uri.clone()),
    };
    let input = build_production_input(parts, observed_at_ms);
    let preliminary = process_usgs_from_worker_request(request, input.clone())?;
    if preliminary.result.status != tee::OracleStatus::Finalized {
        return Ok(serde_json::to_value(output_to_tee_json(preliminary)?)?);
    }

    let signer = LocalEd25519Signer::new(seed);
    let archive = WalrusCliSourceArchive::new(WalrusCliSourceArchiveConfig::from_env()?)?;
    let output = process_usgs_with_source_archive(input, &archive, &signer)?;
    let mut result = output_to_tee_json(output)?;
    if let (TeeJsonResult::Finalized { metadata, .. }, Some(registration_metadata)) =
        (&mut result, registration_metadata)
    {
        *metadata = Some(registration_metadata);
    }
    Ok(serde_json::to_value(result)?)
}

struct ProductionInputParts {
    source_event_id: String,
    detail_json: Vec<u8>,
    grid_xml: Option<Vec<u8>>,
    raw_grid_bytes: Option<Vec<u8>>,
    raw_grid_uri: Option<String>,
}

fn build_production_input(parts: ProductionInputParts, observed_at_ms: u64) -> UsgsOracleInput {
    let id = &parts.source_event_id;
    UsgsOracleInput {
        case_id: format!("usgs-live/{id}"),
        detail_json: parts.detail_json,
        grid_xml: parts.grid_xml,
        raw_grid_bytes: parts.raw_grid_bytes,
        observed_at_ms,
        raw_detail_uri: usgs_detail_url(id),
        raw_grid_uri: parts.raw_grid_uri,
        raw_data_uri: format!("ipfs://sonari/live/{id}/raw_data_manifest.json"),
        affected_cells_uri: format!("ipfs://sonari/live/{id}/affected_cells.json"),
    }
}

fn canonical_usgs_detail_id_for_request<'a>(
    detail: &'a serde_json::Value,
    request_source_event_id: &str,
) -> Option<&'a str> {
    let canonical_id = detail.get("id").and_then(serde_json::Value::as_str)?;
    if canonical_id == request_source_event_id {
        return Some(canonical_id);
    }
    let ids = detail
        .get("properties")
        .and_then(|properties| properties.get("ids"))
        .and_then(serde_json::Value::as_str)?;
    if ids
        .split(',')
        .map(str::trim)
        .any(|alias| alias == request_source_event_id)
    {
        return Some(canonical_id);
    }
    None
}

fn usgs_detail_url(source_event_id: &str) -> String {
    format!(
        "https://earthquake.usgs.gov/fdsnws/event/1/query?eventid={source_event_id}&format=geojson"
    )
}

fn production_request_bytes(input: Option<PathBuf>) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    if let Some(path) = input {
        return Ok(fs::read(path)?);
    }

    let mut bytes = Vec::new();
    io::stdin().read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn current_unix_time_ms() -> Result<u64, Box<dyn std::error::Error>> {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH)?;
    Ok(elapsed
        .as_secs()
        .checked_mul(1_000)
        .and_then(|millis| millis.checked_add(u64::from(elapsed.subsec_millis())))
        .ok_or("current time is outside u64 millisecond range")?)
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

struct FetchedGrid {
    grid_xml: Vec<u8>,
    raw_grid_bytes: Vec<u8>,
    raw_grid_uri: String,
}

fn production_http_client() -> Result<reqwest::blocking::Client, reqwest::Error> {
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(PRODUCTION_FETCH_TIMEOUT_MS));
    if let Some(proxy_url) = non_empty_env("SONARI_EARTHQUAKE_EGRESS_PROXY_URL") {
        builder = builder.proxy(reqwest::Proxy::all(proxy_url)?);
    }
    builder.build()
}

fn fetch_grid(
    client: &reqwest::blocking::Client,
    uri: &str,
) -> Result<FetchedGrid, Box<dyn std::error::Error>> {
    let bytes = match client.get(uri).send().and_then(|response| {
        if response.status().is_success() {
            response.bytes()
        } else {
            Err(response.error_for_status().unwrap_err())
        }
    }) {
        Ok(bytes) => bytes.to_vec(),
        Err(_) => {
            return Err("SHAKEMAP_GRID_UNAVAILABLE".into());
        }
    };
    let grid_xml = grid_xml_from_artifact(uri, &bytes)?;
    Ok(FetchedGrid {
        grid_xml,
        raw_grid_bytes: bytes,
        raw_grid_uri: uri.to_owned(),
    })
}

fn preferred_grid_uri_from_detail(detail: &serde_json::Value) -> Option<String> {
    let products = detail
        .get("properties")?
        .get("products")?
        .get("shakemap")?
        .as_array()?;
    let selected = products
        .iter()
        .max_by(|left, right| product_sort_key(left).cmp(&product_sort_key(right)))?;
    let contents = selected.get("contents")?.as_object()?;
    contents
        .get("download/grid.xml.zip")
        .or_else(|| contents.get("download/grid.xml"))
        .and_then(|content| content.get("url"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

fn product_sort_key(product: &serde_json::Value) -> (u64, u64, u64, String, String, String) {
    let properties = product
        .get("properties")
        .unwrap_or(&serde_json::Value::Null);
    (
        product
            .get("preferredWeight")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        properties
            .get("version")
            .and_then(serde_json::Value::as_str)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0),
        product
            .get("updateTime")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        product
            .get("source")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        product
            .get("code")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        product
            .get("status")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    )
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum TeeJsonResult {
    PendingSource {
        source_event_id: String,
        error_code: &'static str,
    },
    PendingMmi {
        source_event_id: String,
        error_code: String,
    },
    Rejected {
        source_event_id: String,
        error_code: String,
    },
    Finalized {
        payload: Box<tee::UnsignedPayload>,
        payload_bcs_hex: String,
        signature: String,
        public_key: String,
        raw_data_manifest: tee::RawDataManifest,
        #[serde(flatten, skip_serializing_if = "Option::is_none")]
        metadata: Option<EnclaveRegistrationMetadata>,
    },
}

fn output_to_tee_json(output: OracleOutput) -> Result<TeeJsonResult, Box<dyn std::error::Error>> {
    match output.result.status {
        tee::OracleStatus::Finalized => {
            let payload = output
                .unsigned_payload
                .ok_or("finalized output is missing unsigned payload")?;
            let payload_bcs_hex = output
                .expected_hashes
                .ok_or("finalized output is missing expected hashes")?
                .unsigned_bcs_payload_hex;
            let signature = output
                .signature
                .ok_or("finalized output is missing signature")?;
            let raw_data_manifest = output
                .raw_data_manifest
                .ok_or("finalized output is missing raw data manifest")?;
            Ok(TeeJsonResult::Finalized {
                payload: Box::new(payload),
                payload_bcs_hex,
                signature: signature.signature,
                public_key: signature.public_key,
                raw_data_manifest,
                metadata: None,
            })
        }
        tee::OracleStatus::PendingSource => Ok(TeeJsonResult::PendingSource {
            source_event_id: output.result.source_event_id,
            error_code: static_error_code(output.result.error_code)?,
        }),
        tee::OracleStatus::PendingMmi => Ok(TeeJsonResult::PendingMmi {
            source_event_id: output.result.source_event_id,
            error_code: output
                .result
                .error_code
                .ok_or("pending_mmi requires error_code")?,
        }),
        tee::OracleStatus::Rejected => Ok(TeeJsonResult::Rejected {
            source_event_id: output.result.source_event_id,
            error_code: output
                .result
                .error_code
                .ok_or("rejected requires error_code")?,
        }),
    }
}

fn static_error_code(value: Option<String>) -> Result<&'static str, Box<dyn std::error::Error>> {
    match value.as_deref() {
        Some("SHAKEMAP_PRODUCT_MISSING") => Ok("SHAKEMAP_PRODUCT_MISSING"),
        Some("SHAKEMAP_GRID_UNAVAILABLE") => Ok("SHAKEMAP_GRID_UNAVAILABLE"),
        Some("USGS_DETAIL_UNAVAILABLE") => Ok("USGS_DETAIL_UNAVAILABLE"),
        _ => Err("pending_source requires a supported error_code".into()),
    }
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
            raw_data_uri: required(cli.raw_data_uri, "--raw-data-uri")?,
            affected_cells_uri: required(cli.affected_cells_uri, "--affected-cells-uri")?,
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
    let source_event_id = source_event_id(&detail_path)?;
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
            raw_data_uri: format!(
                "ipfs://sonari/examples/{source_event_id}/raw_data_manifest.json"
            ),
            affected_cells_uri: format!(
                "ipfs://sonari/examples/{source_event_id}/affected_cells.json"
            ),
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

fn source_event_id(detail_path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let detail: serde_json::Value = serde_json::from_slice(&fs::read(detail_path)?)?;
    detail
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("{} is missing string field `id`", detail_path.display()).into())
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

    #[test]
    fn tee_json_result_preserves_payload_field_order_after_value_conversion() {
        let payload = tee::UnsignedPayload {
            intent: 1,
            oracle_version: 1,
            event_uid: format!("0x{}", "11".repeat(32)),
            hazard_type: 1,
            status: 3,
            event_revision: 1,
            source_event_id: "us7000abcd".to_owned(),
            title: "M 7.1 - Sonari Fixture Earthquake".to_owned(),
            region: "Sonari Fixture Region".to_owned(),
            occurred_at_ms: 1_700_000_000_000,
            magnitude_x100: 710,
            verified_at_ms: 1_700_000_100_000,
            source_updated_at_ms: 1_700_000_050_000,
            primary_source: 1,
            severity_band: 3,
            source_set_hash: format!("0x{}", "22".repeat(32)),
            raw_data_hash: format!("0x{}", "33".repeat(32)),
            raw_data_uri: "ipfs://sonari/live/us7000abcd/raw_data_manifest.json".to_owned(),
            affected_cells_root: format!("0x{}", "44".repeat(32)),
            affected_cells_uri: "ipfs://sonari/live/us7000abcd/affected_cells.json".to_owned(),
            affected_cells_data_hash: format!("0x{}", "55".repeat(32)),
            affected_cell_count: 1,
            geo_resolution: 7,
            cells_generation_method: 1,
            cell_metric: 1,
            cell_aggregation: 1,
            intensity_scale: 1,
            freshness_deadline_ms: 1_700_021_700_000,
        };

        let result = TeeJsonResult::Finalized {
            payload: Box::new(payload),
            payload_bcs_hex: "0x01".to_owned(),
            signature: format!("0x{}", "66".repeat(64)),
            public_key: format!("0x{}", "77".repeat(32)),
            raw_data_manifest: tee::RawDataManifest {
                oracle_version: 1,
                entries: Vec::new(),
            },
            metadata: Some(EnclaveRegistrationMetadata {
                verifier_config_key: 1,
                verifier_config_version: 10,
                enclave_instance_public_key: format!("0x{}", "77".repeat(32)),
            }),
        };
        let value = serde_json::to_value(result).expect("TEE result should serialize");
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
                "hazard_type",
                "status",
                "event_revision",
                "source_event_id",
                "title",
                "region",
                "occurred_at_ms",
                "magnitude_x100",
                "verified_at_ms",
                "source_updated_at_ms",
                "primary_source",
                "severity_band",
                "source_set_hash",
                "raw_data_hash",
                "raw_data_uri",
                "affected_cells_root",
                "affected_cells_uri",
                "affected_cells_data_hash",
                "affected_cell_count",
                "geo_resolution",
                "cells_generation_method",
                "cell_metric",
                "cell_aggregation",
                "intensity_scale",
                "freshness_deadline_ms",
            ]
        );
    }

    #[test]
    fn build_production_input_uses_injected_observed_at_ms() {
        let properties_updated_ms = 1_700_000_000_000_u64;
        let injected_observed_at_ms = 1_800_000_000_000_u64;
        assert_ne!(
            properties_updated_ms, injected_observed_at_ms,
            "test must distinguish the injected clock from properties.updated"
        );

        let detail_json =
            format!(r#"{{"id":"us7000abcd","properties":{{"updated":{properties_updated_ms}}}}}"#)
                .into_bytes();
        let parts = ProductionInputParts {
            source_event_id: "us7000abcd".to_owned(),
            detail_json,
            grid_xml: None,
            raw_grid_bytes: None,
            raw_grid_uri: None,
        };

        let input = build_production_input(parts, injected_observed_at_ms);

        assert_eq!(input.observed_at_ms, injected_observed_at_ms);
        assert_ne!(input.observed_at_ms, properties_updated_ms);
        assert_eq!(input.case_id, "usgs-live/us7000abcd");
        assert_eq!(
            input.raw_detail_uri,
            "https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=us7000abcd&format=geojson"
        );
        assert_eq!(
            input.raw_data_uri,
            "ipfs://sonari/live/us7000abcd/raw_data_manifest.json"
        );
        assert_eq!(
            input.affected_cells_uri,
            "ipfs://sonari/live/us7000abcd/affected_cells.json"
        );
    }
}
