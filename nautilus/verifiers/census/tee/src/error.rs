use std::error::Error;
use std::fmt::{Display, Formatter};

#[derive(Debug)]
pub enum CensusError {
    Hex(sonari_tee_core::HexError),
    Bcs(bcs::Error),
    InvalidPayload(String),
}

impl Display for CensusError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Hex(error) => write!(f, "invalid census hex input: {error}"),
            Self::Bcs(error) => write!(f, "BCS serialization failed: {error}"),
            Self::InvalidPayload(message) => write!(f, "invalid census BCS payload: {message}"),
        }
    }
}

impl Error for CensusError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Hex(error) => Some(error),
            Self::Bcs(error) => Some(error),
            Self::InvalidPayload(_) => None,
        }
    }
}

impl From<sonari_tee_core::HexError> for CensusError {
    fn from(value: sonari_tee_core::HexError) -> Self {
        Self::Hex(value)
    }
}

impl From<bcs::Error> for CensusError {
    fn from(value: bcs::Error) -> Self {
        Self::Bcs(value)
    }
}
