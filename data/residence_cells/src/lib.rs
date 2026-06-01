use flate2::{Compression, GzBuilder, read::GzDecoder};
use geo::{
    BooleanOps, Geometry as GeoGeometry, LineString, MultiPolygon, Polygon, Rect, Relate, coord,
};
use geojson::{Feature, GeoJson};
use h3o::{
    CellIndex, Resolution,
    geom::{ContainmentMode, TilerBuilder},
};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fmt, fs, io,
    io::{BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

const ALLOWLIST_SCHEMA: &str = "sonari.residence.allowlist.v1";
const ALLOWLIST_SCHEMA_VERSION: u64 = 1;
const LOCAL_GEOJSON_SOURCE_KIND: &str = "local_geojson";
const MANIFEST_SCHEMA: &str = "sonari.residence.allowlist.manifest.v1";
const MANIFEST_SCHEMA_VERSION: u64 = 1;
const PROOF_MANIFEST_SCHEMA: &str = "sonari.residence.proof_manifest.v1";
const PROOF_MANIFEST_SCHEMA_VERSION: u64 = 1;
const PROOF_SHARD_SCHEMA: &str = "sonari.residence.proof_shard.v1";
const PROOF_SHARD_SCHEMA_VERSION: u64 = 1;
const PROOF_SHARD_OBJECT_KEY_RULE: &str =
    "residence-cells/v{allowlist_version}/res{geo_resolution}/proofs/shards/{shard_id:05}.json.gz";
const S3_BUCKET_ENV: &str = "SONARI_RESIDENCE_CELLS_BUCKET";
const PI: f64 = std::f64::consts::PI;
const FRAC_PI_2: f64 = std::f64::consts::FRAC_PI_2;
const TWO_PI: f64 = std::f64::consts::TAU;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LandSourceManifest {
    pub source_name: &'static str,
    pub version: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub resolution: u8,
    pub containment_mode: &'static str,
}

pub const NATURAL_EARTH_LAND_SOURCE: LandSourceManifest = LandSourceManifest {
    source_name: "Natural Earth ne_10m_land",
    version: "v5.1.2",
    url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_land.geojson",
    sha256: "1ac90796408bc6ad6911d69448485d3c4dbf2190370080368a09976e1c9f7416",
    resolution: 7,
    containment_mode: "h3o::geom::ContainmentMode::Covers",
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GenerationStrategy {
    Hierarchical,
    Tiler,
}

impl std::str::FromStr for GenerationStrategy {
    type Err = ResidenceAllowlistError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "hierarchical" => Ok(Self::Hierarchical),
            "tiler" => Ok(Self::Tiler),
            _ => Err(ResidenceAllowlistError::InvalidArgument(format!(
                "strategy must be hierarchical or tiler: {value}"
            ))),
        }
    }
}

impl fmt::Display for GenerationStrategy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Hierarchical => write!(formatter, "hierarchical"),
            Self::Tiler => write!(formatter, "tiler"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GenerateOptions {
    pub allowlist_version: u64,
    pub strategy: GenerationStrategy,
    pub start_resolution: u8,
    pub target_resolution: u8,
    pub jobs: Option<usize>,
    pub progress_interval: Duration,
}

impl Default for GenerateOptions {
    fn default() -> Self {
        Self {
            allowlist_version: 1,
            strategy: GenerationStrategy::Tiler,
            start_resolution: 5,
            target_resolution: NATURAL_EARTH_LAND_SOURCE.resolution,
            jobs: None,
            progress_interval: Duration::from_secs(5),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ResidenceCellLeaf {
    pub h3_index: u64,
    pub geo_resolution: u8,
    pub allowlist_version: u64,
}

#[derive(Debug)]
pub enum ResidenceAllowlistError {
    DuplicateH3Index(u64),
    InvalidArgument(String),
    InvalidArtifact(String),
    InvalidLandGeometry(String),
    Io(io::Error),
    Json(serde_json::Error),
    LeafEncoding(bcs::Error),
    MalformedLandSource(String),
}

impl fmt::Display for ResidenceAllowlistError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateH3Index(h3_index) => {
                write!(
                    formatter,
                    "duplicate h3_index in residence allowlist: {h3_index}"
                )
            }
            Self::InvalidArgument(error) | Self::InvalidArtifact(error) => {
                write!(formatter, "{error}")
            }
            Self::InvalidLandGeometry(error) => {
                write!(formatter, "invalid residence land geometry: {error}")
            }
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Json(error) => write!(formatter, "{error}"),
            Self::LeafEncoding(error) => {
                write!(formatter, "failed to encode residence leaf: {error}")
            }
            Self::MalformedLandSource(error) => {
                write!(formatter, "malformed residence land source: {error}")
            }
        }
    }
}

impl std::error::Error for ResidenceAllowlistError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::LeafEncoding(error) => Some(error),
            Self::DuplicateH3Index(_)
            | Self::InvalidArgument(_)
            | Self::InvalidArtifact(_)
            | Self::InvalidLandGeometry(_)
            | Self::MalformedLandSource(_) => None,
        }
    }
}

impl From<bcs::Error> for ResidenceAllowlistError {
    fn from(error: bcs::Error) -> Self {
        Self::LeafEncoding(error)
    }
}

