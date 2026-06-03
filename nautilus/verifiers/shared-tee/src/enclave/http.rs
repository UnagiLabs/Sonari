use std::fs::File;
use std::io::{Read, Write};

/// Maximum request header bytes accumulated before the `\r\n\r\n` boundary.
const MAX_HEADER_SIZE: usize = 1024 * 1024;

/// Maximum request body bytes the enclave will accumulate for a single request.
///
/// The enclave runs with fixed memory, so an unbounded `Content-Length` body is a
/// DoS vector. The real `process_data` envelopes are small JSON documents (the
/// worker passes URIs, not bulk data, and the enclave fetches large artifacts via
/// the egress proxy), so a 1 MiB ceiling (matching [`MAX_HEADER_SIZE`]) leaves
/// generous headroom while bounding memory. A `Content-Length` above this is
/// rejected before any body bytes are read.
const MAX_BODY_SIZE: usize = 1024 * 1024;

/// Minimal HTTP/1.1 request parsed off a stream.
///
/// Only the fields the enclave routing needs are retained: method, path and the
/// raw request body bytes.
#[derive(Debug)]
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub body: Vec<u8>,
}

/// Reads a single HTTP request from `stream`.
///
/// Headers are read until the `\r\n\r\n` boundary (capped at [`MAX_HEADER_SIZE`]),
/// then exactly `Content-Length` body bytes are consumed after rejecting any
/// declared length above [`MAX_BODY_SIZE`].
///
/// Future work: the server spawns one thread per accepted connection
/// ([`crate::enclave::server::handle_connection`]); a max-concurrent-connection
/// cap is out of scope here because the enclave peer is the limited Nitro parent,
/// but it should be added if the trust boundary widens.
pub fn read_http_request(stream: &mut File) -> Result<HttpRequest, Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    let header_end;
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            return Err("connection closed before HTTP headers".into());
        }
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(index) = find_header_end(&bytes) {
            header_end = index;
            break;
        }
        if bytes.len() > MAX_HEADER_SIZE {
            return Err("HTTP headers exceeded max size".into());
        }
    }
    let header_text = std::str::from_utf8(&bytes[..header_end])?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().ok_or("missing HTTP request line")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or("missing HTTP method")?.to_owned();
    let path = parts.next().ok_or("missing HTTP path")?.to_owned();
    let content_length = lines
        .filter_map(|line| line.split_once(':'))
        .find_map(|(name, value)| {
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);
    if content_length > MAX_BODY_SIZE {
        return Err(format!(
            "HTTP body Content-Length {content_length} exceeds max body size {MAX_BODY_SIZE}"
        )
        .into());
    }
    let body_start = header_end + 4;
    while bytes.len() < body_start + content_length {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            return Err("connection closed before HTTP body".into());
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    Ok(HttpRequest {
        method,
        path,
        body: bytes[body_start..body_start + content_length].to_vec(),
    })
}

/// Finds the byte index of the `\r\n\r\n` header/body delimiter, if present.
pub fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

/// Writes a JSON body as an HTTP/1.1 response with a `connection: close` header.
pub fn write_http_json_response(
    stream: &mut File,
    status_code: u16,
    body: &serde_json::Value,
) -> Result<(), Box<dyn std::error::Error>> {
    let body_bytes = serde_json::to_vec(body)?;
    let reason = if status_code == 200 { "OK" } else { "Error" };
    write!(
        stream,
        "HTTP/1.1 {status_code} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body_bytes.len()
    )?;
    stream.write_all(&body_bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{HttpRequest, find_header_end, read_http_request};
    use std::fs::File;
    use std::io::{Seek, SeekFrom, Write};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_stream(raw: &[u8]) -> File {
        let path = std::env::temp_dir().join(format!(
            "sonari-tee-core-http-{}-{}.bin",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut file = File::options()
            .create(true)
            .read(true)
            .write(true)
            .truncate(true)
            .open(&path)
            .unwrap();
        file.write_all(raw).unwrap();
        file.seek(SeekFrom::Start(0)).unwrap();
        let _ = std::fs::remove_file(&path);
        file
    }

    #[test]
    fn find_header_end_locates_crlf_boundary() {
        assert_eq!(find_header_end(b"GET / HTTP/1.1\r\n\r\nbody"), Some(14));
        assert_eq!(find_header_end(b"no boundary here"), None);
    }

    #[test]
    fn read_http_request_parses_request_line_content_length_and_body() {
        // Content-Length is 12 (`{"action":1}`); bytes after it must be ignored.
        let raw = b"POST /process_data HTTP/1.1\r\ncontent-type: application/json\r\nContent-Length: 12\r\n\r\n{\"action\":1}trailing-bytes-ignored";
        let mut stream = temp_stream(raw);

        let HttpRequest { method, path, body } = read_http_request(&mut stream).unwrap();

        assert_eq!(method, "POST");
        assert_eq!(path, "/process_data");
        assert_eq!(body, b"{\"action\":1}");
    }

    #[test]
    fn read_http_request_defaults_to_empty_body_without_content_length() {
        let raw = b"GET /get_attestation HTTP/1.1\r\nhost: enclave\r\n\r\n";
        let mut stream = temp_stream(raw);

        let request = read_http_request(&mut stream).unwrap();

        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/get_attestation");
        assert!(request.body.is_empty());
    }

    #[test]
    fn read_http_request_rejects_content_length_above_max_body_size() {
        // A Content-Length above the enclave body limit must be rejected before any
        // body bytes are accumulated, so an adversarial peer cannot exhaust the
        // enclave's fixed memory by declaring an enormous body.
        let over_limit = super::MAX_BODY_SIZE + 1;
        let raw = format!(
            "POST /process_data HTTP/1.1\r\ncontent-type: application/json\r\nContent-Length: {over_limit}\r\n\r\n"
        );
        let mut stream = temp_stream(raw.as_bytes());

        let error = read_http_request(&mut stream)
            .expect_err("an over-limit Content-Length must be rejected");

        assert!(
            error.to_string().contains("body") && error.to_string().contains("max"),
            "error: {error}"
        );
    }

    #[test]
    fn read_http_request_accepts_body_at_max_body_size_boundary() {
        // A small body well within the limit is still accepted unchanged, proving
        // the limit only rejects over-limit declarations (no behaviour change for
        // the real, small process_data envelopes).
        let raw = b"POST /process_data HTTP/1.1\r\nContent-Length: 12\r\n\r\n{\"action\":1}";
        let mut stream = temp_stream(raw);

        let request = read_http_request(&mut stream).expect("an in-limit body must be accepted");

        assert_eq!(request.body, b"{\"action\":1}");
    }
}
