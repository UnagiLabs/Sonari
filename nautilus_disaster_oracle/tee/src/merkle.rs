use crate::artifacts::{LeafHash, ProofStep, SampleProof};
use crate::crypto::{sha3_256_bytes, to_hex};

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
                let mut data = Vec::with_capacity(65);
                data.push(0x01);
                data.extend_from_slice(&chunk[0]);
                data.extend_from_slice(&chunk[1]);
                next.push(sha3_256_bytes(&data));
            }
        }
        level = next;
    }
    level.first().copied()
}

pub(crate) fn sample_proof(
    leaf_hashes: &[LeafHash],
    expected_root: [u8; 32],
) -> Option<SampleProof> {
    if leaf_hashes.is_empty() {
        return None;
    }
    let target_index = usize::from(leaf_hashes.len() > 1);
    let mut proof = Vec::new();
    if leaf_hashes.len() > 1 {
        let sibling_index = if target_index == 0 { 1 } else { 0 };
        proof.push(ProofStep {
            direction: if sibling_index < target_index {
                "LEFT".to_owned()
            } else {
                "RIGHT".to_owned()
            },
            sibling_hash: leaf_hashes[sibling_index].leaf_hash.clone(),
        });
    }
    Some(SampleProof {
        target_leaf: leaf_hashes[target_index].clone(),
        proof,
        expected_root: to_hex(&expected_root),
    })
}
