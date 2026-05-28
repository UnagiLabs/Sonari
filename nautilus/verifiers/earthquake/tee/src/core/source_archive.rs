use crate::core::artifacts::StoredSourceRef;
use crate::core::types::OracleError;
use crate::crypto::{sha256_bytes, to_hex};
use serde_json::Value;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use thiserror::Error;

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);
pub const DEFAULT_WALRUS_CLI_TIMEOUT_MS: u64 = 120_000;

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

#[derive(Debug, Clone)]
pub struct WalrusCliSourceArchiveConfig {
    pub cli_path: PathBuf,
    pub config_path: Option<PathBuf>,
    pub context: Option<String>,
    pub wallet: Option<String>,
    pub upload_relay: Option<String>,
    pub aggregator_url: String,
    pub epochs: u32,
    pub command_timeout_ms: u64,
}

impl Default for WalrusCliSourceArchiveConfig {
    fn default() -> Self {
        Self {
            cli_path: PathBuf::from("walrus"),
            config_path: None,
            context: None,
            wallet: None,
            upload_relay: None,
            aggregator_url: String::new(),
            epochs: 2,
            command_timeout_ms: DEFAULT_WALRUS_CLI_TIMEOUT_MS,
        }
    }
}

impl WalrusCliSourceArchiveConfig {
    pub fn from_env() -> Result<Self, SourceArchiveError> {
        let cli_path = std::env::var_os("SONARI_WALRUS_CLI")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("walrus"));
        let config_path = std::env::var_os("SONARI_WALRUS_CONFIG").map(PathBuf::from);
        let context = non_empty_env("SONARI_WALRUS_CONTEXT");
        let wallet = non_empty_env("SONARI_WALRUS_WALLET");
        let upload_relay = non_empty_env("SONARI_WALRUS_UPLOAD_RELAY");
        let aggregator_url = non_empty_env("SONARI_WALRUS_AGGREGATOR_URL").ok_or_else(|| {
            SourceArchiveError::StoreFailed(
                "SONARI_WALRUS_AGGREGATOR_URL is required for Walrus archive".to_owned(),
            )
        })?;
        let epochs = match non_empty_env("SONARI_WALRUS_EPOCHS") {
            Some(value) => parse_epochs(&value)?,
            None => 2,
        };
        let command_timeout_ms = match std::env::var("SONARI_WALRUS_CLI_TIMEOUT_MS") {
            Ok(value) => parse_command_timeout_ms(&value)?,
            Err(std::env::VarError::NotPresent) => DEFAULT_WALRUS_CLI_TIMEOUT_MS,
            Err(error) => {
                return Err(SourceArchiveError::StoreFailed(format!(
                    "invalid SONARI_WALRUS_CLI_TIMEOUT_MS: {error}"
                )));
            }
        };

        Ok(Self {
            cli_path,
            config_path,
            context,
            wallet,
            upload_relay,
            aggregator_url,
            epochs,
            command_timeout_ms,
        })
    }
}

#[derive(Debug)]
pub struct WalrusCliSourceArchive<R = SystemWalrusCommandRunner, F = ReqwestBlobFetcher> {
    config: WalrusCliSourceArchiveConfig,
    command_runner: R,
    blob_fetcher: F,
}

impl WalrusCliSourceArchive<SystemWalrusCommandRunner, ReqwestBlobFetcher> {
    pub fn new(config: WalrusCliSourceArchiveConfig) -> Result<Self, SourceArchiveError> {
        validate_walrus_config(&config)?;
        Ok(Self {
            config,
            command_runner: SystemWalrusCommandRunner,
            blob_fetcher: ReqwestBlobFetcher,
        })
    }
}

