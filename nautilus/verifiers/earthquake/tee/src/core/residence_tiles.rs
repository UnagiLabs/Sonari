use crate::GEO_RESOLUTION;
use crate::crypto::{sha256_bytes, to_hex};
use h3o::{CellIndex, Resolution};
use serde::Deserialize;
use std::collections::HashSet;
use thiserror::Error;

const TILE_MANIFEST_SCHEMA: &str = "sonari.residence.tile_manifest.v1";
const TILE_SCHEMA: &str = "sonari.residence.tile.v1";
const TILE_MANIFEST_SCHEMA_VERSION: u64 = 1;
const TILE_SCHEMA_VERSION: u64 = 1;
const TILE_OBJECT_KEY_RULE: &str =
    "residence-cells/v{allowlist_version}/res{geo_resolution}/tiles/res4/{parent_hex}.json";
const HEX32_PREFIXED_LEN: usize = 66;

pub const RESIDENCE_TILE_PARENT_RESOLUTION: u8 = 4;
pub const RESIDENCE_TILE_CLASSIFIER_NAME: &str = "r2_residence_tile_manifest_v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResidenceTileConfig {
    pub base_url: String,
    pub manifest_key: String,
    pub manifest_sha256: String,
    pub object_prefix: String,
    pub bucket: String,
    pub allowlist_version: u64,
    pub geo_resolution: u8,
    pub merkle_root: String,
    pub source_hash: Option<String>,
}

impl ResidenceTileConfig {
    pub fn from_env() -> Result<Self, ResidenceTileError> {
        let base_url = required_env("SONARI_RESIDENCE_R2_BASE_URL")?;
        let manifest_key = required_env("SONARI_RESIDENCE_TILE_MANIFEST_KEY")?;
        let manifest_sha256 = normalize_hex32(
            "SONARI_RESIDENCE_TILE_MANIFEST_SHA256",
            &required_env("SONARI_RESIDENCE_TILE_MANIFEST_SHA256")?,
        )?;
        let object_prefix = required_env("SONARI_RESIDENCE_R2_OBJECT_PREFIX")?;
        let bucket = required_env("SONARI_RESIDENCE_R2_BUCKET")?;
        let allowlist_version = parse_positive_u64(
            "SONARI_RESIDENCE_ALLOWLIST_VERSION",
            &required_env("SONARI_RESIDENCE_ALLOWLIST_VERSION")?,
        )?;
        let geo_resolution = parse_u8(
            "SONARI_GEO_RESOLUTION",
            &required_env("SONARI_GEO_RESOLUTION")?,
        )?;
        if geo_resolution != GEO_RESOLUTION {
            return Err(ResidenceTileError::InvalidConfig(format!(
                "SONARI_GEO_RESOLUTION must be {GEO_RESOLUTION}"
            )));
        }
        let merkle_root = normalize_hex32(
            "SONARI_RESIDENCE_ROOT",
            &required_env("SONARI_RESIDENCE_ROOT")?,
        )?;
        let source_hash = optional_env("SONARI_RESIDENCE_SOURCE_HASH")
            .map(|value| normalize_hex32("SONARI_RESIDENCE_SOURCE_HASH", &value))
            .transpose()?;

        if !base_url.starts_with("https://") {
            return Err(ResidenceTileError::InvalidConfig(
                "SONARI_RESIDENCE_R2_BASE_URL must be an https URL".to_owned(),
            ));
        }
        if manifest_key.starts_with('/') || manifest_key.contains("..") {
            return Err(ResidenceTileError::InvalidConfig(
                "SONARI_RESIDENCE_TILE_MANIFEST_KEY must be a relative object key".to_owned(),
            ));
        }
        if object_prefix.starts_with('/') || object_prefix.contains("..") {
            return Err(ResidenceTileError::InvalidConfig(
                "SONARI_RESIDENCE_R2_OBJECT_PREFIX must be a relative object prefix".to_owned(),
            ));
        }
        if !manifest_key.starts_with(&object_prefix) {
            return Err(ResidenceTileError::InvalidConfig(
                "SONARI_RESIDENCE_TILE_MANIFEST_KEY must start with SONARI_RESIDENCE_R2_OBJECT_PREFIX"
                    .to_owned(),
            ));
        }

        Ok(Self {
            base_url,
            manifest_key,
            manifest_sha256,
            object_prefix,
            bucket,
            allowlist_version,
            geo_resolution,
            merkle_root,
            source_hash,
        })
    }