impl From<io::Error> for ResidenceAllowlistError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for ResidenceAllowlistError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AllowlistArtifact {
    pub schema: String,
    pub schema_version: u64,
    pub source: SourceMetadata,
    pub geo_resolution: u8,
    pub allowlist_version: u64,
    pub h3_indexes: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceMetadata {
    pub kind: String,
    pub name: String,
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub byte_length: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AllowlistManifest {
    pub schema: String,
    pub schema_version: u64,
    pub allowlist_version: u64,
    pub geo_resolution: u8,
    pub source: ManifestSource,
    pub generation_command: Vec<String>,
    pub local_artifact_path: String,
    pub s3: ManifestS3,
    pub artifact: ManifestArtifact,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestSource {
    pub name: String,
    pub version: String,
    pub url: String,
    pub sha256: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestS3 {
    pub bucket_env: String,
    pub object_key: String,
    pub version_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestArtifact {
    pub status: String,
    pub generated_at: Option<String>,
    pub sha256: Option<String>,
    pub byte_size: Option<u64>,
    pub h3_count: Option<usize>,
    pub merkle_root: Option<String>,
}

#[derive(Debug)]
pub struct ValidatedAllowlist {
    pub artifact: AllowlistArtifact,
    pub leaves: Vec<ResidenceCellLeaf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ProofDirection {
    #[serde(rename = "LEFT")]
    Left,
    #[serde(rename = "RIGHT")]
    Right,
}

impl ProofDirection {
    pub fn sibling_on_left(self) -> bool {
        matches!(self, Self::Left)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ResidenceProofStep {
    pub direction: ProofDirection,
    pub sibling_on_left: bool,
    pub sibling_hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResidenceMerkleProof {
    pub target_h3_index: u64,
    pub target_leaf_hash: [u8; 32],
    pub promoted_without_sibling_at_levels: Vec<usize>,
    pub steps: Vec<ResidenceProofStep>,
    pub expected_root: [u8; 32],
}

#[derive(Debug, Serialize)]
pub struct RootOutput {
    pub merkle_root: String,
    pub count: usize,
    pub geo_resolution: u8,
    pub allowlist_version: u64,
}

#[derive(Debug, Serialize)]
pub struct ProofOutput {
    pub target_h3_index: String,
    pub target_leaf_hash: String,
    pub promoted_without_sibling_at_levels: Vec<usize>,
    pub steps: Vec<ProofStepOutput>,
    pub expected_root: String,
}

#[derive(Debug, Serialize)]
pub struct ProofStepOutput {
    pub direction: ProofDirection,
    pub sibling_on_left: bool,
    pub sibling_hash: String,
}

#[derive(Debug, Serialize)]
pub struct VerifyLocalOutput {
    pub status: String,
    pub sha256: String,
    pub byte_size: u64,
    pub h3_count: usize,
    pub merkle_root: String,
}

#[derive(Debug, Serialize)]
pub struct VerifyProofShardsOutput {
    pub status: String,
    pub shard_count: usize,
    pub total_proof_count: usize,
    pub verified_shards: usize,
    pub verified_proofs: usize,
    pub merkle_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GeneratedProofShards {
    pub manifest: ProofShardManifest,
    pub shards: Vec<ProofShard>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProofShardManifest {
    pub schema: String,
    pub schema_version: u64,
    pub allowlist_version: u64,
    pub geo_resolution: u8,
    pub merkle_root: String,
    pub shard_count: usize,
    pub total_proof_count: usize,
    pub object_key_rule: String,
    pub shards: Vec<ProofShardInventoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProofShardInventoryEntry {
    pub shard_id: usize,
    pub object_key: String,
    pub proof_count: usize,
    pub sha256: String,
    pub byte_size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProofShard {
    pub schema: String,
    pub schema_version: u64,
    pub allowlist_version: u64,
    pub geo_resolution: u8,
    pub merkle_root: String,
    pub shard_id: usize,
    pub shard_count: usize,
    pub proofs: Vec<ProofShardEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProofShardEntry {
    pub h3_index: String,
    pub leaf_hash: String,
    pub proof: Vec<ProofShardStep>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProofShardStep {
    pub sibling_on_left: bool,
    pub sibling_hash: String,
}

struct ProofShardBuildContext {
    sorted: Vec<(ResidenceCellLeaf, [u8; 32])>,
    levels: Vec<Vec<[u8; 32]>>,
    merkle_root: String,
    allowlist_version: u64,
    geo_resolution: u8,
    shard_count: usize,
}

struct ProofShardLeafIndices {
    starts: Vec<usize>,
    leaf_indices: Vec<usize>,
}

struct HashingWriter<W> {
    inner: W,
    hasher: Sha256,
    byte_size: u64,
}

impl<W: Write> HashingWriter<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
            byte_size: 0,
        }
    }

    fn finish(self) -> (W, String, u64) {
        (
            self.inner,
            prefixed_hex(&self.hasher.finalize()),
            self.byte_size,
        )
    }
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(buf)?;
        self.hasher.update(&buf[..written]);
        self.byte_size += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

pub fn build_allowlist_artifact(
    source: &str,
    source_bytes: &[u8],
    options: GenerateOptions,
) -> Result<AllowlistArtifact, ResidenceAllowlistError> {
    build_allowlist_artifact_with_manifest(source, source_bytes, options, NATURAL_EARTH_LAND_SOURCE)
}

pub fn build_allowlist_artifact_with_manifest(
    source: &str,
    source_bytes: &[u8],
    options: GenerateOptions,
    manifest: LandSourceManifest,
) -> Result<AllowlistArtifact, ResidenceAllowlistError> {
    let source_hash = sha256_hex(source_bytes);
    if source_hash != manifest.sha256 {
        return Err(ResidenceAllowlistError::InvalidArtifact(
            "source file does not match pinned Natural Earth source".to_owned(),
        ));
    }
    if options.target_resolution != manifest.resolution {
        return Err(ResidenceAllowlistError::InvalidArgument(format!(
            "target resolution must be {} for this allowlist",
            manifest.resolution
        )));
    }
    if options.start_resolution > options.target_resolution {
        return Err(ResidenceAllowlistError::InvalidArgument(
            "start resolution must be less than or equal to target resolution".to_owned(),
        ));
    }

    let indexes = generate_candidate_h3_indexes_from_geojson(source, options)?;
    Ok(AllowlistArtifact {
        schema: ALLOWLIST_SCHEMA.to_owned(),
        schema_version: ALLOWLIST_SCHEMA_VERSION,
        source: SourceMetadata {
            kind: LOCAL_GEOJSON_SOURCE_KIND.to_owned(),
            name: manifest.source_name.to_owned(),
            version: manifest.version.to_owned(),
            url: manifest.url.to_owned(),
            sha256: format!("0x{source_hash}"),
            byte_length: source_bytes.len() as u64,
        },
        geo_resolution: manifest.resolution,
        allowlist_version: options.allowlist_version,
        h3_indexes: indexes.into_iter().map(|index| index.to_string()).collect(),
    })
}

pub fn write_allowlist_artifact_atomic(
    output: &Path,
    artifact: &AllowlistArtifact,
) -> Result<(), ResidenceAllowlistError> {
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp_path = tmp_path_for(output)?;
    let json = format!("{}\n", serde_json::to_string_pretty(artifact)?);
    fs::write(&tmp_path, json)?;
    fs::rename(tmp_path, output)?;
    Ok(())
}

pub fn generate_and_write_allowlist_artifact_atomic(
    source: &str,
    source_bytes: &[u8],
    output: &Path,
    options: GenerateOptions,
) -> Result<(), ResidenceAllowlistError> {
    let source_hash = sha256_hex(source_bytes);
    if source_hash != NATURAL_EARTH_LAND_SOURCE.sha256 {
        return Err(ResidenceAllowlistError::InvalidArtifact(
            "source file does not match pinned Natural Earth source".to_owned(),
        ));
    }
    if options.target_resolution != NATURAL_EARTH_LAND_SOURCE.resolution {
        return Err(ResidenceAllowlistError::InvalidArgument(format!(
            "target resolution must be {} for this allowlist",
            NATURAL_EARTH_LAND_SOURCE.resolution
        )));
    }
    if options.start_resolution > options.target_resolution {
        return Err(ResidenceAllowlistError::InvalidArgument(
            "start resolution must be less than or equal to target resolution".to_owned(),
        ));
    }

    let indexes = generate_candidate_h3_indexes_from_geojson(source, options)?;
    write_allowlist_indexes_atomic(output, source_bytes, &source_hash, options, &indexes)
}

pub fn write_allowlist_indexes_atomic(
    output: &Path,
    source_bytes: &[u8],
    source_hash: &str,
    options: GenerateOptions,
    indexes: &[u64],
) -> Result<(), ResidenceAllowlistError> {
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp_path = tmp_path_for(output)?;
    let tmp_file = fs::File::create(&tmp_path)?;
    let mut writer = BufWriter::new(tmp_file);

    writeln!(writer, "{{")?;
    writeln!(writer, "  \"schema\": \"{ALLOWLIST_SCHEMA}\",")?;
    writeln!(writer, "  \"schema_version\": {ALLOWLIST_SCHEMA_VERSION},")?;
    writeln!(writer, "  \"source\": {{")?;
    writeln!(writer, "    \"kind\": \"{LOCAL_GEOJSON_SOURCE_KIND}\",")?;
    writeln!(
        writer,
        "    \"name\": \"{}\",",
        NATURAL_EARTH_LAND_SOURCE.source_name
    )?;
    writeln!(
        writer,
        "    \"version\": \"{}\",",
        NATURAL_EARTH_LAND_SOURCE.version
    )?;
    writeln!(
        writer,
        "    \"url\": \"{}\",",
        NATURAL_EARTH_LAND_SOURCE.url
    )?;
    writeln!(writer, "    \"sha256\": \"0x{source_hash}\",")?;
    writeln!(writer, "    \"byte_length\": {}", source_bytes.len())?;
    writeln!(writer, "  }},")?;
    writeln!(
        writer,
        "  \"geo_resolution\": {},",
        NATURAL_EARTH_LAND_SOURCE.resolution
    )?;
    writeln!(
        writer,
        "  \"allowlist_version\": {},",
        options.allowlist_version
    )?;
    writeln!(writer, "  \"h3_indexes\": [")?;
    for (index, h3_index) in indexes.iter().enumerate() {
        let suffix = if index + 1 == indexes.len() { "" } else { "," };
        writeln!(writer, "    \"{h3_index}\"{suffix}")?;
    }
    writeln!(writer, "  ]")?;
    writeln!(writer, "}}")?;
    writer.flush()?;
    fs::rename(tmp_path, output)?;
    Ok(())
}

pub fn generate_candidate_h3_indexes_from_geojson(
    source: &str,
    options: GenerateOptions,
) -> Result<Vec<u64>, ResidenceAllowlistError> {
    let polygons = load_land_polygons_from_geojson(source)?;
    match options.strategy {
        GenerationStrategy::Hierarchical => {
            generate_candidate_h3_indexes_hierarchical(&polygons, options)
        }
        GenerationStrategy::Tiler => generate_candidate_h3_indexes_tiler(&polygons, options),
    }
}

pub fn load_land_polygons_from_geojson(
    source: &str,
) -> Result<Vec<Polygon>, ResidenceAllowlistError> {
    let geojson = source
        .parse::<GeoJson>()
        .map_err(|error| ResidenceAllowlistError::MalformedLandSource(error.to_string()))?;
    let mut polygons = Vec::new();

    match geojson {
        GeoJson::FeatureCollection(collection) => {
            if collection.features.is_empty() {
                return Err(ResidenceAllowlistError::MalformedLandSource(
                    "feature collection is empty".to_owned(),
                ));
            }
            for feature in collection.features {
                append_feature_polygons(feature, &mut polygons)?;
            }
        }
        GeoJson::Feature(feature) => append_feature_polygons(feature, &mut polygons)?,
        GeoJson::Geometry(geometry) => append_geometry_polygons(geometry, &mut polygons)?,
    }

    if polygons.is_empty() {
        return Err(ResidenceAllowlistError::MalformedLandSource(
            "land source contains no Polygon or MultiPolygon geometry".to_owned(),
        ));
    }

    Ok(polygons)
}

pub fn generate_candidate_h3_indexes_tiler(
    polygons: &[Polygon],
    options: GenerateOptions,
) -> Result<Vec<u64>, ResidenceAllowlistError> {
    let resolution = resolution_from_u8(options.target_resolution)?;
    let produced_label = format!("H3 res{} candidate cells", options.target_resolution);
    let progress = Progress::new(
        polygons.len(),
        "polygons",
        produced_label,
        options.progress_interval,
    );
    let generate = || {
        polygons
            .par_iter()
            .map(|polygon| {
                let mut tiler = TilerBuilder::new(resolution)
                    .containment_mode(ContainmentMode::Covers)
                    .build();
                tiler.add(polygon.clone()).map_err(|error| {
                    ResidenceAllowlistError::InvalidLandGeometry(error.to_string())
                })?;
                let indexes = tiler.into_coverage().map(u64::from).collect::<Vec<_>>();
                progress.tick(indexes.len());
                Ok::<Vec<u64>, ResidenceAllowlistError>(indexes)
            })
            .try_reduce(Vec::new, |mut left, mut right| {
                left.append(&mut right);
                Ok::<Vec<u64>, ResidenceAllowlistError>(left)
            })
    };

    let mut indexes: Vec<u64> = if let Some(jobs) = options.jobs {
        if jobs == 0 {
            return Err(ResidenceAllowlistError::InvalidArgument(
                "jobs must be greater than zero".to_owned(),
            ));
        }
        rayon::ThreadPoolBuilder::new()
            .num_threads(jobs)
            .build()
            .map_err(|error| ResidenceAllowlistError::InvalidArgument(error.to_string()))?
            .install(generate)?
    } else {
        generate()?
    };
    indexes.sort_unstable();
    indexes.dedup();
    Ok(indexes)
}

pub fn generate_candidate_h3_indexes_hierarchical(
    polygons: &[Polygon],
    options: GenerateOptions,
) -> Result<Vec<u64>, ResidenceAllowlistError> {
    let start_resolution = resolution_from_u8(options.start_resolution)?;
    let target_resolution = resolution_from_u8(options.target_resolution)?;
    let land = Arc::new(MultiPolygon::new(
        polygons.iter().cloned().map(polygon_to_radians).collect(),
    ));
    let start_cells = generate_candidate_start_cells(polygons, land.as_ref(), start_resolution)?;
    let total = start_cells.len();
    let produced_label = format!("H3 res{} candidate cells", options.target_resolution);
    let progress = Progress::new(
        total,
        "start cells",
        produced_label,
        options.progress_interval,
    );

    let generate = || {
        start_cells
            .par_iter()
            .map(|cell| {
                let mut output = Vec::new();
                collect_descendants(*cell, target_resolution, land.as_ref(), &mut output);
                progress.tick(output.len());
                output
            })
            .reduce(Vec::new, |mut left, mut right| {
                left.append(&mut right);
                left
            })
    };

    let mut indexes = if let Some(jobs) = options.jobs {
        if jobs == 0 {
            return Err(ResidenceAllowlistError::InvalidArgument(
                "jobs must be greater than zero".to_owned(),
            ));
        }
        rayon::ThreadPoolBuilder::new()
            .num_threads(jobs)
            .build()
            .map_err(|error| ResidenceAllowlistError::InvalidArgument(error.to_string()))?
            .install(generate)
    } else {
        generate()
    };

    indexes.sort_unstable();
    indexes.dedup();
    Ok(indexes)
}

pub fn leaf_bcs_bytes(leaf: &ResidenceCellLeaf) -> Result<Vec<u8>, bcs::Error> {
    bcs::to_bytes(leaf)
}

pub fn leaf_hash(leaf: &ResidenceCellLeaf) -> Result<[u8; 32], bcs::Error> {
    let leaf_bcs = leaf_bcs_bytes(leaf)?;
    let mut hasher = Sha256::new();
    hasher.update([0x00]);
    hasher.update(leaf_bcs);
    Ok(hasher.finalize().into())
}

pub fn internal_node_hash(left: [u8; 32], right: [u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update([0x01]);
    hasher.update(left);
    hasher.update(right);
    hasher.finalize().into()
}

pub fn merkle_root_from_leaf_hashes(leaf_hashes: &[[u8; 32]]) -> Option<[u8; 32]> {
    let mut level = leaf_hashes.to_vec();
    if level.is_empty() {
        return None;
    }

    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for chunk in level.chunks(2) {
            if chunk.len() == 1 {
                next.push(chunk[0]);
            } else {
                next.push(internal_node_hash(chunk[0], chunk[1]));
            }
        }
        level = next;
    }

    level.first().copied()
}

pub fn merkle_root_from_leaves(
    leaves: &[ResidenceCellLeaf],
) -> Result<Option<[u8; 32]>, ResidenceAllowlistError> {
    let leaf_hashes = sorted_leaf_hashes(leaves)?
        .into_iter()
        .map(|(_, hash)| hash)
        .collect::<Vec<_>>();
    Ok(merkle_root_from_leaf_hashes(&leaf_hashes))
}

pub fn generate_proof_for_h3_index(
    leaves: &[ResidenceCellLeaf],
    target_h3_index: u64,
) -> Result<Option<ResidenceMerkleProof>, ResidenceAllowlistError> {
    let sorted = sorted_leaf_hashes(leaves)?;
    let Some(target_index) = sorted
        .iter()
        .position(|(leaf, _)| leaf.h3_index == target_h3_index)
    else {
        return Ok(None);
    };

    let leaf_hashes = sorted.iter().map(|(_, hash)| *hash).collect::<Vec<_>>();
    let Some(expected_root) = merkle_root_from_leaf_hashes(&leaf_hashes) else {
        return Ok(None);
    };
    let Some((_, target_leaf_hash)) = sorted.get(target_index).copied() else {
        return Ok(None);
    };

    let mut current_index = target_index;
    let mut level = leaf_hashes;
    let mut level_index = 0;
    let mut promoted_without_sibling_at_levels = Vec::new();
    let mut steps = Vec::new();

    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        let mut next_target_index = None;

        for left_index in (0..level.len()).step_by(2) {
            let Some(left_hash) = level.get(left_index).copied() else {
                return Ok(None);
            };
            let right_index = left_index + 1;
            let Some(right_hash) = level.get(right_index).copied() else {
                if current_index == left_index {
                    promoted_without_sibling_at_levels.push(level_index);
                    next_target_index = Some(next.len());
                }
                next.push(left_hash);
                continue;
            };

            if current_index == left_index {
                steps.push(proof_step(ProofDirection::Right, right_hash));
                next_target_index = Some(next.len());
            } else if current_index == right_index {
                steps.push(proof_step(ProofDirection::Left, left_hash));
                next_target_index = Some(next.len());
            }

            next.push(internal_node_hash(left_hash, right_hash));
        }

        let Some(index) = next_target_index else {
            return Ok(None);
        };
        current_index = index;
        level = next;
        level_index += 1;
    }

    Ok(Some(ResidenceMerkleProof {
        target_h3_index,
        target_leaf_hash,
        promoted_without_sibling_at_levels,
        steps,
        expected_root,
    }))
}

pub fn generate_proof_shards(
    leaves: &[ResidenceCellLeaf],
    shard_count: usize,
) -> Result<GeneratedProofShards, ResidenceAllowlistError> {
    let context = build_proof_shard_context(leaves, shard_count)?;

    let mut shards = (0..context.shard_count)
        .map(|shard_id| ProofShard {
            schema: PROOF_SHARD_SCHEMA.to_owned(),
            schema_version: PROOF_SHARD_SCHEMA_VERSION,
            allowlist_version: context.allowlist_version,
            geo_resolution: context.geo_resolution,
            merkle_root: context.merkle_root.clone(),
            shard_id,
            shard_count: context.shard_count,
            proofs: Vec::new(),
        })
        .collect::<Vec<_>>();

    for (leaf_index, (leaf, _)) in context.sorted.iter().enumerate() {
        let shard_id = (leaf.h3_index % context.shard_count as u64) as usize;
        let entry = proof_shard_entry_from_context(&context, leaf_index)?;
        let Some(shard) = shards.get_mut(shard_id) else {
            return Err(ResidenceAllowlistError::InvalidArtifact(format!(
                "computed shard_id {shard_id} is outside shard_count {}",
                context.shard_count
            )));
        };
        shard.proofs.push(entry);
    }

    let inventory = shards
        .iter()
        .map(|shard| {
            let shard_bytes = proof_shard_gzip_bytes(shard)?;
            Ok(ProofShardInventoryEntry {
                shard_id: shard.shard_id,
                object_key: proof_shard_object_key(
                    shard.allowlist_version,
                    shard.geo_resolution,
                    shard.shard_id,
                ),
                proof_count: shard.proofs.len(),
                sha256: prefixed_hex(&Sha256::digest(&shard_bytes)),
                byte_size: shard_bytes.len() as u64,
            })
        })
        .collect::<Result<Vec<_>, ResidenceAllowlistError>>()?;

    Ok(GeneratedProofShards {
        manifest: ProofShardManifest {
            schema: PROOF_MANIFEST_SCHEMA.to_owned(),
            schema_version: PROOF_MANIFEST_SCHEMA_VERSION,
            allowlist_version: context.allowlist_version,
            geo_resolution: context.geo_resolution,
            merkle_root: context.merkle_root,
            shard_count: context.shard_count,
            total_proof_count: context.sorted.len(),
            object_key_rule: PROOF_SHARD_OBJECT_KEY_RULE.to_owned(),
            shards: inventory,
        },
        shards,
    })
}

pub fn proof_shard_json_bytes(shard: &ProofShard) -> Result<Vec<u8>, ResidenceAllowlistError> {
    Ok(serde_json::to_vec(shard)?)
}

pub fn proof_shard_gzip_bytes(shard: &ProofShard) -> Result<Vec<u8>, ResidenceAllowlistError> {
    let mut encoder = GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), Compression::default());
    encoder.write_all(&proof_shard_json_bytes(shard)?)?;
    Ok(encoder.finish()?)
}

pub fn replay_proof_shard_entry(
    entry: &ProofShardEntry,
) -> Result<String, ResidenceAllowlistError> {
    let mut current = parse_prefixed_hex_32("leaf_hash", &entry.leaf_hash)?;
    for step in &entry.proof {
        let sibling = parse_prefixed_hex_32("sibling_hash", &step.sibling_hash)?;
        current = if step.sibling_on_left {
            internal_node_hash(sibling, current)
        } else {
            internal_node_hash(current, sibling)
        };
    }
    Ok(prefixed_hex(&current))
}

pub fn parse_valid_allowlist(bytes: &[u8]) -> Result<ValidatedAllowlist, ResidenceAllowlistError> {
    parse_allowlist_with_validator(bytes, validate_artifact)
}

fn parse_allowlist_with_validator(
    bytes: &[u8],
    validator: fn(&AllowlistArtifact) -> Result<(), ResidenceAllowlistError>,
) -> Result<ValidatedAllowlist, ResidenceAllowlistError> {
    let artifact: AllowlistArtifact = serde_json::from_slice(bytes)?;
    validator(&artifact)?;
    let leaves = artifact
        .h3_indexes
        .iter()
        .map(|value| {
            parse_h3_index(value, artifact.geo_resolution).map(|h3_index| ResidenceCellLeaf {
                h3_index,
                geo_resolution: artifact.geo_resolution,
                allowlist_version: artifact.allowlist_version,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(ValidatedAllowlist { artifact, leaves })
}

pub fn load_verified_allowlist(
    allowlist_path: &Path,
    source_path: &Path,
    options: GenerateOptions,
) -> Result<ValidatedAllowlist, ResidenceAllowlistError> {
    let allowlist = parse_valid_allowlist(&fs::read(allowlist_path)?)?;
    let source_bytes = fs::read(source_path)?;
    let source = String::from_utf8(source_bytes.clone()).map_err(|error| {
        ResidenceAllowlistError::InvalidArtifact(format!("{source_path:?} must be UTF-8: {error}"))
    })?;
    validate_allowlist_matches_source(&allowlist, &source, &source_bytes, options)?;
    Ok(allowlist)
}

pub fn validate_allowlist_matches_source(
    allowlist: &ValidatedAllowlist,
    source: &str,
    source_bytes: &[u8],
    options: GenerateOptions,
) -> Result<(), ResidenceAllowlistError> {
    let source_sha256 = sha256_hex(source_bytes);
    if source_sha256 != NATURAL_EARTH_LAND_SOURCE.sha256 {
        return Err(ResidenceAllowlistError::InvalidArtifact(
            "local source file does not match pinned Natural Earth source".to_owned(),
        ));
    }
    validate_allowlist_matches_source_content(allowlist, source, source_bytes, options)
}

fn validate_allowlist_matches_source_content(
    allowlist: &ValidatedAllowlist,
    source: &str,
    source_bytes: &[u8],
    options: GenerateOptions,
) -> Result<(), ResidenceAllowlistError> {
    let source_sha256 = sha256_hex(source_bytes);
    let source_sha256_prefixed = format!("0x{source_sha256}");

    if allowlist.artifact.source.sha256 != source_sha256_prefixed {
        return Err(ResidenceAllowlistError::InvalidArtifact(
            "allowlist source.sha256 does not match local source file".to_owned(),
        ));
    }
    if allowlist.artifact.source.byte_length != source_bytes.len() as u64 {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "allowlist source.byte_length {} does not match computed {}",
            allowlist.artifact.source.byte_length,
            source_bytes.len()
        )));
    }

    let generated_indexes = generate_candidate_h3_indexes_from_geojson(source, options)?
        .into_iter()
        .map(|index| index.to_string())
        .collect::<Vec<_>>();
    if generated_indexes != allowlist.artifact.h3_indexes {
        return Err(ResidenceAllowlistError::InvalidArtifact(
            "allowlist h3_indexes do not match the pinned Natural Earth source".to_owned(),
        ));
    }

    Ok(())
}

pub fn generate_and_write_proof_shards_atomic(
    allowlist_path: &Path,
    source_path: &Path,
    output_dir: &Path,
    shard_count: usize,
    options: GenerateOptions,
) -> Result<ProofShardManifest, ResidenceAllowlistError> {
    if shard_count == 0 {
        return Err(ResidenceAllowlistError::InvalidArgument(
            "shard_count must be greater than zero".to_owned(),
        ));
    }

    let allowlist = load_verified_allowlist(allowlist_path, source_path, options)?;
    write_proof_shards_from_leaves_atomic(output_dir, &allowlist.leaves, shard_count)
}

pub fn write_proof_shards_from_leaves_atomic(
    output_dir: &Path,
    leaves: &[ResidenceCellLeaf],
    shard_count: usize,
) -> Result<ProofShardManifest, ResidenceAllowlistError> {
    let context = build_proof_shard_context(leaves, shard_count)?;
    let shards_dir = output_dir.join("shards");
    fs::create_dir_all(&shards_dir)?;
    let shard_indices = proof_shard_leaf_indices(&context);
    let mut inventory = Vec::with_capacity(context.shard_count);

    for shard_id in 0..context.shard_count {
        let start = shard_indices.starts[shard_id];
        let end = shard_indices.starts[shard_id + 1];
        let leaf_indices = &shard_indices.leaf_indices[start..end];
        inventory.push(write_proof_shard_from_indices_atomic(
            &shards_dir,
            &context,
            shard_id,
            leaf_indices,
        )?);
    }

    let manifest = ProofShardManifest {
        schema: PROOF_MANIFEST_SCHEMA.to_owned(),
        schema_version: PROOF_MANIFEST_SCHEMA_VERSION,
        allowlist_version: context.allowlist_version,
        geo_resolution: context.geo_resolution,
        merkle_root: context.merkle_root,
        shard_count: context.shard_count,
        total_proof_count: context.sorted.len(),
        object_key_rule: PROOF_SHARD_OBJECT_KEY_RULE.to_owned(),
        shards: inventory,
    };
    write_proof_shard_manifest_atomic(output_dir, &manifest)?;
    Ok(manifest)
}

pub fn write_generated_proof_shards_atomic(
    output_dir: &Path,
    generated: &GeneratedProofShards,
) -> Result<(), ResidenceAllowlistError> {
    let shards_dir = output_dir.join("shards");
    fs::create_dir_all(&shards_dir)?;

    for shard in &generated.shards {
        let shard_path = shards_dir.join(format!("{:05}.json.gz", shard.shard_id));
        write_bytes_atomic(&shard_path, &proof_shard_gzip_bytes(shard)?)?;
    }

    write_proof_shard_manifest_atomic(output_dir, &generated.manifest)
}

pub fn verify_proof_shards(
    manifest_path: &Path,
    shards_dir: &Path,
) -> Result<VerifyProofShardsOutput, ResidenceAllowlistError> {
    let manifest: ProofShardManifest = serde_json::from_slice(&fs::read(manifest_path)?)?;
    validate_proof_shard_manifest(&manifest)?;
    reject_unexpected_shard_files(shards_dir, manifest.shard_count)?;

    let mut inventory_by_id = vec![None; manifest.shard_count];
    for inventory in &manifest.shards {
        if inventory_by_id[inventory.shard_id].is_some() {
            return Err(ResidenceAllowlistError::InvalidArtifact(format!(
                "duplicate shard inventory entry for shard_id {}",
                inventory.shard_id
            )));
        }
        inventory_by_id[inventory.shard_id] = Some(inventory);
    }

    let mut verified_proofs = 0usize;
    let mut seen_h3_indexes = std::collections::BTreeSet::new();
    for (shard_id, inventory) in inventory_by_id.into_iter().enumerate() {
        let Some(inventory) = inventory else {
            return Err(ResidenceAllowlistError::InvalidArtifact(format!(
                "missing shard inventory entry for shard_id {shard_id}"
            )));
        };
        let shard_path = shards_dir.join(format!("{shard_id:05}.json.gz"));
        if !shard_path.is_file() {
            return Err(ResidenceAllowlistError::InvalidArtifact(format!(
                "missing shard file {}",
                shard_path.display()
            )));
        }

        let compressed = fs::read(&shard_path)?;
        if compressed.len() as u64 != inventory.byte_size {
            return Err(ResidenceAllowlistError::InvalidArtifact(format!(
                "shard {shard_id} byte_size {} does not match manifest {}",
                compressed.len(),
                inventory.byte_size
            )));
        }
        let actual_sha256 = prefixed_hex(&Sha256::digest(&compressed));
        if actual_sha256 != inventory.sha256 {
            return Err(ResidenceAllowlistError::InvalidArtifact(format!(
                "shard {shard_id} sha256 {actual_sha256} does not match manifest {}",
                inventory.sha256
            )));
        }

        let shard = read_proof_shard_gzip(&shard_path, &compressed)?;
        verified_proofs += validate_proof_shard_contents(
            &manifest,
            inventory,
            shard_id,
            &shard,
            &mut seen_h3_indexes,
        )?;
    }

    if verified_proofs != manifest.total_proof_count {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "verified proof count {verified_proofs} does not match manifest total_proof_count {}",
            manifest.total_proof_count
        )));
    }
    if seen_h3_indexes.len() != manifest.total_proof_count {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "unique proof count {} does not match manifest total_proof_count {}",
            seen_h3_indexes.len(),
            manifest.total_proof_count
        )));
    }

    Ok(VerifyProofShardsOutput {
        status: "verified".to_owned(),
        shard_count: manifest.shard_count,
        total_proof_count: manifest.total_proof_count,
        verified_shards: manifest.shard_count,
        verified_proofs,
        merkle_root: manifest.merkle_root,
    })
}

pub fn root_output(
    allowlist_path: &Path,
    source_path: &Path,
    options: GenerateOptions,
) -> Result<RootOutput, ResidenceAllowlistError> {
    let allowlist = load_verified_allowlist(allowlist_path, source_path, options)?;
    let root = root_for_valid_allowlist(&allowlist)?;
    Ok(RootOutput {
        merkle_root: prefixed_hex(&root),
        count: allowlist.leaves.len(),
        geo_resolution: allowlist.artifact.geo_resolution,
        allowlist_version: allowlist.artifact.allowlist_version,
    })
}

pub fn proof_output(
    allowlist_path: &Path,
    source_path: &Path,
    raw_h3_index: u64,
    options: GenerateOptions,
) -> Result<ProofOutput, ResidenceAllowlistError> {
    let allowlist = load_verified_allowlist(allowlist_path, source_path, options)?;
    let target_resolution = allowlist.artifact.geo_resolution;
    let h3_index = parse_h3_index(&raw_h3_index.to_string(), target_resolution)?;
    let Some(proof) = generate_proof_for_h3_index(&allowlist.leaves, h3_index)? else {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "h3_index {h3_index} is not in the residence allowlist"
        )));
    };
    Ok(format_proof_output(proof))
}

pub fn verify_local(
    manifest_path: &Path,
    allowlist_path: &Path,
    source_path: &Path,
    options: GenerateOptions,
) -> Result<VerifyLocalOutput, ResidenceAllowlistError> {
    let manifest: AllowlistManifest = serde_json::from_slice(&fs::read(manifest_path)?)?;
    validate_manifest_metadata(&manifest)?;
    let allowlist_bytes = fs::read(allowlist_path)?;
    let allowlist = parse_valid_allowlist(&allowlist_bytes)?;
    let source_bytes = fs::read(source_path)?;
    let source = String::from_utf8(source_bytes.clone()).map_err(|error| {
        ResidenceAllowlistError::InvalidArtifact(format!("{source_path:?} must be UTF-8: {error}"))
    })?;
    let root = root_for_valid_allowlist(&allowlist)?;
    let artifact_sha256 = prefixed_hex(&Sha256::digest(&allowlist_bytes));
    let source_sha256 = sha256_hex(&source_bytes);
    let byte_size = allowlist_bytes.len() as u64;
    let h3_count = allowlist.leaves.len();
    let merkle_root = prefixed_hex(&root);

    assert_manifest_field(
        "artifact.sha256",
        manifest.artifact.sha256.as_deref(),
        &artifact_sha256,
    )?;
    assert_manifest_field(
        "artifact.merkle_root",
        manifest.artifact.merkle_root.as_deref(),
        &merkle_root,
    )?;
    assert_manifest_u64("artifact.byte_size", manifest.artifact.byte_size, byte_size)?;
    assert_manifest_usize("artifact.h3_count", manifest.artifact.h3_count, h3_count)?;

    if manifest.geo_resolution != allowlist.artifact.geo_resolution {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "manifest geo_resolution {} does not match allowlist {}",
            manifest.geo_resolution, allowlist.artifact.geo_resolution
        )));
    }
    if manifest.allowlist_version != allowlist.artifact.allowlist_version {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "manifest allowlist_version {} does not match allowlist {}",
            manifest.allowlist_version, allowlist.artifact.allowlist_version
        )));
    }
    if manifest.source.sha256 != source_sha256 {
        return Err(ResidenceAllowlistError::InvalidArtifact(
            "manifest source.sha256 does not match local source file".to_owned(),
        ));
    }
    validate_allowlist_matches_source(&allowlist, &source, &source_bytes, options)?;

    Ok(VerifyLocalOutput {
        status: "verified".to_owned(),
        sha256: artifact_sha256,
        byte_size,
        h3_count,
        merkle_root,
    })
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex_bytes(&Sha256::digest(data))
}

