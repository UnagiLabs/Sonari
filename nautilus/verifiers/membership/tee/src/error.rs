use thiserror::Error;

#[derive(Debug, Error)]
pub enum IdentityError {
    #[error("invalid identity hex input: {0}")]
    Hex(#[from] sonari_tee_core::HexError),
    #[error("invalid identity signing seed: {0}")]
    Seed(#[from] sonari_tee_core::SeedError),
    #[error("BCS serialization failed: {0}")]
    Bcs(#[from] bcs::Error),
    #[error("invalid identity verification request: {0}")]
    Request(String),
}
