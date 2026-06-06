use crate::crypto::PayloadSigner;
use nsm_api::api::{Request as NsmRequest, Response as NsmResponse};
use nsm_api::driver;
use std::fs::File;
use std::io::Read;

/// Generates a fresh 32-byte ephemeral signing seed from the kernel CSPRNG.
pub fn generate_ephemeral_signing_key_seed() -> Result<[u8; 32], Box<dyn std::error::Error>> {
    let mut file = File::open("/dev/urandom")?;
    read_seed_from(&mut file)
}

/// Reads exactly 32 seed bytes from an arbitrary reader (test seam).
fn read_seed_from<R: Read>(reader: &mut R) -> Result<[u8; 32], Box<dyn std::error::Error>> {
    let mut seed = [0u8; 32];
    reader.read_exact(&mut seed)?;
    Ok(seed)
}

/// Builds the JSON body returned by the `get_attestation` route.
///
/// `public_key` is the ephemeral enclave public key (hex). It is the same value
/// embedded in the NSM attestation document, so callers do not need any
/// registration-specific value here.
pub fn attestation_response_json(
    attestation_document: &[u8],
    public_key: &str,
) -> serde_json::Value {
    serde_json::json!({
        "attestation_document_hex": format!("0x{}", hex::encode(attestation_document)),
        "public_key": public_key,
    })
}

/// `attestation_response_json` に診断用の観測値を `world_id_mode_observation`
/// キーで追記したもの。membership enclave 専用。
///
/// 重要: 観測値は署名済み NSM attestation document の「外側」の平文 JSON エンベロープ
/// に載るだけで、attestation document（user_data）には一切含めない。よって診断専用で
/// あり attestation により保証された値ではない（host が渡した入力の echo に過ぎない）。
pub fn attestation_response_json_with_observation(
    attestation_document: &[u8],
    public_key: &str,
    world_id_mode_observation: &serde_json::Value,
) -> serde_json::Value {
    let mut value = attestation_response_json(attestation_document, public_key);
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "world_id_mode_observation".to_owned(),
            world_id_mode_observation.clone(),
        );
    }
    value
}

/// Produces an NSM attestation document binding the signer's ephemeral public
/// key, returning the `get_attestation` response body.
///
/// `public_key_label` is the byte string the enclave signs to derive the
/// ephemeral public key it embeds; callers pass their verifier-specific label
/// (the embedded public key is the ephemeral key itself, so the label does not
/// affect on-chain registration matching).
pub fn enclave_attestation_response<S: PayloadSigner>(
    signer: &S,
    public_key_label: &[u8],
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    enclave_attestation_response_inner(signer, public_key_label, None)
}

/// 観測値付きの get_attestation 応答。観測値は平文エンベロープにのみ載り、
/// NSM attestation document（user_data）には含めない（診断専用）。
pub fn enclave_attestation_response_with_observation<S: PayloadSigner>(
    signer: &S,
    public_key_label: &[u8],
    world_id_mode_observation: &serde_json::Value,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    enclave_attestation_response_inner(signer, public_key_label, Some(world_id_mode_observation))
}