pub fn prefixed_hex(bytes: &[u8]) -> String {
    format!("0x{}", hex_bytes(bytes))
}

pub fn hex_bytes(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn generate_candidate_start_cells(
    polygons: &[Polygon],
    land: &MultiPolygon,
    start_resolution: Resolution,
) -> Result<Vec<CellIndex>, ResidenceAllowlistError> {
    let seed_resolution = cmp_resolution(start_resolution, Resolution::Three);
    let mut tiler = TilerBuilder::new(seed_resolution)
        .containment_mode(ContainmentMode::Covers)
        .build();
    tiler
        .add_batch(polygons.iter().cloned())
        .map_err(|error| ResidenceAllowlistError::InvalidLandGeometry(error.to_string()))?;

    let seed_cells = tiler.into_coverage().collect::<Vec<_>>();
    let mut cells = if seed_resolution == start_resolution {
        seed_cells
    } else {
        seed_cells
            .par_iter()
            .flat_map_iter(|cell| {
                cell.children(start_resolution)
                    .filter(|child| land.relate(&cell_boundary(*child)).is_intersects())
            })
            .collect::<Vec<_>>()
    };
    cells.sort_unstable();
    cells.dedup();
    Ok(cells)
}

fn cmp_resolution(left: Resolution, right: Resolution) -> Resolution {
    if left <= right { left } else { right }
}

fn collect_descendants(
    cell: CellIndex,
    target_resolution: Resolution,
    land: &MultiPolygon,
    output: &mut Vec<u64>,
) {
    let relation = land.relate(&cell_boundary(cell));
    if !relation.is_intersects() {
        return;
    }

    if cell.resolution() == target_resolution {
        output.push(u64::from(cell));
        return;
    }

    if relation.is_covers() {
        output.extend(cell.children(target_resolution).map(u64::from));
        return;
    }

    let child_resolution = resolution_from_u8(u8::from(cell.resolution()) + 1)
        .expect("child resolution stays inside the H3 range");
    for child in cell.children(child_resolution) {
        collect_descendants(child, target_resolution, land, output);
    }
}

fn append_feature_polygons(
    feature: Feature,
    polygons: &mut Vec<Polygon>,
) -> Result<(), ResidenceAllowlistError> {
    let Some(geometry) = feature.geometry else {
        return Err(ResidenceAllowlistError::MalformedLandSource(
            "feature is missing geometry".to_owned(),
        ));
    };
    append_geometry_polygons(geometry, polygons)
}

fn append_geometry_polygons(
    geometry: geojson::Geometry,
    polygons: &mut Vec<Polygon>,
) -> Result<(), ResidenceAllowlistError> {
    let geometry = GeoGeometry::try_from(geometry)
        .map_err(|error| ResidenceAllowlistError::MalformedLandSource(error.to_string()))?;
    append_geo_polygons(geometry, polygons)
}

fn append_geo_polygons(
    geometry: GeoGeometry,
    polygons: &mut Vec<Polygon>,
) -> Result<(), ResidenceAllowlistError> {
    match geometry {
        GeoGeometry::Polygon(polygon) => polygons.push(polygon),
        GeoGeometry::MultiPolygon(multipolygon) => polygons.extend(multipolygon.0),
        _ => {
            return Err(ResidenceAllowlistError::MalformedLandSource(
                "land source geometry must be Polygon or MultiPolygon".to_owned(),
            ));
        }
    }
    Ok(())
}

fn polygon_to_radians(mut polygon: Polygon) -> Polygon {
    polygon.exterior_mut(line_string_to_radians);
    polygon.interiors_mut(|interiors| {
        for interior in interiors {
            line_string_to_radians(interior);
        }
    });
    polygon
}

fn line_string_to_radians(line: &mut LineString) {
    for coord in line.coords_mut() {
        coord.x = coord.x.to_radians();
        coord.y = coord.y.to_radians();
    }
}

fn cell_boundary(cell: CellIndex) -> MultiPolygon {
    let boundary = LineString::new(
        cell.boundary()
            .iter()
            .copied()
            .map(|ll| coord! { x: ll.lng_radians(), y: ll.lat_radians() })
            .collect(),
    );
    let polygon = Polygon::new(boundary, Vec::new());
    if is_transmeridian(&polygon) {
        fix_transmeridian(polygon)
    } else {
        MultiPolygon::new(vec![polygon])
    }
}

fn is_transmeridian(geom: &Polygon) -> bool {
    geom.exterior()
        .lines()
        .any(|line| (line.start.x - line.end.x).abs() > PI)
}

fn fix_transmeridian(mut polygon: Polygon) -> MultiPolygon {
    let west = Rect::new(
        coord! { x: PI, y: -FRAC_PI_2 },
        coord! { x: TWO_PI, y: FRAC_PI_2 },
    )
    .to_polygon();
    let east = Rect::new(
        coord! { x: 0., y: -FRAC_PI_2 },
        coord! { x: PI, y: FRAC_PI_2 },
    )
    .to_polygon();

    shift_transmeridian(&mut polygon);
    let mut fixed = polygon.intersection(&west);
    unshift_transmeridian(&mut fixed);
    fix_clipping_boundary(&mut fixed, true);

    let mut other = polygon.intersection(&east);
    fix_clipping_boundary(&mut other, false);
    fixed.0.extend(other.0);
    fixed
}

fn shift_transmeridian(geom: &mut Polygon) {
    geom.exterior_mut(shift_transmeridian_ring);
    geom.interiors_mut(|interiors| {
        for interior in interiors {
            shift_transmeridian_ring(interior);
        }
    });
}

fn unshift_transmeridian(geom: &mut MultiPolygon) {
    for polygon in geom.iter_mut() {
        polygon.exterior_mut(unshift_transmeridian_ring);
        polygon.interiors_mut(|interiors| {
            for interior in interiors {
                unshift_transmeridian_ring(interior);
            }
        });
    }
}

fn shift_transmeridian_ring(ring: &mut LineString) {
    for coord in ring.coords_mut() {
        if coord.x < 0. {
            coord.x += TWO_PI;
        }
    }
}

fn unshift_transmeridian_ring(ring: &mut LineString) {
    for coord in ring.coords_mut() {
        if coord.x >= PI {
            coord.x -= TWO_PI;
        }
    }
}

fn fix_clipping_boundary(geom: &mut MultiPolygon, is_west: bool) {
    for polygon in geom.iter_mut() {
        polygon.exterior_mut(|exterior| fix_ring_clipping_boundary(exterior, is_west));
        polygon.interiors_mut(|interiors| {
            for interior in interiors {
                fix_ring_clipping_boundary(interior, is_west);
            }
        });
    }
}

fn fix_ring_clipping_boundary(ring: &mut LineString, is_west: bool) {
    const ROUNDING_EPSILON: f64 = 1e-6;
    let (bad_value, fixed_value) = if is_west {
        let mut bad_value = PI;
        for coord in ring.coords() {
            if (coord.x - PI).abs() <= ROUNDING_EPSILON {
                bad_value = coord.x;
                break;
            }
            bad_value = bad_value.min(coord.x);
        }
        (bad_value, -PI)
    } else {
        let mut bad_value = -PI;
        for coord in ring.coords() {
            if (coord.x + PI).abs() <= ROUNDING_EPSILON {
                bad_value = coord.x;
                break;
            }
            bad_value = bad_value.max(coord.x);
        }
        (bad_value, PI)
    };

    for coord in ring.coords_mut() {
        if coord.x == bad_value {
            coord.x = fixed_value;
        }
    }
}

fn root_for_valid_allowlist(
    allowlist: &ValidatedAllowlist,
) -> Result<[u8; 32], ResidenceAllowlistError> {
    let Some(root) = merkle_root_from_leaves(&allowlist.leaves)? else {
        return Err(ResidenceAllowlistError::InvalidArtifact(
            "allowlist must contain at least one h3_index".to_owned(),
        ));
    };
    Ok(root)
}

fn validate_artifact(artifact: &AllowlistArtifact) -> Result<(), ResidenceAllowlistError> {
    validate_allowlist_shape(artifact)?;
    if artifact.source.name != NATURAL_EARTH_LAND_SOURCE.source_name
        || artifact.source.version != NATURAL_EARTH_LAND_SOURCE.version
        || artifact.source.url != NATURAL_EARTH_LAND_SOURCE.url
        || artifact.source.sha256 != format!("0x{}", NATURAL_EARTH_LAND_SOURCE.sha256)
    {
        return Err(ResidenceAllowlistError::InvalidArtifact(
            "allowlist source metadata does not match pinned Natural Earth source".to_owned(),
        ));
    }
    if artifact.geo_resolution != NATURAL_EARTH_LAND_SOURCE.resolution {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "allowlist geo_resolution must be {}",
            NATURAL_EARTH_LAND_SOURCE.resolution
        )));
    }
    Ok(())
}

