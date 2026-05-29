use clap::{Parser, Subcommand};
use serde::Serialize;
use sonari_tee_core::{DEV_SIGNING_KEY_SEED_HEX, parse_seed, signing_key_seed_from_env};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tee::{
    DEFAULT_WALRUS_CLI_TIMEOUT_MS, LocalEd25519Signer, OracleOutput, UsgsOracleInput,
    WalrusCliSourceArchive, WalrusCliSourceArchiveConfig, canonical_json_bytes,
    grid_xml_from_artifact, parse_command_timeout_ms, parse_epochs,
    process_usgs_from_worker_request, process_usgs_with_signer, process_usgs_with_source_archive,
};

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
    walrus_config: Option<PathBuf>,
    #[arg(long)]
    walrus_context: Option<String>,
    #[arg(long)]
    walrus_wallet: Option<String>,
    #[arg(long)]
    walrus_upload_relay: Option<String>,
    #[arg(long)]
    walrus_aggregator_url: Option<String>,
    #[arg(long)]
    walrus_epochs: Option<u32>,
    #[arg(long)]
    walrus_timeout_ms: Option<u64>,
}

#[derive(Debug, Subcommand)]
enum Command {
    Fixture(FixtureArgs),
    Production(ProductionArgs),
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

fn production_result(args: ProductionArgs) -> Result<TeeJsonResult, Box<dyn std::error::Error>> {
    let seed = strict_signing_key_seed(args.signing_key_seed)?;
    let request_json: serde_json::Value =
        serde_json::from_slice(&production_request_bytes(args.input)?)?;
    let request = tee::WorkerToTeeRequest::from_json_value(request_json)?;
    let detail_url = format!(
        "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/{}.geojson",
        request.source_event_id
    );
    let detail_json = match reqwest::blocking::get(&detail_url).and_then(|response| {
        if response.status().is_success() {
            response.bytes()
        } else {
            Err(response.error_for_status().unwrap_err())
        }
    }) {
        Ok(bytes) => bytes.to_vec(),
        Err(_) => {
            return Ok(TeeJsonResult::PendingSource {
                source_event_id: request.source_event_id,
                error_code: "USGS_DETAIL_UNAVAILABLE",
            });
        }
    };
    let detail_value: serde_json::Value = match serde_json::from_slice(&detail_json) {
        Ok(value) => value,
        Err(_) => {
            return Ok(TeeJsonResult::PendingSource {
                source_event_id: request.source_event_id,
                error_code: "USGS_DETAIL_UNAVAILABLE",
            });
        }
    };
    let Some(canonical_source_event_id) =
        canonical_usgs_detail_id_for_request(&detail_value, &request.source_event_id)
    else {
        return Ok(TeeJsonResult::PendingSource {
            source_event_id: request.source_event_id,
            error_code: "USGS_DETAIL_UNAVAILABLE",
        });
    };

    let grid = match preferred_grid_uri_from_detail(&detail_value) {
        Some(uri) => match fetch_grid(&uri) {
            Ok(grid) => Some(grid),
            Err(_) => {
                return Ok(TeeJsonResult::PendingSource {
                    source_event_id: request.source_event_id,
                    error_code: "SHAKEMAP_GRID_UNAVAILABLE",
                });
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
        return output_to_tee_json(preliminary);
    }

    let signer = LocalEd25519Signer::new(seed);
    let archive = WalrusCliSourceArchive::new(WalrusCliSourceArchiveConfig::from_env()?)?;
    let output = process_usgs_with_source_archive(input, &archive, &signer)?;
    output_to_tee_json(output)
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
        raw_detail_uri: format!(
            "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/{id}.geojson"
        ),
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

fn fetch_grid(uri: &str) -> Result<FetchedGrid, Box<dyn std::error::Error>> {
    let bytes = match reqwest::blocking::get(uri).and_then(|response| {
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
        payload: tee::UnsignedPayload,
        payload_bcs_hex: String,
        signature: String,
        public_key: String,
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
            Ok(TeeJsonResult::Finalized {
                payload,
                payload_bcs_hex,
                signature: signature.signature,
                public_key: signature.public_key,
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
    let (grid_xml, raw_grid_bytes, raw_grid_uri) = grid_input(cli.grid, cli.raw_grid_uri)?;
    Ok(RunConfig {
        input: UsgsOracleInput {
            case_id: required(cli.case_id, "--case-id")?,
            detail_json,
            grid_xml,
            raw_grid_bytes,
            observed_at_ms,
            raw_detail_uri: required(cli.raw_detail_uri, "--raw-detail-uri")?,
            raw_grid_uri,
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
    let (grid_xml, raw_grid_bytes, raw_grid_uri) = if grid_path.exists() {
        grid_input(Some(grid_path), None)?
    } else {
        (None, None, None)
    };

    Ok(RunConfig {
        input: UsgsOracleInput {
            case_id: args.case,
            detail_json,
            grid_xml,
            raw_grid_bytes,
            observed_at_ms,
            raw_detail_uri: display_path(&detail_path),
            raw_grid_uri,
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

fn grid_input(
    grid_path: Option<PathBuf>,
    raw_grid_uri: Option<String>,
) -> Result<(Option<Vec<u8>>, Option<Vec<u8>>, Option<String>), Box<dyn std::error::Error>> {
    let Some(grid_path) = grid_path else {
        return Ok((None, None, None));
    };

    let raw_grid_uri = raw_grid_uri.unwrap_or_else(|| display_path(&grid_path));
    let grid_bytes = fs::read(&grid_path)?;
    let grid_xml = grid_xml_from_artifact(&raw_grid_uri, &grid_bytes)?;
    Ok((Some(grid_xml), Some(grid_bytes), Some(raw_grid_uri)))
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

    let aggregator_url = cli
        .walrus_aggregator_url
        .clone()
        .or_else(|| non_empty_env("SONARI_WALRUS_AGGREGATOR_URL"))
        .ok_or("--walrus-aggregator-url or SONARI_WALRUS_AGGREGATOR_URL is required with --walrus-archive")?;
    let epochs = match cli
        .walrus_epochs
        .map(Ok)
        .or_else(|| non_empty_env("SONARI_WALRUS_EPOCHS").map(|value| parse_epochs(&value)))
    {
        Some(epochs) => epochs?,
        None => 2,
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
        config_path: cli
            .walrus_config
            .clone()
            .or_else(|| env::var_os("SONARI_WALRUS_CONFIG").map(PathBuf::from)),
        context: cli
            .walrus_context
            .clone()
            .or_else(|| non_empty_env("SONARI_WALRUS_CONTEXT")),
        wallet: cli
            .walrus_wallet
            .clone()
            .or_else(|| non_empty_env("SONARI_WALRUS_WALLET")),
        upload_relay: cli
            .walrus_upload_relay
            .clone()
            .or_else(|| non_empty_env("SONARI_WALRUS_UPLOAD_RELAY")),
        aggregator_url,
        epochs,
        command_timeout_ms,
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
            "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us7000abcd.geojson"
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
