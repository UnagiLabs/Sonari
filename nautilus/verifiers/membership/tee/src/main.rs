use std::env;
use std::io::{self, Read};
use std::thread;

use clap::{Parser, Subcommand, ValueEnum};
use membership_tee::server::{EGRESS_PROXY_URL_KEY, IdentityProcessHandler};
use membership_tee::{
    CloudWorldIdVerifier, IdentityProcessingOutput, IdentityProcessingStatus, IdentityProvider,
    IdentityTeeResult, IdentityVerifyRequest, ResolvedWorldIdVerifierMode, SUI_NETWORK_ENV,
    WORLD_ID_API_BASE_CANONICAL, WORLD_ID_API_UNAVAILABLE, WORLD_ID_APP_ID_ENV,
    WORLD_ID_PROOF_MODE_ENV, WORLD_ID_VERIFICATION_FAILED, WorldIdModeObservation,
    WorldIdProofRequest, WorldIdVerificationStatus, WorldIdVerifier,
    encoding::identity_bcs::payload_bcs_bytes, process_identity_with_verifier,
    resolve_world_id_verifier_mode, world_id_mode_observation,
};
use serde::{Deserialize, Serialize};
use sonari_tee_core::enclave::{
    EnclaveRegistrationMetadata, HttpRequest, ProcessDataHandler, ProcessOutput, TeeContext,
    VsockListener, enclave_attestation_response_with_observation, error_response,
    generate_ephemeral_signing_key_seed, handle_connection, health_check_response,
};
use sonari_tee_core::registry::{
    IDENTITY_ATTESTATION_PUBLIC_KEY_LABEL, IDENTITY_VERIFIER_CONFIG_KEY,
};
use sonari_tee_core::{
    LocalEd25519Signer, PayloadSigner, SignatureArtifact, non_empty_env, signing_key_seed_from_env,
    to_hex,
};
use std::time::{SystemTime, UNIX_EPOCH};

const PRODUCTION_SIGNING_KEY_SEED_ENV: &str = "SONARI_TEE_SIGNING_KEY_SEED";
const PRODUCTION_SIGNING_KEY_SEED_FILE_ENV: &str = "SONARI_TEE_SIGNING_KEY_SEED_FILE";

/// Byte string the enclave signs to derive its embedded attestation public key.
///
/// Sourced from the shared verifier registry so the label has a single
/// definition (see `sonari_tee_core::registry`); the registry's uniqueness
/// tests guarantee it does not collide with another verifier's label.
const ATTESTATION_PUBLIC_KEY_LABEL: &[u8] = IDENTITY_ATTESTATION_PUBLIC_KEY_LABEL;

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
    Server(ServerArgs),
}