fn validate_allowlist_shape(artifact: &AllowlistArtifact) -> Result<(), ResidenceAllowlistError> {
    if artifact.schema != ALLOWLIST_SCHEMA {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "allowlist schema must be {ALLOWLIST_SCHEMA}"
        )));
    }
    if artifact.schema_version != ALLOWLIST_SCHEMA_VERSION {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "allowlist schema_version must be {ALLOWLIST_SCHEMA_VERSION}"
        )));
    }
    if artifact.source.kind != LOCAL_GEOJSON_SOURCE_KIND {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "allowlist source.kind must be {LOCAL_GEOJSON_SOURCE_KIND}"
        )));
    }
    if !is_lower_prefixed_hex(&artifact.source.sha256, 32) {
        return Err(ResidenceAllowlistError::InvalidArtifact(
            "allowlist source.sha256 must be a lowercase 0x-prefixed SHA-256 hash".to_owned(),
        ));
    }
    if artifact.source.byte_length == 0 {
        return Err(ResidenceAllowlistError::InvalidArtifact(
            "allowlist source.byte_length must be greater than zero".to_owned(),
        ));
    }
    resolution_from_u8(artifact.geo_resolution)?;
    if artifact.h3_indexes.is_empty() {
        return Err(ResidenceAllowlistError::InvalidArtifact(
            "allowlist must contain at least one h3_index".to_owned(),
        ));
    }

    let mut previous = None;
    for raw in &artifact.h3_indexes {
        let current = parse_h3_index(raw, artifact.geo_resolution)?;
        if let Some(previous_index) = previous {
            if current == previous_index {
                return Err(ResidenceAllowlistError::InvalidArtifact(format!(
                    "duplicate h3_index in residence allowlist: {current}"
                )));
            }
            if current < previous_index {
                return Err(ResidenceAllowlistError::InvalidArtifact(
                    "allowlist h3_indexes must be sorted ascending".to_owned(),
                ));
            }
        }
        previous = Some(current);
    }

    Ok(())
}