fn enclave_attestation_response_inner<S: PayloadSigner>(
    signer: &S,
    public_key_label: &[u8],
    world_id_mode_observation: Option<&serde_json::Value>,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let signature = signer.sign_payload(public_key_label);
    let public_key_bytes = hex::decode(signature.public_key.trim_start_matches("0x"))?;
    let fd = driver::nsm_init();
    let request = NsmRequest::Attestation {
        user_data: None,
        nonce: None,
        public_key: Some(serde_bytes::ByteBuf::from(public_key_bytes)),
    };
    let response = driver::nsm_process_request(fd, request);
    driver::nsm_exit(fd);
    match response {
        NsmResponse::Attestation { document } => {
            let json = match world_id_mode_observation {
                Some(obs) => attestation_response_json_with_observation(
                    &document,
                    &signature.public_key,
                    obs,
                ),
                None => attestation_response_json(&document, &signature.public_key),
            };
            Ok(json)
        }
        _ => Err("unexpected NSM attestation response".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        attestation_response_json, attestation_response_json_with_observation, read_seed_from,
    };

    #[test]
    fn read_seed_from_consumes_exactly_32_bytes() {
        let bytes = (0u8..40).collect::<Vec<u8>>();
        let mut cursor = std::io::Cursor::new(bytes);

        let seed = read_seed_from(&mut cursor).unwrap();

        assert_eq!(seed, std::array::from_fn::<u8, 32, _>(|i| i as u8));
    }

    #[test]
    fn read_seed_from_fails_when_source_is_too_short() {
        let mut cursor = std::io::Cursor::new(vec![0u8; 31]);
        assert!(read_seed_from(&mut cursor).is_err());
    }

    #[test]
    fn attestation_response_json_has_document_and_public_key_shape() {
        let document = [0xAB, 0xCD, 0xEF];
        let public_key = format!("0x{}", "11".repeat(32));

        let value = attestation_response_json(&document, &public_key);

        assert_eq!(
            value
                .get("attestation_document_hex")
                .and_then(serde_json::Value::as_str),
            Some("0xabcdef")
        );
        assert_eq!(
            value.get("public_key").and_then(serde_json::Value::as_str),
            Some(public_key.as_str())
        );
        let keys = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        assert_eq!(keys, ["attestation_document_hex", "public_key"]);
    }

    #[test]
    fn attestation_response_json_with_observation_adds_observation_key() {
        let document = [0xAB, 0xCD, 0xEF];
        let public_key = format!("0x{}", "11".repeat(32));
        let observation = serde_json::json!({
            "resolved_mode": "dummy",
            "received_proof_mode": "dummy",
            "received_network": "testnet",
            "redacted": false,
        });

        let value =
            attestation_response_json_with_observation(&document, &public_key, &observation);

        // world_id_mode_observation キーが存在し中身が一致する
        assert_eq!(value.get("world_id_mode_observation"), Some(&observation));
        // 既存の 2 キーも残る
        assert_eq!(
            value
                .get("attestation_document_hex")
                .and_then(serde_json::Value::as_str),
            Some("0xabcdef")
        );
        assert_eq!(
            value.get("public_key").and_then(serde_json::Value::as_str),
            Some(public_key.as_str())
        );
    }

    #[test]
    fn attestation_response_json_without_observation_stays_two_keys() {
        let document = [0xAB, 0xCD, 0xEF];
        let public_key = format!("0x{}", "22".repeat(32));

        let value = attestation_response_json(&document, &public_key);

        let key_count = value.as_object().unwrap().len();
        assert_eq!(key_count, 2, "base function must produce exactly 2 keys");
        assert!(
            value.get("world_id_mode_observation").is_none(),
            "base function must not contain observation key"
        );
    }

    #[test]
    fn observation_rides_outside_the_signed_document() {
        // The observation is a plaintext sibling of the attestation document, never
        // folded into it. Adding the observation must not change the document hex or
        // public key, proving it cannot alter the signed attestation bytes (it is
        // diagnostic-only, not attestation-bound).
        let document = [0x01, 0x02, 0x03];
        let public_key = format!("0x{}", "33".repeat(32));
        let observation = serde_json::json!({
            "resolved_mode": "dummy",
            "received_proof_mode": "dummy",
            "received_network": "testnet",
            "redacted": false,
        });

        let with = attestation_response_json_with_observation(&document, &public_key, &observation);
        let without = attestation_response_json(&document, &public_key);

        assert_eq!(
            with["attestation_document_hex"], without["attestation_document_hex"],
            "observation must not change the attestation document"
        );
        assert_eq!(
            with["public_key"], without["public_key"],
            "observation must not change the embedded public key"
        );
        assert_eq!(with.get("world_id_mode_observation"), Some(&observation));
    }
}