impl<R, F> WalrusCliSourceArchive<R, F>
where
    R: WalrusCommandRunner,
    F: BlobFetcher,
{
    #[cfg(test)]
    fn with_clients(
        config: WalrusCliSourceArchiveConfig,
        command_runner: R,
        blob_fetcher: F,
    ) -> Self {
        Self {
            config,
            command_runner,
            blob_fetcher,
        }
    }

    fn blob_id_for_bytes(&self, bytes: &[u8]) -> Result<String, SourceArchiveError> {
        let temp_file = TempSourceFile::write(bytes)
            .map_err(|error| SourceArchiveError::StoreFailed(error.to_string()))?;
        let output = self.run_walrus(
            vec![
                OsString::from("blob-id"),
                temp_file.path().as_os_str().to_owned(),
            ],
            SourceArchiveError::StoreFailed,
        )?;
        parse_blob_id_output(&output.stdout)
    }

    fn run_store(&self, bytes: &[u8]) -> Result<String, SourceArchiveError> {
        let temp_file = TempSourceFile::write(bytes)
            .map_err(|error| SourceArchiveError::StoreFailed(error.to_string()))?;
        let mut args = vec![
            OsString::from("store"),
            OsString::from("--epochs"),
            OsString::from(self.config.epochs.to_string()),
            OsString::from("--json"),
        ];
        if let Some(upload_relay) = &self.config.upload_relay {
            args.push(OsString::from("--upload-relay"));
            args.push(OsString::from(upload_relay));
        }
        args.push(temp_file.path().as_os_str().to_owned());
        let output = self.run_walrus(args, SourceArchiveError::StoreFailed)?;
        parse_store_blob_id(&output.stdout)
    }

    fn run_walrus(
        &self,
        command_args: Vec<OsString>,
        map_error: impl FnOnce(String) -> SourceArchiveError,
    ) -> Result<CommandOutput, SourceArchiveError> {
        let mut args = Vec::new();
        if let Some(config_path) = &self.config.config_path {
            args.push(OsString::from("--config"));
            args.push(config_path.as_os_str().to_owned());
        }
        if let Some(context) = &self.config.context {
            args.push(OsString::from("--context"));
            args.push(OsString::from(context));
        }
        if let Some(wallet) = &self.config.wallet {
            args.push(OsString::from("--wallet"));
            args.push(OsString::from(wallet));
        }
        args.extend(command_args);
        self.command_runner
            .run(&self.config.cli_path, &args, self.config.command_timeout_ms)
            .map_err(map_error)
    }
}

impl<R, F> SourceArchive for WalrusCliSourceArchive<R, F>
where
    R: WalrusCommandRunner,
    F: BlobFetcher,
{
    fn store_and_verify(
        &self,
        source_uri: &str,
        source_hash: &str,
        bytes: &[u8],
    ) -> Result<StoredSourceRef, SourceArchiveError> {
        validate_walrus_config(&self.config)?;
        let computed_source_hash = to_hex(&sha256_bytes(bytes));
        if computed_source_hash != source_hash {
            return Err(SourceArchiveError::BlobMismatch {
                source_uri: source_uri.to_owned(),
                expected_hash: source_hash.to_owned(),
                actual_hash: computed_source_hash,
            });
        }

        let expected_blob_id = self.blob_id_for_bytes(bytes)?;
        let stored_blob_id = self.run_store(bytes)?;
        if stored_blob_id != expected_blob_id {
            return Err(SourceArchiveError::BlobMismatch {
                source_uri: source_uri.to_owned(),
                expected_hash: expected_blob_id,
                actual_hash: stored_blob_id,
            });
        }

        let blob_url = format!(
            "{}/v1/blobs/{}",
            self.config.aggregator_url.trim_end_matches('/'),
            stored_blob_id
        );
        let fetched_bytes = self
            .blob_fetcher
            .fetch(
                &blob_url,
                bytes.len() as u64,
                self.config.command_timeout_ms,
            )
            .map_err(SourceArchiveError::FetchFailed)?;
        let fetched_hash = to_hex(&sha256_bytes(&fetched_bytes));
        if fetched_hash != source_hash {
            return Err(SourceArchiveError::BlobMismatch {
                source_uri: source_uri.to_owned(),
                expected_hash: source_hash.to_owned(),
                actual_hash: fetched_hash,
            });
        }
        let fetched_blob_id = self.blob_id_for_bytes(&fetched_bytes)?;
        if fetched_blob_id != stored_blob_id {
            return Err(SourceArchiveError::BlobMismatch {
                source_uri: source_uri.to_owned(),
                expected_hash: stored_blob_id,
                actual_hash: fetched_blob_id,
            });
        }

        Ok(StoredSourceRef {
            uri: format!("walrus://blob/{stored_blob_id}"),
            walrus_blob_id: stored_blob_id,
            source_hash: source_hash.to_owned(),
            size_bytes: bytes.len() as u64,
        })
    }
}

pub trait WalrusCommandRunner {
    fn run(
        &self,
        program: &Path,
        args: &[OsString],
        timeout_ms: u64,
    ) -> Result<CommandOutput, String>;
}

impl<T: WalrusCommandRunner + ?Sized> WalrusCommandRunner for &T {
    fn run(
        &self,
        program: &Path,
        args: &[OsString],
        timeout_ms: u64,
    ) -> Result<CommandOutput, String> {
        (*self).run(program, args, timeout_ms)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Debug, Clone, Copy)]
pub struct SystemWalrusCommandRunner;

impl WalrusCommandRunner for SystemWalrusCommandRunner {
    fn run(
        &self,
        program: &Path,
        args: &[OsString],
        timeout_ms: u64,
    ) -> Result<CommandOutput, String> {
        if timeout_ms == 0 {
            return Err("Walrus CLI timeout must be greater than zero".to_owned());
        }

        let mut child = Command::new(program)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("failed to run {}: {error}", program.display()))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("failed to capture {} stdout", program.display()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| format!("failed to capture {} stderr", program.display()))?;
        let stdout_reader = thread::spawn(move || read_pipe(stdout));
        let stderr_reader = thread::spawn(move || read_pipe(stderr));
        let timeout = Duration::from_millis(timeout_ms);
        let started_at = Instant::now();

