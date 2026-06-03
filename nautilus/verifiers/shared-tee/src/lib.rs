mod artifacts;
mod crypto;
pub mod enclave;
mod seed;

pub use artifacts::SignatureArtifact;
pub use crypto::{HexError, LocalEd25519Signer, PayloadSigner, hex_to_32, sha256_bytes, to_hex};
pub use enclave::{
    EnclaveRegistrationMetadata, HandlerError, HttpRequest, ProcessDataHandler, ProcessOutput,
    TeeContext, VsockListener, attestation_response_json, enclave_attestation_response,
    error_response, generate_ephemeral_signing_key_seed, handle_connection, health_check_response,
    read_http_request, write_http_json_response,
};
pub use seed::{
    DEV_SIGNING_KEY_SEED_HEX, SeedError, non_empty_env, parse_seed, signing_key_seed_from_env,
};
