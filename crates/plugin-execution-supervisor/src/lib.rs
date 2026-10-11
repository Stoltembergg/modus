//! Host-side execution dispatcher for process-isolated plugin workers.
//!
//! This crate consumes the shared protocol's one-use admission token and
//! `WorkerSession`. Its Linux bootstrap starts only the bundled inert worker
//! and applies a verified subset of delegated cgroup v2 controls. The full
//! required control set is not assessed, so plugin admission remains denied
//! before artifact transfer.

use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::time::Instant;

#[cfg(target_os = "linux")]
use linux_cgroup::{
    CgroupV2Error, LinuxCgroupV2, WorkerCgroupIdentity, WorkerCgroupLease,
    terminate_worker_and_cleanup,
};
#[cfg(target_os = "linux")]
use std::fs::{self, File};
#[cfg(target_os = "linux")]
use std::io::Read;
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::process::{Child, Command, Stdio};
#[cfg(target_os = "linux")]
use std::sync::mpsc;
#[cfg(target_os = "linux")]
use std::thread;
#[cfg(target_os = "linux")]
use std::time::Duration;

use modus_plugin_execution_protocol::resource_policy::APPROVED_RESOURCE_POLICY;
use modus_plugin_execution_protocol::worker_admission::{
    AdmissionAssessmentToken, AdmissionError, AssessedWorker, EnforcementControl,
    HostAuthorization, PluginHostcallRateLimiterRegistry, WorkerTransport,
};
use modus_plugin_execution_protocol::{
    HostProvenance, HostTrustLevel, InvocationOutcome, MAX_IPC_FRAME_BYTES, MAX_RESULT_BYTES,
    ProtocolError, WorkerSession, encode_worker_bootstrap_ready, validate_worker_bootstrap_hello,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(target_os = "linux")]
mod linux_cgroup;

pub const MAX_SUPERVISOR_REQUEST_BYTES: usize = MAX_IPC_FRAME_BYTES - 4;
pub const MAX_SUPERVISOR_RESPONSE_BYTES: usize = MAX_IPC_FRAME_BYTES - 4;
#[cfg(target_os = "linux")]
const TRUSTED_WORKER_EXECUTABLE: &str = "modus-plugin-worker";
#[cfg(target_os = "linux")]
const WORKER_BOOTSTRAP_CHALLENGE_ENV: &str = "MODUS_WORKER_BOOTSTRAP_CHALLENGE";
#[cfg(target_os = "linux")]
const WORKER_BOOTSTRAP_TIMEOUT: Duration =
    Duration::from_millis(APPROVED_RESOURCE_POLICY.handshake_timeout_ms);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WorkerBootstrapFailure {
    #[cfg(not(target_os = "linux"))]
    UnsupportedPlatform,
    BinaryUnavailable,
    BinaryIdentityInvalid,
    CgroupUnavailable,
    StartFailed,
    HandshakeFailed,
    TimedOut,
    CleanupFailed,
}

impl WorkerBootstrapFailure {
    fn description(self) -> &'static str {
        match self {
            #[cfg(not(target_os = "linux"))]
            Self::UnsupportedPlatform => "platform is not enabled",
            Self::BinaryUnavailable => "bundled worker binary is unavailable",
            Self::BinaryIdentityInvalid => "bundled worker identity is invalid",
            Self::CgroupUnavailable => "required delegated cgroup v2 controls are unavailable",
            Self::StartFailed => "bundled worker failed to start",
            Self::HandshakeFailed => "bundled worker handshake failed",
            Self::TimedOut => "bundled worker bootstrap timed out",
            Self::CleanupFailed => "bundled worker cleanup failed",
        }
    }
}