        let status = loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|error| format!("failed to poll {}: {error}", program.display()))?
            {
                break status;
            }
            if started_at.elapsed() >= timeout {
                let _ = child.kill();
                let _ = child.wait();
                let stdout = join_reader(stdout_reader, "stdout")?;
                let stderr = join_reader(stderr_reader, "stderr")?;
                let stderr_summary = String::from_utf8_lossy(&stderr).trim().to_owned();
                let stdout_summary = String::from_utf8_lossy(&stdout).trim().to_owned();
                return Err(format!(
                    "{} {} timed out after {}ms{}{}",
                    program.display(),
                    command_args_summary(args),
                    timeout_ms,
                    output_summary("stdout", &stdout_summary),
                    output_summary("stderr", &stderr_summary)
                ));
            }
            thread::sleep(Duration::from_millis(10));
        };

        let stdout = join_reader(stdout_reader, "stdout")?;
        let stderr = join_reader(stderr_reader, "stderr")?;
        if !status.success() {
            return Err(format!(
                "{} {} exited with status {}: {}",
                program.display(),
                command_args_summary(args),
                status,
                String::from_utf8_lossy(&stderr).trim()
            ));
        }
        Ok(CommandOutput { stdout, stderr })
    }
}

pub trait BlobFetcher {
    fn fetch(
        &self,
        url: &str,
        expected_size_bytes: u64,
        timeout_ms: u64,
    ) -> Result<Vec<u8>, String>;
}

impl<T: BlobFetcher + ?Sized> BlobFetcher for &T {
    fn fetch(
        &self,
        url: &str,
        expected_size_bytes: u64,
        timeout_ms: u64,
    ) -> Result<Vec<u8>, String> {
        (*self).fetch(url, expected_size_bytes, timeout_ms)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ReqwestBlobFetcher;

impl BlobFetcher for ReqwestBlobFetcher {
    fn fetch(
        &self,
        url: &str,
        expected_size_bytes: u64,
        timeout_ms: u64,
    ) -> Result<Vec<u8>, String> {
        if timeout_ms == 0 {
            return Err("aggregator fetch timeout must be greater than zero".to_owned());
        }
        let max_read_bytes = expected_size_bytes
            .checked_add(1)
            .ok_or_else(|| "expected source size is too large".to_owned())?;
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .build()
            .map_err(|error| format!("GET {url} client build failed: {error}"))?;
        let response = client
            .get(url)
            .send()
            .map_err(|error| format!("GET {url} failed: {error}"))?
            .error_for_status()
            .map_err(|error| format!("GET {url} returned error status: {error}"))?;
        let mut body = response.take(max_read_bytes);
        let mut bytes = Vec::new();
        body.read_to_end(&mut bytes)
            .map_err(|error| format!("GET {url} body read failed: {error}"))?;
        if bytes.len() as u64 > expected_size_bytes {
            return Err(format!(
                "GET {url} body exceeds expected size {expected_size_bytes} bytes"
            ));
        }
        Ok(bytes)
    }
}

fn validate_walrus_config(config: &WalrusCliSourceArchiveConfig) -> Result<(), SourceArchiveError> {
    if config.aggregator_url.trim().is_empty() {
        return Err(SourceArchiveError::StoreFailed(
            "Walrus aggregator URL is required for live archive".to_owned(),
        ));
    }
    if config.epochs == 0 {
        return Err(SourceArchiveError::StoreFailed(
            "Walrus epochs must be greater than zero".to_owned(),
        ));
    }
    if config.command_timeout_ms == 0 {
        return Err(SourceArchiveError::StoreFailed(
            "Walrus CLI timeout must be greater than zero".to_owned(),
        ));
    }
    Ok(())
}

fn parse_blob_id_output(stdout: &[u8]) -> Result<String, SourceArchiveError> {
    let output = std::str::from_utf8(stdout).map_err(|error| {
        SourceArchiveError::StoreFailed(format!("walrus blob-id output is not UTF-8: {error}"))
    })?;
    if let Some(blob_id) = output
        .lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("Blob ID:").map(str::trim))
        .filter(|blob_id| !blob_id.is_empty())
    {
        return Ok(blob_id.to_owned());
    }
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| !line.starts_with("Success:"))
        .next_back()
        .map(str::to_owned)
        .ok_or_else(|| SourceArchiveError::StoreFailed("walrus blob-id output is empty".to_owned()))
}

