//! Host-side execution dispatcher for process-isolated plugin workers.
//!
//! This crate consumes the shared protocol's one-use admission token and
//! `WorkerSession`. It deliberately has no Linux process launcher yet. The
//! packaged supervisor therefore denies requests until a Linux adapter can
//! report every required control for the exact worker process.

use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::time::Instant;

use modus_plugin_execution_protocol::resource_policy::APPROVED_RESOURCE_POLICY;
use modus_plugin_execution_protocol::worker_admission::{
    AdmissionAssessmentToken, AdmissionError, AssessedWorker, EnforcementControl,
    HostAuthorization, PluginHostcallRateLimiterRegistry, WorkerTransport,
};
use modus_plugin_execution_protocol::{
    HostProvenance, HostTrustLevel, InvocationOutcome, MAX_IPC_FRAME_BYTES, MAX_RESULT_BYTES,
    ProtocolError, WorkerSession,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_SUPERVISOR_REQUEST_BYTES: usize = MAX_IPC_FRAME_BYTES - 4;
pub const MAX_SUPERVISOR_RESPONSE_BYTES: usize = MAX_IPC_FRAME_BYTES - 4;

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
}

impl SupervisorService {
    /// Handle one newline-delimited desktop IPC command. Session release is
    /// one-way; invocations always receive an explicit response.
    pub fn handle_command(&mut self, bytes: &[u8]) -> Option<WorkerInvocationResponse> {
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

                Some(WorkerInvocationResponse::Denied {
                    request_id,
                    reason:
                        "Linux process isolation is not implemented; worker admission is denied."
                            .into(),
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
    /// Linux controls are implemented and assessed.
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
            RequestLine::Data(bytes) => service.handle_command(&bytes),
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
        reason: "Linux process isolation is not implemented; worker admission is denied.".into(),
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
        encode_worker_frame,
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
                reason: "Linux process isolation is not implemented; worker admission is denied."
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
            Some(WorkerInvocationResponse::Denied { reason, .. }) if reason.contains("is not implemented")
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
        serve_supervisor(&input[..], &mut output).unwrap();
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
                    reason:
                        "Linux process isolation is not implemented; worker admission is denied."
                            .into(),
                },
                WorkerInvocationResponse::Denied {
                    request_id: "request-2".into(),
                    reason:
                        "Linux process isolation is not implemented; worker admission is denied."
                            .into(),
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
        serve_supervisor(&input[..], &mut output).unwrap();
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
                if request_id == "request-1" && reason.contains("is not implemented")
        ));
    }
}