fn validate_manifest_metadata(manifest: &AllowlistManifest) -> Result<(), ResidenceAllowlistError> {
    if manifest.schema != MANIFEST_SCHEMA {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "manifest schema must be {MANIFEST_SCHEMA}"
        )));
    }
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "manifest schema_version must be {MANIFEST_SCHEMA_VERSION}"
        )));
    }
    if manifest.source.name != NATURAL_EARTH_LAND_SOURCE.source_name
        || manifest.source.version != NATURAL_EARTH_LAND_SOURCE.version
        || manifest.source.url != NATURAL_EARTH_LAND_SOURCE.url
        || manifest.source.sha256 != NATURAL_EARTH_LAND_SOURCE.sha256
    {
        return Err(ResidenceAllowlistError::InvalidArtifact(
            "manifest source metadata does not match pinned Natural Earth source".to_owned(),
        ));
    }
    if !is_lower_hex(&manifest.source.sha256, 32) {
        return Err(ResidenceAllowlistError::InvalidArtifact(
            "manifest source.sha256 must be a lowercase SHA-256 hash".to_owned(),
        ));
    }
    if manifest.geo_resolution != NATURAL_EARTH_LAND_SOURCE.resolution {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "manifest geo_resolution must be {}",
            NATURAL_EARTH_LAND_SOURCE.resolution
        )));
    }
    if manifest.s3.bucket_env != S3_BUCKET_ENV {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "manifest s3.bucket_env must be {S3_BUCKET_ENV}"
        )));
    }
    if manifest.s3.object_key.is_empty() {
        return Err(ResidenceAllowlistError::InvalidArtifact(
            "manifest s3.object_key must not be empty".to_owned(),
        ));
    }
    if manifest.generation_command.is_empty() {
        return Err(ResidenceAllowlistError::InvalidArtifact(
            "manifest generation_command must not be empty".to_owned(),
        ));
    }
    Ok(())
}

