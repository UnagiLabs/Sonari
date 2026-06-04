use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SignatureArtifact {
    pub algorithm: String,
    pub public_key: String,
    pub signature: String,
}

#[cfg(test)]
mod tests {
    use super::SignatureArtifact;

    #[test]
    fn signature_artifact_preserves_json_shape() {
        let artifact = SignatureArtifact {
            algorithm: "Ed25519".to_owned(),
            public_key: "0xpublic".to_owned(),
            signature: "0xsig".to_owned(),
        };

        assert_eq!(
            serde_json::to_value(artifact).unwrap(),
            serde_json::json!({
                "algorithm": "Ed25519",
                "public_key": "0xpublic",
                "signature": "0xsig",
            })
        );
    }
}