/// Production Nautilus server mode.
///
/// Unlike the legacy `Fixture` / `Production` CLI routes (which sign with a
/// fixed/dev or env-provided seed for local/legacy use), the server mode signs
/// every finalized result with an enclave-local ephemeral key generated at
/// startup. No fixed seed is ever read on this path.
#[derive(Debug, Parser)]
struct ServerArgs {
    #[arg(long, default_value_t = 3000)]
    port: u32,
    #[arg(long, default_value_t = 7777)]
    bootstrap_port: u32,
    #[arg(long)]
    skip_bootstrap: bool,
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
        Some(Command::Server(args)) => run_nautilus_server(args),
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

/// Per-connection enclave state for the production server path.
///
/// The signing seed is the enclave-local ephemeral key generated at startup; no
/// fixed/dev seed is reachable from this state (legacy fixed-seed signing lives
/// only on the `Fixture` / `Production` CLI routes).
#[derive(Clone)]
struct EnclaveState {
    ephemeral_signing_key_seed: [u8; 32],
    ctx: TeeContext,
    world_id_base_url: String,
    world_id_app_id: String,
    /// Resolved once at startup by the fail-closed gate. Passed to the handler so
    /// it can select the dummy or cloud World ID verifier per request without
    /// re-reading the host-supplied bootstrap env.
    world_id_verifier_mode: ResolvedWorldIdVerifierMode,
    /// Diagnostic observation of the proof_mode/network received at bootstrap and
    /// the resolved verifier mode. Surfaced on the get_attestation response in the
    /// plaintext envelope (NOT inside the signed NSM document), so it carries no
    /// secrets and is diagnostic-only, never an attestation-bound trust anchor.
    world_id_mode_observation: WorldIdModeObservation,
}

/// Runs the production Nautilus server: ephemeral key signing, NSM attestation,
/// World ID egress proxy via [`TeeContext`], and registration-metadata injection.
fn run_nautilus_server(args: ServerArgs) -> Result<(), Box<dyn std::error::Error>> {
    let ephemeral_signing_key_seed = generate_ephemeral_signing_key_seed()?;
    if !args.skip_bootstrap {
        receive_bootstrap_config(args.bootstrap_port)?;
    }
    // Resolve env-derived configuration once at startup (orchestration layer) so
    // per-request handlers never read the process environment.
    let state = enclave_state_from_env(ephemeral_signing_key_seed)?;
    let listener = VsockListener::bind(args.port)?;
    eprintln!(
        "sonari membership nautilus server listening on vsock port {}",
        args.port
    );
    loop {
        let stream = listener.accept()?;
        let state = state.clone();
        thread::spawn(move || {
            if let Err(error) = handle_connection(stream, |request| route_request(request, &state))
            {
                eprintln!("sonari membership nautilus request failed: {error}");
            }
        });
    }
}

/// Resolves the bootstrap-populated env into the per-connection enclave state.
///
/// The World ID base URL is **pinned** to the canonical
/// [`WORLD_ID_API_BASE_CANONICAL`] (`https://developer.world.org`) on this
/// production server path and is never read from the host/bootstrap env, so an
/// adversarial host cannot redirect the signed-result origin to an arbitrary
/// https base. Only the egress proxy URL is host-variable (injected through the
/// [`TeeContext`]), mirroring the earthquake egress model where the base is fixed
/// and the proxy merely steers the TCP connection. The app id is still read from
/// the bootstrap env; the egress proxy is resolved into the [`TeeContext`].
fn enclave_state_from_env(
    ephemeral_signing_key_seed: [u8; 32],
) -> Result<EnclaveState, Box<dyn std::error::Error>> {
    let world_id_app_id = non_empty_env(WORLD_ID_APP_ID_ENV)
        .ok_or(format!("{WORLD_ID_APP_ID_ENV} is required for server mode"))?;
    let proof_mode = non_empty_env(WORLD_ID_PROOF_MODE_ENV);
    let network = non_empty_env(SUI_NETWORK_ENV);
    // Fail-closed gate: evaluate once at startup. If the proof_mode/network
    // combination is disallowed (e.g. dummy on mainnet or with unknown/unset
    // network), the server refuses to start rather than silently degrading.
    let world_id_verifier_mode =
        resolve_world_id_verifier_mode(proof_mode.as_deref(), network.as_deref())?;
    // Build the diagnostic observation from the same env values that drove the
    // resolution above, so the get_attestation response can surface what the
    // enclave actually received and resolved (dev-only raw echo, mainnet redacted).
    let world_id_mode_observation = world_id_mode_observation(
        proof_mode.as_deref(),
        network.as_deref(),
        world_id_verifier_mode,
    );
    Ok(EnclaveState {
        ephemeral_signing_key_seed,
        ctx: tee_context_from_env(),
        world_id_base_url: server_world_id_base_url(),
        world_id_app_id,
        world_id_verifier_mode,
        world_id_mode_observation,
    })
}

/// Returns the canonical World ID base URL the production server path signs
/// against, independent of any host/bootstrap-supplied env value.
fn server_world_id_base_url() -> String {
    WORLD_ID_API_BASE_CANONICAL.to_owned()
}

/// Builds the dependency-injection context from the bootstrap-populated env.
///
/// The handler resolves the egress proxy through this context instead of reading
/// the process environment directly.
fn tee_context_from_env() -> TeeContext {
    match non_empty_env(EGRESS_PROXY_URL_KEY) {
        Some(proxy) => TeeContext::with_env([(EGRESS_PROXY_URL_KEY, proxy)]),
        None => TeeContext::new(),
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
            let signer = LocalEd25519Signer::new(state.ephemeral_signing_key_seed);
            // The observation rides in the plaintext envelope only (the signed NSM
            // document keeps user_data: None), so it stays diagnostic-only.
            let observation = serde_json::to_value(&state.world_id_mode_observation)?;
            Ok((
                200,
                enclave_attestation_response_with_observation(
                    &signer,
                    ATTESTATION_PUBLIC_KEY_LABEL,
                    &observation,
                )?,
            ))
        }
        ("POST", "/process_data") => {
            let envelope = parse_process_data_envelope(&request.body)?;
            let handler = IdentityProcessHandler::new(
                &state.world_id_base_url,
                &state.world_id_app_id,
                state.world_id_verifier_mode,
            );
            let output = handler
                .process(&serde_json::to_vec(&envelope.payload)?, &state.ctx)
                .map_err(|error| -> Box<dyn std::error::Error> { error.to_string().into() })?;
            let signer = LocalEd25519Signer::new(state.ephemeral_signing_key_seed);
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
/// The outer body wire shape is `{action, payload, registration_metadata}`.
/// `deny_unknown_fields` rejects any extra field and a missing `action` is
/// rejected by serde, so the route fails closed on malformed envelopes.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProcessDataEnvelope {
    action: String,
    payload: serde_json::Value,
    registration_metadata: EnclaveRegistrationMetadata,
}

/// Parses and validates the `/process_data` request body, rejecting unknown
/// fields, any `action` other than [`PROCESS_DATA_ACTION`], and any registration
/// metadata whose `verifier_config_key` is not the identity family key
/// (fail-closed). The config key/version supply still comes from the worker
/// (orchestration layer); the handler never touches it.
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
    let config_key = envelope.registration_metadata.verifier_config_key;
    if config_key != IDENTITY_VERIFIER_CONFIG_KEY {
        return Err(format!(
            "registration metadata verifier_config_key {config_key} does not match the identity \
             family key {IDENTITY_VERIFIER_CONFIG_KEY}"
        )
        .into());
    }
    Ok(envelope)
}

/// Server-owned finalization: signs a [`ProcessOutput::Signable`] payload with the
/// ephemeral key and injects the registration metadata into the result envelope,
/// preserving byte order. [`ProcessOutput::Unsigned`] envelopes are returned
/// verbatim.
///
/// The handler emits the [`ProcessOutput::Signable`] variant for verified results
/// with empty `signature` / `public_key` placeholders; overwriting those existing
/// keys keeps their canonical position because `serde_json` preserves key order
/// (the `preserve_order` feature). Registration metadata is appended last. A
/// verified result that lacks a non-empty signable payload is rejected upstream
/// in `process_output_from_identity`, so a signable result always carries signing
/// bytes here (fail-closed).
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
    eprintln!("waiting for sonari membership bootstrap config on vsock port {port}");
    let mut stream = listener.accept()?;
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes)?;
    let config: BootstrapConfig = serde_json::from_slice(&bytes)?;
    // The World ID base URL is intentionally NOT installed from the host-supplied
    // bootstrap config: the production server path pins it to
    // `WORLD_ID_API_BASE_CANONICAL` so the host cannot redirect the signed-result
    // origin. The field is still accepted on the wire for backward compatibility.
    set_env_before_server(WORLD_ID_APP_ID_ENV, &config.world_id_app_id);
    apply_egress_proxy_env(config.egress_proxy_url.as_deref());
    apply_network_env(config.network.as_deref());
    apply_proof_mode_env(config.proof_mode.as_deref());
    Ok(())
}

