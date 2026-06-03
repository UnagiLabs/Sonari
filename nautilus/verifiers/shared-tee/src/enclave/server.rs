use crate::enclave::http::{HttpRequest, read_http_request, write_http_json_response};
use std::collections::BTreeMap;
use std::fs::File;
use std::panic::{AssertUnwindSafe, catch_unwind};

/// Dependency-injection boundary passed to a [`ProcessDataHandler`].
///
/// The handler must never read process environment variables directly; the
/// shared server resolves environment-derived configuration once and hands it
/// to the handler through this context (e.g. the egress proxy URL).
#[derive(Debug, Clone, Default)]
pub struct TeeContext {
    env: BTreeMap<String, String>,
}

impl TeeContext {
    /// Builds an empty context.
    pub fn new() -> Self {
        Self {
            env: BTreeMap::new(),
        }
    }

    /// Returns a context carrying the provided env entries.
    pub fn with_env<I, K, V>(entries: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        Self {
            env: entries
                .into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect(),
        }
    }

    /// Looks up an injected configuration value by name.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.env.get(name).map(String::as_str)
    }
}

/// Error returned by a [`ProcessDataHandler`].
///
/// The handler reports a domain error with an error code and message; mapping
/// the error onto an HTTP status and response envelope is the server's job.
#[derive(Debug, Clone)]
pub struct HandlerError {
    pub error_code: String,
    pub message: String,
}

impl HandlerError {
    /// Builds a handler error from an error code and message.
    pub fn new(error_code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            error_code: error_code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for HandlerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.error_code, self.message)
    }
}

impl std::error::Error for HandlerError {}

/// Output a [`ProcessDataHandler`] produces for a single request.
///
/// `payload_bcs` are the canonical bytes the server will sign; `result_json`
/// is the display/result envelope returned to the caller. The handler does not
/// sign, attest, perform I/O, or inject registration metadata.
#[derive(Debug, Clone)]
pub struct ProcessOutput {
    pub payload_bcs: Vec<u8>,
    pub result_json: serde_json::Value,
}

/// Verifier-specific request processing contract.
///
/// Implementations transform request `input` bytes into a [`ProcessOutput`].
/// They MUST NOT sign payloads, generate ephemeral keys, call NSM attestation,
/// inject registration metadata, or touch VSOCK/HTTP I/O — those concerns are
/// owned by the shared server.
pub trait ProcessDataHandler {
    fn process(&self, input: &[u8], ctx: &TeeContext) -> Result<ProcessOutput, HandlerError>;
}

/// Standard error envelope shared by every enclave route.
pub fn error_response(error_code: &str, message: &str) -> serde_json::Value {
    serde_json::json!({
        "error_code": error_code,
        "message": message,
    })
}

/// Standard healthy response body for the `health_check` route.
pub fn health_check_response() -> serde_json::Value {
    serde_json::json!({
        "status": "healthy",
        "external_sources_reachable": true,
    })
}

/// Extracts a panic payload into a printable message.
pub fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return format!("panic: {message}");
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return format!("panic: {message}");
    }
    "panic: unknown payload".to_owned()
}

/// Reads a request, dispatches it, and writes the JSON response, catching any
/// panic so a single bad request never tears down the connection thread.
pub fn handle_connection<F>(mut stream: File, dispatch: F) -> Result<(), Box<dyn std::error::Error>>
where
    F: FnOnce(HttpRequest) -> Result<(u16, serde_json::Value), Box<dyn std::error::Error>>,
{
    let request = read_http_request(&mut stream)?;
    let (status_code, body) = match catch_unwind(AssertUnwindSafe(|| dispatch(request))) {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => (
            500,
            error_response("AWS_RUNNER_PROCESS_FAILED", &error.to_string()),
        ),
        Err(payload) => (
            500,
            error_response("AWS_RUNNER_PROCESS_FAILED", &panic_message(payload)),
        ),
    };
    write_http_json_response(&mut stream, status_code, &body)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        HandlerError, ProcessDataHandler, ProcessOutput, TeeContext, error_response,
        health_check_response, panic_message,
    };

    struct EchoHandler;

    impl ProcessDataHandler for EchoHandler {
        fn process(&self, input: &[u8], ctx: &TeeContext) -> Result<ProcessOutput, HandlerError> {
            if input.is_empty() {
                return Err(HandlerError::new("EMPTY_INPUT", "input was empty"));
            }
            Ok(ProcessOutput {
                payload_bcs: input.to_vec(),
                result_json: serde_json::json!({
                    "proxy": ctx.get("SONARI_EARTHQUAKE_EGRESS_PROXY_URL"),
                    "len": input.len(),
                }),
            })
        }
    }

    #[test]
    fn tee_context_exposes_injected_env_only() {
        let ctx =
            TeeContext::with_env([("SONARI_EARTHQUAKE_EGRESS_PROXY_URL", "http://proxy:8080")]);

        assert_eq!(
            ctx.get("SONARI_EARTHQUAKE_EGRESS_PROXY_URL"),
            Some("http://proxy:8080")
        );
        assert_eq!(ctx.get("UNSET"), None);
        assert_eq!(TeeContext::new().get("anything"), None);
    }

    #[test]
    fn handler_returns_payload_bytes_and_result_json() {
        let handler = EchoHandler;
        let ctx =
            TeeContext::with_env([("SONARI_EARTHQUAKE_EGRESS_PROXY_URL", "http://proxy:8080")]);

        let output = handler.process(b"abc", &ctx).unwrap();

        assert_eq!(output.payload_bcs, b"abc");
        assert_eq!(output.result_json.get("len").unwrap(), 3);
        assert_eq!(
            output.result_json.get("proxy").and_then(|v| v.as_str()),
            Some("http://proxy:8080")
        );
    }

    #[test]
    fn handler_error_surfaces_code_and_message() {
        let error = EchoHandler.process(b"", &TeeContext::new()).unwrap_err();
        assert_eq!(error.error_code, "EMPTY_INPUT");
        assert_eq!(error.to_string(), "EMPTY_INPUT: input was empty");
    }

    #[test]
    fn error_and_health_envelopes_have_expected_shape() {
        assert_eq!(
            error_response("AWS_RUNNER_PROCESS_FAILED", "boom"),
            serde_json::json!({
                "error_code": "AWS_RUNNER_PROCESS_FAILED",
                "message": "boom",
            })
        );
        assert_eq!(
            health_check_response(),
            serde_json::json!({
                "status": "healthy",
                "external_sources_reachable": true,
            })
        );
    }

    #[test]
    fn panic_message_renders_str_and_string_payloads() {
        assert_eq!(panic_message(Box::new("boom")), "panic: boom");
        assert_eq!(panic_message(Box::new("boom".to_owned())), "panic: boom");
    }
}
