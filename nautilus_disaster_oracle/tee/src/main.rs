use clap::{Parser, Subcommand};
use std::fs;
use std::path::{Path, PathBuf};
use tee::{OracleOutput, UsgsOracleInput, canonical_json_bytes, process_usgs};

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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let (input, output_dir) = match cli.command {
        Some(Command::Fixture(args)) => fixture_input(args)?,
        None => low_level_input(cli)?,
    };
    let output = process_usgs(input)?;

    if let Some(output_dir) = output_dir {
        write_output(&output_dir, &output)?;
    } else {
        println!("{}", serde_json::to_string_pretty(&output.result)?);
    }

    Ok(())
}

fn low_level_input(
    cli: Cli,
) -> Result<(UsgsOracleInput, Option<PathBuf>), Box<dyn std::error::Error>> {
    let signing_key_seed = signing_key_seed(false, cli.signing_key_seed)?;
    Ok((
        UsgsOracleInput {
            case_id: required(cli.case_id, "--case-id")?,
            detail_json: fs::read(required(cli.detail, "--detail")?)?,
            grid_xml: cli.grid.map(fs::read).transpose()?,
            raw_detail_uri: required(cli.raw_detail_uri, "--raw-detail-uri")?,
            raw_grid_uri: cli.raw_grid_uri,
            raw_data_uri: required(cli.raw_data_uri, "--raw-data-uri")?,
            affected_cells_uri: required(cli.affected_cells_uri, "--affected-cells-uri")?,
            signing_key_seed,
        },
        cli.output_dir,
    ))
}

fn fixture_input(
    args: FixtureArgs,
) -> Result<(UsgsOracleInput, Option<PathBuf>), Box<dyn std::error::Error>> {
    let case_dir = args.fixtures_dir.join(&args.case);
    let input_dir = case_dir.join("input");
    let detail_path = input_dir.join("usgs_detail.json");
    let grid_path = input_dir.join("usgs_grid.xml");
    let source_event_id = source_event_id(&detail_path)?;
    let output_dir = args.write_expected.then(|| case_dir.join("expected"));
    let signing_key_seed = signing_key_seed(args.sign_dev, args.signing_key_seed)?;

    Ok((
        UsgsOracleInput {
            case_id: args.case,
            detail_json: fs::read(&detail_path)?,
            grid_xml: grid_path
                .exists()
                .then(|| fs::read(&grid_path))
                .transpose()?,
            raw_detail_uri: display_path(&detail_path),
            raw_grid_uri: grid_path.exists().then(|| display_path(&grid_path)),
            raw_data_uri: format!(
                "ipfs://sonari/examples/{source_event_id}/raw_data_manifest.json"
            ),
            affected_cells_uri: format!(
                "ipfs://sonari/examples/{source_event_id}/affected_cells.json"
            ),
            signing_key_seed,
        },
        output_dir,
    ))
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