/// Installs or clears the Sui network env from the bootstrap config.
///
/// `Some(network)` installs the host-supplied value; `None` explicitly clears
/// the env so a stale value from a prior run can never influence the gate.
fn apply_network_env(network: Option<&str>) {
    match network {
        Some(n) => set_env_before_server(SUI_NETWORK_ENV, n),
        None => unset_env_before_server(SUI_NETWORK_ENV),
    }
}

/// Installs or clears the World ID proof mode env from the bootstrap config.
///
/// `Some(mode)` installs the host-supplied value; `None` explicitly clears the
/// env so a stale proof_mode from a prior run can never enable dummy mode.
fn apply_proof_mode_env(proof_mode: Option<&str>) {
    match proof_mode {
        Some(m) => set_env_before_server(WORLD_ID_PROOF_MODE_ENV, m),
        None => unset_env_before_server(WORLD_ID_PROOF_MODE_ENV),
    }
}

/// Installs or clears the egress proxy env from the bootstrap config.
///
/// `Some(proxy)` installs the host-supplied proxy; `None` explicitly clears the
/// env so a stale proxy from a prior run can never leak into [`TeeContext`],
/// leaving the egress direct (mirrors earthquake's always-set behaviour).
fn apply_egress_proxy_env(egress_proxy_url: Option<&str>) {
    match egress_proxy_url {
        Some(proxy) => set_env_before_server(EGRESS_PROXY_URL_KEY, proxy),
        None => unset_env_before_server(EGRESS_PROXY_URL_KEY),
    }
}

#[derive(Debug, Deserialize)]
struct BootstrapConfig {
    /// Accepted for backward compatibility but ignored: the server path pins the
    /// World ID base to [`WORLD_ID_API_BASE_CANONICAL`].
    #[allow(dead_code)]
    world_id_api_base: String,
    world_id_app_id: String,
    egress_proxy_url: Option<String>,
    /// Sui network name supplied by the host (e.g. `"testnet"`, `"mainnet"`).
    /// Optional for backward compatibility; absence is treated as unset (will
    /// cause dummy mode to be rejected by the fail-closed gate).
    network: Option<String>,
    /// World ID proof mode supplied by the host (`"real"` or `"dummy"`).
    /// Optional for backward compatibility; absence defaults to real mode.
    proof_mode: Option<String>,
}

fn set_env_before_server(name: &str, value: &str) {
    // The server is not accepting requests yet, so no other Rust thread is reading
    // the process environment when bootstrap values are installed.
    unsafe {
        env::set_var(name, value);
    }
}

