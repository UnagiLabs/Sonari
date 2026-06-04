//! Shared enclave plumbing for Sonari TEE verifiers.
//!
//! This module hosts the verifier-agnostic enclave wiring (VSOCK transport,
//! minimal HTTP framing, NSM attestation, ephemeral key generation, and the
//! request-routing server skeleton) plus the [`ProcessDataHandler`] contract.
//! Verifier crates implement the handler and own their domain logic; they do
//! not reimplement transport, signing, attestation, or registration injection.

pub mod attestation;
pub mod http;
pub mod registration;
pub mod server;
pub mod vsock;

pub use attestation::{
    attestation_response_json, enclave_attestation_response, generate_ephemeral_signing_key_seed,
};
pub use http::{HttpRequest, find_header_end, read_http_request, write_http_json_response};
pub use registration::EnclaveRegistrationMetadata;
pub use server::{
    HandlerError, ProcessDataHandler, ProcessOutput, TeeContext, error_response, handle_connection,
    health_check_response, panic_message,
};
pub use vsock::{AF_VSOCK, SockAddrVm, VMADDR_CID_ANY, VsockListener};
