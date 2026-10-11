//! Host-side execution dispatcher for process-isolated plugin workers.
//!
//! This crate consumes the shared protocol's one-use admission token and
//! `WorkerSession`. It deliberately has no Linux process launcher yet. The
//! packaged supervisor therefore denies requests until a Linux adapter can
//! report every required control for the exact worker process.

use std::io;
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
    let trust_level = match request.trust_level.as_str() {
        "core" => HostTrustLevel::Core,
        "official" => HostTrustLevel::Official,
        "verified" => HostTrustLevel::Verified,
        "community" => HostTrustLevel::Community,
        "local" => HostTrustLevel::Local,
        _ => return Err(SupervisorRequestError::InvalidIdentity),
    };
    HostProvenance::from_host_catalog(
        request.plugin_id,
        request.plugin_version,
        request.artifact_sha256,
        request.artifact_origin,
        trust_level,
        request.session_id,
        request.workspace_id,
        request.run_id,
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

    Ok(WorkerInvocationResponse::Denied {
        request_id: request.request_id,
        reason: "Linux process isolation is not implemented; worker admission is denied.".into(),
    })
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
    session.execute_until(capability, payload, deadline, broker)
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
        DispatchEvent, HostFrame, PROTOCOL_VERSION, WorkerExecutionOutcome, WorkerFrame,
        decode_host_frame, encode_worker_frame,
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
        let limiter_registry = PluginHostcallRateLimiterRegistry::default();

        let result = execute_assessed_worker(
            assessed_worker,
            provenance,
            [],
            &limiter_registry,
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
}
