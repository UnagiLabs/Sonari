use geo::{Geometry as GeoGeometry, Polygon};
use geojson::{Feature, GeoJson};
use h3o::{
    Resolution,
    geom::{ContainmentMode, TilerBuilder},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fmt;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ResidenceCellLeaf {
    pub h3_index: u64,
    pub geo_resolution: u8,
    pub allowlist_version: u64,
}

#[derive(Debug)]
pub enum ResidenceAllowlistError {
    DuplicateH3Index(u64),
    InvalidLandGeometry(String),
    MalformedLandSource(String),
    LeafEncoding(bcs::Error),
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
            Self::InvalidLandGeometry(error) => {
                write!(formatter, "invalid residence land geometry: {error}")
            }
            Self::MalformedLandSource(error) => {
                write!(formatter, "malformed residence land source: {error}")
            }
            Self::LeafEncoding(error) => {
                write!(formatter, "failed to encode residence leaf: {error}")
            }
        }
    }
}

impl std::error::Error for ResidenceAllowlistError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::DuplicateH3Index(_) => None,
            Self::InvalidLandGeometry(_) | Self::MalformedLandSource(_) => None,
            Self::LeafEncoding(error) => Some(error),
        }
    }
}

impl From<bcs::Error> for ResidenceAllowlistError {
    fn from(error: bcs::Error) -> Self {
        Self::LeafEncoding(error)
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
                    "feature collection is empty".to_string(),
                ));
            }
            for feature in collection.features {
                append_feature_polygons(feature, &mut polygons)?;
            }
        }
        GeoJson::Feature(feature) => {
            append_feature_polygons(feature, &mut polygons)?;
        }
        GeoJson::Geometry(geometry) => {
            append_geometry_polygons(geometry, &mut polygons)?;
        }
    }

    if polygons.is_empty() {
        return Err(ResidenceAllowlistError::MalformedLandSource(
            "land source contains no Polygon or MultiPolygon geometry".to_string(),
        ));
    }

    Ok(polygons)
}

pub fn generate_candidate_h3_indexes_from_geojson(
    source: &str,
) -> Result<Vec<u64>, ResidenceAllowlistError> {
    let polygons = load_land_polygons_from_geojson(source)?;
    generate_candidate_h3_indexes(&polygons)
}

pub fn generate_candidate_h3_indexes(
    polygons: &[Polygon],
) -> Result<Vec<u64>, ResidenceAllowlistError> {
    // Covers includes cells whose boundary intersects land, plus cells covering tiny polygons.
    let mut tiler = TilerBuilder::new(Resolution::Seven)
        .containment_mode(ContainmentMode::Covers)
        .build();
    tiler
        .add_batch(polygons.iter().cloned())
        .map_err(|error| ResidenceAllowlistError::InvalidLandGeometry(error.to_string()))?;

    let mut indexes = tiler.into_coverage().map(u64::from).collect::<Vec<_>>();
    indexes.sort_unstable();
    indexes.dedup();
    Ok(indexes)
}

fn append_feature_polygons(
    feature: Feature,
    polygons: &mut Vec<Polygon>,
) -> Result<(), ResidenceAllowlistError> {
    let Some(geometry) = feature.geometry else {
        return Err(ResidenceAllowlistError::MalformedLandSource(
            "feature is missing geometry".to_string(),
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
                "land source geometry must be Polygon or MultiPolygon".to_string(),
            ));
        }
    }
    Ok(())
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

fn proof_step(direction: ProofDirection, sibling_hash: [u8; 32]) -> ResidenceProofStep {
    ResidenceProofStep {
        direction,
        sibling_on_left: direction.sibling_on_left(),
        sibling_hash,
    }
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