fn parse_store_blob_id(stdout: &[u8]) -> Result<String, SourceArchiveError> {
    let value = serde_json::from_slice::<Value>(stdout).map_err(|error| {
        SourceArchiveError::StoreFailed(format!("walrus store JSON output is invalid: {error}"))
    })?;
    let blob_ids = store_success_blob_ids(&value);
    let Some(blob_id) = single_unique_blob_id(&blob_ids)? else {
        return Err(SourceArchiveError::StoreFailed(
            "walrus store JSON missing blobId".to_owned(),
        ));
    };
    if blob_id.is_empty() {
        return Err(SourceArchiveError::StoreFailed(
            "walrus store JSON blobId is empty".to_owned(),
        ));
    }
    Ok(blob_id)
}

fn store_success_blob_ids(value: &Value) -> Vec<String> {
    const SUCCESS_BLOB_ID_PATHS: &[&[&str]] = &[
        &["newlyCreated", "blobObject", "blobId"],
        &["alreadyCertified", "blobId"],
        &["blobStoreResult", "newlyCreated", "blobObject", "blobId"],
        &["blobStoreResult", "alreadyCertified", "blobId"],
    ];

    SUCCESS_BLOB_ID_PATHS
        .iter()
        .filter_map(|path| string_at_path(value, path))
        .map(str::to_owned)
        .collect()
}

fn string_at_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for segment in path {
        current = current.as_object()?.get(*segment)?;
    }
    current.as_str()
}

fn single_unique_blob_id(blob_ids: &[String]) -> Result<Option<String>, SourceArchiveError> {
    let mut unique: Vec<&str> = Vec::new();
    for blob_id in blob_ids {
        if !unique.iter().any(|existing| *existing == blob_id) {
            unique.push(blob_id);
        }
    }
    match unique.as_slice() {
        [] => Ok(None),
        [blob_id] => Ok(Some((*blob_id).to_owned())),
        _ => Err(SourceArchiveError::StoreFailed(
            "walrus store JSON contains multiple blobId values".to_owned(),
        )),
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub fn parse_epochs(value: &str) -> Result<u32, SourceArchiveError> {
    let epochs = value.parse::<u32>().map_err(|error| {
        SourceArchiveError::StoreFailed(format!("invalid Walrus epochs `{value}`: {error}"))
    })?;
    if epochs == 0 {
        return Err(SourceArchiveError::StoreFailed(
            "Walrus epochs must be greater than zero".to_owned(),
        ));
    }
    Ok(epochs)
}

pub fn parse_command_timeout_ms(value: &str) -> Result<u64, SourceArchiveError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(SourceArchiveError::StoreFailed(
            "Walrus CLI timeout must be greater than zero".to_owned(),
        ));
    }
    let timeout_ms = trimmed.parse::<u64>().map_err(|error| {
        SourceArchiveError::StoreFailed(format!("invalid Walrus CLI timeout `{value}`: {error}"))
    })?;
    if timeout_ms == 0 {
        return Err(SourceArchiveError::StoreFailed(
            "Walrus CLI timeout must be greater than zero".to_owned(),
        ));
    }
    Ok(timeout_ms)
}

fn read_pipe(mut pipe: impl Read) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    pipe.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn join_reader(
    reader: thread::JoinHandle<std::io::Result<Vec<u8>>>,
    stream_name: &str,
) -> Result<Vec<u8>, String> {
    reader
        .join()
        .map_err(|_| format!("Walrus CLI {stream_name} reader panicked"))?
        .map_err(|error| format!("Walrus CLI {stream_name} read failed: {error}"))
}