fn validate_proof_shard_manifest(
    manifest: &ProofShardManifest,
) -> Result<(), ResidenceAllowlistError> {
    if manifest.schema != PROOF_MANIFEST_SCHEMA {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "proof manifest schema must be {PROOF_MANIFEST_SCHEMA}"
        )));
    }
    if manifest.schema_version != PROOF_MANIFEST_SCHEMA_VERSION {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "proof manifest schema_version must be {PROOF_MANIFEST_SCHEMA_VERSION}"
        )));
    }
    if manifest.shard_count == 0 {
        return Err(ResidenceAllowlistError::InvalidArtifact(
            "proof manifest shard_count must be greater than zero".to_owned(),
        ));
    }
    resolution_from_u8(manifest.geo_resolution)?;
    parse_prefixed_hex_32("proof manifest merkle_root", &manifest.merkle_root)?;
    if manifest.object_key_rule != PROOF_SHARD_OBJECT_KEY_RULE {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "proof manifest object_key_rule must be {PROOF_SHARD_OBJECT_KEY_RULE}"
        )));
    }
    if manifest.shards.len() != manifest.shard_count {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "proof manifest inventory length {} does not match shard_count {}",
            manifest.shards.len(),
            manifest.shard_count
        )));
    }

    let mut seen = vec![false; manifest.shard_count];
    for inventory in &manifest.shards {
        if inventory.shard_id >= manifest.shard_count {
            return Err(ResidenceAllowlistError::InvalidArtifact(format!(
                "proof manifest shard_id {} is outside shard_count {}",
                inventory.shard_id, manifest.shard_count
            )));
        }
        if seen[inventory.shard_id] {
            return Err(ResidenceAllowlistError::InvalidArtifact(format!(
                "duplicate shard inventory entry for shard_id {}",
                inventory.shard_id
            )));
        }
        seen[inventory.shard_id] = true;
        let expected_object_key = proof_shard_object_key(
            manifest.allowlist_version,
            manifest.geo_resolution,
            inventory.shard_id,
        );
        if inventory.object_key != expected_object_key {
            return Err(ResidenceAllowlistError::InvalidArtifact(format!(
                "shard {} object_key {} does not match expected {}",
                inventory.shard_id, inventory.object_key, expected_object_key
            )));
        }
        parse_prefixed_hex_32("proof manifest shard sha256", &inventory.sha256)?;
    }

    for shard_id in 0..manifest.shard_count {
        if !seen[shard_id] {
            return Err(ResidenceAllowlistError::InvalidArtifact(format!(
                "missing shard inventory entry for shard_id {shard_id}"
            )));
        }
    }

    Ok(())
}

fn reject_unexpected_shard_files(
    shards_dir: &Path,
    shard_count: usize,
) -> Result<(), ResidenceAllowlistError> {
    let expected = (0..shard_count)
        .map(|shard_id| format!("{shard_id:05}.json.gz"))
        .collect::<std::collections::BTreeSet<_>>();

    for entry in fs::read_dir(shards_dir)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            return Err(ResidenceAllowlistError::InvalidArtifact(format!(
                "unexpected non-UTF-8 shard file in {}",
                shards_dir.display()
            )));
        };
        if !expected.contains(file_name) {
            return Err(ResidenceAllowlistError::InvalidArtifact(format!(
                "unexpected shard file {}",
                entry.path().display()
            )));
        }
    }

    Ok(())
}

