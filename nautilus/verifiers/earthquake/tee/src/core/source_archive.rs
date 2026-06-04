use crate::core::artifacts::StoredSourceRef;
use crate::core::types::OracleError;
use crate::crypto::{sha256_bytes, to_hex};
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
    pub n_shards: u32,
    pub command_timeout_ms: u64,
    pub egress_proxy_url: Option<String>,
}

impl Default for WalrusCliSourceArchiveConfig {
    fn default() -> Self {
        Self {
            cli_path: PathBuf::from("walrus"),
            n_shards: 1000,
            command_timeout_ms: DEFAULT_WALRUS_CLI_TIMEOUT_MS,
            egress_proxy_url: None,
        }
    }
}

impl WalrusCliSourceArchiveConfig {
    pub fn from_env() -> Result<Self, SourceArchiveError> {
        let cli_path = std::env::var_os("SONARI_WALRUS_CLI")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("walrus"));
        let egress_proxy_url = non_empty_env("SONARI_EARTHQUAKE_EGRESS_PROXY_URL");
        let n_shards = required_n_shards_from_env()?;
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
            n_shards,
            command_timeout_ms,
            egress_proxy_url,
        })
    }
}

#[derive(Debug)]
pub struct WalrusCliSourceArchive<R = SystemWalrusCommandRunner> {
    config: WalrusCliSourceArchiveConfig,
    command_runner: R,
}

impl WalrusCliSourceArchive<SystemWalrusCommandRunner> {
    pub fn new(config: WalrusCliSourceArchiveConfig) -> Result<Self, SourceArchiveError> {
        validate_walrus_config(&config)?;
        Ok(Self {
            config,
            command_runner: SystemWalrusCommandRunner,
        })
    }
}

impl<R> WalrusCliSourceArchive<R>
where
    R: WalrusCommandRunner,
{
    #[cfg(test)]
    fn with_clients(config: WalrusCliSourceArchiveConfig, command_runner: R) -> Self {
        Self {
            config,
            command_runner,
        }
    }

    fn blob_id_for_bytes(&self, bytes: &[u8]) -> Result<String, SourceArchiveError> {
        let temp_file = TempSourceFile::write(bytes)
            .map_err(|error| SourceArchiveError::StoreFailed(error.to_string()))?;
        let output = self.run_walrus(
            vec![
                OsString::from("blob-id"),
                OsString::from("--n-shards"),
                OsString::from(self.config.n_shards.to_string()),
                temp_file.path().as_os_str().to_owned(),
            ],
            SourceArchiveError::StoreFailed,
        )?;
        parse_blob_id_output(&output.stdout)
    }

    fn run_walrus(
        &self,
        command_args: Vec<OsString>,
        map_error: impl FnOnce(String) -> SourceArchiveError,
    ) -> Result<CommandOutput, SourceArchiveError> {
        let mut args = Vec::new();
        args.extend(command_args);
        let env_overrides = proxy_env_overrides(self.config.egress_proxy_url.as_deref());
        self.command_runner
            .run(
                &self.config.cli_path,
                &args,
                self.config.command_timeout_ms,
                &env_overrides,
            )
            .map_err(map_error)
    }
}

impl<R> SourceArchive for WalrusCliSourceArchive<R>
where
    R: WalrusCommandRunner,
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

        let blob_id = self.blob_id_for_bytes(bytes)?;

        Ok(StoredSourceRef {
            uri: format!("walrus://blob/{blob_id}"),
            walrus_blob_id: blob_id,
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
        env_overrides: &[(OsString, OsString)],
    ) -> Result<CommandOutput, String>;
}

