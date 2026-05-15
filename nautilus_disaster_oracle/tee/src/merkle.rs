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
    let mut current_index = target_index;
    let mut level = leaf_hashes
        .iter()
        .map(|leaf| hex_hash_to_32(&leaf.leaf_hash))
        .collect::<Option<Vec<_>>>()?;
    let mut proof = Vec::new();

    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for left_index in (0..level.len()).step_by(2) {
            let right_index = left_index + 1;
            if right_index == level.len() {
                if current_index == left_index {
                    current_index = next.len();
                }
                next.push(level[left_index]);
                continue;
            }

            if current_index == left_index || current_index == right_index {
                let (direction, sibling) = if current_index == left_index {
                    ("RIGHT", level[right_index])
                } else {
                    ("LEFT", level[left_index])
                };
                proof.push(ProofStep {
                    direction: direction.to_owned(),
                    sibling_hash: to_hex(&sibling),
                });
                current_index = next.len();
            }

            next.push(internal_hash(level[left_index], level[right_index]));
        }
        level = next;
    }

    Some(SampleProof {
        target_leaf: leaf_hashes[target_index].clone(),
        proof,
        expected_root: to_hex(&expected_root),
    })
}

fn internal_hash(left: [u8; 32], right: [u8; 32]) -> [u8; 32] {
    let mut data = Vec::with_capacity(65);
    data.push(0x01);
    data.extend_from_slice(&left);
    data.extend_from_slice(&right);
    sha3_256_bytes(&data)
}

fn hex_hash_to_32(value: &str) -> Option<[u8; 32]> {
    hex::decode(value.strip_prefix("0x")?).ok()?.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_leaf_hashes(count: usize) -> Vec<LeafHash> {
        (0..count)
            .map(|index| {
                let hash = sha3_256_bytes(&[index as u8]);
                LeafHash {
                    h3_index: index.to_string(),
                    leaf_hash: to_hex(&hash),
                }
            })
            .collect()
    }

    fn proof_root(proof: &SampleProof) -> [u8; 32] {
        let mut current: [u8; 32] = hex::decode(
            proof
                .target_leaf
                .leaf_hash
                .strip_prefix("0x")
                .expect("fixture leaf hash is 0x-prefixed"),
        )
        .expect("fixture leaf hash is hex")
        .try_into()
        .expect("fixture leaf hash is 32 bytes");

        for step in &proof.proof {
            let sibling: [u8; 32] = hex::decode(
                step.sibling_hash
                    .strip_prefix("0x")
                    .expect("fixture sibling hash is 0x-prefixed"),
            )
            .expect("fixture sibling hash is hex")
            .try_into()
            .expect("fixture sibling hash is 32 bytes");
            let mut data = Vec::with_capacity(65);
            data.push(0x01);
            match step.direction.as_str() {
                "LEFT" => {
                    data.extend_from_slice(&sibling);
                    data.extend_from_slice(&current);
                }
                "RIGHT" => {
                    data.extend_from_slice(&current);
                    data.extend_from_slice(&sibling);
                }
                direction => panic!("unsupported proof direction {direction}"),
            }
            current = sha3_256_bytes(&data);
        }

        current
    }

    #[test]
    fn sample_proof_replays_to_root_for_three_leaves() {
        let leaf_hashes = fixture_leaf_hashes(3);
        let root = merkle_root_from_leaf_hashes(
            &leaf_hashes
                .iter()
                .map(|leaf| {
                    hex::decode(leaf.leaf_hash.trim_start_matches("0x"))
                        .unwrap()
                        .try_into()
                        .unwrap()
                })
                .collect::<Vec<[u8; 32]>>(),
        )
        .expect("root exists");
        let proof = sample_proof(&leaf_hashes, root).expect("proof exists");

        assert_eq!(proof_root(&proof), root);
    }

    #[test]
    fn sample_proof_replays_to_root_for_five_leaves() {
        let leaf_hashes = fixture_leaf_hashes(5);
        let root = merkle_root_from_leaf_hashes(
            &leaf_hashes
                .iter()
                .map(|leaf| {
                    hex::decode(leaf.leaf_hash.trim_start_matches("0x"))
                        .unwrap()
                        .try_into()
                        .unwrap()
                })
                .collect::<Vec<[u8; 32]>>(),
        )
        .expect("root exists");
        let proof = sample_proof(&leaf_hashes, root).expect("proof exists");

        assert_eq!(proof_root(&proof), root);
    }
}