fn read_proof_shard_gzip(
    shard_path: &Path,
    compressed: &[u8],
) -> Result<ProofShard, ResidenceAllowlistError> {
    let mut decoder = GzDecoder::new(compressed);
    let mut json = Vec::new();
    decoder.read_to_end(&mut json).map_err(|error| {
        ResidenceAllowlistError::InvalidArtifact(format!(
            "failed to decode gzip shard {}: {error}",
            shard_path.display()
        ))
    })?;
    serde_json::from_slice(&json).map_err(ResidenceAllowlistError::Json)
}

fn validate_proof_shard_contents(
    manifest: &ProofShardManifest,
    inventory: &ProofShardInventoryEntry,
    expected_shard_id: usize,
    shard: &ProofShard,
    seen_h3_indexes: &mut std::collections::BTreeSet<u64>,
) -> Result<usize, ResidenceAllowlistError> {
    if shard.schema != PROOF_SHARD_SCHEMA {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "shard {expected_shard_id} schema must be {PROOF_SHARD_SCHEMA}"
        )));
    }
    if shard.schema_version != PROOF_SHARD_SCHEMA_VERSION {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "shard {expected_shard_id} schema_version must be {PROOF_SHARD_SCHEMA_VERSION}"
        )));
    }
    if shard.allowlist_version != manifest.allowlist_version {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "shard {expected_shard_id} allowlist_version {} does not match manifest {}",
            shard.allowlist_version, manifest.allowlist_version
        )));
    }
    if shard.geo_resolution != manifest.geo_resolution {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "shard {expected_shard_id} geo_resolution {} does not match manifest {}",
            shard.geo_resolution, manifest.geo_resolution
        )));
    }
    if shard.merkle_root != manifest.merkle_root {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "shard {expected_shard_id} merkle_root {} does not match manifest {}",
            shard.merkle_root, manifest.merkle_root
        )));
    }
    if shard.shard_id != expected_shard_id {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "shard file {expected_shard_id} contains shard_id {}",
            shard.shard_id
        )));
    }
    if shard.shard_count != manifest.shard_count {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "shard {expected_shard_id} shard_count {} does not match manifest {}",
            shard.shard_count, manifest.shard_count
        )));
    }
    if shard.proofs.len() != inventory.proof_count {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "shard {expected_shard_id} proof_count {} does not match manifest {}",
            shard.proofs.len(),
            inventory.proof_count
        )));
    }

    let shard_count = u64::try_from(manifest.shard_count).map_err(|_| {
        ResidenceAllowlistError::InvalidArtifact(
            "proof manifest shard_count is outside the u64 range".to_owned(),
        )
    })?;
    for entry in &shard.proofs {
        let h3_index = parse_h3_index(&entry.h3_index, manifest.geo_resolution)?;
        if !seen_h3_indexes.insert(h3_index) {
            return Err(ResidenceAllowlistError::InvalidArtifact(format!(
                "duplicate proof entry for h3_index {h3_index}"
            )));
        }
        let expected_leaf = ResidenceCellLeaf {
            h3_index,
            geo_resolution: manifest.geo_resolution,
            allowlist_version: manifest.allowlist_version,
        };
        let expected_leaf_hash = prefixed_hex(&leaf_hash(&expected_leaf)?);
        if entry.leaf_hash != expected_leaf_hash {
            return Err(ResidenceAllowlistError::InvalidArtifact(format!(
                "h3_index {h3_index} leaf_hash {} does not match computed {}",
                entry.leaf_hash, expected_leaf_hash
            )));
        }

        let computed_shard_id = (h3_index % shard_count) as usize;
        if computed_shard_id != expected_shard_id {
            return Err(ResidenceAllowlistError::InvalidArtifact(format!(
                "h3_index {h3_index} belongs to shard_id {computed_shard_id}, not {expected_shard_id}"
            )));
        }

        let replayed_root = replay_proof_shard_entry(entry)?;
        if replayed_root != manifest.merkle_root {
            return Err(ResidenceAllowlistError::InvalidArtifact(format!(
                "h3_index {h3_index} proof replays to {replayed_root}, not manifest merkle_root {}",
                manifest.merkle_root
            )));
        }
    }

    Ok(shard.proofs.len())
}

fn assert_manifest_field(
    field: &str,
    actual: Option<&str>,
    expected: &str,
) -> Result<(), ResidenceAllowlistError> {
    let Some(actual) = actual else {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "manifest {field} is required for local verification"
        )));
    };
    if actual != expected {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "manifest {field} {actual} does not match computed {expected}"
        )));
    }
    Ok(())
}

fn assert_manifest_u64(
    field: &str,
    actual: Option<u64>,
    expected: u64,
) -> Result<(), ResidenceAllowlistError> {
    let Some(actual) = actual else {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "manifest {field} is required for local verification"
        )));
    };
    if actual != expected {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "manifest {field} {actual} does not match computed {expected}"
        )));
    }
    Ok(())
}

fn assert_manifest_usize(
    field: &str,
    actual: Option<usize>,
    expected: usize,
) -> Result<(), ResidenceAllowlistError> {
    let Some(actual) = actual else {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "manifest {field} is required for local verification"
        )));
    };
    if actual != expected {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "manifest {field} {actual} does not match computed {expected}"
        )));
    }
    Ok(())
}

fn parse_h3_index(value: &str, expected_resolution: u8) -> Result<u64, ResidenceAllowlistError> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "h3_index must be a decimal u64 string: {value}"
        )));
    }
    if value != "0" && value.starts_with('0') {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "h3_index must not contain leading zeroes: {value}"
        )));
    }
    let parsed = value.parse::<u64>().map_err(|_| {
        ResidenceAllowlistError::InvalidArtifact(format!(
            "h3_index is outside the u64 range: {value}"
        ))
    })?;
    let cell = CellIndex::try_from(parsed).map_err(|error| {
        ResidenceAllowlistError::InvalidArtifact(format!(
            "h3_index is not a valid H3 cell index: {error}"
        ))
    })?;
    if u8::from(cell.resolution()) != expected_resolution {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "h3_index resolution must be {expected_resolution}: {value}"
        )));
    }
    Ok(parsed)
}

fn format_proof_output(proof: ResidenceMerkleProof) -> ProofOutput {
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

fn proof_step(direction: ProofDirection, sibling_hash: [u8; 32]) -> ResidenceProofStep {
    ResidenceProofStep {
        direction,
        sibling_on_left: direction.sibling_on_left(),
        sibling_hash,
    }
}

fn build_proof_shard_context(
    leaves: &[ResidenceCellLeaf],
    shard_count: usize,
) -> Result<ProofShardBuildContext, ResidenceAllowlistError> {
    if shard_count == 0 {
        return Err(ResidenceAllowlistError::InvalidArgument(
            "shard_count must be greater than zero".to_owned(),
        ));
    }
    let Some(first_leaf) = leaves.first().copied() else {
        return Err(ResidenceAllowlistError::InvalidArtifact(
            "proof shards require at least one residence leaf".to_owned(),
        ));
    };
    validate_proof_shard_leaf_metadata(leaves, first_leaf)?;

    let sorted = sorted_leaf_hashes(leaves)?;
    let leaf_hashes = sorted.iter().map(|(_, hash)| *hash).collect::<Vec<_>>();
    let levels = merkle_levels_from_leaf_hashes(&leaf_hashes);
    let Some(root) = levels.last().and_then(|level| level.first()).copied() else {
        return Err(ResidenceAllowlistError::InvalidArtifact(
            "proof shards require at least one residence leaf".to_owned(),
        ));
    };

    Ok(ProofShardBuildContext {
        sorted,
        levels,
        merkle_root: prefixed_hex(&root),
        allowlist_version: first_leaf.allowlist_version,
        geo_resolution: first_leaf.geo_resolution,
        shard_count,
    })
}

fn validate_proof_shard_leaf_metadata(
    leaves: &[ResidenceCellLeaf],
    expected: ResidenceCellLeaf,
) -> Result<(), ResidenceAllowlistError> {
    for leaf in leaves {
        if leaf.geo_resolution != expected.geo_resolution {
            return Err(ResidenceAllowlistError::InvalidArtifact(format!(
                "all proof shard leaves must use geo_resolution {}",
                expected.geo_resolution
            )));
        }
        if leaf.allowlist_version != expected.allowlist_version {
            return Err(ResidenceAllowlistError::InvalidArtifact(format!(
                "all proof shard leaves must use allowlist_version {}",
                expected.allowlist_version
            )));
        }
    }
    Ok(())
}

fn merkle_levels_from_leaf_hashes(leaf_hashes: &[[u8; 32]]) -> Vec<Vec<[u8; 32]>> {
    let mut levels = vec![leaf_hashes.to_vec()];
    while let Some(level) = levels.last() {
        if level.len() <= 1 {
            break;
        }
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for chunk in level.chunks(2) {
            if chunk.len() == 1 {
                next.push(chunk[0]);
            } else {
                next.push(internal_node_hash(chunk[0], chunk[1]));
            }
        }
        levels.push(next);
    }
    levels
}

fn proof_steps_from_levels(levels: &[Vec<[u8; 32]>], leaf_index: usize) -> Vec<ProofShardStep> {
    let mut current_index = leaf_index;
    let mut proof = Vec::new();
    for level in levels {
        if level.len() <= 1 {
            break;
        }
        let sibling_index = if current_index % 2 == 0 {
            current_index + 1
        } else {
            current_index - 1
        };
        if let Some(sibling_hash) = level.get(sibling_index) {
            proof.push(ProofShardStep {
                sibling_on_left: sibling_index < current_index,
                sibling_hash: prefixed_hex(sibling_hash),
            });
        }
        current_index /= 2;
    }
    proof
}

fn proof_shard_leaf_indices(context: &ProofShardBuildContext) -> ProofShardLeafIndices {
    let mut counts = vec![0usize; context.shard_count];
    for (leaf, _) in &context.sorted {
        counts[(leaf.h3_index % context.shard_count as u64) as usize] += 1;
    }

    let mut starts = Vec::with_capacity(context.shard_count + 1);
    starts.push(0);
    for count in &counts {
        let next = starts.last().copied().expect("starts has seed") + count;
        starts.push(next);
    }

    let mut write_offsets = starts[..context.shard_count].to_vec();
    let mut leaf_indices = vec![0usize; context.sorted.len()];
    for (leaf_index, (leaf, _)) in context.sorted.iter().enumerate() {
        let shard_id = (leaf.h3_index % context.shard_count as u64) as usize;
        let output_index = write_offsets[shard_id];
        leaf_indices[output_index] = leaf_index;
        write_offsets[shard_id] += 1;
    }

    ProofShardLeafIndices {
        starts,
        leaf_indices,
    }
}

fn proof_shard_entry_from_context(
    context: &ProofShardBuildContext,
    leaf_index: usize,
) -> Result<ProofShardEntry, ResidenceAllowlistError> {
    let Some((leaf, leaf_hash)) = context.sorted.get(leaf_index) else {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "leaf index {leaf_index} is outside proof shard tree"
        )));
    };
    Ok(ProofShardEntry {
        h3_index: leaf.h3_index.to_string(),
        leaf_hash: prefixed_hex(leaf_hash),
        proof: proof_steps_from_levels(&context.levels, leaf_index),
    })
}