#[cfg(target_os = "linux")]
fn map_cgroup_failure(error: CgroupV2Error) -> WorkerBootstrapFailure {
    match error {
        CgroupV2Error::CleanupFailed => WorkerBootstrapFailure::CleanupFailed,
        _ => WorkerBootstrapFailure::CgroupUnavailable,
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum SupervisorCommand {
    Invoke { request: WorkerInvocationRequest },
    ReleaseSession { session_id: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerInvocationRequest {
    pub request_id: String,
    pub plugin_id: String,
    pub plugin_version: String,
    pub artifact_sha256: String,
    pub artifact_origin: String,
    pub trust_level: String,
    pub session_id: String,
    pub workspace_id: String,
    pub run_id: String,
    pub generation: u64,
    pub capability: String,
    pub payload: Value,
    pub host_granted_capabilities: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkerInvocationResponse {
    Completed { request_id: String, result: Value },
    Failed { request_id: String, error: String },
    Cancelled { request_id: String },
    Denied { request_id: String, reason: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SessionProvenance {
    plugin_version: String,
    artifact_sha256: String,
    artifact_origin: String,
    trust_level: String,
    workspace_id: String,
    generation: u64,
}

/// State owned by one persistent supervisor process. Session provenance is
/// retained until the host releases that Pi SDK session or this process exits.
/// The single hostcall limiter registry is reused by every future WorkerSession.
#[derive(Default)]
pub struct SupervisorService {
    sessions: HashMap<(String, String), SessionProvenance>,
    hostcall_rate_limiters: PluginHostcallRateLimiterRegistry,
    worker_cleanup_failed: bool,
}

impl SupervisorService {
    /// Handle one newline-delimited desktop IPC command. Session release is
    /// one-way; invocations always receive an explicit response.
    pub fn handle_command(&mut self, bytes: &[u8]) -> Option<WorkerInvocationResponse> {
        self.handle_command_with_bootstrap(bytes, &mut |_| Ok(()))
    }

    fn handle_command_with_bootstrap(
        &mut self,
        bytes: &[u8],
        bootstrap: &mut impl FnMut(&HostProvenance) -> Result<(), WorkerBootstrapFailure>,
    ) -> Option<WorkerInvocationResponse> {
        if bytes.len() > MAX_SUPERVISOR_REQUEST_BYTES {
            return Some(denied(
                "invalid-request",
                "Supervisor request exceeded its bounded input size.",
            ));
        }
        let command: SupervisorCommand = match serde_json::from_slice(bytes) {
            Ok(command) => command,
            Err(_) => {
                return Some(denied(
                    "invalid-request",
                    "Supervisor rejected an invalid IPC command.",
                ));
            }
        };

        match command {
            SupervisorCommand::Invoke { request } => {
                if request.request_id.is_empty() || request.request_id.len() > 128 {
                    return Some(denied(
                        "invalid-request",
                        "Supervisor rejected an invalid request identity.",
                    ));
                }
                let request_id = request.request_id.clone();
                if self.worker_cleanup_failed {
                    return Some(denied(
                        request_id,
                        "Worker cleanup could not be confirmed; the supervisor remains fail-closed until restart.",
                    ));
                }
                let provenance = match validate_invocation(&request) {
                    Ok(provenance) => provenance,
                    Err(error) => {
                        return Some(denied(
                            request_id,
                            &format!("Supervisor rejected request: {error}"),
                        ));
                    }
                };

                let key = (
                    provenance.plugin_id().to_string(),
                    provenance.session_id().to_string(),
                );
                let identity = SessionProvenance {
                    plugin_version: request.plugin_version,
                    artifact_sha256: request.artifact_sha256,
                    artifact_origin: request.artifact_origin,
                    trust_level: request.trust_level,
                    workspace_id: provenance.workspace_id().to_string(),
                    generation: provenance.generation(),
                };
                if self
                    .sessions
                    .get(&key)
                    .is_some_and(|registered| registered != &identity)
                {
                    return Some(denied(
                        request_id,
                        "Plugin provenance changed while the supervisor session remained active.",
                    ));
                }
                self.sessions.entry(key).or_insert(identity);

                let outcome = bootstrap(&provenance);
                if matches!(outcome, Err(WorkerBootstrapFailure::CleanupFailed)) {
                    self.worker_cleanup_failed = true;
                }
                Some(match outcome {
                    Ok(()) => denied(
                        request_id,
                        "Linux isolation enforcement is unavailable; plugin admission is denied before artifact transfer.",
                    ),
                    Err(failure) => denied(
                        request_id,
                        &format!(
                            "Trusted Linux worker bootstrap failed ({}); plugin admission is denied.",
                            failure.description(),
                        ),
                    ),
                })
            }
            SupervisorCommand::ReleaseSession { session_id } => {
                if !session_id.is_empty() && session_id.len() <= 128 {
                    self.sessions
                        .retain(|(_, registered_session), _| registered_session != &session_id);
                    None
                } else {
                    Some(denied(
                        "invalid-request",
                        "Supervisor rejected an invalid session release.",
                    ))
                }
            }
        }
    }

    /// The platform adapter must pass this runtime-owned registry to every
    /// WorkerSession, so plugin budgets cannot reset per invocation or session.
    pub fn hostcall_rate_limiters(&self) -> &PluginHostcallRateLimiterRegistry {
        &self.hostcall_rate_limiters
    }

    /// Execute through the shared Rust protocol while retaining this service's
    /// per-plugin hostcall budgets. No production adapter calls this until all
    /// required Linux controls are implemented and assessed.
    pub fn execute_assessed_worker<T: WorkerTransport>(
        &self,
        assessed_worker: AssessedWorker<T>,
        provenance: HostProvenance,
        host_granted_capabilities: impl IntoIterator<Item = String>,
        challenge: &str,
        capability: &str,
        payload: Value,
        deadline: Instant,
        broker: impl FnMut(modus_plugin_execution_protocol::AuthorizedInvocation) -> InvocationOutcome,
    ) -> Result<InvocationOutcome, WorkerExecutionError> {
        execute_assessed_worker(
            assessed_worker,
            provenance,
            host_granted_capabilities,
            &self.hostcall_rate_limiters,
            challenge,
            capability,
            payload,
            deadline,
            broker,
        )
    }

    #[cfg(test)]
    fn session_count(&self) -> usize {
        self.sessions.len()
    }
}

enum RequestLine {
    Data(Vec<u8>),
    TooLarge,
}

/// Serve bounded newline-delimited IPC until the host closes stdin.
pub fn serve_supervisor<R: BufRead, W: Write>(mut reader: R, mut writer: W) -> io::Result<()> {
    serve_supervisor_with_bootstrap(&mut reader, &mut writer, bootstrap_bundled_worker)
}

fn serve_supervisor_with_bootstrap<R, W, F>(
    mut reader: R,
    mut writer: W,
    mut bootstrap: F,
) -> io::Result<()>
where
    R: BufRead,
    W: Write,
    F: FnMut(&HostProvenance) -> Result<(), WorkerBootstrapFailure>,
{
    let mut service = SupervisorService::default();
    loop {
        let Some(line) = read_request_line(&mut reader)? else {
            return Ok(());
        };
        let response = match line {
            RequestLine::TooLarge => Some(denied(
                "invalid-request",
                "Supervisor request exceeded its bounded input size.",
            )),
            RequestLine::Data(bytes) if bytes.is_empty() => None,
            RequestLine::Data(bytes) => {
                service.handle_command_with_bootstrap(&bytes, &mut bootstrap)
            }
        };
        if let Some(response) = response {
            let bytes = encode_supervisor_response(&response)
                .map_err(|_| io::Error::other("supervisor response exceeded its bound"))?;
            writer.write_all(&bytes)?;
            writer.write_all(b"\n")?;
            writer.flush()?;
        }
    }
}

fn bootstrap_bundled_worker(provenance: &HostProvenance) -> Result<(), WorkerBootstrapFailure> {
    #[cfg(target_os = "linux")]
    {
        bootstrap_linux_worker(provenance)
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(WorkerBootstrapFailure::UnsupportedPlatform)
    }
}

#[cfg(target_os = "linux")]
fn bootstrap_linux_worker(provenance: &HostProvenance) -> Result<(), WorkerBootstrapFailure> {
    let supervisor_path =
        std::env::current_exe().map_err(|_| WorkerBootstrapFailure::BinaryUnavailable)?;
    let worker_path = resolve_bundled_worker_path(&supervisor_path)?;
    let challenge = create_bootstrap_challenge()?;
    let identity = WorkerCgroupIdentity::from_provenance(provenance);
    let cgroup_manager = LinuxCgroupV2::discover().map_err(map_cgroup_failure)?;
    let mut cgroup = cgroup_manager
        .prepare_worker(identity.clone(), REQUIRED_POLICY)
        .map_err(map_cgroup_failure)?;
    let child = Command::new(worker_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_clear()
        .env(WORKER_BOOTSTRAP_CHALLENGE_ENV, &challenge)
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(_) => {
            return Err(cleanup_unstarted_cgroup(
                &mut cgroup,
                WorkerBootstrapFailure::StartFailed,
            ));
        }
    };

    if cgroup.attach_process(&identity, child.id()).is_err() {
        return Err(cleanup_worker_after_error(
            &mut child,
            &mut cgroup,
            WorkerBootstrapFailure::CgroupUnavailable,
        ));
    }

    let input = match child.stdin.take() {
        Some(input) => input,
        None => {
            return Err(cleanup_worker_after_error(
                &mut child,
                &mut cgroup,
                WorkerBootstrapFailure::StartFailed,
            ));
        }
    };
    let output = match child.stdout.take() {
        Some(output) => output,
        None => {
            drop(input);
            return Err(cleanup_worker_after_error(
                &mut child,
                &mut cgroup,
                WorkerBootstrapFailure::StartFailed,
            ));
        }
    };

    let (sender, receiver) = mpsc::sync_channel(1);
    let reader = thread::Builder::new()
        .name("modus-worker-bootstrap-reader".into())
        .spawn(move || {
            let result = read_bounded_worker_frame(output)
                .map_err(|_| WorkerBootstrapFailure::HandshakeFailed);
            let _ = sender.send(result);
        });
    let reader = match reader {
        Ok(reader) => reader,
        Err(_) => {
            return Err(cleanup_worker_after_error(
                &mut child,
                &mut cgroup,
                WorkerBootstrapFailure::StartFailed,
            ));
        }
    };

    let frame = match receiver.recv_timeout(WORKER_BOOTSTRAP_TIMEOUT) {
        Ok(Ok(frame)) => frame,
        Ok(Err(failure)) => {
            drop(input);
            let failure = cleanup_worker_after_error(&mut child, &mut cgroup, failure);
            if failure == WorkerBootstrapFailure::CleanupFailed {
                drop(reader);
                return Err(failure);
            }
            return if reader.join().is_err() {
                Err(WorkerBootstrapFailure::CleanupFailed)
            } else {
                Err(failure)
            };
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            drop(input);
            let failure = cleanup_worker_after_error(
                &mut child,
                &mut cgroup,
                WorkerBootstrapFailure::TimedOut,
            );
            if failure == WorkerBootstrapFailure::CleanupFailed {
                drop(reader);
                return Err(failure);
            }
            return if reader.join().is_err() {
                Err(WorkerBootstrapFailure::CleanupFailed)
            } else {
                Err(failure)
            };
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            drop(input);
            let failure = cleanup_worker_after_error(
                &mut child,
                &mut cgroup,
                WorkerBootstrapFailure::HandshakeFailed,
            );
            if failure == WorkerBootstrapFailure::CleanupFailed {
                drop(reader);
                return Err(failure);
            }
            return if reader.join().is_err() {
                Err(WorkerBootstrapFailure::CleanupFailed)
            } else {
                Err(failure)
            };
        }
    };
    if reader.join().is_err() {
        drop(input);
        return Err(cleanup_worker_after_error(
            &mut child,
            &mut cgroup,
            WorkerBootstrapFailure::HandshakeFailed,
        ));
    }
    let mut input = input;
    if acknowledge_worker_bootstrap(&frame, &challenge, &mut input).is_err() {
        drop(input);
        return Err(cleanup_worker_after_error(
            &mut child,
            &mut cgroup,
            WorkerBootstrapFailure::HandshakeFailed,
        ));
    }
    drop(input);

    match wait_for_worker_exit(&mut child, Instant::now() + WORKER_BOOTSTRAP_TIMEOUT) {
        Ok(status) if status.success() => cgroup.cleanup().map_err(map_cgroup_failure),
        Ok(_) => {
            if cgroup.cleanup().is_err() {
                Err(WorkerBootstrapFailure::CleanupFailed)
            } else {
                Err(WorkerBootstrapFailure::HandshakeFailed)
            }
        }
        Err(WorkerBootstrapFailure::TimedOut) => Err(cleanup_worker_after_error(
            &mut child,
            &mut cgroup,
            WorkerBootstrapFailure::TimedOut,
        )),
        Err(failure) => Err(cleanup_worker_after_error(&mut child, &mut cgroup, failure)),
    }
}

#[cfg(target_os = "linux")]
fn cleanup_unstarted_cgroup(
    group: &mut WorkerCgroupLease,
    failure: WorkerBootstrapFailure,
) -> WorkerBootstrapFailure {
    if group.cleanup().is_ok() {
        failure
    } else {
        WorkerBootstrapFailure::CleanupFailed
    }
}

#[cfg(target_os = "linux")]
fn cleanup_worker_after_error(
    child: &mut Child,
    group: &mut WorkerCgroupLease,
    failure: WorkerBootstrapFailure,
) -> WorkerBootstrapFailure {
    let deadline = Instant::now()
        + Duration::from_millis(APPROVED_RESOURCE_POLICY.forced_termination_reap_deadline_ms);
    if terminate_worker_and_cleanup(child, group, deadline).is_ok() {
        failure
    } else {
        WorkerBootstrapFailure::CleanupFailed
    }
}

fn acknowledge_worker_bootstrap(
    worker_hello: &[u8],
    challenge: &str,
    host_output: &mut impl Write,
) -> Result<(), WorkerBootstrapFailure> {
    validate_worker_bootstrap_hello(worker_hello, challenge)
        .map_err(|_| WorkerBootstrapFailure::HandshakeFailed)?;
    let ready =
        encode_worker_bootstrap_ready().map_err(|_| WorkerBootstrapFailure::HandshakeFailed)?;
    host_output
        .write_all(&ready)
        .and_then(|()| host_output.flush())
        .map_err(|_| WorkerBootstrapFailure::HandshakeFailed)
}

#[cfg(target_os = "linux")]
fn resolve_bundled_worker_path(
    supervisor_executable: &Path,
) -> Result<PathBuf, WorkerBootstrapFailure> {
    let supervisor = fs::canonicalize(supervisor_executable)
        .map_err(|_| WorkerBootstrapFailure::BinaryUnavailable)?;
    let resources_dir = supervisor
        .parent()
        .ok_or(WorkerBootstrapFailure::BinaryIdentityInvalid)?;
    let worker_candidate = resources_dir.join(TRUSTED_WORKER_EXECUTABLE);
    let worker_link_metadata = fs::symlink_metadata(&worker_candidate)
        .map_err(|_| WorkerBootstrapFailure::BinaryUnavailable)?;
    if worker_link_metadata.file_type().is_symlink() || !worker_link_metadata.is_file() {
        return Err(WorkerBootstrapFailure::BinaryIdentityInvalid);
    }
    let worker = fs::canonicalize(&worker_candidate)
        .map_err(|_| WorkerBootstrapFailure::BinaryUnavailable)?;
    if worker.parent() != Some(resources_dir)
        || worker
            .file_name()
            .is_none_or(|name| name != TRUSTED_WORKER_EXECUTABLE)
    {
        return Err(WorkerBootstrapFailure::BinaryIdentityInvalid);
    }

    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let directory_metadata =
        fs::metadata(resources_dir).map_err(|_| WorkerBootstrapFailure::BinaryIdentityInvalid)?;
    let worker_metadata =
        fs::metadata(&worker).map_err(|_| WorkerBootstrapFailure::BinaryIdentityInvalid)?;
    let mode = worker_metadata.permissions().mode();
    if mode & 0o111 == 0
        || mode & 0o022 != 0
        || worker_metadata.uid() != directory_metadata.uid()
        || directory_metadata.permissions().mode() & 0o022 != 0
    {
        return Err(WorkerBootstrapFailure::BinaryIdentityInvalid);
    }

    Ok(worker)
}

#[cfg(target_os = "linux")]
fn create_bootstrap_challenge() -> Result<String, WorkerBootstrapFailure> {
    let mut random = [0; 32];
    File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut random))
        .map_err(|_| WorkerBootstrapFailure::StartFailed)?;
    let mut challenge = String::with_capacity(64);
    for byte in random {
        use std::fmt::Write as _;
        write!(&mut challenge, "{byte:02x}").map_err(|_| WorkerBootstrapFailure::StartFailed)?;
    }
    Ok(challenge)
}

#[cfg(target_os = "linux")]
fn read_bounded_worker_frame<R: Read>(mut reader: R) -> Result<Vec<u8>, ProtocolError> {
    let mut header = [0; 4];
    reader
        .read_exact(&mut header)
        .map_err(|error| ProtocolError::IoFailure(error.kind()))?;
    let payload_length = u32::from_be_bytes(header) as usize;
    let frame_length = payload_length
        .checked_add(header.len())
        .ok_or(ProtocolError::FrameTooLarge)?;
    if payload_length == 0 {
        return Err(ProtocolError::InvalidLength);
    }
    if frame_length > MAX_IPC_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge);
    }
    let mut frame = Vec::with_capacity(frame_length);
    frame.extend_from_slice(&header);
    frame.resize(frame_length, 0);
    reader
        .read_exact(&mut frame[header.len()..])
        .map_err(|error| ProtocolError::IoFailure(error.kind()))?;
    Ok(frame)
}

#[cfg(target_os = "linux")]
fn wait_for_worker_exit(
    child: &mut Child,
    deadline: Instant,
) -> Result<std::process::ExitStatus, WorkerBootstrapFailure> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            Ok(None) => return Err(WorkerBootstrapFailure::TimedOut),
            Err(_) => return Err(WorkerBootstrapFailure::CleanupFailed),
        }
    }
}