    fn object_url(&self, object_key: &str) -> Result<String, ResidenceTileError> {
        if object_key.starts_with('/') || object_key.contains("..") {
            return Err(ResidenceTileError::InvalidArtifact(format!(
                "R2 object key must be relative: {object_key}"
            )));
        }
        let base = self.base_url.trim_end_matches('/');
        Ok(format!("{base}/{object_key}"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResidenceTileManifest {
    pub schema: String,
    pub schema_version: u64,
    pub allowlist_version: u64,
    pub geo_resolution: u8,
    pub tile_parent_resolution: u8,
    pub merkle_root: String,
    pub object_key_rule: String,
    pub tile_count: usize,
    pub total_cell_count: usize,
    pub tiles: Vec<ResidenceTileInventoryEntry>,
}

impl ResidenceTileManifest {
    fn inventory_for_parent(&self, parent_h3_index: u64) -> Option<&ResidenceTileInventoryEntry> {
        let parent = parent_h3_index.to_string();
        self.tiles
            .binary_search_by(|entry| entry.parent_h3_index.as_str().cmp(parent.as_str()))
            .ok()
            .map(|index| &self.tiles[index])
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResidenceTileInventoryEntry {
    pub parent_h3_index: String,
    pub object_key: String,
    pub cell_count: usize,
    pub sha256: String,
    pub byte_size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResidenceTile {
    schema: String,
    schema_version: u64,
    allowlist_version: u64,
    geo_resolution: u8,
    tile_parent_resolution: u8,
    merkle_root: String,
    parent_h3_index: String,
    cells: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResidenceTileSet {
    manifest: ResidenceTileManifest,
    tiles: Vec<LoadedResidenceTile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LoadedResidenceTile {
    parent_h3_index: u64,
    cells: HashSet<u64>,
}

impl ResidenceTileSet {
    pub fn load(
        config: &ResidenceTileConfig,
        source: &impl ResidenceTileSource,
        required_parents: &[u64],
    ) -> Result<Self, ResidenceTileError> {
        let manifest_bytes = source.fetch(&config.object_url(&config.manifest_key)?)?;
        let manifest = parse_manifest_bytes(config, &manifest_bytes)?;
        let mut unique_parents = required_parents.to_vec();
        unique_parents.sort_unstable();
        unique_parents.dedup();

        let mut tiles = Vec::new();
        for parent in unique_parents {
            let Some(inventory) = manifest.inventory_for_parent(parent) else {
                continue;
            };
            let tile_bytes = source.fetch(&config.object_url(&inventory.object_key)?)?;
            let tile = parse_tile_bytes(config, &manifest, inventory, parent, &tile_bytes)?;
            tiles.push(tile);
        }
        Ok(Self { manifest, tiles })
    }

    pub fn manifest(&self) -> &ResidenceTileManifest {
        &self.manifest
    }

    pub fn is_land_cell(&self, h3_index: u64) -> bool {
        self.tiles.iter().any(|tile| tile.cells.contains(&h3_index))
    }
}

pub trait ResidenceTileSource {
    fn fetch(&self, url: &str) -> Result<Vec<u8>, ResidenceTileError>;
}

pub struct ResidenceTileSourceHttp<'a> {
    client: &'a reqwest::blocking::Client,
}

impl<'a> ResidenceTileSourceHttp<'a> {
    pub fn new(client: &'a reqwest::blocking::Client) -> Self {
        Self { client }
    }
}

impl ResidenceTileSource for ResidenceTileSourceHttp<'_> {
    fn fetch(&self, url: &str) -> Result<Vec<u8>, ResidenceTileError> {
        let bytes = self
            .client
            .get(url)
            .send()
            .and_then(|response| {
                if response.status().is_success() {
                    response.bytes()
                } else {
                    Err(response.error_for_status().unwrap_err())
                }
            })
            .map_err(|error| ResidenceTileError::Fetch(error.to_string()))?;
        Ok(bytes.to_vec())
    }
}

#[derive(Debug, Error)]
pub enum ResidenceTileError {
    #[error("invalid residence tile config: {0}")]
    InvalidConfig(String),
    #[error("failed to fetch residence tile artifact: {0}")]
    Fetch(String),
    #[error("invalid residence tile artifact: {0}")]
    InvalidArtifact(String),
}

fn parse_manifest_bytes(
    config: &ResidenceTileConfig,
    bytes: &[u8],
) -> Result<ResidenceTileManifest, ResidenceTileError> {
    let actual_sha256 = to_hex(&sha256_bytes(bytes));
    if actual_sha256 != config.manifest_sha256 {
        return Err(ResidenceTileError::InvalidArtifact(format!(
            "tile manifest sha256 {actual_sha256} does not match configured {}",
            config.manifest_sha256
        )));
    }
    let manifest: ResidenceTileManifest = serde_json::from_slice(bytes)
        .map_err(|error| ResidenceTileError::InvalidArtifact(error.to_string()))?;
    validate_manifest(config, &manifest)?;
    Ok(manifest)
}

fn validate_manifest(
    config: &ResidenceTileConfig,
    manifest: &ResidenceTileManifest,
) -> Result<(), ResidenceTileError> {
    if manifest.schema != TILE_MANIFEST_SCHEMA {
        return invalid_artifact(format!(
            "tile manifest schema {} is not {TILE_MANIFEST_SCHEMA}",
            manifest.schema
        ));
    }
    if manifest.schema_version != TILE_MANIFEST_SCHEMA_VERSION {
        return invalid_artifact(format!(
            "tile manifest schema_version {} is not {TILE_MANIFEST_SCHEMA_VERSION}",
            manifest.schema_version
        ));
    }
    if manifest.allowlist_version != config.allowlist_version {
        return invalid_artifact("tile manifest allowlist_version does not match config");
    }
    if manifest.geo_resolution != config.geo_resolution {
        return invalid_artifact("tile manifest geo_resolution does not match config");
    }
    if manifest.tile_parent_resolution != RESIDENCE_TILE_PARENT_RESOLUTION {
        return invalid_artifact(format!(
            "tile manifest tile_parent_resolution {} is not {RESIDENCE_TILE_PARENT_RESOLUTION}",
            manifest.tile_parent_resolution
        ));
    }
    if normalize_hex32("tile manifest merkle_root", &manifest.merkle_root)? != config.merkle_root {
        return invalid_artifact("tile manifest merkle_root does not match config");
    }
    if manifest.object_key_rule != TILE_OBJECT_KEY_RULE {
        return invalid_artifact("tile manifest object_key_rule does not match expected rule");
    }
    if manifest.tiles.len() != manifest.tile_count {
        return invalid_artifact("tile manifest tiles length does not match tile_count");
    }

    let mut total_cell_count = 0usize;
    let mut previous_parent: Option<u64> = None;
    for entry in &manifest.tiles {
        let parent = parse_h3_index(
            "tile manifest parent_h3_index",
            &entry.parent_h3_index,
            RESIDENCE_TILE_PARENT_RESOLUTION,
        )?;
        if previous_parent.is_some_and(|previous| parent <= previous) {
            return invalid_artifact("tile manifest parent_h3_index must be strictly ascending");
        }
        previous_parent = Some(parent);

        if !entry.object_key.starts_with(&config.object_prefix) {
            return invalid_artifact("tile object_key must start with configured object prefix");
        }
        if entry.object_key.starts_with('/') || entry.object_key.contains("..") {
            return invalid_artifact("tile object_key must be a relative object key");
        }
        normalize_hex32("tile sha256", &entry.sha256)?;
        if entry.cell_count == 0 {
            return invalid_artifact("tile cell_count must be positive");
        }
        if entry.byte_size == 0 {
            return invalid_artifact("tile byte_size must be positive");
        }
        total_cell_count = total_cell_count
            .checked_add(entry.cell_count)
            .ok_or_else(|| {
                ResidenceTileError::InvalidArtifact("tile cell count overflow".to_owned())
            })?;
    }
    if total_cell_count != manifest.total_cell_count {
        return invalid_artifact("tile manifest total_cell_count does not match inventory sum");
    }
    Ok(())
}

fn parse_tile_bytes(
    config: &ResidenceTileConfig,
    manifest: &ResidenceTileManifest,
    inventory: &ResidenceTileInventoryEntry,
    required_parent: u64,
    bytes: &[u8],
) -> Result<LoadedResidenceTile, ResidenceTileError> {
    let byte_size = u64::try_from(bytes.len())
        .map_err(|_| ResidenceTileError::InvalidArtifact("tile body is too large".to_owned()))?;
    if byte_size != inventory.byte_size {
        return invalid_artifact(format!(
            "tile {} byte_size {byte_size} does not match manifest {}",
            inventory.parent_h3_index, inventory.byte_size
        ));
    }
    let actual_sha256 = to_hex(&sha256_bytes(bytes));
    if actual_sha256 != normalize_hex32("tile sha256", &inventory.sha256)? {
        return invalid_artifact(format!(
            "tile {} sha256 {actual_sha256} does not match manifest {}",
            inventory.parent_h3_index, inventory.sha256
        ));
    }
    let tile: ResidenceTile = serde_json::from_slice(bytes)
        .map_err(|error| ResidenceTileError::InvalidArtifact(error.to_string()))?;
    verify_tile_contents(config, manifest, inventory, required_parent, &tile)
}

fn verify_tile_contents(
    config: &ResidenceTileConfig,
    manifest: &ResidenceTileManifest,
    inventory: &ResidenceTileInventoryEntry,
    required_parent: u64,
    tile: &ResidenceTile,
) -> Result<LoadedResidenceTile, ResidenceTileError> {
    if tile.schema != TILE_SCHEMA || tile.schema_version != TILE_SCHEMA_VERSION {
        return invalid_artifact("tile schema or schema_version is invalid");
    }
    if tile.allowlist_version != manifest.allowlist_version
        || tile.geo_resolution != manifest.geo_resolution
        || tile.tile_parent_resolution != manifest.tile_parent_resolution
        || normalize_hex32("tile merkle_root", &tile.merkle_root)? != config.merkle_root
        || tile.parent_h3_index != inventory.parent_h3_index
    {
        return invalid_artifact(format!(
            "tile {} metadata does not match manifest",
            inventory.parent_h3_index
        ));
    }
    let parent = parse_h3_index(
        "tile parent_h3_index",
        &tile.parent_h3_index,
        RESIDENCE_TILE_PARENT_RESOLUTION,
    )?;
    if parent != required_parent {
        return invalid_artifact("tile parent_h3_index does not match requested parent");
    }
    if tile.cells.len() != inventory.cell_count {
        return invalid_artifact(format!(
            "tile {} cell_count {} does not match manifest {}",
            inventory.parent_h3_index,
            tile.cells.len(),
            inventory.cell_count
        ));
    }

    let parent_resolution = resolution_from_u8(RESIDENCE_TILE_PARENT_RESOLUTION)?;
    let mut previous: Option<u64> = None;
    let mut cells = HashSet::with_capacity(tile.cells.len());
    for cell in &tile.cells {
        let cell_u64 = parse_h3_index("tile cell", cell, manifest.geo_resolution)?;
        if previous.is_some_and(|value| cell_u64 <= value) {
            return invalid_artifact(format!(
                "tile {} cells must be strictly ascending and unique",
                inventory.parent_h3_index
            ));
        }
        previous = Some(cell_u64);
        let cell_index = CellIndex::try_from(cell_u64).map_err(|error| {
            ResidenceTileError::InvalidArtifact(format!(
                "tile cell {cell_u64} is not a valid H3 cell: {error}"
            ))
        })?;
        let actual_parent = cell_index.parent(parent_resolution).ok_or_else(|| {
            ResidenceTileError::InvalidArtifact(format!(
                "could not compute parent for tile cell {cell_u64}"
            ))
        })?;
        if u64::from(actual_parent) != parent {
            return invalid_artifact(format!("tile cell {cell_u64} is not under parent {parent}"));
        }
        cells.insert(cell_u64);
    }

    Ok(LoadedResidenceTile {
        parent_h3_index: parent,
        cells,
    })
}

fn parse_h3_index(
    name: &str,
    value: &str,
    expected_resolution: u8,
) -> Result<u64, ResidenceTileError> {
    if value.is_empty() {
        return invalid_artifact(format!("{name} must be non-empty"));
    }
    if value != "0" && value.starts_with('0') {
        return invalid_artifact(format!("{name} must not contain leading zeroes: {value}"));
    }
    let parsed = value.parse::<u64>().map_err(|_| {
        ResidenceTileError::InvalidArtifact(format!("{name} is outside u64 range: {value}"))
    })?;
    let cell = CellIndex::try_from(parsed).map_err(|error| {
        ResidenceTileError::InvalidArtifact(format!("{name} is not a valid H3 cell: {error}"))
    })?;
    if u8::from(cell.resolution()) != expected_resolution {
        return invalid_artifact(format!(
            "{name} resolution must be {expected_resolution}: {value}"
        ));
    }
    Ok(parsed)
}

fn resolution_from_u8(value: u8) -> Result<Resolution, ResidenceTileError> {
    Resolution::try_from(value).map_err(|error| {
        ResidenceTileError::InvalidArtifact(format!("invalid H3 resolution {value}: {error}"))
    })
}

fn required_env(name: &str) -> Result<String, ResidenceTileError> {
    optional_env(name)
        .ok_or_else(|| ResidenceTileError::InvalidConfig(format!("{name} is required")))
}

fn optional_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn parse_positive_u64(name: &str, value: &str) -> Result<u64, ResidenceTileError> {
    let parsed = value
        .parse::<u64>()
        .map_err(|_| ResidenceTileError::InvalidConfig(format!("{name} must be an integer")))?;
    if parsed == 0 {
        return Err(ResidenceTileError::InvalidConfig(format!(
            "{name} must be positive"
        )));
    }
    Ok(parsed)
}

fn parse_u8(name: &str, value: &str) -> Result<u8, ResidenceTileError> {
    value
        .parse::<u8>()
        .map_err(|_| ResidenceTileError::InvalidConfig(format!("{name} must be a u8 integer")))
}

fn normalize_hex32(name: &str, value: &str) -> Result<String, ResidenceTileError> {
    let prefixed = if value.starts_with("0x") {
        value.to_owned()
    } else {
        format!("0x{value}")
    };
    if prefixed.len() != HEX32_PREFIXED_LEN
        || !prefixed[2..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(ResidenceTileError::InvalidConfig(format!(
            "{name} must be a 32-byte hex string"
        )));
    }
    Ok(prefixed.to_ascii_lowercase())
}

fn invalid_artifact<T>(message: impl Into<String>) -> Result<T, ResidenceTileError> {
    Err(ResidenceTileError::InvalidArtifact(message.into()))
}

#[cfg(test)]
mod tests {
    use super::{
        ResidenceTileConfig, ResidenceTileError, ResidenceTileSet, ResidenceTileSource,
        parse_manifest_bytes, parse_tile_bytes,
    };
    use crate::crypto::{sha256_bytes, to_hex};
    use h3o::{CellIndex, Resolution};
    use std::cell::RefCell;
    use std::collections::HashMap;

    const ROOT: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const CELL_A: u64 = 608_819_013_547_458_559;
    const CELL_B: u64 = 608_819_013_614_567_423;

    #[derive(Default)]
    struct MockSource {
        bytes_by_url: HashMap<String, Vec<u8>>,
        requested_urls: RefCell<Vec<String>>,
    }

    impl ResidenceTileSource for MockSource {
        fn fetch(&self, url: &str) -> Result<Vec<u8>, ResidenceTileError> {
            self.requested_urls.borrow_mut().push(url.to_owned());
            self.bytes_by_url
                .get(url)
                .cloned()
                .ok_or_else(|| ResidenceTileError::Fetch(format!("missing mock url {url}")))
        }
    }

    fn parent_u64() -> u64 {
        let cell = CellIndex::try_from(CELL_A).unwrap();
        u64::from(cell.parent(Resolution::Four).unwrap())
    }

    fn parent_hex() -> String {
        CellIndex::try_from(parent_u64()).unwrap().to_string()
    }

    fn tile_json(cells: &[u64]) -> Vec<u8> {
        let cell_json = cells
            .iter()
            .map(|cell| format!("\"{cell}\""))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "{{\"schema\":\"sonari.residence.tile.v1\",\"schema_version\":1,\"allowlist_version\":1,\"geo_resolution\":7,\"tile_parent_resolution\":4,\"merkle_root\":\"{ROOT}\",\"parent_h3_index\":\"{}\",\"cells\":[{}]}}",
            parent_u64(),
            cell_json
        )
        .into_bytes()
    }

    fn manifest_json(tile_bytes: &[u8]) -> Vec<u8> {
        format!(
            "{{\"schema\":\"sonari.residence.tile_manifest.v1\",\"schema_version\":1,\"allowlist_version\":1,\"geo_resolution\":7,\"tile_parent_resolution\":4,\"merkle_root\":\"{ROOT}\",\"object_key_rule\":\"residence-cells/v{{allowlist_version}}/res{{geo_resolution}}/tiles/res4/{{parent_hex}}.json\",\"tile_count\":1,\"total_cell_count\":2,\"tiles\":[{{\"parent_h3_index\":\"{}\",\"object_key\":\"residence-cells/v1/res7/tiles/res4/{}.json\",\"cell_count\":2,\"sha256\":\"{}\",\"byte_size\":{}}}]}}",
            parent_u64(),
            parent_hex(),
            to_hex(&sha256_bytes(tile_bytes)),
            tile_bytes.len()
        )
        .into_bytes()
    }

    fn config(manifest_bytes: &[u8]) -> ResidenceTileConfig {
        ResidenceTileConfig {
            base_url: "https://r2.example.test".to_owned(),
            manifest_key: "residence-cells/v1/res7/tiles/tile_manifest.json".to_owned(),
            manifest_sha256: to_hex(&sha256_bytes(manifest_bytes)),
            object_prefix: "residence-cells/v1/res7/tiles/".to_owned(),
            bucket: "sonari-residence-cells".to_owned(),
            allowlist_version: 1,
            geo_resolution: 7,
            merkle_root: ROOT.to_owned(),
            source_hash: None,
        }
    }

    fn source(manifest_bytes: &[u8], tile_bytes: &[u8]) -> MockSource {
        let mut bytes_by_url = HashMap::new();
        bytes_by_url.insert(
            "https://r2.example.test/residence-cells/v1/res7/tiles/tile_manifest.json".to_owned(),
            manifest_bytes.to_vec(),
        );
        bytes_by_url.insert(
            format!(
                "https://r2.example.test/residence-cells/v1/res7/tiles/res4/{}.json",
                parent_hex()
            ),
            tile_bytes.to_vec(),
        );
        MockSource {
            bytes_by_url,
            requested_urls: RefCell::new(Vec::new()),
        }
    }

    #[test]
    fn load_fetches_manifest_and_required_tiles_then_classifies_land_cells() {
        let tile_bytes = tile_json(&[CELL_A, CELL_B]);
        let manifest_bytes = manifest_json(&tile_bytes);
        let config = config(&manifest_bytes);
        let source = source(&manifest_bytes, &tile_bytes);

        let set = ResidenceTileSet::load(&config, &source, &[parent_u64()]).unwrap();

        assert!(set.is_land_cell(CELL_A));
        assert!(set.is_land_cell(CELL_B));
        assert!(!set.is_land_cell(CELL_A + 1));
        assert_eq!(set.manifest().total_cell_count, 2);
        assert_eq!(source.requested_urls.borrow().len(), 2);
    }

    #[test]
    fn load_treats_missing_parent_as_all_water_without_fetching_tile() {
        let tile_bytes = tile_json(&[CELL_A, CELL_B]);
        let manifest_bytes = manifest_json(&tile_bytes);
        let config = config(&manifest_bytes);
        let source = source(&manifest_bytes, &tile_bytes);

        let set = ResidenceTileSet::load(&config, &source, &[parent_u64() + 1]).unwrap();

        assert!(!set.is_land_cell(CELL_A));
        assert_eq!(source.requested_urls.borrow().len(), 1);
    }

    #[test]
    fn parse_manifest_rejects_sha256_mismatch() {
        let tile_bytes = tile_json(&[CELL_A, CELL_B]);
        let manifest_bytes = manifest_json(&tile_bytes);
        let mut config = config(&manifest_bytes);
        config.manifest_sha256 = format!("0x{}", "22".repeat(32));

        let error = parse_manifest_bytes(&config, &manifest_bytes).unwrap_err();

        assert!(error.to_string().contains("manifest sha256"));
    }

    #[test]
    fn parse_manifest_rejects_merkle_root_mismatch() {
        let tile_bytes = tile_json(&[CELL_A, CELL_B]);
        let manifest_bytes = manifest_json(&tile_bytes);
        let mut config = config(&manifest_bytes);
        config.merkle_root = format!("0x{}", "33".repeat(32));

        let error = parse_manifest_bytes(&config, &manifest_bytes).unwrap_err();

        assert!(error.to_string().contains("merkle_root"));
    }

    #[test]
    fn parse_tile_rejects_byte_size_mismatch() {
        let tile_bytes = tile_json(&[CELL_A, CELL_B]);
        let manifest_bytes = manifest_json(&tile_bytes);
        let config = config(&manifest_bytes);
        let manifest = parse_manifest_bytes(&config, &manifest_bytes).unwrap();
        let mut inventory = manifest.tiles[0].clone();
        inventory.byte_size += 1;

        let error = parse_tile_bytes(&config, &manifest, &inventory, parent_u64(), &tile_bytes)
            .unwrap_err();

        assert!(error.to_string().contains("byte_size"));
    }

    #[test]
    fn parse_tile_rejects_sha256_mismatch() {
        let tile_bytes = tile_json(&[CELL_A, CELL_B]);
        let manifest_bytes = manifest_json(&tile_bytes);
        let config = config(&manifest_bytes);
        let manifest = parse_manifest_bytes(&config, &manifest_bytes).unwrap();
        let mut inventory = manifest.tiles[0].clone();
        inventory.sha256 = format!("0x{}", "44".repeat(32));

        let error = parse_tile_bytes(&config, &manifest, &inventory, parent_u64(), &tile_bytes)
            .unwrap_err();

        assert!(error.to_string().contains("sha256"));
    }

    #[test]
    fn parse_tile_rejects_unsorted_cells() {
        let tile_bytes = tile_json(&[CELL_B, CELL_A]);
        let manifest_bytes = manifest_json(&tile_bytes);
        let config = config(&manifest_bytes);
        let manifest = parse_manifest_bytes(&config, &manifest_bytes).unwrap();

        let error = parse_tile_bytes(
            &config,
            &manifest,
            &manifest.tiles[0],
            parent_u64(),
            &tile_bytes,
        )
        .unwrap_err();

        assert!(error.to_string().contains("ascending"));
    }
}
