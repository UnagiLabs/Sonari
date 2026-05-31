use clap::{Parser, Subcommand};
use h3o::{CellIndex, Resolution};
use residence_allowlist::{
    NATURAL_EARTH_LAND_SOURCE, ProofDirection, ResidenceAllowlistError, ResidenceCellLeaf,
    ResidenceMerkleProof, generate_candidate_h3_indexes_from_geojson, generate_proof_for_h3_index,
    merkle_root_from_leaves,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fmt, fs, io, path::PathBuf};

const ALLOWLIST_SCHEMA: &str = "sonari.residence.allowlist.v1";
const ALLOWLIST_SCHEMA_VERSION: u64 = 1;
const LOCAL_GEOJSON_SOURCE_KIND: &str = "local_geojson";

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
    Root(RootArgs),
    Proof(ProofArgs),
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
}

#[derive(Debug, Parser)]
struct RootArgs {
    #[arg(long)]
    allowlist: PathBuf,
}

#[derive(Debug, Parser)]
struct ProofArgs {
    #[arg(long)]
    allowlist: PathBuf,
    #[arg(long)]
    h3_index: u64,
}

#[derive(Debug, Parser)]
struct VerifyLocalArgs {
    #[arg(long)]
    manifest: PathBuf,
    #[arg(long)]
    allowlist: PathBuf,
    #[arg(long)]
    source: PathBuf,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AllowlistArtifact {
    schema: String,
    schema_version: u64,
    source: SourceMetadata,
    geo_resolution: u8,
    allowlist_version: u64,
    h3_indexes: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SourceMetadata {
    kind: String,
    sha256: String,
    byte_length: u64,
}

#[derive(Debug)]
struct ValidatedAllowlist {
    artifact: AllowlistArtifact,
    leaves: Vec<ResidenceCellLeaf>,
}

#[derive(Debug, Serialize)]
struct RootOutput {
    merkle_root: String,
    count: usize,
    geo_resolution: u8,
    allowlist_version: u64,
}

#[derive(Debug, Serialize)]
struct ProofOutput {
    target_h3_index: String,
    target_leaf_hash: String,
    promoted_without_sibling_at_levels: Vec<usize>,
    steps: Vec<ProofStepOutput>,
    expected_root: String,
}

#[derive(Debug, Serialize)]
struct ProofStepOutput {
    direction: ProofDirection,
    sibling_on_left: bool,
    sibling_hash: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AllowlistManifest {
    schema: String,
    schema_version: u64,
    allowlist_version: u64,
    geo_resolution: u8,
    source: ManifestSource,
    generation_command: Vec<String>,
    local_artifact_path: String,
    s3: ManifestS3,
    artifact: ManifestArtifact,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ManifestSource {
    name: String,
    version: String,
    url: String,
    sha256: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ManifestS3 {
    bucket_env: String,
    object_key: String,
    version_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ManifestArtifact {
    status: String,
    generated_at: Option<String>,
    sha256: Option<String>,
    byte_size: Option<u64>,
    h3_count: Option<usize>,
    merkle_root: Option<String>,
}

#[derive(Debug, Serialize)]
struct VerifyLocalOutput {
    status: String,
    sha256: String,
    byte_size: u64,
    h3_count: usize,
    merkle_root: String,
}

#[derive(Debug)]
enum CliError {
    Io(io::Error),
    Json(serde_json::Error),
    Allowlist(ResidenceAllowlistError),
    InvalidArtifact(String),
}

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Json(error) => write!(formatter, "{error}"),
            Self::Allowlist(error) => write!(formatter, "{error}"),
            Self::InvalidArtifact(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for CliError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::Allowlist(error) => Some(error),
            Self::InvalidArtifact(_) => None,
        }
    }
}

impl From<io::Error> for CliError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for CliError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl From<ResidenceAllowlistError> for CliError {
    fn from(error: ResidenceAllowlistError) -> Self {
        Self::Allowlist(error)
    }
}

fn main() -> Result<(), CliError> {
    let cli = Cli::parse();

    match cli.command {
        Command::Generate(args) => generate(args),
        Command::Root(args) => print_root(args),
        Command::Proof(args) => print_proof(args),
        Command::VerifyLocal(args) => verify_local(args),
    }
}

fn generate(args: GenerateArgs) -> Result<(), CliError> {
    let source = fs::read_to_string(&args.source)?;
    let h3_indexes = generate_candidate_h3_indexes_from_geojson(&source)?
        .into_iter()
        .map(|index| index.to_string())
        .collect::<Vec<_>>();
    let artifact = AllowlistArtifact {
        schema: ALLOWLIST_SCHEMA.to_owned(),
        schema_version: ALLOWLIST_SCHEMA_VERSION,
        source: SourceMetadata {
            kind: LOCAL_GEOJSON_SOURCE_KIND.to_owned(),
            sha256: prefixed_hex(&Sha256::digest(source.as_bytes())),
            byte_length: source.len() as u64,
        },
        geo_resolution: NATURAL_EARTH_LAND_SOURCE.resolution,
        allowlist_version: args.allowlist_version,
        h3_indexes,
    };

    let json = format!("{}\n", serde_json::to_string_pretty(&artifact)?);
    fs::write(args.output, json)?;
    Ok(())
}

fn print_root(args: RootArgs) -> Result<(), CliError> {
    let allowlist = load_valid_allowlist(args.allowlist)?;
    let root = root_for_valid_allowlist(&allowlist)?;
    let output = RootOutput {
        merkle_root: prefixed_hex(&root),
        count: allowlist.leaves.len(),
        geo_resolution: allowlist.artifact.geo_resolution,
        allowlist_version: allowlist.artifact.allowlist_version,
    };

    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}

fn print_proof(args: ProofArgs) -> Result<(), CliError> {
    let allowlist = load_valid_allowlist(args.allowlist)?;
    let Some(proof) = generate_proof_for_h3_index(&allowlist.leaves, args.h3_index)? else {
        return Err(CliError::InvalidArtifact(format!(
            "h3_index {} is not in the residence allowlist",
            args.h3_index
        )));
    };
    let output = proof_output(proof);

    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}

fn verify_local(args: VerifyLocalArgs) -> Result<(), CliError> {
    let manifest: AllowlistManifest = serde_json::from_slice(&fs::read(args.manifest)?)?;
    validate_manifest_metadata(&manifest)?;
    let allowlist_bytes = fs::read(&args.allowlist)?;
    let allowlist = parse_valid_allowlist(&allowlist_bytes)?;
    let source_bytes = fs::read(&args.source)?;
    let root = root_for_valid_allowlist(&allowlist)?;
    let sha256 = prefixed_hex(&Sha256::digest(&allowlist_bytes));
    let source_sha256 = Sha256::digest(&source_bytes);
    let source_sha256_raw = hex_bytes(&source_sha256);
    let source_sha256_prefixed = prefixed_hex(&source_sha256);
    let byte_size = allowlist_bytes.len() as u64;
    let h3_count = allowlist.leaves.len();
    let merkle_root = prefixed_hex(&root);

    assert_manifest_field(
        "artifact.sha256",
        manifest.artifact.sha256.as_deref(),
        &sha256,
    )?;
    assert_manifest_field(
        "artifact.merkle_root",
        manifest.artifact.merkle_root.as_deref(),
        &merkle_root,
    )?;
    assert_manifest_u64("artifact.byte_size", manifest.artifact.byte_size, byte_size)?;
    assert_manifest_usize("artifact.h3_count", manifest.artifact.h3_count, h3_count)?;

    if manifest.geo_resolution != allowlist.artifact.geo_resolution {
        return Err(CliError::InvalidArtifact(format!(
            "manifest geo_resolution {} does not match allowlist {}",
            manifest.geo_resolution, allowlist.artifact.geo_resolution
        )));
    }
    if manifest.allowlist_version != allowlist.artifact.allowlist_version {
        return Err(CliError::InvalidArtifact(format!(
            "manifest allowlist_version {} does not match allowlist {}",
            manifest.allowlist_version, allowlist.artifact.allowlist_version
        )));
    }
    if manifest.source.sha256 != source_sha256_raw {
        return Err(CliError::InvalidArtifact(
            "manifest source.sha256 does not match local source file".to_owned(),
        ));
    }
    if allowlist.artifact.source.sha256 != source_sha256_prefixed {
        return Err(CliError::InvalidArtifact(
            "allowlist source.sha256 does not match local source file".to_owned(),
        ));
    }
    assert_manifest_u64(
        "allowlist source.byte_length",
        Some(allowlist.artifact.source.byte_length),
        source_bytes.len() as u64,
    )?;

    let output = VerifyLocalOutput {
        status: "verified".to_owned(),
        sha256,
        byte_size,
        h3_count,
        merkle_root,
    };
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}

fn load_valid_allowlist(path: PathBuf) -> Result<ValidatedAllowlist, CliError> {
    parse_valid_allowlist(&fs::read(path)?)
}

fn parse_valid_allowlist(bytes: &[u8]) -> Result<ValidatedAllowlist, CliError> {
    let artifact: AllowlistArtifact = serde_json::from_slice(bytes)?;
    validate_artifact(&artifact)?;
    let leaves = artifact
        .h3_indexes
        .iter()
        .map(|value| {
            parse_h3_index(value).map(|h3_index| ResidenceCellLeaf {
                h3_index,
                geo_resolution: artifact.geo_resolution,
                allowlist_version: artifact.allowlist_version,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(ValidatedAllowlist { artifact, leaves })
}

fn root_for_valid_allowlist(allowlist: &ValidatedAllowlist) -> Result<[u8; 32], CliError> {
    let Some(root) = merkle_root_from_leaves(&allowlist.leaves)? else {
        return Err(CliError::InvalidArtifact(
            "allowlist must contain at least one h3_index".to_owned(),
        ));
    };
    Ok(root)
}

fn validate_artifact(artifact: &AllowlistArtifact) -> Result<(), CliError> {
    if artifact.schema != ALLOWLIST_SCHEMA {
        return Err(CliError::InvalidArtifact(format!(
            "allowlist schema must be {ALLOWLIST_SCHEMA}"
        )));
    }
    if artifact.schema_version != ALLOWLIST_SCHEMA_VERSION {
        return Err(CliError::InvalidArtifact(format!(
            "allowlist schema_version must be {ALLOWLIST_SCHEMA_VERSION}"
        )));
    }
    if artifact.source.kind != LOCAL_GEOJSON_SOURCE_KIND {
        return Err(CliError::InvalidArtifact(format!(
            "allowlist source.kind must be {LOCAL_GEOJSON_SOURCE_KIND}"
        )));
    }
    if !is_lower_prefixed_hex(&artifact.source.sha256, 32) {
        return Err(CliError::InvalidArtifact(
            "allowlist source.sha256 must be a lowercase 0x-prefixed SHA-256 hash".to_owned(),
        ));
    }
    if artifact.source.byte_length == 0 {
        return Err(CliError::InvalidArtifact(
            "allowlist source.byte_length must be greater than zero".to_owned(),
        ));
    }
    if artifact.geo_resolution != NATURAL_EARTH_LAND_SOURCE.resolution {
        return Err(CliError::InvalidArtifact(format!(
            "allowlist geo_resolution must be {}",
            NATURAL_EARTH_LAND_SOURCE.resolution
        )));
    }
    if artifact.h3_indexes.is_empty() {
        return Err(CliError::InvalidArtifact(
            "allowlist must contain at least one h3_index".to_owned(),
        ));
    }

    let mut previous = None;
    for raw in &artifact.h3_indexes {
        let current = parse_h3_index(raw)?;
        if let Some(previous_index) = previous {
            if current == previous_index {
                return Err(CliError::InvalidArtifact(format!(
                    "duplicate h3_index in residence allowlist: {current}"
                )));
            }
            if current < previous_index {
                return Err(CliError::InvalidArtifact(
                    "allowlist h3_indexes must be sorted ascending".to_owned(),
                ));
            }
        }
        previous = Some(current);
    }

    Ok(())
}

fn validate_manifest_metadata(manifest: &AllowlistManifest) -> Result<(), CliError> {
    if manifest.schema != "sonari.residence.allowlist.manifest.v1" {
        return Err(CliError::InvalidArtifact(
            "manifest schema must be sonari.residence.allowlist.manifest.v1".to_owned(),
        ));
    }
    if manifest.schema_version != 1 {
        return Err(CliError::InvalidArtifact(
            "manifest schema_version must be 1".to_owned(),
        ));
    }
    if manifest.source.name.is_empty()
        || manifest.source.version.is_empty()
        || manifest.source.url.is_empty()
    {
        return Err(CliError::InvalidArtifact(
            "manifest source name, version, and url must not be empty".to_owned(),
        ));
    }
    if !is_lower_hex(&manifest.source.sha256, 32) {
        return Err(CliError::InvalidArtifact(
            "manifest source.sha256 must be a lowercase SHA-256 hash".to_owned(),
        ));
    }
    if manifest.geo_resolution != NATURAL_EARTH_LAND_SOURCE.resolution {
        return Err(CliError::InvalidArtifact(format!(
            "manifest geo_resolution must be {}",
            NATURAL_EARTH_LAND_SOURCE.resolution
        )));
    }
    if manifest.s3.bucket_env != "SONARI_RESIDENCE_CELLS_BUCKET" {
        return Err(CliError::InvalidArtifact(
            "manifest s3.bucket_env must be SONARI_RESIDENCE_CELLS_BUCKET".to_owned(),
        ));
    }
    if manifest.s3.object_key.is_empty() {
        return Err(CliError::InvalidArtifact(
            "manifest s3.object_key must not be empty".to_owned(),
        ));
    }
    if manifest.generation_command.is_empty() {
        return Err(CliError::InvalidArtifact(
            "manifest generation_command must not be empty".to_owned(),
        ));
    }
    Ok(())
}

fn assert_manifest_field(
    field: &str,
    actual: Option<&str>,
    expected: &str,
) -> Result<(), CliError> {
    let Some(actual) = actual else {
        return Err(CliError::InvalidArtifact(format!(
            "manifest {field} is required for local verification"
        )));
    };
    if actual != expected {
        return Err(CliError::InvalidArtifact(format!(
            "manifest {field} {actual} does not match computed {expected}"
        )));
    }
    Ok(())
}

fn assert_manifest_u64(field: &str, actual: Option<u64>, expected: u64) -> Result<(), CliError> {
    let Some(actual) = actual else {
        return Err(CliError::InvalidArtifact(format!(
            "manifest {field} is required for local verification"
        )));
    };
    if actual != expected {
        return Err(CliError::InvalidArtifact(format!(
            "manifest {field} {actual} does not match computed {expected}"
        )));
    }
    Ok(())
}

fn assert_manifest_usize(
    field: &str,
    actual: Option<usize>,
    expected: usize,
) -> Result<(), CliError> {
    let Some(actual) = actual else {
        return Err(CliError::InvalidArtifact(format!(
            "manifest {field} is required for local verification"
        )));
    };
    if actual != expected {
        return Err(CliError::InvalidArtifact(format!(
            "manifest {field} {actual} does not match computed {expected}"
        )));
    }
    Ok(())
}

fn parse_h3_index(value: &str) -> Result<u64, CliError> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(CliError::InvalidArtifact(format!(
            "h3_index must be a decimal u64 string: {value}"
        )));
    }
    if value != "0" && value.starts_with('0') {
        return Err(CliError::InvalidArtifact(format!(
            "h3_index must not contain leading zeroes: {value}"
        )));
    }
    let parsed = value.parse::<u64>().map_err(|_| {
        CliError::InvalidArtifact(format!("h3_index is outside the u64 range: {value}"))
    })?;
    let cell = CellIndex::try_from(parsed).map_err(|error| {
        CliError::InvalidArtifact(format!("h3_index is not a valid H3 cell index: {error}"))
    })?;
    if cell.resolution() != Resolution::Seven {
        return Err(CliError::InvalidArtifact(format!(
            "h3_index resolution must be {}: {value}",
            NATURAL_EARTH_LAND_SOURCE.resolution
        )));
    }

    Ok(parsed)
}

fn proof_output(proof: ResidenceMerkleProof) -> ProofOutput {
    ProofOutput {
        target_h3_index: proof.target_h3_index.to_string(),
        target_leaf_hash: prefixed_hex(&proof.target_leaf_hash),
        promoted_without_sibling_at_levels: proof.promoted_without_sibling_at_levels,
        steps: proof
            .steps
            .into_iter()
            .map(|step| ProofStepOutput {
                direction: step.direction,
                sibling_on_left: step.sibling_on_left,
                sibling_hash: prefixed_hex(&step.sibling_hash),
            })
            .collect(),
        expected_root: prefixed_hex(&proof.expected_root),
    }
}

fn prefixed_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(2 + (bytes.len() * 2));
    output.push_str("0x");
    output.push_str(&hex_bytes(bytes));
    output
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn is_lower_prefixed_hex(value: &str, byte_len: usize) -> bool {
    let Some(hex) = value.strip_prefix("0x") else {
        return false;
    };
    is_lower_hex(hex, byte_len)
}

fn is_lower_hex(hex: &str, byte_len: usize) -> bool {
    hex.len() == byte_len * 2
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