fn write_proof_shard_from_indices_atomic(
    shards_dir: &Path,
    context: &ProofShardBuildContext,
    shard_id: usize,
    leaf_indices: &[usize],
) -> Result<ProofShardInventoryEntry, ResidenceAllowlistError> {
    let shard_path = shards_dir.join(format!("{shard_id:05}.json.gz"));
    let tmp_path = tmp_path_for(&shard_path)?;
    let file = fs::File::create(&tmp_path)?;
    let writer = HashingWriter::new(BufWriter::new(file));
    let mut encoder = GzBuilder::new()
        .mtime(0)
        .write(writer, Compression::default());

    write!(
        encoder,
        "{{\"schema\":\"{PROOF_SHARD_SCHEMA}\",\"schema_version\":{PROOF_SHARD_SCHEMA_VERSION},\"allowlist_version\":{},\"geo_resolution\":{},\"merkle_root\":\"{}\",\"shard_id\":{shard_id},\"shard_count\":{},\"proofs\":[",
        context.allowlist_version, context.geo_resolution, context.merkle_root, context.shard_count
    )?;
    for (entry_index, leaf_index) in leaf_indices.iter().copied().enumerate() {
        if entry_index > 0 {
            encoder.write_all(b",")?;
        }
        let entry = proof_shard_entry_from_context(context, leaf_index)?;
        serde_json::to_writer(&mut encoder, &entry)?;
    }
    encoder.write_all(b"]}")?;

    let hashing_writer = encoder.finish()?;
    let (mut writer, sha256, byte_size) = hashing_writer.finish();
    writer.flush()?;
    fs::rename(tmp_path, &shard_path)?;

    Ok(ProofShardInventoryEntry {
        shard_id,
        object_key: proof_shard_object_key(
            context.allowlist_version,
            context.geo_resolution,
            shard_id,
        ),
        proof_count: leaf_indices.len(),
        sha256,
        byte_size,
    })
}

fn write_proof_shard_manifest_atomic(
    output_dir: &Path,
    manifest: &ProofShardManifest,
) -> Result<(), ResidenceAllowlistError> {
    let manifest_path = output_dir.join("proof_manifest.json");
    let manifest = format!("{}\n", serde_json::to_string_pretty(manifest)?);
    write_bytes_atomic(&manifest_path, manifest.as_bytes())
}

fn proof_shard_object_key(allowlist_version: u64, geo_resolution: u8, shard_id: usize) -> String {
    format!(
        "residence-cells/v{allowlist_version}/res{geo_resolution}/proofs/shards/{shard_id:05}.json.gz"
    )
}

fn parse_prefixed_hex_32(field: &str, value: &str) -> Result<[u8; 32], ResidenceAllowlistError> {
    if !is_lower_prefixed_hex(value, 32) {
        return Err(ResidenceAllowlistError::InvalidArtifact(format!(
            "{field} must be a lowercase 0x-prefixed SHA-256 hash"
        )));
    }
    let hex = value
        .strip_prefix("0x")
        .expect("is_lower_prefixed_hex validated prefix");
    let mut bytes = [0u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        let start = index * 2;
        *byte = u8::from_str_radix(&hex[start..start + 2], 16).map_err(|error| {
            ResidenceAllowlistError::InvalidArtifact(format!(
                "{field} contains invalid hex at byte {index}: {error}"
            ))
        })?;
    }
    Ok(bytes)
}

fn sorted_leaf_hashes(
    leaves: &[ResidenceCellLeaf],
) -> Result<Vec<(ResidenceCellLeaf, [u8; 32])>, ResidenceAllowlistError> {
    let mut sorted = leaves.to_vec();
    sorted.sort_by_key(|leaf| leaf.h3_index);

    for pair in sorted.windows(2) {
        let Some(left) = pair.first() else {
            continue;
        };
        let Some(right) = pair.get(1) else {
            continue;
        };
        if left.h3_index == right.h3_index {
            return Err(ResidenceAllowlistError::DuplicateH3Index(left.h3_index));
        }
    }

    sorted
        .into_iter()
        .map(|leaf| {
            let hash = leaf_hash(&leaf)?;
            Ok((leaf, hash))
        })
        .collect()
}

fn resolution_from_u8(value: u8) -> Result<Resolution, ResidenceAllowlistError> {
    Resolution::try_from(value).map_err(|error| {
        ResidenceAllowlistError::InvalidArgument(format!("invalid H3 resolution {value}: {error}"))
    })
}

fn tmp_path_for(output: &Path) -> Result<PathBuf, ResidenceAllowlistError> {
    let Some(file_name) = output.file_name().and_then(|value| value.to_str()) else {
        return Err(ResidenceAllowlistError::InvalidArgument(format!(
            "output path must include a UTF-8 file name: {}",
            output.display()
        )));
    };
    Ok(output.with_file_name(format!("{file_name}.tmp")))
}

fn write_bytes_atomic(output: &Path, bytes: &[u8]) -> Result<(), ResidenceAllowlistError> {
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp_path = tmp_path_for(output)?;
    fs::write(&tmp_path, bytes)?;
    fs::rename(tmp_path, output)?;
    Ok(())
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

struct Progress {
    total: usize,
    processed_label: &'static str,
    produced_label: String,
    processed: AtomicUsize,
    accepted: AtomicUsize,
    interval: Duration,
    last_log: Mutex<Instant>,
    started_at: Instant,
}

impl Progress {
    fn new(
        total: usize,
        processed_label: &'static str,
        produced_label: String,
        interval: Duration,
    ) -> Arc<Self> {
        let now = Instant::now();
        Arc::new(Self {
            total,
            processed_label,
            produced_label,
            processed: AtomicUsize::new(0),
            accepted: AtomicUsize::new(0),
            interval,
            last_log: Mutex::new(now),
            started_at: now,
        })
    }

    fn tick(&self, accepted_count: usize) {
        let processed = self.processed.fetch_add(1, Ordering::Relaxed) + 1;
        let accepted = self.accepted.fetch_add(accepted_count, Ordering::Relaxed) + accepted_count;
        if self.interval.is_zero() {
            return;
        }

        let Ok(mut last_log) = self.last_log.try_lock() else {
            return;
        };
        if last_log.elapsed() < self.interval && processed != self.total {
            return;
        }
        *last_log = Instant::now();
        let elapsed = self.started_at.elapsed().as_secs();
        eprintln!(
            "{}",
            format_progress_message(
                processed,
                self.total,
                self.processed_label,
                accepted,
                &self.produced_label,
                elapsed,
            )
        );
    }
}

fn format_progress_message(
    processed: usize,
    total: usize,
    processed_label: &str,
    produced: usize,
    produced_label: &str,
    elapsed_seconds: u64,
) -> String {
    format!(
        "progress: processed {}/{} {processed_label}; collected ~{} {produced_label}; elapsed {elapsed_seconds}s",
        format_count(processed),
        format_count(total),
        format_count(produced),
    )
}

fn format_count(value: usize) -> String {
    let digits = value.to_string();
    let mut output = String::with_capacity(digits.len() + digits.len() / 3);
    let first_group_len = digits.len() % 3;

    for (index, byte) in digits.bytes().enumerate() {
        if index > 0
            && (index == first_group_len
                || (index > first_group_len && (index - first_group_len) % 3 == 0))
        {
            output.push(',');
        }
        output.push(char::from(byte));
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_tiler_progress_with_clear_labels_and_grouped_counts() {
        let message = format_progress_message(
            6813,
            6837,
            "polygons",
            10_654_772,
            "H3 res7 candidate cells",
            50,
        );

        assert_eq!(
            message,
            "progress: processed 6,813/6,837 polygons; collected ~10,654,772 H3 res7 candidate cells; elapsed 50s"
        );
    }

    #[test]
    fn formats_hierarchical_progress_without_tiler_specific_wording() {
        let message =
            format_progress_message(42, 100, "start cells", 12_345, "H3 res7 candidate cells", 7);

        assert_eq!(
            message,
            "progress: processed 42/100 start cells; collected ~12,345 H3 res7 candidate cells; elapsed 7s"
        );
    }
}
