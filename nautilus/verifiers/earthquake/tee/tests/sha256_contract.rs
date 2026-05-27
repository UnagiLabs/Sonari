use tee::sha256_bytes;

#[test]
fn digest_helper_uses_sha256() {
    assert_eq!(
        hex::encode(sha256_bytes(b"abc")),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
}