fn unset_env_before_server(name: &str) {
    // The server is not accepting requests yet, so no other Rust thread is reading
    // the process environment when bootstrap clears a stale value.
    unsafe {
        env::remove_var(name);
    }
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
                signal_hash: "0x004c584cd5e136507a762e7bc3bdd3f2e2535f5d32a7c6f343e17377886cca47"
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

    mod server_mode {
        use super::super::{
            ATTESTATION_PUBLIC_KEY_LABEL, EnclaveState, IDENTITY_VERIFIER_CONFIG_KEY,
            ProcessDataEnvelope, finalize_process_output, parse_process_data_envelope,
            route_request,
        };
        use membership_tee::server::{
            EGRESS_PROXY_URL_KEY, UNSIGNED_PLACEHOLDER, process_with_verifier,
        };
        use membership_tee::{
            ResolvedWorldIdVerifierMode, VERIFIER_FAMILY, WORLD_ID_ACTION,
            WORLD_ID_API_UNAVAILABLE, WorldIdProofRequest, WorldIdVerificationStatus,
            WorldIdVerifier,
        };
        use sonari_tee_core::enclave::{EnclaveRegistrationMetadata, ProcessOutput, TeeContext};
        use sonari_tee_core::{LocalEd25519Signer, PayloadSigner};

        const SERVER_SEED: [u8; 32] = [7u8; 32];

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

        fn registration_metadata() -> EnclaveRegistrationMetadata {
            EnclaveRegistrationMetadata {
                verifier_config_key: IDENTITY_VERIFIER_CONFIG_KEY,
                verifier_config_version: 10,
                enclave_instance_public_key: format!("0x{}", "77".repeat(32)),
            }
        }

        fn world_id_request() -> membership_tee::IdentityVerifyRequest {
            membership_tee::IdentityVerifyRequest {
                registry_id: "0x1111111111111111111111111111111111111111111111111111111111111111"
                    .to_owned(),
                membership_id: "0x2222222222222222222222222222222222222222222222222222222222222222"
                    .to_owned(),
                owner: "0x3333333333333333333333333333333333333333333333333333333333333333"
                    .to_owned(),
                provider: membership_tee::IdentityProvider::WorldId,
                issued_at_ms: None,
                validity_ms: None,
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
                    signal_hash:
                        "0x004c584cd5e136507a762e7bc3bdd3f2e2535f5d32a7c6f343e17377886cca47"
                            .to_owned(),
                }),
            }
        }

        fn process_data_wire_body() -> Vec<u8> {
            serde_json::to_vec(&serde_json::json!({
                "action": "process_data",
                "payload": {
                    "registry_id": "0x1111111111111111111111111111111111111111111111111111111111111111",
                    "membership_id": "0x2222222222222222222222222222222222222222222222222222222222222222",
                    "owner": "0x3333333333333333333333333333333333333333333333333333333333333333",
                    "provider": "world_id",
                    "issued_at_ms": null,
                    "validity_ms": null,
                    "terms_version": 1,
                    "signed_statement_hash": "0x6666666666666666666666666666666666666666666666666666666666666666",
                    "world_id": {
                        "world_app_id": "app_staging_123",
                        "nullifier_hash": "12345678901234567890",
                        "merkle_root": "987654321",
                        "proof": "0xproof",
                        "verification_level": "orb",
                        "action": WORLD_ID_ACTION,
                        "signal_hash": "0x004c584cd5e136507a762e7bc3bdd3f2e2535f5d32a7c6f343e17377886cca47",
                    },
                },
                "registration_metadata": {
                    "verifier_config_key": IDENTITY_VERIFIER_CONFIG_KEY,
                    "verifier_config_version": 10,
                    "enclave_instance_public_key": format!("0x{}", "77".repeat(32)),
                },
            }))
            .unwrap()
        }

        #[test]
        fn identity_verifier_config_key_is_two() {
            assert_eq!(IDENTITY_VERIFIER_CONFIG_KEY, 2);
        }

        #[test]
        fn finalize_signs_verified_payload_with_ephemeral_key_and_injects_registration_metadata() {
            let output = process_with_verifier(
                world_id_request(),
                &MockWorldIdVerifier {
                    status: WorldIdVerificationStatus::Verified,
                },
                1_900_000_000_000,
            )
            .expect("verified output is signable");
            let ProcessOutput::Signable { payload_bcs, .. } = &output else {
                panic!("verified output must be signable");
            };
            let payload_bcs = payload_bcs.clone();

            let signer = LocalEd25519Signer::new(SERVER_SEED);
            let value = finalize_process_output(output, &signer, Some(registration_metadata()))
                .expect("signable output should finalize");

            let expected = signer.sign_payload(&payload_bcs);
            assert_eq!(value["signature"], expected.signature);
            assert_eq!(value["public_key"], expected.public_key);
            // Registration metadata is injected at the JSON top level (outside the
            // BCS payload, which is unchanged), with config_key = 2.
            assert_eq!(value["verifier_config_key"], IDENTITY_VERIFIER_CONFIG_KEY);
            assert_eq!(value["verifier_config_version"], 10);
            assert_eq!(
                value["enclave_instance_public_key"],
                format!("0x{}", "77".repeat(32))
            );
            // The injected registration metadata is appended after the wire fields.
            let object = value.as_object().unwrap();
            let keys = object.keys().map(String::as_str).collect::<Vec<_>>();
            let last_three = &keys[keys.len() - 3..];
            assert_eq!(
                last_three,
                [
                    "verifier_config_key",
                    "verifier_config_version",
                    "enclave_instance_public_key",
                ]
            );
        }

        #[test]
        fn finalize_leaves_non_verified_result_unsigned_without_metadata() {
            let output = process_with_verifier(
                world_id_request(),
                &MockWorldIdVerifier {
                    status: WorldIdVerificationStatus::PendingSource {
                        error_code: WORLD_ID_API_UNAVAILABLE.to_owned(),
                    },
                },
                1_900_000_000_000,
            )
            .unwrap();
            let signer = LocalEd25519Signer::new(SERVER_SEED);

            let value = finalize_process_output(output, &signer, Some(registration_metadata()))
                .expect("unsigned output is verbatim");

            assert_eq!(value["status"], "pending_source");
            assert!(value.get("signature").is_none());
            assert!(value.get("verifier_config_key").is_none());
        }

        #[test]
        fn server_path_signs_only_with_the_injected_ephemeral_signer_not_a_fixed_seed() {
            // Two different ephemeral seeds must produce two different signatures
            // for the same payload, proving the server signs with the per-enclave
            // ephemeral key handed in (never a fixed/dev seed baked into the path).
            let make_value = |seed: [u8; 32]| {
                let output = process_with_verifier(
                    world_id_request(),
                    &MockWorldIdVerifier {
                        status: WorldIdVerificationStatus::Verified,
                    },
                    1_900_000_000_000,
                )
                .unwrap();
                finalize_process_output(
                    output,
                    &LocalEd25519Signer::new(seed),
                    Some(registration_metadata()),
                )
                .unwrap()
            };

            let signed_a = make_value([7u8; 32]);
            let signed_b = make_value([9u8; 32]);
            assert_ne!(signed_a["signature"], signed_b["signature"]);
            assert_ne!(signed_a["public_key"], signed_b["public_key"]);
            // Neither placeholder leaks into the signed output.
            assert_ne!(signed_a["signature"], UNSIGNED_PLACEHOLDER);
            assert_ne!(signed_a["public_key"], UNSIGNED_PLACEHOLDER);
        }

        #[test]
        fn route_get_attestation_signs_label_with_ephemeral_key() {
            // /get_attestation derives its embedded public key from the ephemeral
            // signing key over the membership attestation label; assert the
            // response public_key matches the seed-derived key. (NSM is exercised
            // only inside an enclave, so we validate the public key derivation via
            // the byte-stable golden test below.)
            let signer = LocalEd25519Signer::new(SERVER_SEED);
            let signature = signer.sign_payload(ATTESTATION_PUBLIC_KEY_LABEL);
            let value = sonari_tee_core::enclave::attestation_response_json(
                &[0xABu8, 0xCD, 0xEF],
                &signature.public_key,
            );
            assert_eq!(value["public_key"], signature.public_key);
        }

        #[test]
        fn attestation_label_is_membership_specific() {
            assert_eq!(
                ATTESTATION_PUBLIC_KEY_LABEL,
                b"sonari-membership-attestation-public-key"
            );
        }

        #[test]
        fn parse_envelope_accepts_real_wire_body() {
            let envelope: ProcessDataEnvelope =
                parse_process_data_envelope(&process_data_wire_body())
                    .expect("the real wire body must be accepted");
            assert_eq!(envelope.action, "process_data");
            assert_eq!(envelope.payload["provider"], "world_id");
            assert_eq!(envelope.registration_metadata.verifier_config_key, 2);
        }

        #[test]
        fn parse_envelope_rejects_unknown_outer_field() {
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
        fn parse_envelope_rejects_foreign_verifier_config_key_family() {
            let mut body: serde_json::Value =
                serde_json::from_slice(&process_data_wire_body()).unwrap();
            body["registration_metadata"]["verifier_config_key"] = serde_json::json!(1);
            let error = parse_process_data_envelope(&serde_json::to_vec(&body).unwrap())
                .expect_err("a non-identity verifier_config_key must be rejected");
            assert!(
                error
                    .to_string()
                    .contains("does not match the identity family key"),
                "error: {error}"
            );
        }

        #[test]
        fn parse_envelope_rejects_wrong_action() {
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
        fn route_process_data_signs_and_injects_metadata_end_to_end() {
            let state = EnclaveState {
                ephemeral_signing_key_seed: SERVER_SEED,
                ctx: TeeContext::new(),
                world_id_base_url: "https://developer.world.org".to_owned(),
                world_id_app_id: "app_staging_123".to_owned(),
                world_id_verifier_mode: ResolvedWorldIdVerifierMode::Real,
                world_id_mode_observation: membership_tee::world_id_mode_observation(
                    None,
                    None,
                    ResolvedWorldIdVerifierMode::Real,
                ),
            };
            // The base URL is unreachable in tests so the real World ID call maps
            // to pending_source: this still proves the route wires the handler,
            // returns 200, and leaves a non-verified result unsigned.
            let request = sonari_tee_core::enclave::HttpRequest {
                method: "POST".to_owned(),
                path: "/process_data".to_owned(),
                body: process_data_wire_body(),
            };
            let (status, value) = route_request(request, &state).expect("route should succeed");
            assert_eq!(status, 200);
            assert!(
                value["status"] == "pending_source" || value["status"] == "verified",
                "unexpected status: {}",
                value["status"]
            );
        }

        #[test]
        fn route_unknown_path_is_not_found() {
            let state = EnclaveState {
                ephemeral_signing_key_seed: SERVER_SEED,
                ctx: TeeContext::with_env([(EGRESS_PROXY_URL_KEY, "http://127.0.0.1:18080")]),
                world_id_base_url: "https://developer.world.org".to_owned(),
                world_id_app_id: "app_staging_123".to_owned(),
                world_id_verifier_mode: ResolvedWorldIdVerifierMode::Real,
                world_id_mode_observation: membership_tee::world_id_mode_observation(
                    None,
                    None,
                    ResolvedWorldIdVerifierMode::Real,
                ),
            };
            let request = sonari_tee_core::enclave::HttpRequest {
                method: "GET".to_owned(),
                path: "/unknown".to_owned(),
                body: Vec::new(),
            };
            let (status, value) = route_request(request, &state).expect("route should succeed");
            assert_eq!(status, 404);
            assert_eq!(value["error_code"], "AWS_RUNNER_PROCESS_FAILED");
        }

        /// Pins the verified server-path serialized JSON bytes (mock-verified World
        /// ID, fixed ephemeral seed, fixed registration metadata) so any future
        /// wire drift in process_with_verifier -> finalize_process_output is caught.
        #[test]
        fn verified_server_path_serialized_bytes_are_byte_stable() {
            let output = process_with_verifier(
                world_id_request(),
                &MockWorldIdVerifier {
                    status: WorldIdVerificationStatus::Verified,
                },
                1_900_000_000_000,
            )
            .expect("verified output is signable");
            let signer = LocalEd25519Signer::new(SERVER_SEED);
            let value = finalize_process_output(output, &signer, Some(registration_metadata()))
                .expect("verified output should sign");
            let serialized = serde_json::to_string(&value).expect("result should serialize");

            let golden = include_str!("testdata/verified_server_path.golden.json").trim_end();
            assert_eq!(
                serialized, golden,
                "verified server-path bytes drifted from golden vector"
            );
            // Sanity: the signed result still carries the identity contract markers.
            assert_eq!(value["verifier_family"], VERIFIER_FAMILY);
        }

        /// Pins the get_attestation response JSON for a fixed seed and document so
        /// the route's wire shape, key order, and seed-derived public key stay
        /// byte-stable across refactors.
        #[test]
        fn get_attestation_response_bytes_are_byte_stable_for_fixed_seed() {
            let signer = LocalEd25519Signer::new(SERVER_SEED);
            let signature = signer.sign_payload(ATTESTATION_PUBLIC_KEY_LABEL);
            let value = sonari_tee_core::enclave::attestation_response_json(
                &[0xABu8, 0xCD, 0xEF],
                &signature.public_key,
            );
            let serialized = serde_json::to_string(&value).expect("attestation should serialize");

            let golden = include_str!("testdata/get_attestation.golden.json").trim_end();
            assert_eq!(
                serialized, golden,
                "get_attestation bytes drifted from golden vector"
            );
        }

        /// route_get_attestation returns world_id_mode_observation key in response.
        #[test]
        fn route_get_attestation_includes_world_id_mode_observation() {
            use membership_tee::{ResolvedWorldIdVerifierMode, world_id_mode_observation};
            use sonari_tee_core::enclave::attestation_response_json_with_observation;

            let signer = LocalEd25519Signer::new(SERVER_SEED);
            let signature = signer.sign_payload(ATTESTATION_PUBLIC_KEY_LABEL);
            let obs = world_id_mode_observation(
                Some("dummy"),
                Some("testnet"),
                ResolvedWorldIdVerifierMode::Dummy,
            );
            let obs_json = serde_json::to_value(&obs).expect("observation should serialize");
            let value = attestation_response_json_with_observation(
                &[0xABu8, 0xCD, 0xEF],
                &signature.public_key,
                &obs_json,
            );

            assert!(
                value.get("world_id_mode_observation").is_some(),
                "get_attestation response must contain world_id_mode_observation"
            );
            assert_eq!(value["world_id_mode_observation"]["resolved_mode"], "dummy");
            assert_eq!(
                value["world_id_mode_observation"]["received_network"],
                "testnet"
            );
        }

        /// Pins the get_attestation-with-observation response bytes (dummy+testnet,
        /// fixed ephemeral seed, fixed document) so wire drift is caught.
        #[test]
        fn get_attestation_with_observation_bytes_are_byte_stable_for_fixed_seed() {
            use membership_tee::{ResolvedWorldIdVerifierMode, world_id_mode_observation};
            use sonari_tee_core::enclave::attestation_response_json_with_observation;

            let signer = LocalEd25519Signer::new(SERVER_SEED);
            let signature = signer.sign_payload(ATTESTATION_PUBLIC_KEY_LABEL);
            let obs = world_id_mode_observation(
                Some("dummy"),
                Some("testnet"),
                ResolvedWorldIdVerifierMode::Dummy,
            );
            let obs_json = serde_json::to_value(&obs).expect("observation should serialize");
            let value = attestation_response_json_with_observation(
                &[0xABu8, 0xCD, 0xEF],
                &signature.public_key,
                &obs_json,
            );
            let serialized = serde_json::to_string(&value)
                .expect("attestation with observation should serialize");

            let golden =
                include_str!("testdata/get_attestation_with_observation.golden.json").trim_end();
            assert_eq!(
                serialized, golden,
                "get_attestation_with_observation bytes drifted from golden vector"
            );
        }
    }

    /// Tests that mutate the process environment to exercise the bootstrap and
    /// server-state resolution. They serialise on a shared lock because the
    /// process environment is global state shared across the test binary.
    mod bootstrap_env {
        use super::super::{
            EnclaveState, apply_egress_proxy_env, enclave_state_from_env, server_world_id_base_url,
            set_env_before_server, tee_context_from_env, unset_env_before_server,
        };
        use membership_tee::server::EGRESS_PROXY_URL_KEY;
        use membership_tee::{
            ResolvedWorldIdVerifierMode, SUI_NETWORK_ENV, WORLD_ID_API_BASE_CANONICAL,
            WORLD_ID_APP_ID_ENV, WORLD_ID_PROOF_MODE_ENV,
        };
        use std::sync::Mutex;

        static ENV_LOCK: Mutex<()> = Mutex::new(());

        const TEST_SEED: [u8; 32] = [7u8; 32];

        /// dummy + mainnet → `enclave_state_from_env` must return Err (fail-closed).
        /// This guards the mainnet boundary at startup so an adversarial bootstrap
        /// config can never enable dummy mode on mainnet.
        #[test]
        fn enclave_state_rejects_dummy_mode_on_mainnet() {
            let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            set_env_before_server(WORLD_ID_APP_ID_ENV, "app_staging_123");
            set_env_before_server(WORLD_ID_PROOF_MODE_ENV, "dummy");
            set_env_before_server(SUI_NETWORK_ENV, "mainnet");

            let result = enclave_state_from_env(TEST_SEED);
            assert!(
                result.is_err(),
                "dummy mode on mainnet must be rejected at startup (fail-closed)"
            );

            unset_env_before_server(WORLD_ID_APP_ID_ENV);
            unset_env_before_server(WORLD_ID_PROOF_MODE_ENV);
            unset_env_before_server(SUI_NETWORK_ENV);
        }

        /// testnet + dummy → the resolved state carries a diagnostic observation
        /// that echoes the raw bootstrap values and the resolved mode. This is the
        /// signal that reveals issue #190: an operator can confirm from outside the
        /// enclave whether it received dummy/testnet yet resolved to real.
        #[test]
        fn enclave_state_on_testnet_dummy_exposes_observation_raw_values() {
            let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            set_env_before_server(WORLD_ID_APP_ID_ENV, "app_staging_123");
            set_env_before_server(WORLD_ID_PROOF_MODE_ENV, "dummy");
            set_env_before_server(SUI_NETWORK_ENV, "testnet");

            let state = enclave_state_from_env(TEST_SEED).expect("dummy+testnet must succeed");
            let observation = &state.world_id_mode_observation;
            assert_eq!(observation.resolved_mode, "dummy");
            assert_eq!(observation.received_proof_mode.as_deref(), Some("dummy"));
            assert_eq!(observation.received_network.as_deref(), Some("testnet"));
            assert!(!observation.redacted);

            unset_env_before_server(WORLD_ID_APP_ID_ENV);
            unset_env_before_server(WORLD_ID_PROOF_MODE_ENV);
            unset_env_before_server(SUI_NETWORK_ENV);
        }

        /// mainnet + real (the only mainnet startup the fail-closed gate allows) →
        /// the observation must redact the raw host-supplied values and report the
        /// resolved mode as real, so production never echoes bootstrap inputs.
        #[test]
        fn enclave_state_on_mainnet_real_redacts_observation() {
            let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            set_env_before_server(WORLD_ID_APP_ID_ENV, "app_staging_123");
            set_env_before_server(WORLD_ID_PROOF_MODE_ENV, "real");
            set_env_before_server(SUI_NETWORK_ENV, "mainnet");

            let state = enclave_state_from_env(TEST_SEED).expect("real+mainnet must succeed");
            let observation = &state.world_id_mode_observation;
            assert_eq!(observation.resolved_mode, "real");
            assert!(observation.received_proof_mode.is_none());
            assert!(observation.received_network.is_none());
            assert!(observation.redacted);

            unset_env_before_server(WORLD_ID_APP_ID_ENV);
            unset_env_before_server(WORLD_ID_PROOF_MODE_ENV);
            unset_env_before_server(SUI_NETWORK_ENV);
        }

        /// dummy + testnet → Ok, and the resolved mode must be Dummy.
        #[test]
        fn enclave_state_allows_dummy_mode_on_testnet() {
            let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            set_env_before_server(WORLD_ID_APP_ID_ENV, "app_staging_123");
            set_env_before_server(WORLD_ID_PROOF_MODE_ENV, "dummy");
            set_env_before_server(SUI_NETWORK_ENV, "testnet");

            let state = enclave_state_from_env(TEST_SEED).expect("dummy+testnet must succeed");
            assert_eq!(
                state.world_id_verifier_mode,
                ResolvedWorldIdVerifierMode::Dummy,
                "world_id_verifier_mode must be Dummy on testnet"
            );

            unset_env_before_server(WORLD_ID_APP_ID_ENV);
            unset_env_before_server(WORLD_ID_PROOF_MODE_ENV);
            unset_env_before_server(SUI_NETWORK_ENV);
        }

        /// dummy + network not set → Err (fail-closed: unknown/missing network must
        /// not permit dummy mode).
        #[test]
        fn enclave_state_rejects_dummy_mode_when_network_unset() {
            let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            set_env_before_server(WORLD_ID_APP_ID_ENV, "app_staging_123");
            set_env_before_server(WORLD_ID_PROOF_MODE_ENV, "dummy");
            unset_env_before_server(SUI_NETWORK_ENV);

            let result = enclave_state_from_env(TEST_SEED);
            assert!(
                result.is_err(),
                "dummy mode with no network must be rejected at startup (fail-closed)"
            );

            unset_env_before_server(WORLD_ID_APP_ID_ENV);
            unset_env_before_server(WORLD_ID_PROOF_MODE_ENV);
        }

        /// proof_mode not set → Ok, and the resolved mode must be Real (safe default).
        #[test]
        fn enclave_state_defaults_to_real_mode_when_proof_mode_unset() {
            let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            set_env_before_server(WORLD_ID_APP_ID_ENV, "app_staging_123");
            unset_env_before_server(WORLD_ID_PROOF_MODE_ENV);
            unset_env_before_server(SUI_NETWORK_ENV);

            let state = enclave_state_from_env(TEST_SEED)
                .expect("unset proof_mode must default to Real and succeed");
            assert_eq!(
                state.world_id_verifier_mode,
                ResolvedWorldIdVerifierMode::Real,
                "unset proof_mode must resolve to Real"
            );

            unset_env_before_server(WORLD_ID_APP_ID_ENV);
        }

        #[test]
        fn server_world_id_base_is_canonical_and_ignores_env() {
            let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            // An adversarial host sets a foreign https base; the production server
            // path must still pin the canonical World ID base so the signed-result
            // origin cannot be redirected.
            set_env_before_server(
                membership_tee::WORLD_ID_API_BASE_ENV,
                "https://attacker.example.com",
            );
            set_env_before_server(WORLD_ID_APP_ID_ENV, "app_staging_123");

            assert_eq!(server_world_id_base_url(), WORLD_ID_API_BASE_CANONICAL);

            let state =
                enclave_state_from_env(TEST_SEED).expect("server state should resolve from env");
            let EnclaveState {
                world_id_base_url, ..
            } = state;
            assert_eq!(
                world_id_base_url, WORLD_ID_API_BASE_CANONICAL,
                "server base must be canonical regardless of env override"
            );

            unset_env_before_server(membership_tee::WORLD_ID_API_BASE_ENV);
            unset_env_before_server(WORLD_ID_APP_ID_ENV);
        }

        #[test]
        fn bootstrap_with_no_proxy_clears_stale_egress_proxy_env() {
            let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            // A prior run left a stale proxy in the env.
            set_env_before_server(EGRESS_PROXY_URL_KEY, "http://stale.proxy:8080");
            // The new bootstrap supplies no proxy, so the bootstrap proxy handling
            // must clear the env and the resolved context must carry no egress proxy
            // (egress stays direct) rather than reusing the stale proxy.
            apply_egress_proxy_env(None);

            let ctx = tee_context_from_env();
            assert!(
                ctx.get(EGRESS_PROXY_URL_KEY).is_none(),
                "a None bootstrap proxy must yield a direct (proxy-free) context"
            );

            unset_env_before_server(EGRESS_PROXY_URL_KEY);
        }

        #[test]
        fn bootstrap_with_proxy_installs_it_into_the_context() {
            let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            apply_egress_proxy_env(Some("http://127.0.0.1:18080"));

            let ctx = tee_context_from_env();
            assert_eq!(
                ctx.get(EGRESS_PROXY_URL_KEY),
                Some("http://127.0.0.1:18080"),
                "a supplied bootstrap proxy must be installed into the context"
            );

            unset_env_before_server(EGRESS_PROXY_URL_KEY);
        }
    }
}
