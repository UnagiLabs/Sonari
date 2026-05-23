use crate::core::artifacts::StoredSourceRef;
use crate::core::types::OracleError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SourceArchiveError {
    #[error("source archive store failed: {0}")]
    StoreFailed(String),
    #[error("source archive fetch failed: {0}")]
    FetchFailed(String),
    #[error(
        "source archive blob mismatch for {source_uri}: expected {expected_hash}, got {actual_hash}"
    )]
    BlobMismatch {
        source_uri: String,
        expected_hash: String,
        actual_hash: String,
    },
    #[error(transparent)]
    Oracle(#[from] OracleError),
}

pub trait SourceArchive {
    fn store_and_verify(
        &self,
        source_uri: &str,
        source_hash: &str,
        bytes: &[u8],
    ) -> Result<StoredSourceRef, SourceArchiveError>;
}
