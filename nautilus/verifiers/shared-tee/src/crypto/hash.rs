use sha2::{Digest, Sha256};

pub fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

#[cfg(test)]
mod tests {
    use super::sha256_bytes;

    #[test]
    fn digest_helper_uses_sha256() {
        assert_eq!(
            hex::encode(sha256_bytes(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
    }
}
