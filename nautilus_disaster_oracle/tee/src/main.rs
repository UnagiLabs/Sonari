use clap::Parser;
use std::fs;
use std::path::PathBuf;
use tee::{OracleOutput, UsgsOracleInput, canonical_json_bytes, process_usgs};

#[derive(Debug, Parser)]
#[command(about = "Generate deterministic Sonari USGS oracle artifacts")]
struct Cli {
    #[arg(long)]
    case_id: String,
    #[arg(long)]
    detail: PathBuf,
    #[arg(long)]
    grid: Option<PathBuf>,
    #[arg(long)]
    raw_detail_uri: String,
    #[arg(long)]
    raw_grid_uri: Option<String>,
    #[arg(long)]
    raw_data_uri: String,
    #[arg(long)]
    affected_cells_uri: String,
    #[arg(
        long,
        default_value = "0x0707070707070707070707070707070707070707070707070707070707070707"
    )]
    signing_key_seed: String,
    #[arg(long)]
    output_dir: Option<PathBuf>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let output = process_usgs(UsgsOracleInput {
        case_id: cli.case_id,
        detail_json: fs::read(cli.detail)?,
        grid_xml: cli.grid.map(fs::read).transpose()?,
        raw_detail_uri: cli.raw_detail_uri,
        raw_grid_uri: cli.raw_grid_uri,
        raw_data_uri: cli.raw_data_uri,
        affected_cells_uri: cli.affected_cells_uri,
        signing_key_seed: parse_seed(&cli.signing_key_seed)?,
    })?;

    if let Some(output_dir) = cli.output_dir {
        write_output(&output_dir, &output)?;
    } else {
        println!("{}", serde_json::to_string_pretty(&output.result)?);
    }

    Ok(())
}

fn parse_seed(value: &str) -> Result<[u8; 32], Box<dyn std::error::Error>> {
    let value = value.strip_prefix("0x").unwrap_or(value);
    let bytes = hex::decode(value)?;
    Ok(bytes
        .try_into()
        .map_err(|_| "signing key seed must be 32 bytes")?)
}

fn write_output(
    output_dir: &PathBuf,
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