fn command_args_summary(args: &[OsString]) -> String {
    let args = args
        .iter()
        .map(|arg| arg.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ");
    if args.is_empty() {
        "[]".to_owned()
    } else {
        format!("[{args}]")
    }
}

fn output_summary(name: &str, value: &str) -> String {
    if value.is_empty() {
        String::new()
    } else {
        format!("; {name}: {value}")
    }
}

struct TempSourceFile {
    path: PathBuf,
}

impl TempSourceFile {
    fn write(bytes: &[u8]) -> std::io::Result<Self> {
        let mut last_error = None;
        for _ in 0..16 {
            let path = temp_source_path();
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    file.write_all(bytes)?;
                    return Ok(Self { path });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    last_error = Some(error);
                }
                Err(error) => return Err(error),
            }
        }
        Err(last_error.unwrap_or_else(|| std::io::Error::other("cannot allocate temp file")))
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempSourceFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn temp_source_path() -> PathBuf {
    let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "sonari-walrus-source-{}-{counter}-{nanos}.bin",
        std::process::id()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::{sha256_bytes, to_hex};
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::ffi::OsString;
    use std::fs;
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    fn source_hash(bytes: &[u8]) -> String {
        to_hex(&sha256_bytes(bytes))
    }

    fn archive<'a>(
        walrus: &'a FakeWalrusCommandRunner,
        fetcher: &'a FakeBlobFetcher,
    ) -> WalrusCliSourceArchive<&'a FakeWalrusCommandRunner, &'a FakeBlobFetcher> {
        WalrusCliSourceArchive::with_clients(
            WalrusCliSourceArchiveConfig {
                cli_path: PathBuf::from("fake-walrus"),
                aggregator_url: "https://aggregator.test".to_owned(),
                epochs: 2,
                ..WalrusCliSourceArchiveConfig::default()
            },
            walrus,
            fetcher,
        )
    }

    #[test]
    fn walrus_cli_archive_stores_fetches_and_verifies_new_blob() {
        let bytes = b"{\"id\":\"source\"}".to_vec();
        let hash = source_hash(&bytes);
        let walrus = FakeWalrusCommandRunner::new([
            Ok("blob-123\n"),
            Ok(r#"{"newlyCreated":{"blobObject":{"blobId":"blob-123"}}}"#),
            Ok("blob-123\n"),
        ]);
        let fetcher = FakeBlobFetcher::ok(bytes.clone());

        let stored = archive(&walrus, &fetcher)
            .store_and_verify("https://source.test/detail.geojson", &hash, &bytes)
            .expect("Walrus archive should verify");

        assert_eq!(stored.uri, "walrus://blob/blob-123");
        assert_eq!(stored.walrus_blob_id, "blob-123");
        assert_eq!(stored.source_hash, hash);
        assert_eq!(stored.size_bytes, bytes.len() as u64);
        assert_eq!(
            fetcher.urls.borrow().as_slice(),
            ["https://aggregator.test/v1/blobs/blob-123"]
        );
        assert_eq!(
            fetcher.requests.borrow().as_slice(),
            [FetchRequest {
                url: "https://aggregator.test/v1/blobs/blob-123".to_owned(),
                expected_size_bytes: bytes.len() as u64,
                timeout_ms: 120_000,
            }]
        );
        assert_eq!(
            walrus
                .args
                .borrow()
                .iter()
                .map(|args| stringify_args(args))
                .collect::<Vec<_>>(),
            vec![
                vec!["blob-id", "<temp>"],
                vec!["store", "--epochs", "2", "--json", "<temp>"],
                vec!["blob-id", "<temp>"],
            ]
        );
        assert_eq!(
            walrus.temp_file_bytes.borrow().as_slice(),
            [bytes.clone(), bytes.clone(), bytes]
        );
    }

    #[test]
    fn walrus_cli_archive_accepts_blob_id_success_prefix() {
        let bytes = b"source".to_vec();
        let hash = source_hash(&bytes);
        let walrus = FakeWalrusCommandRunner::new([
            Ok("Success: Blob from file '/tmp/source.bin' encoded successfully.\nblob-prefixed\n"),
            Ok(r#"{"blobStoreResult":{"newlyCreated":{"blobObject":{"blobId":"blob-prefixed"}}}}"#),
            Ok("blob-prefixed\n"),
        ]);
        let fetcher = FakeBlobFetcher::ok(bytes.clone());

        let stored = archive(&walrus, &fetcher)
            .store_and_verify("https://source.test/grid.xml", &hash, &bytes)
            .expect("blob-id output with success prefix should verify");

        assert_eq!(stored.walrus_blob_id, "blob-prefixed");
    }

    #[test]
    fn walrus_cli_archive_accepts_labeled_blob_id_output() {
        let bytes = b"source".to_vec();
        let hash = source_hash(&bytes);
        let walrus = FakeWalrusCommandRunner::new([
            Ok(
                "Success: Blob from file '/tmp/source.bin' encoded successfully.\nBlob ID: blob-labeled\nEncoding type: RedStuff/Reed-Solomon\n",
            ),
            Ok(r#"{"alreadyCertified":{"blobId":"blob-labeled"}}"#),
            Ok("blob-labeled\n"),
        ]);
        let fetcher = FakeBlobFetcher::ok(bytes.clone());

        let stored = archive(&walrus, &fetcher)
            .store_and_verify("https://source.test/grid.xml", &hash, &bytes)
            .expect("labeled blob-id output should verify");

        assert_eq!(stored.walrus_blob_id, "blob-labeled");
    }

    #[test]
    fn walrus_cli_default_timeout_is_bounded() {
        assert_eq!(
            WalrusCliSourceArchiveConfig::default().command_timeout_ms,
            120_000
        );
    }

    #[test]
    fn parses_walrus_cli_timeout_ms_strictly() {
        assert_eq!(parse_command_timeout_ms("120000").unwrap(), 120_000);
        assert!(parse_command_timeout_ms("0").is_err());
        assert!(parse_command_timeout_ms("").is_err());
        assert!(parse_command_timeout_ms("not-a-number").is_err());
    }

    #[test]
    fn walrus_config_from_env_rejects_invalid_timeout() {
        static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = ENV_LOCK.lock().unwrap();
        let previous_aggregator = std::env::var_os("SONARI_WALRUS_AGGREGATOR_URL");
        let previous_timeout = std::env::var_os("SONARI_WALRUS_CLI_TIMEOUT_MS");
        unsafe {
            std::env::set_var("SONARI_WALRUS_AGGREGATOR_URL", "https://aggregator.test");
            std::env::set_var("SONARI_WALRUS_CLI_TIMEOUT_MS", "0");
        }

        let error =
            WalrusCliSourceArchiveConfig::from_env().expect_err("zero timeout must be rejected");

        unsafe {
            match previous_aggregator {
                Some(value) => std::env::set_var("SONARI_WALRUS_AGGREGATOR_URL", value),
                None => std::env::remove_var("SONARI_WALRUS_AGGREGATOR_URL"),
            }
            match previous_timeout {
                Some(value) => std::env::set_var("SONARI_WALRUS_CLI_TIMEOUT_MS", value),
                None => std::env::remove_var("SONARI_WALRUS_CLI_TIMEOUT_MS"),
            }
        }
        assert!(format!("{error}").contains("Walrus CLI timeout"));
    }

    #[test]
    fn system_walrus_command_runner_kills_process_after_timeout() {
        let runner = SystemWalrusCommandRunner;
        let started_at = Instant::now();

        let error = runner
            .run(Path::new("sleep"), &[OsString::from("5")], 50)
            .expect_err("long-running command must time out");

        assert!(
            started_at.elapsed() < Duration::from_secs(2),
            "timeout should kill the child promptly"
        );
        assert!(error.contains("timed out"));
        assert!(error.contains("50ms"));
        assert!(error.contains("sleep"));
        assert!(error.contains("[5]"));
    }

    #[test]
    fn walrus_cli_archive_accepts_already_certified_store_response() {
        let bytes = b"source".to_vec();
        let hash = source_hash(&bytes);
        let walrus = FakeWalrusCommandRunner::new([
            Ok("blob-certified\n"),
            Ok(r#"{"alreadyCertified":{"blobId":"blob-certified"}}"#),
            Ok("blob-certified\n"),
        ]);
        let fetcher = FakeBlobFetcher::ok(bytes.clone());

        let stored = archive(&walrus, &fetcher)
            .store_and_verify("https://source.test/grid.xml", &hash, &bytes)
            .expect("already certified blob should verify");

        assert_eq!(stored.uri, "walrus://blob/blob-certified");
        assert_eq!(stored.walrus_blob_id, "blob-certified");
    }

    #[test]
    fn walrus_cli_archive_accepts_nested_store_result_response() {
        let bytes = b"source".to_vec();
        let hash = source_hash(&bytes);
        let walrus = FakeWalrusCommandRunner::new([
            Ok("blob-nested\n"),
            Ok(r#"{"blobStoreResult":{"newlyCreated":{"blobObject":{"blobId":"blob-nested"}}}}"#),
            Ok("blob-nested\n"),
        ]);
        let fetcher = FakeBlobFetcher::ok(bytes.clone());

        let stored = archive(&walrus, &fetcher)
            .store_and_verify("https://source.test/grid.xml", &hash, &bytes)
            .expect("nested store result should verify");

        assert_eq!(stored.uri, "walrus://blob/blob-nested");
        assert_eq!(stored.walrus_blob_id, "blob-nested");
    }

    #[test]
    fn walrus_cli_archive_accepts_nested_already_certified_store_response() {
        let blob_id = parse_store_blob_id(
            br#"{"blobStoreResult":{"alreadyCertified":{"blobId":"blob-nested-certified"}}}"#,
        )
        .expect("nested alreadyCertified store result should be accepted");

        assert_eq!(blob_id, "blob-nested-certified");
    }

    #[test]
    fn walrus_cli_archive_rejects_error_store_blob_id() {
        let error =
            parse_store_blob_id(br#"{"blobStoreResult":{"error":{"blobId":"blob-error"}}}"#)
                .expect_err("error variant blobId must not be accepted");

        assert!(matches!(error, SourceArchiveError::StoreFailed(_)));
    }

    #[test]
    fn walrus_cli_archive_rejects_marked_invalid_store_blob_id() {
        let error = parse_store_blob_id(br#"{"markedInvalid":{"blobId":"blob-invalid"}}"#)
            .expect_err("markedInvalid variant blobId must not be accepted");

        assert!(matches!(error, SourceArchiveError::StoreFailed(_)));
    }

    #[test]
    fn walrus_cli_archive_rejects_nested_marked_invalid_store_blob_id() {
        let error = parse_store_blob_id(
            br#"{"blobStoreResult":{"markedInvalid":{"blobId":"blob-invalid"}}}"#,
        )
        .expect_err("nested markedInvalid variant blobId must not be accepted");

        assert!(matches!(error, SourceArchiveError::StoreFailed(_)));
    }

    #[test]
    fn walrus_cli_archive_rejects_multiple_success_store_blob_ids() {
        let error = parse_store_blob_id(
            br#"{"newlyCreated":{"blobObject":{"blobId":"blob-new"}},"alreadyCertified":{"blobId":"blob-certified"}}"#,
        )
        .expect_err("multiple different success blobIds must fail closed");

        assert!(matches!(error, SourceArchiveError::StoreFailed(_)));
    }

    #[test]
    fn walrus_cli_archive_rejects_store_blob_id_mismatch() {
        let bytes = b"source".to_vec();
        let hash = source_hash(&bytes);
        let walrus = FakeWalrusCommandRunner::new([
            Ok("blob-expected\n"),
            Ok(r#"{"newlyCreated":{"blobObject":{"blobId":"blob-actual"}}}"#),
        ]);
        let fetcher = FakeBlobFetcher::ok(bytes.clone());

        let error = archive(&walrus, &fetcher)
            .store_and_verify("https://source.test/grid.xml", &hash, &bytes)
            .expect_err("store blob id mismatch must fail closed");

        assert!(matches!(
            error,
            SourceArchiveError::BlobMismatch {
                expected_hash,
                actual_hash,
                ..
            } if expected_hash == "blob-expected" && actual_hash == "blob-actual"
        ));
        assert!(fetcher.urls.borrow().is_empty());
    }

    #[test]
    fn walrus_cli_archive_rejects_aggregator_source_hash_mismatch() {
        let bytes = b"source".to_vec();
        let wrong_bytes = b"tampered".to_vec();
        let hash = source_hash(&bytes);
        let walrus = FakeWalrusCommandRunner::new([
            Ok("blob-123\n"),
            Ok(r#"{"alreadyCertified":{"blobId":"blob-123"}}"#),
        ]);
        let fetcher = FakeBlobFetcher::ok(wrong_bytes.clone());

        let error = archive(&walrus, &fetcher)
            .store_and_verify("https://source.test/grid.xml", &hash, &bytes)
            .expect_err("tampered aggregator bytes must fail closed");

        assert!(matches!(
            error,
            SourceArchiveError::BlobMismatch {
                expected_hash,
                actual_hash,
                ..
            } if expected_hash == hash && actual_hash == source_hash(&wrong_bytes)
        ));
    }

    #[test]
    fn walrus_cli_archive_returns_fetch_error_when_aggregator_fetch_fails() {
        let bytes = b"source".to_vec();
        let hash = source_hash(&bytes);
        let walrus = FakeWalrusCommandRunner::new([
            Ok("blob-123\n"),
            Ok(r#"{"alreadyCertified":{"blobId":"blob-123"}}"#),
        ]);
        let fetcher = FakeBlobFetcher::err("aggregator unavailable");

        let error = archive(&walrus, &fetcher)
            .store_and_verify("https://source.test/grid.xml", &hash, &bytes)
            .expect_err("aggregator fetch failure must fail closed");

        assert!(
            matches!(error, SourceArchiveError::FetchFailed(message) if message.contains("aggregator unavailable"))
        );
    }

    #[test]
    fn reqwest_blob_fetcher_rejects_body_larger_than_expected_size() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test server should bind");
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("test request should connect");
            let mut buffer = [0_u8; 1024];
            let _ = stream.read(&mut buffer);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nabcd")
                .unwrap();
        });

        let error = ReqwestBlobFetcher
            .fetch(&format!("http://{address}/v1/blobs/blob-123"), 3, 1_000)
            .expect_err("oversized aggregator response must fail closed");

        server.join().unwrap();
        assert!(error.contains("exceeds expected size"));
    }

    #[test]
    fn walrus_cli_archive_rejects_aggregator_blob_id_mismatch() {
        let bytes = b"source".to_vec();
        let hash = source_hash(&bytes);
        let walrus = FakeWalrusCommandRunner::new([
            Ok("blob-expected\n"),
            Ok(r#"{"alreadyCertified":{"blobId":"blob-expected"}}"#),
            Ok("blob-other\n"),
        ]);
        let fetcher = FakeBlobFetcher::ok(bytes.clone());

        let error = archive(&walrus, &fetcher)
            .store_and_verify("https://source.test/grid.xml", &hash, &bytes)
            .expect_err("blob-id mismatch after aggregator fetch must fail closed");

        assert!(matches!(
            error,
            SourceArchiveError::BlobMismatch {
                expected_hash,
                actual_hash,
                ..
            } if expected_hash == "blob-expected" && actual_hash == "blob-other"
        ));
    }

    #[test]
    fn walrus_cli_archive_returns_store_error_when_store_command_fails() {
        let bytes = b"source".to_vec();
        let hash = source_hash(&bytes);
        let walrus =
            FakeWalrusCommandRunner::new([Ok("blob-123\n"), Err("walrus store failed".to_owned())]);
        let fetcher = FakeBlobFetcher::ok(bytes.clone());

        let error = archive(&walrus, &fetcher)
            .store_and_verify("https://source.test/grid.xml", &hash, &bytes)
            .expect_err("store failure must fail closed");

        assert!(
            matches!(error, SourceArchiveError::StoreFailed(message) if message.contains("walrus store failed"))
        );
        assert!(fetcher.urls.borrow().is_empty());
    }

    #[test]
    #[ignore = "requires SONARI_WALRUS_LIVE=1, Walrus CLI config/wallet, and network funds"]
    fn live_walrus_cli_archive_stores_fetches_and_verifies_fixture_source() {
        if std::env::var("SONARI_WALRUS_LIVE").ok().as_deref() != Some("1") {
            return;
        }
        let archive = WalrusCliSourceArchive::new(
            WalrusCliSourceArchiveConfig::from_env().expect("Walrus env should be valid"),
        )
        .expect("Walrus archive config should be valid");
        let bytes = b"sonari walrus archive live fixture\n";
        let hash = source_hash(bytes);

        let stored = archive
            .store_and_verify("sonari://fixtures/walrus-live.txt", &hash, bytes)
            .expect("live Walrus archive should verify");

        assert!(stored.uri.starts_with("walrus://blob/"));
        assert_eq!(stored.source_hash, hash);
        assert_eq!(stored.size_bytes, bytes.len() as u64);
    }

    struct FakeWalrusCommandRunner {
        outputs: RefCell<VecDeque<Result<String, String>>>,
        args: RefCell<Vec<Vec<OsString>>>,
        temp_file_bytes: RefCell<Vec<Vec<u8>>>,
    }

    impl<const N: usize> From<[Result<&'static str, String>; N]> for FakeWalrusCommandRunner {
        fn from(outputs: [Result<&'static str, String>; N]) -> Self {
            Self::new(outputs)
        }
    }

    impl FakeWalrusCommandRunner {
        fn new<const N: usize>(outputs: [Result<&'static str, String>; N]) -> Self {
            Self {
                outputs: RefCell::new(
                    outputs
                        .into_iter()
                        .map(|output| output.map(str::to_owned))
                        .collect(),
                ),
                args: RefCell::new(Vec::new()),
                temp_file_bytes: RefCell::new(Vec::new()),
            }
        }
    }

    impl WalrusCommandRunner for FakeWalrusCommandRunner {
        fn run(
            &self,
            _program: &Path,
            args: &[OsString],
            _timeout_ms: u64,
        ) -> Result<CommandOutput, String> {
            self.args.borrow_mut().push(args.to_vec());
            if let Some(path) = args.last().map(PathBuf::from).filter(|path| path.exists()) {
                self.temp_file_bytes
                    .borrow_mut()
                    .push(fs::read(path).expect("temp source file should be readable"));
            }
            let output = self
                .outputs
                .borrow_mut()
                .pop_front()
                .expect("unexpected walrus command");
            output.map(|stdout| CommandOutput {
                stdout: stdout.into_bytes(),
                stderr: Vec::new(),
            })
        }
    }

    struct FakeBlobFetcher {
        bytes: Vec<u8>,
        error: Option<String>,
        urls: RefCell<Vec<String>>,
        requests: RefCell<Vec<FetchRequest>>,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct FetchRequest {
        url: String,
        expected_size_bytes: u64,
        timeout_ms: u64,
    }

    impl FakeBlobFetcher {
        fn ok(bytes: Vec<u8>) -> Self {
            Self {
                bytes,
                error: None,
                urls: RefCell::new(Vec::new()),
                requests: RefCell::new(Vec::new()),
            }
        }

        fn err(error: &str) -> Self {
            Self {
                bytes: Vec::new(),
                error: Some(error.to_owned()),
                urls: RefCell::new(Vec::new()),
                requests: RefCell::new(Vec::new()),
            }
        }
    }

    impl BlobFetcher for FakeBlobFetcher {
        fn fetch(
            &self,
            url: &str,
            expected_size_bytes: u64,
            timeout_ms: u64,
        ) -> Result<Vec<u8>, String> {
            self.urls.borrow_mut().push(url.to_owned());
            self.requests.borrow_mut().push(FetchRequest {
                url: url.to_owned(),
                expected_size_bytes,
                timeout_ms,
            });
            if let Some(error) = &self.error {
                return Err(error.clone());
            }
            Ok(self.bytes.clone())
        }
    }

    fn stringify_args(args: &[OsString]) -> Vec<&'static str> {
        args.iter()
            .map(|arg| {
                let value = arg.to_string_lossy();
                if value.starts_with(std::env::temp_dir().to_string_lossy().as_ref()) {
                    "<temp>"
                } else {
                    Box::leak(value.into_owned().into_boxed_str())
                }
            })
            .collect()
    }
}
