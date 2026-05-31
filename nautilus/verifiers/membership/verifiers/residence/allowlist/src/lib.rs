use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ResidenceCellLeaf {
    pub h3_index: u64,
    pub geo_resolution: u8,
    pub allowlist_version: u64,
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
