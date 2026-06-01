use clap::{Parser, Subcommand};
use residence_allowlist::{
    GenerateOptions, GenerationStrategy, ResidenceAllowlistError,
    generate_and_write_allowlist_artifact_atomic, generate_and_write_proof_shards_atomic,
    proof_output, root_output, verify_local, verify_proof_shards,
};
use std::{fs, path::PathBuf, time::Duration};

#[derive(Debug, Parser)]
#[command(name = "residence-allowlist")]
#[command(about = "Generate and inspect local residence allowlist artifacts")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Generate(GenerateArgs),
    Root(InspectArgs),
    Proof(ProofArgs),
    ProofShards(ProofShardsArgs),
    VerifyProofShards(VerifyProofShardsArgs),
    VerifyLocal(VerifyLocalArgs),
}

#[derive(Debug, Parser)]
struct GenerateArgs {
    #[arg(long)]
    source: PathBuf,
    #[arg(long)]
    output: PathBuf,
    #[arg(long, default_value_t = 1)]
    allowlist_version: u64,
    #[arg(long, default_value = "tiler")]
    strategy: GenerationStrategy,
    #[arg(long, default_value_t = 5)]
    start_resolution: u8,
    #[arg(long, default_value_t = 7)]
    target_resolution: u8,
    #[arg(long)]
    jobs: Option<usize>,
    #[arg(long, default_value_t = 5)]
    progress_interval_seconds: u64,
}

#[derive(Debug, Parser)]
struct InspectArgs {
    #[arg(long)]
    allowlist: PathBuf,
    #[arg(long)]
    source: PathBuf,
    #[arg(long, default_value = "tiler")]
    strategy: GenerationStrategy,
    #[arg(long, default_value_t = 5)]
    start_resolution: u8,
    #[arg(long, default_value_t = 7)]
    target_resolution: u8,
    #[arg(long)]
    jobs: Option<usize>,
}

#[derive(Debug, Parser)]
struct ProofArgs {
    #[arg(long)]
    allowlist: PathBuf,
    #[arg(long)]
    source: PathBuf,
    #[arg(long)]
    h3_index: u64,
    #[arg(long, default_value = "tiler")]
    strategy: GenerationStrategy,
    #[arg(long, default_value_t = 5)]
    start_resolution: u8,
    #[arg(long, default_value_t = 7)]
    target_resolution: u8,
    #[arg(long)]
    jobs: Option<usize>,
}

#[derive(Debug, Parser)]
struct ProofShardsArgs {
    #[arg(long)]
    allowlist: PathBuf,
    #[arg(long)]
    source: PathBuf,
    #[arg(long)]
    output_dir: PathBuf,
    #[arg(long, default_value_t = 65_536)]
    shard_count: usize,
}

#[derive(Debug, Parser)]
struct VerifyProofShardsArgs {
    #[arg(long)]
    manifest: PathBuf,
    #[arg(long)]
    shards_dir: PathBuf,
}

#[derive(Debug, Parser)]
struct VerifyLocalArgs {
    #[arg(long)]
    manifest: PathBuf,
    #[arg(long)]
    allowlist: PathBuf,
    #[arg(long)]
    source: PathBuf,
    #[arg(long, default_value = "tiler")]
    strategy: GenerationStrategy,
    #[arg(long, default_value_t = 5)]
    start_resolution: u8,
    #[arg(long, default_value_t = 7)]
    target_resolution: u8,
    #[arg(long)]
    jobs: Option<usize>,
}

fn main() -> Result<(), ResidenceAllowlistError> {
    let cli = Cli::parse();

    match cli.command {
        Command::Generate(args) => generate(args),
        Command::Root(args) => {
            let output = root_output(&args.allowlist, &args.source, inspect_options(&args))?;
            println!("{}", serde_json::to_string_pretty(&output)?);
            Ok(())
        }
        Command::Proof(args) => {
            let options = GenerateOptions {
                strategy: args.strategy,
                start_resolution: args.start_resolution,
                target_resolution: args.target_resolution,
                jobs: args.jobs,
                ..GenerateOptions::default()
            };
            let output = proof_output(&args.allowlist, &args.source, args.h3_index, options)?;
            println!("{}", serde_json::to_string_pretty(&output)?);
            Ok(())
        }
        Command::ProofShards(args) => proof_shards(args),
        Command::VerifyProofShards(args) => {
            let output = verify_proof_shards(&args.manifest, &args.shards_dir)?;
            println!("{}", serde_json::to_string_pretty(&output)?);
            Ok(())
        }
        Command::VerifyLocal(args) => {
            let options = GenerateOptions {
                strategy: args.strategy,
                start_resolution: args.start_resolution,
                target_resolution: args.target_resolution,
                jobs: args.jobs,
                ..GenerateOptions::default()
            };
            let output = verify_local(&args.manifest, &args.allowlist, &args.source, options)?;
            println!("{}", serde_json::to_string_pretty(&output)?);
            Ok(())
        }
    }
}

fn generate(args: GenerateArgs) -> Result<(), ResidenceAllowlistError> {
    let source_bytes = fs::read(&args.source)?;
    let source = String::from_utf8(source_bytes.clone()).map_err(|error| {
        ResidenceAllowlistError::InvalidArtifact(format!(
            "{} must be UTF-8: {error}",
            args.source.display()
        ))
    })?;
    let options = GenerateOptions {
        allowlist_version: args.allowlist_version,
        strategy: args.strategy,
        start_resolution: args.start_resolution,
        target_resolution: args.target_resolution,
        jobs: args.jobs,
        progress_interval: Duration::from_secs(args.progress_interval_seconds),
    };
    generate_and_write_allowlist_artifact_atomic(&source, &source_bytes, &args.output, options)
}

fn proof_shards(args: ProofShardsArgs) -> Result<(), ResidenceAllowlistError> {
    let options = GenerateOptions::default();
    let manifest = generate_and_write_proof_shards_atomic(
        &args.allowlist,
        &args.source,
        &args.output_dir,
        args.shard_count,
        options,
    )?;
    println!("{}", serde_json::to_string_pretty(&manifest)?);
    Ok(())
}

fn inspect_options(args: &InspectArgs) -> GenerateOptions {
    GenerateOptions {
        strategy: args.strategy,
        start_resolution: args.start_resolution,
        target_resolution: args.target_resolution,
        jobs: args.jobs,
        ..GenerateOptions::default()
    }
}