impl<T: WalrusCommandRunner + ?Sized> WalrusCommandRunner for &T {
    fn run(
        &self,
        program: &Path,
        args: &[OsString],
        timeout_ms: u64,
        env_overrides: &[(OsString, OsString)],
    ) -> Result<CommandOutput, String> {
        (*self).run(program, args, timeout_ms, env_overrides)
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
        env_overrides: &[(OsString, OsString)],
    ) -> Result<CommandOutput, String> {
        if timeout_ms == 0 {
            return Err("Walrus CLI timeout must be greater than zero".to_owned());
        }

        let mut child = Command::new(program)
            .args(args)
            .envs(env_overrides.iter().map(|(key, value)| (key, value)))
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

fn proxy_env_overrides(proxy_url: Option<&str>) -> Vec<(OsString, OsString)> {
    let Some(proxy_url) = proxy_url.map(str::trim).filter(|value| !value.is_empty()) else {
        return Vec::new();
    };
    [
        ("ALL_PROXY", proxy_url),
        ("HTTPS_PROXY", proxy_url),
        ("HTTP_PROXY", proxy_url),
        ("NO_PROXY", "127.0.0.1,localhost"),
    ]
    .into_iter()
    .map(|(key, value)| (OsString::from(key), OsString::from(value)))
    .collect()
}

fn validate_walrus_config(config: &WalrusCliSourceArchiveConfig) -> Result<(), SourceArchiveError> {
    if config.command_timeout_ms == 0 {
        return Err(SourceArchiveError::StoreFailed(
            "Walrus CLI timeout must be greater than zero".to_owned(),
        ));
    }
    if config.n_shards < 2 {
        return Err(SourceArchiveError::StoreFailed(
            "SONARI_WALRUS_N_SHARDS must be an integer greater than or equal to 2".to_owned(),
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
        .rfind(|line| !line.starts_with("Success:"))
        .map(str::to_owned)
        .ok_or_else(|| SourceArchiveError::StoreFailed("walrus blob-id output is empty".to_owned()))
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

pub fn parse_n_shards(value: &str) -> Result<u32, SourceArchiveError> {
    let trimmed = value.trim();
    let n_shards = trimmed.parse::<u32>().map_err(|error| {
        SourceArchiveError::StoreFailed(format!(
            "invalid SONARI_WALRUS_N_SHARDS `{value}`: {error}"
        ))
    })?;
    if n_shards < 2 {
        return Err(SourceArchiveError::StoreFailed(
            "SONARI_WALRUS_N_SHARDS must be an integer greater than or equal to 2".to_owned(),
        ));
    }
    Ok(n_shards)
}

fn required_n_shards_from_env() -> Result<u32, SourceArchiveError> {
    match std::env::var("SONARI_WALRUS_N_SHARDS") {
        Ok(value) => parse_n_shards(&value),
        Err(std::env::VarError::NotPresent) => Err(SourceArchiveError::StoreFailed(
            "SONARI_WALRUS_N_SHARDS is required".to_owned(),
        )),
        Err(error) => Err(SourceArchiveError::StoreFailed(format!(
            "invalid SONARI_WALRUS_N_SHARDS: {error}"
        ))),
    }
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
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn source_hash(bytes: &[u8]) -> String {
        to_hex(&sha256_bytes(bytes))
    }

    fn archive(
        walrus: &FakeWalrusCommandRunner,
    ) -> WalrusCliSourceArchive<&FakeWalrusCommandRunner> {
        WalrusCliSourceArchive::with_clients(
            WalrusCliSourceArchiveConfig {
                cli_path: PathBuf::from("fake-walrus"),
                ..WalrusCliSourceArchiveConfig::default()
            },
            walrus,
        )
    }

    #[test]
    fn walrus_cli_archive_creates_content_addressed_reference_without_store_or_fetch() {
        let bytes = b"{\"id\":\"source\"}".to_vec();
        let hash = source_hash(&bytes);
        let walrus = FakeWalrusCommandRunner::new([Ok("blob-123\n")]);

        let stored = archive(&walrus)
            .store_and_verify("https://source.test/detail.geojson", &hash, &bytes)
            .expect("Walrus content-addressed reference should verify");

        assert_eq!(stored.uri, "walrus://blob/blob-123");
        assert_eq!(stored.walrus_blob_id, "blob-123");
        assert_eq!(stored.source_hash, hash);
        assert_eq!(stored.size_bytes, bytes.len() as u64);
        assert_eq!(
            walrus
                .args
                .borrow()
                .iter()
                .map(|args| stringify_args(args))
                .collect::<Vec<_>>(),
            vec![vec!["blob-id", "--n-shards", "1000", "<temp>"]]
        );
        assert_eq!(walrus.temp_file_bytes.borrow().as_slice(), [bytes]);
    }

    #[test]
    fn walrus_cli_archive_accepts_blob_id_success_prefix() {
        let bytes = b"source".to_vec();
        let hash = source_hash(&bytes);
        let walrus = FakeWalrusCommandRunner::new([Ok(
            "Success: Blob from file '/tmp/source.bin' encoded successfully.\nblob-prefixed\n",
        )]);

        let stored = archive(&walrus)
            .store_and_verify("https://source.test/grid.xml", &hash, &bytes)
            .expect("blob-id output with success prefix should verify");

        assert_eq!(stored.walrus_blob_id, "blob-prefixed");
    }

    #[test]
    fn walrus_cli_archive_accepts_labeled_blob_id_output() {
        let bytes = b"source".to_vec();
        let hash = source_hash(&bytes);
        let walrus = FakeWalrusCommandRunner::new([Ok(
            "Success: Blob from file '/tmp/source.bin' encoded successfully.\nBlob ID: blob-labeled\nEncoding type: RedStuff/Reed-Solomon\n",
        )]);

        let stored = archive(&walrus)
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
    fn parses_walrus_n_shards_strictly() {
        assert_eq!(parse_n_shards("1000").unwrap(), 1000);
        assert!(parse_n_shards("0").is_err());
        assert!(parse_n_shards("1").is_err());
        assert!(parse_n_shards("not-a-number").is_err());
    }

    #[test]
    fn walrus_config_from_env_rejects_missing_or_invalid_n_shards() {
        let _guard = ENV_LOCK.lock().unwrap();
        with_env_var("SONARI_WALRUS_N_SHARDS", None, || {
            let error = WalrusCliSourceArchiveConfig::from_env()
                .expect_err("missing n_shards must be rejected");
            assert!(format!("{error}").contains("SONARI_WALRUS_N_SHARDS"));
        });
        for value in ["0", "1", "not-a-number"] {
            with_env_var("SONARI_WALRUS_N_SHARDS", Some(value), || {
                let error = WalrusCliSourceArchiveConfig::from_env()
                    .expect_err("invalid n_shards must be rejected");
                assert!(format!("{error}").contains("SONARI_WALRUS_N_SHARDS"));
            });
        }
    }

    #[test]
    fn walrus_config_from_env_rejects_invalid_timeout() {
        let _guard = ENV_LOCK.lock().unwrap();
        with_env_var("SONARI_WALRUS_N_SHARDS", Some("1000"), || {
            with_env_var("SONARI_WALRUS_CLI_TIMEOUT_MS", Some("0"), || {
                let error = WalrusCliSourceArchiveConfig::from_env()
                    .expect_err("zero timeout must be rejected");
                assert!(format!("{error}").contains("Walrus CLI timeout"));
            });
        });
    }

    fn with_env_var(name: &str, value: Option<&str>, test: impl FnOnce()) {
        let previous = std::env::var_os(name);
        unsafe {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
        test();
        unsafe {
            match previous {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }

    #[test]
    fn walrus_config_from_env_reads_earthquake_egress_proxy_url() {
        let _guard = ENV_LOCK.lock().unwrap();
        with_env_var("SONARI_WALRUS_N_SHARDS", Some("1000"), || {
            with_env_var(
                "SONARI_EARTHQUAKE_EGRESS_PROXY_URL",
                Some("http://127.0.0.1:18080"),
                || {
                    let config = WalrusCliSourceArchiveConfig::from_env().unwrap();
                    assert_eq!(
                        config.egress_proxy_url.as_deref(),
                        Some("http://127.0.0.1:18080")
                    );
                    assert_eq!(config.n_shards, 1000);
                },
            );
        });
    }

    #[test]
    fn walrus_cli_commands_receive_proxy_environment_when_configured() {
        let bytes = b"source".to_vec();
        let hash = source_hash(&bytes);
        let walrus = FakeWalrusCommandRunner::new([Ok("blob-123\n")]);
        let archive = WalrusCliSourceArchive::with_clients(
            WalrusCliSourceArchiveConfig {
                cli_path: PathBuf::from("fake-walrus"),
                egress_proxy_url: Some("http://127.0.0.1:18080".to_owned()),
                ..WalrusCliSourceArchiveConfig::default()
            },
            &walrus,
        );

        archive
            .store_and_verify("https://source.test/grid.xml", &hash, &bytes)
            .expect("Walrus archive should verify");

        let envs = walrus.envs.borrow();
        assert_eq!(envs.len(), 1);
        for command_env in envs.iter() {
            assert_eq!(
                stringify_env(command_env),
                vec![
                    ("ALL_PROXY".to_owned(), "http://127.0.0.1:18080".to_owned()),
                    (
                        "HTTPS_PROXY".to_owned(),
                        "http://127.0.0.1:18080".to_owned(),
                    ),
                    ("HTTP_PROXY".to_owned(), "http://127.0.0.1:18080".to_owned(),),
                    ("NO_PROXY".to_owned(), "127.0.0.1,localhost".to_owned()),
                ]
            );
        }
    }

    #[test]
    fn system_walrus_command_runner_kills_process_after_timeout() {
        let runner = SystemWalrusCommandRunner;
        let started_at = Instant::now();

        let error = runner
            .run(Path::new("sleep"), &[OsString::from("5")], 50, &[])
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
    fn walrus_cli_archive_rejects_source_hash_mismatch_before_blob_id() {
        let bytes = b"source".to_vec();
        let wrong_bytes = b"tampered".to_vec();
        let wrong_hash = source_hash(&wrong_bytes);
        let walrus = FakeWalrusCommandRunner::new([]);

        let error = archive(&walrus)
            .store_and_verify("https://source.test/grid.xml", &wrong_hash, &bytes)
            .expect_err("source hash mismatch must fail closed");

        assert!(matches!(
            error,
            SourceArchiveError::BlobMismatch {
                expected_hash,
                actual_hash,
                ..
            } if expected_hash == wrong_hash && actual_hash == source_hash(&bytes)
        ));
        assert!(walrus.args.borrow().is_empty());
    }

    #[test]
    fn walrus_cli_archive_returns_blob_id_error_when_blob_id_command_fails() {
        let bytes = b"source".to_vec();
        let hash = source_hash(&bytes);
        let walrus = FakeWalrusCommandRunner::new([Err("walrus blob-id failed".to_owned())]);

        let error = archive(&walrus)
            .store_and_verify("https://source.test/grid.xml", &hash, &bytes)
            .expect_err("blob-id failure must fail closed");

        assert!(
            matches!(error, SourceArchiveError::StoreFailed(message) if message.contains("walrus blob-id failed"))
        );
    }

    #[test]
    #[ignore = "requires SONARI_WALRUS_LIVE=1 and Walrus CLI"]
    fn live_walrus_cli_archive_creates_fixture_source_reference() {
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
        envs: RefCell<Vec<Vec<(OsString, OsString)>>>,
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
                envs: RefCell::new(Vec::new()),
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
            env_overrides: &[(OsString, OsString)],
        ) -> Result<CommandOutput, String> {
            self.args.borrow_mut().push(args.to_vec());
            self.envs.borrow_mut().push(env_overrides.to_vec());
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

    fn stringify_env(envs: &[(OsString, OsString)]) -> Vec<(String, String)> {
        envs.iter()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.to_string_lossy().into_owned(),
                )
            })
            .collect()
    }
}
