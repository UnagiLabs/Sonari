use clap::{Parser, Subcommand};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use tee::{
    DEFAULT_WALRUS_CLI_TIMEOUT_MS, LocalEd25519Signer, OracleOutput, UsgsOracleInput,
    WalrusCliSourceArchive, WalrusCliSourceArchiveConfig, canonical_json_bytes,
    grid_xml_from_artifact, parse_command_timeout_ms, parse_epochs, process_usgs_with_signer,
    process_usgs_with_source_archive,
};

const DEV_SIGNING_KEY_SEED: &str =
    "0x0707070707070707070707070707070707070707070707070707070707070707";

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

fn low_level_input(cli: Cli) -> Result<RunConfig, Box<dyn std::error::Error>> {
    let walrus_archive = walrus_archive_config(&cli)?;
    let signing_key_seed = signing_key_seed(false, cli.signing_key_seed)?;
    let detail_path = required(cli.detail, "--detail")?;
    let (grid_xml, raw_grid_bytes, raw_grid_uri) = grid_input(cli.grid, cli.raw_grid_uri)?;
    Ok(RunConfig {
        input: UsgsOracleInput {
            case_id: required(cli.case_id, "--case-id")?,
            detail_json: fs::read(detail_path)?,
            grid_xml,
            raw_grid_bytes,
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
            detail_json: fs::read(&detail_path)?,
            grid_xml,
            raw_grid_bytes,
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
    sign_dev: bool,
    signing_key_seed: Option<String>,
) -> Result<[u8; 32], Box<dyn std::error::Error>> {
    let seed = match (signing_key_seed, sign_dev) {
        (Some(seed), _) => seed,
        (None, true) | (None, false) => DEV_SIGNING_KEY_SEED.to_owned(),
    };
    parse_seed(&seed)
}

fn parse_seed(value: &str) -> Result<[u8; 32], Box<dyn std::error::Error>> {
    let value = value.strip_prefix("0x").unwrap_or(value);
    let bytes = hex::decode(value)?;
    Ok(bytes
        .try_into()
        .map_err(|_| "signing key seed must be 32 bytes")?)
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
            output_dir.join("unsigned_payload_v1.json"),
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