fn read_request_line<R: BufRead>(reader: &mut R) -> io::Result<Option<RequestLine>> {
    let mut line = Vec::new();
    let mut too_large = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if too_large {
                return Ok(Some(RequestLine::TooLarge));
            }
            return Ok((!line.is_empty()).then_some(RequestLine::Data(line)));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let length = newline.map_or(available.len(), |index| index + 1);
        let data_length = newline.map_or(length, |index| index);
        if !too_large {
            if line.len().saturating_add(data_length) > MAX_SUPERVISOR_REQUEST_BYTES {
                too_large = true;
            } else {
                line.extend_from_slice(&available[..data_length]);
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
            }
        }
        reader.consume(length);
        if newline.is_some() {
            return Ok(Some(if too_large {
                RequestLine::TooLarge
            } else {
                RequestLine::Data(line)
            }));
        }
    }
}

fn denied(request_id: impl Into<String>, reason: &str) -> WorkerInvocationResponse {
    WorkerInvocationResponse::Denied {
        request_id: request_id.into(),
        reason: reason.to_string(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SupervisorRequestError {
    TooLarge,
    InvalidJson,
    InvalidIdentity,
    InvalidPayload,
    ResponseTooLarge,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkerExecutionError {
    Admission(AdmissionError),
    Protocol(ProtocolError),
}

impl std::fmt::Display for WorkerExecutionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Admission(error) => write!(formatter, "worker admission failed: {error:?}"),
            Self::Protocol(error) => write!(formatter, "worker protocol failed: {error}"),
        }
    }
}

impl std::error::Error for WorkerExecutionError {}

impl From<ProtocolError> for WorkerExecutionError {
    fn from(error: ProtocolError) -> Self {
        Self::Protocol(error)
    }
}

impl std::fmt::Display for SupervisorRequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for SupervisorRequestError {}

/// Validate the bounded desktop-to-supervisor envelope and deny admission.
/// There is intentionally no best-effort or in-process fallback.
pub fn handle_unavailable_linux_request(
    bytes: &[u8],
) -> Result<WorkerInvocationResponse, SupervisorRequestError> {
    if bytes.len() > MAX_SUPERVISOR_REQUEST_BYTES {
        return Err(SupervisorRequestError::TooLarge);
    }
    let request: WorkerInvocationRequest =
        serde_json::from_slice(bytes).map_err(|_| SupervisorRequestError::InvalidJson)?;
    if request.request_id.is_empty() || request.request_id.len() > 128 {
        return Err(SupervisorRequestError::InvalidIdentity);
    }
    validate_invocation(&request)?;

    Ok(WorkerInvocationResponse::Denied {
        request_id: request.request_id,
        reason: "Linux isolation enforcement is unavailable; plugin admission is denied before artifact transfer.".into(),
    })
}

fn validate_invocation(
    request: &WorkerInvocationRequest,
) -> Result<HostProvenance, SupervisorRequestError> {
    let trust_level = match request.trust_level.as_str() {
        "core" => HostTrustLevel::Core,
        "official" => HostTrustLevel::Official,
        "verified" => HostTrustLevel::Verified,
        "community" => HostTrustLevel::Community,
        "local" => HostTrustLevel::Local,
        _ => return Err(SupervisorRequestError::InvalidIdentity),
    };
    let provenance = HostProvenance::from_host_catalog(
        request.plugin_id.clone(),
        request.plugin_version.clone(),
        request.artifact_sha256.clone(),
        request.artifact_origin.clone(),
        trust_level,
        request.session_id.clone(),
        request.workspace_id.clone(),
        request.run_id.clone(),
        request.generation,
    )
    .map_err(|_| SupervisorRequestError::InvalidIdentity)?;
    if request.capability.is_empty() || request.capability.len() > 128 {
        return Err(SupervisorRequestError::InvalidIdentity);
    }
    let payload_size = serde_json::to_vec(&request.payload)
        .map_err(|_| SupervisorRequestError::InvalidPayload)?
        .len();
    if payload_size > MAX_RESULT_BYTES {
        return Err(SupervisorRequestError::InvalidPayload);
    }
    Ok(provenance)
}

/// Execute one capability through the shared protocol after a platform
/// adapter has supplied a worker whose controls are already active. Production
/// Linux admission remains unavailable until such an adapter exists.
pub fn execute_assessed_worker<T: WorkerTransport>(
    assessed_worker: AssessedWorker<T>,
    provenance: HostProvenance,
    host_granted_capabilities: impl IntoIterator<Item = String>,
    hostcall_rate_limiters: &PluginHostcallRateLimiterRegistry,
    challenge: &str,
    capability: &str,
    payload: Value,
    deadline: Instant,
    broker: impl FnMut(modus_plugin_execution_protocol::AuthorizedInvocation) -> InvocationOutcome,
) -> Result<InvocationOutcome, WorkerExecutionError> {
    let admission = AdmissionAssessmentToken::validate(assessed_worker, provenance.clone())
        .map_err(WorkerExecutionError::Admission)?;
    // SAFETY: This entry point receives grants from the host permission broker
    // and a runtime-owned rate limiter registry; worker input cannot modify either.
    let authorization = unsafe {
        HostAuthorization::from_permission_broker(
            provenance,
            host_granted_capabilities,
            hostcall_rate_limiters,
        )?
    };
    let mut session = WorkerSession::new(admission, authorization, challenge)?;
    Ok(session.execute_until(capability, payload, deadline, broker)?)
}

/// Encode a supervisor response under the same bounded host IPC ceiling.
pub fn encode_supervisor_response(
    response: &WorkerInvocationResponse,
) -> Result<Vec<u8>, SupervisorRequestError> {
    let bytes = serde_json::to_vec(response).map_err(|_| SupervisorRequestError::InvalidJson)?;
    if bytes.len() > MAX_SUPERVISOR_RESPONSE_BYTES {
        return Err(SupervisorRequestError::ResponseTooLarge);
    }
    Ok(bytes)
}

/// Marker for platform adapters: every approved enforcement category is
/// required before constructing `AssessedWorker`.
pub const REQUIRED_LINUX_CONTROLS: &[EnforcementControl] = &[
    EnforcementControl::ArtifactLimitBeforeParsing,
    EnforcementControl::BoundedIpcResultsAndOutput,
    EnforcementControl::WasmMemoryAndFuel,
    EnforcementControl::HelperAndAggregateRss,
    EnforcementControl::CpuRatePerCore,
    EnforcementControl::StartupExecutionAndBrokerDeadlines,
    EnforcementControl::PreemptibleTerminationAndTreeReap,
    EnforcementControl::HostcallAndPendingRequestLimits,
    EnforcementControl::GuestProcessAndKernelHandleLimits,
    EnforcementControl::AmbientFilesystemNetworkAndCredentialDenial,
];

/// Frozen policy consumers must apply before artifact bytes are exposed.
pub const REQUIRED_POLICY: modus_plugin_execution_protocol::resource_policy::ResourcePolicy =
    APPROVED_RESOURCE_POLICY;

/// Use when a future Linux adapter cannot create a process without starting it.
pub fn unavailable_adapter_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "Linux worker admission is disabled until all required controls are enforced",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::io;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use modus_plugin_execution_protocol::worker_admission::PlatformAssessment;
    use modus_plugin_execution_protocol::{
        HostFrame, PROTOCOL_VERSION, WorkerExecutionOutcome, WorkerFrame, decode_host_frame,
        decode_worker_bootstrap_ready, encode_worker_frame,
    };
    use serde_json::json;

    const CHALLENGE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    struct FixtureTransport {
        input: VecDeque<u8>,
        output: Arc<Mutex<Vec<u8>>>,
        terminated: Arc<AtomicBool>,
        reaped: Arc<AtomicBool>,
    }

    impl modus_plugin_execution_protocol::DeadlineReader for FixtureTransport {
        fn read_with_deadline(
            &mut self,
            buffer: &mut [u8],
            deadline: Instant,
        ) -> io::Result<usize> {
            if Instant::now() >= deadline {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "fixture deadline"));
            }
            let length = buffer.len().min(self.input.len());
            for byte in &mut buffer[..length] {
                *byte = self.input.pop_front().expect("fixture length is bounded");
            }
            Ok(length)
        }
    }

    unsafe impl WorkerTransport for FixtureTransport {
        fn write_with_deadline(&mut self, bytes: &[u8], deadline: Instant) -> io::Result<()> {
            if Instant::now() >= deadline {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "fixture deadline"));
            }
            self.output.lock().unwrap().extend_from_slice(bytes);
            Ok(())
        }

        fn request_termination(&mut self) {
            self.terminated.store(true, Ordering::SeqCst);
        }

        fn reap_until(&mut self, deadline: Instant) -> io::Result<()> {
            if Instant::now() >= deadline {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "fixture reap"));
            }
            self.reaped.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    fn provenance() -> HostProvenance {
        HostProvenance::from_host_catalog(
            "fixture/plugin",
            "1.0.0",
            "b".repeat(64),
            "fixture-catalog",
            HostTrustLevel::Verified,
            "fixture-session",
            "fixture-workspace",
            "fixture-run",
            1,
        )
        .unwrap()
    }

    fn append_frame(bytes: &mut Vec<u8>, frame: WorkerFrame) {
        bytes.extend(encode_worker_frame(&frame).unwrap());
    }

    #[test]
    fn supervisor_routes_synthetic_execution_through_worker_session_and_returns_result() {
        let provenance = provenance();
        let output = Arc::new(Mutex::new(Vec::new()));
        let terminated = Arc::new(AtomicBool::new(false));
        let reaped = Arc::new(AtomicBool::new(false));
        let mut input = Vec::new();
        append_frame(
            &mut input,
            WorkerFrame::Hello {
                protocol_version: PROTOCOL_VERSION,
                challenge: CHALLENGE.into(),
            },
        );
        append_frame(
            &mut input,
            WorkerFrame::ExecutionComplete {
                protocol_version: PROTOCOL_VERSION,
                sequence: 1,
                outcome: WorkerExecutionOutcome::Success {
                    result: json!({ "value": "synthetic result" }),
                },
            },
        );
        let transport = FixtureTransport {
            input: input.into(),
            output: Arc::clone(&output),
            terminated: Arc::clone(&terminated),
            reaped: Arc::clone(&reaped),
        };
        let assessment = unsafe {
            PlatformAssessment::from_adapter(
                provenance.clone(),
                APPROVED_RESOURCE_POLICY,
                REQUIRED_LINUX_CONTROLS.iter().copied(),
            )
        };
        let assessed_worker = unsafe { AssessedWorker::from_adapter(assessment, transport) };
        let supervisor = SupervisorService::default();

        let result = supervisor.execute_assessed_worker(
            assessed_worker,
            provenance,
            [],
            CHALLENGE,
            "plugin.transform",
            json!({ "text": "fixture" }),
            Instant::now() + Duration::from_secs(30),
            |_| panic!("no hostcall was sent by the synthetic worker"),
        );

        assert_eq!(
            result,
            Ok(InvocationOutcome::Success(
                json!({ "value": "synthetic result" })
            ))
        );
        assert!(terminated.load(Ordering::SeqCst));
        assert!(reaped.load(Ordering::SeqCst));
        let bytes = output.lock().unwrap();
        let ready_length = 4 + u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        assert_eq!(
            decode_host_frame(&bytes[..ready_length]).unwrap(),
            HostFrame::Ready {
                protocol_version: PROTOCOL_VERSION,
            },
        );
        assert!(matches!(
            decode_host_frame(&bytes[ready_length..]).unwrap(),
            HostFrame::Execute { capability, .. } if capability == "plugin.transform"
        ));
    }

    #[test]
    fn linux_supervisor_denies_structurally_valid_request_when_adapter_is_missing() {
        let request = WorkerInvocationRequest {
            request_id: "fixture-request".into(),
            plugin_id: "fixture/plugin".into(),
            plugin_version: "1.0.0".into(),
            artifact_sha256: "c".repeat(64),
            artifact_origin: "fixture-catalog".into(),
            trust_level: "verified".into(),
            session_id: "fixture-session".into(),
            workspace_id: "fixture-workspace".into(),
            run_id: "fixture-run".into(),
            generation: 1,
            capability: "plugin.transform".into(),
            payload: json!({ "text": "fixture" }),
            host_granted_capabilities: Vec::new(),
        };
        let bytes = serde_json::to_vec(&request).unwrap();
        assert_eq!(
            handle_unavailable_linux_request(&bytes),
            Ok(WorkerInvocationResponse::Denied {
                request_id: "fixture-request".into(),
                reason: "Linux isolation enforcement is unavailable; plugin admission is denied before artifact transfer."
                    .into(),
            }),
        );
    }

    fn invocation_command(
        request_id: &str,
        session_id: &str,
        workspace_id: &str,
        run_id: &str,
    ) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "type": "invoke",
            "request": WorkerInvocationRequest {
                request_id: request_id.into(),
                plugin_id: "fixture/plugin".into(),
                plugin_version: "1.0.0".into(),
                artifact_sha256: "c".repeat(64),
                artifact_origin: "fixture-catalog".into(),
                trust_level: "verified".into(),
                session_id: session_id.into(),
                workspace_id: workspace_id.into(),
                run_id: run_id.into(),
                generation: 1,
                capability: "plugin.transform".into(),
                payload: json!({ "text": "synthetic" }),
                host_granted_capabilities: Vec::new(),
            }
        }))
        .unwrap()
    }

    #[test]
    fn persistent_supervisor_reuses_session_provenance_until_host_release() {
        let mut service = SupervisorService::default();
        for (request_id, run_id) in [("request-1", "run-1"), ("request-2", "run-2")] {
            assert!(matches!(
                service.handle_command(&invocation_command(
                    request_id,
                    "session-1",
                    "workspace-1",
                    run_id,
                )),
                Some(WorkerInvocationResponse::Denied { request_id: returned, .. }) if returned == request_id
            ));
        }
        assert_eq!(service.session_count(), 1);

        assert_eq!(
            service.handle_command(br#"{"type":"release_session","sessionId":"session-1"}"#),
            None,
        );
        assert_eq!(service.session_count(), 0);

        assert!(matches!(
            service.handle_command(&invocation_command(
                "request-3",
                "session-1",
                "workspace-2",
                "run-3",
            )),
            Some(WorkerInvocationResponse::Denied { request_id, .. }) if request_id == "request-3"
        ));
    }

    #[test]
    fn persistent_supervisor_rejects_provenance_changes_inside_a_live_session() {
        let mut service = SupervisorService::default();
        assert!(matches!(
            service.handle_command(&invocation_command(
                "request-1",
                "session-1",
                "workspace-1",
                "run-1",
            )),
            Some(WorkerInvocationResponse::Denied { reason, .. }) if reason.contains("before artifact transfer")
        ));
        let changed = invocation_command("request-2", "session-1", "workspace-2", "run-2");
        assert!(matches!(
            service.handle_command(&changed),
            Some(WorkerInvocationResponse::Denied { reason, .. }) if reason.contains("provenance changed")
        ));
        assert_eq!(service.session_count(), 1);
    }

    #[test]
    fn persistent_ipc_serves_multiple_requests_until_host_closes_stdin() {
        let input = [
            invocation_command("request-1", "session-1", "workspace-1", "run-1"),
            invocation_command("request-2", "session-2", "workspace-2", "run-2"),
        ]
        .into_iter()
        .flat_map(|mut line| {
            line.push(b'\n');
            line
        })
        .collect::<Vec<_>>();
        let mut output = Vec::new();
        serve_supervisor_with_bootstrap(&input[..], &mut output, |_| Ok(())).unwrap();
        let lines = output
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty());
        let responses = lines
            .map(|line| serde_json::from_slice::<WorkerInvocationResponse>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            responses,
            vec![
                WorkerInvocationResponse::Denied {
                    request_id: "request-1".into(),
                    reason: "Linux isolation enforcement is unavailable; plugin admission is denied before artifact transfer.".into(),
                },
                WorkerInvocationResponse::Denied {
                    request_id: "request-2".into(),
                    reason: "Linux isolation enforcement is unavailable; plugin admission is denied before artifact transfer.".into(),
                },
            ],
        );
    }

    #[test]
    fn persistent_ipc_bounds_each_line_and_keeps_later_requests_fail_closed() {
        let mut input = vec![b'x'; MAX_SUPERVISOR_REQUEST_BYTES + 1];
        input.push(b'\n');
        input.extend(invocation_command(
            "request-1",
            "session-1",
            "workspace-1",
            "run-1",
        ));
        input.push(b'\n');
        let mut output = Vec::new();
        serve_supervisor_with_bootstrap(&input[..], &mut output, |_| Ok(())).unwrap();
        let responses = output
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice::<WorkerInvocationResponse>(line).unwrap())
            .collect::<Vec<_>>();
        assert!(matches!(
            responses.first(),
            Some(WorkerInvocationResponse::Denied { request_id, reason })
                if request_id == "invalid-request" && reason.contains("bounded input size")
        ));
        assert!(matches!(
            responses.get(1),
            Some(WorkerInvocationResponse::Denied { request_id, reason })
                if request_id == "request-1" && reason.contains("before artifact transfer")
        ));
    }

    #[test]
    fn supervisor_bootstrap_receives_host_provenance_and_never_transfers_artifacts() {
        let input = invocation_command(
            "request-bootstrap",
            "session-host",
            "workspace-host",
            "run-host",
        );
        let mut line = input;
        line.push(b'\n');
        let mut output = Vec::new();
        let mut observed = None;
        let mut host_output = Vec::new();

        serve_supervisor_with_bootstrap(&line[..], &mut output, |provenance| {
            observed = Some((
                provenance.plugin_id().to_owned(),
                provenance.session_id().to_owned(),
                provenance.workspace_id().to_owned(),
                provenance.run_id().to_owned(),
                provenance.generation(),
            ));
            let hello = encode_worker_frame(&WorkerFrame::Hello {
                protocol_version: PROTOCOL_VERSION,
                challenge: CHALLENGE.into(),
            })
            .unwrap();
            acknowledge_worker_bootstrap(&hello, CHALLENGE, &mut host_output)
        })
        .unwrap();

        assert_eq!(
            observed,
            Some((
                "fixture/plugin".into(),
                "session-host".into(),
                "workspace-host".into(),
                "run-host".into(),
                1,
            )),
        );
        let response: WorkerInvocationResponse =
            serde_json::from_slice(output.split(|byte| *byte == b'\n').next().unwrap()).unwrap();
        assert_eq!(
            response,
            WorkerInvocationResponse::Denied {
                request_id: "request-bootstrap".into(),
                reason: "Linux isolation enforcement is unavailable; plugin admission is denied before artifact transfer.".into(),
            },
        );
        assert_eq!(decode_worker_bootstrap_ready(&host_output), Ok(()));
    }

    #[test]
    fn supervisor_bootstrap_rejects_wrong_challenge_without_replying_ready() {
        let hello = encode_worker_frame(&WorkerFrame::Hello {
            protocol_version: PROTOCOL_VERSION,
            challenge: CHALLENGE.into(),
        })
        .unwrap();
        let mut host_output = Vec::new();
        assert_eq!(
            acknowledge_worker_bootstrap(&hello, &"b".repeat(64), &mut host_output),
            Err(WorkerBootstrapFailure::HandshakeFailed),
        );
        assert!(host_output.is_empty());
    }

    #[test]
    fn supervisor_bootstrap_failure_and_untrusted_artifact_path_fail_closed() {
        let mut timeout_input = invocation_command(
            "request-timeout",
            "session-timeout",
            "workspace-timeout",
            "run-timeout",
        );
        timeout_input.push(b'\n');
        let mut output = Vec::new();
        serve_supervisor_with_bootstrap(&timeout_input[..], &mut output, |_| {
            Err(WorkerBootstrapFailure::TimedOut)
        })
        .unwrap();
        let timeout_response: WorkerInvocationResponse =
            serde_json::from_slice(output.split(|byte| *byte == b'\n').next().unwrap()).unwrap();
        assert!(matches!(
            timeout_response,
            WorkerInvocationResponse::Denied { reason, .. }
                if reason.contains("bootstrap timed out") && reason.contains("admission is denied")
        ));

        let mut cleanup_input = invocation_command(
            "request-cleanup",
            "session-cleanup",
            "workspace-cleanup",
            "run-cleanup",
        );
        cleanup_input.push(b'\n');
        let mut cleanup_output = Vec::new();
        serve_supervisor_with_bootstrap(&cleanup_input[..], &mut cleanup_output, |_| {
            Err(WorkerBootstrapFailure::CleanupFailed)
        })
        .unwrap();
        assert!(
            cleanup_output
                .windows(b"cleanup failed".len())
                .any(|window| window == b"cleanup failed")
        );

        let mut request: serde_json::Value = serde_json::from_slice(&invocation_command(
            "request-path",
            "session-path",
            "workspace-path",
            "run-path",
        ))
        .unwrap();
        request["request"]["artifactPath"] = serde_json::json!("/tmp/plugin-provided-worker");
        let mut input = serde_json::to_vec(&request).unwrap();
        input.push(b'\n');
        let mut bootstrap_calls = 0;
        let mut output = Vec::new();
        serve_supervisor_with_bootstrap(&input[..], &mut output, |_| {
            bootstrap_calls += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(bootstrap_calls, 0);
        assert!(
            output
                .windows(b"invalid IPC command".len())
                .any(|window| window == b"invalid IPC command")
        );
    }

    #[test]
    fn supervisor_stops_starting_workers_after_unconfirmed_cleanup() {
        let mut service = SupervisorService::default();
        let first = service.handle_command_with_bootstrap(
            &invocation_command("request-cleanup-failed", "session", "workspace", "run"),
            &mut |_| Err(WorkerBootstrapFailure::CleanupFailed),
        );
        assert!(matches!(
            first,
            Some(WorkerInvocationResponse::Denied { reason, .. })
                if reason.contains("cleanup failed")
        ));

        let mut bootstrap_calls = 0;
        let second = service.handle_command_with_bootstrap(
            &invocation_command(
                "request-after-cleanup-failed",
                "session",
                "workspace",
                "run",
            ),
            &mut |_| {
                bootstrap_calls += 1;
                Ok(())
            },
        );
        assert_eq!(bootstrap_calls, 0);
        assert!(matches!(
            second,
            Some(WorkerInvocationResponse::Denied { reason, .. })
                if reason.contains("remains fail-closed until restart")
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn bundled_worker_path_is_host_relative_regular_executable_only() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        use std::time::{SystemTime, UNIX_EPOCH};

        let root = std::env::temp_dir().join(format!(
            "modus-worker-path-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        fs::create_dir(&root).unwrap();
        let supervisor = root.join("modus-plugin-execution-supervisor");
        let worker = root.join(TRUSTED_WORKER_EXECUTABLE);
        fs::write(&supervisor, b"synthetic host supervisor").unwrap();
        fs::write(&worker, b"synthetic bundled worker").unwrap();
        fs::set_permissions(&supervisor, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&worker, fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            resolve_bundled_worker_path(&supervisor).unwrap(),
            fs::canonicalize(&worker).unwrap(),
        );

        fs::set_permissions(&worker, fs::Permissions::from_mode(0o666)).unwrap();
        assert_eq!(
            resolve_bundled_worker_path(&supervisor),
            Err(WorkerBootstrapFailure::BinaryIdentityInvalid),
        );

        fs::remove_file(&worker).unwrap();
        let outside = root.join("arbitrary-worker");
        fs::write(&outside, b"synthetic arbitrary executable").unwrap();
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            resolve_bundled_worker_path(&supervisor),
            Err(WorkerBootstrapFailure::BinaryUnavailable),
        );
        symlink(&outside, &worker).unwrap();
        assert_eq!(
            resolve_bundled_worker_path(&supervisor),
            Err(WorkerBootstrapFailure::BinaryIdentityInvalid),
        );

        fs::remove_dir_all(root).unwrap();
    }
}
