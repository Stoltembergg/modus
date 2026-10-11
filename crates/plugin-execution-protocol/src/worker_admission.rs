//! Host-owned admission for a future process-backed plugin worker.
//!
//! A validated token owns the exact IPC transport assessed by the platform
//! adapter. The shared dispatcher consumes that token and is the only
//! production API for reading worker frames or writing host responses. This
//! module defines the boundary contract; it does not implement or prove
//! operating-system enforcement. No production adapter currently creates an
//! [`AssessedWorker`], so external worker execution remains unavailable.
//!
//! Platform adapters live in trusted host crates and cross this boundary with
//! explicit `unsafe` constructors/implementations. Their safety obligations
//! are documented on [`WorkerTransport`], [`PlatformAssessment::from_adapter`],
//! and [`AssessedWorker::from_adapter`]. The admission token is not itself
//! proof that those obligations were met.
//!
//! ```compile_fail
//! use modus_plugin_execution_protocol::{Dispatcher, HostProvenance, HostTrustLevel};
//! let provenance = HostProvenance::from_host_catalog(
//!     "plugin", "1.0.0", "0".repeat(64), "catalog", HostTrustLevel::Verified,
//!     "session", "workspace", "run", 1,
//! ).unwrap();
//! // The low-level dispatcher has no public constructor.
//! let _dispatcher = Dispatcher::new("0".repeat(64), provenance, Vec::<String>::new());
//! ```
//!
//! ```compile_fail
//! use modus_plugin_execution_protocol::worker_admission::AdmissionAssessmentToken;
//! use modus_plugin_execution_protocol::worker_admission::WorkerTransport;
//! fn require_clone<T: Clone>() {}
//! fn assert_token_cloneable<T: WorkerTransport>() {
//!     require_clone::<AdmissionAssessmentToken<T>>();
//! }
//! ```
//!
//! ```compile_fail
//! use modus_plugin_execution_protocol::WorkerSession;
//! use modus_plugin_execution_protocol::worker_admission::{
//!     AdmissionAssessmentToken, HostAuthorization, WorkerTransport,
//! };
//! fn consume_twice<T: WorkerTransport>(
//!     token: AdmissionAssessmentToken<T>,
//!     authorization_one: HostAuthorization,
//!     authorization_two: HostAuthorization,
//! ) {
//!     let _ = WorkerSession::new(token, authorization_one, "a".repeat(64));
//!     let _ = WorkerSession::new(token, authorization_two, "a".repeat(64));
//! }
//! ```
//!
//! ```compile_fail
//! use std::time::Instant;
//! use modus_plugin_execution_protocol::{DeadlineReader, WorkerSession};
//! use modus_plugin_execution_protocol::worker_admission::WorkerTransport;
//! fn read_from_an_unrelated_stream<R: DeadlineReader, T: WorkerTransport>(
//!     session: &mut WorkerSession<T>,
//!     unrelated_reader: &mut R,
//! ) {
//!     let _ = session.receive_from_until(unrelated_reader, Instant::now());
//! }
//! ```

use std::collections::{BTreeSet, VecDeque};
use std::io;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::resource_policy::{APPROVED_RESOURCE_POLICY, ResourcePolicy};
use crate::{DeadlineReader, HostProvenance};

/// Operations on one host-created worker's IPC endpoint and process tree.
///
/// # Safety
///
/// Implementations must own the IPC endpoint for exactly one worker process.
/// Reads and writes must honor the supplied absolute deadlines, enforce the
/// protocol frame limit before allocating or writing, and never block past a
/// deadline. `request_termination` must be non-blocking and stop the complete
/// process tree. `reap_until` must return only after the process tree is gone,
/// or return an error by the supplied deadline. Dropping the implementation
/// must also request termination so abandoning an assessment or session does
/// not leave a worker running. These are adapter obligations; this trait does
/// not verify that an OS mechanism enforces them.
pub unsafe trait WorkerTransport: DeadlineReader + Send {
    fn write_with_deadline(&mut self, frame: &[u8], deadline: Instant) -> io::Result<()>;

    fn request_termination(&mut self);

    fn reap_until(&mut self, deadline: Instant) -> io::Result<()>;
}

/// One required control category in the approved worker contract. A single
/// list defines both the enum and required set so a new category cannot be
/// omitted silently from validation.
macro_rules! define_enforcement_controls {
    ($($control:ident),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
        pub enum EnforcementControl {
            $($control),+
        }

        const REQUIRED_CONTROLS: &[EnforcementControl] = &[
            $(EnforcementControl::$control),+
        ];
    };
}

define_enforcement_controls! {
    ArtifactLimitBeforeParsing,
    BoundedIpcResultsAndOutput,
    WasmMemoryAndFuel,
    HelperAndAggregateRss,
    CpuRatePerCore,
    StartupExecutionAndBrokerDeadlines,
    PreemptibleTerminationAndTreeReap,
    HostcallAndPendingRequestLimits,
    GuestProcessAndKernelHandleLimits,
    AmbientFilesystemNetworkAndCredentialDenial,
}

/// Platform adapter assessment attached to a single worker transport.
///
/// # Safety
///
/// The caller must report only controls actually installed and inspected for
/// the worker associated with the [`AssessedWorker`] created from this value.
/// Configuration intent or a synthetic report is not sufficient.
#[derive(Debug, Eq, PartialEq)]
pub struct PlatformAssessment {
    provenance: HostProvenance,
    assessed_policy: ResourcePolicy,
    assessed_controls: BTreeSet<EnforcementControl>,
}

impl PlatformAssessment {
    /// Create a platform assessment from trusted host adapter code.
    ///
    /// # Safety
    ///
    /// `assessed_policy` and `assessed_controls` must describe active
    /// enforcement on the exact process that will be paired with this
    /// assessment. Provenance must be host-resolved, and no artifact bytes may
    /// have been sent to the worker before those controls were installed.
    pub unsafe fn from_adapter(
        provenance: HostProvenance,
        assessed_policy: ResourcePolicy,
        assessed_controls: impl IntoIterator<Item = EnforcementControl>,
    ) -> Self {
        Self {
            provenance,
            assessed_policy,
            assessed_controls: assessed_controls.into_iter().collect(),
        }
    }
}

/// A started worker and the exact transport for the worker assessed by the
/// platform adapter. The value can only be created through an unsafe adapter
/// boundary and is consumed by admission validation.
pub struct AssessedWorker<T: WorkerTransport> {
    assessment: Option<PlatformAssessment>,
    transport: Option<T>,
}

impl<T: WorkerTransport> AssessedWorker<T> {
    /// Pair adapter evidence with its worker's transport endpoint.
    ///
    /// # Safety
    ///
    /// `transport` must address the same process described by `assessment`;
    /// all reported controls must already be active; and the adapter must not
    /// have transferred guest artifact bytes before this pair was assessed.
    pub unsafe fn from_adapter(assessment: PlatformAssessment, transport: T) -> Self {
        Self {
            assessment: Some(assessment),
            transport: Some(transport),
        }
    }

    fn into_parts(mut self) -> (PlatformAssessment, T) {
        (
            self.assessment
                .take()
                .expect("assessed worker is consumed once"),
            self.transport
                .take()
                .expect("assessed worker transport is consumed once"),
        )
    }
}

impl<T: WorkerTransport> Drop for AssessedWorker<T> {
    fn drop(&mut self) {
        if let Some(transport) = self.transport.as_mut() {
            request_and_reap(transport, cleanup_deadline());
        }
    }
}

/// Rejection reason for an incomplete or inconsistent platform assessment.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdmissionError {
    ProvenanceMismatch,
    PolicyDiffersFromApproved,
    RequiredControlNotAssessed(EnforcementControl),
    WorkerCleanupFailed(io::ErrorKind),
}

/// Host-owned rolling one-second hostcall budget shared by every session for
/// one plugin identity. The supervisor must reuse the same value when it
/// authorizes concurrent or restarted workers for that plugin.
#[derive(Debug)]
pub struct PluginHostcallRateLimiter {
    plugin_id: String,
    recent_calls: Mutex<VecDeque<Instant>>,
}

impl PluginHostcallRateLimiter {
    /// Create a limiter for the plugin identity resolved by the host catalog.
    /// Keep and reuse this `Arc` across sessions for that plugin.
    pub fn for_plugin(provenance: &HostProvenance) -> Arc<Self> {
        Arc::new(Self {
            plugin_id: provenance.plugin_id().to_string(),
            recent_calls: Mutex::new(VecDeque::new()),
        })
    }

    fn reserve(&self, provenance: &HostProvenance) -> Result<(), crate::ProtocolError> {
        self.reserve_with_clock(provenance, Instant::now)
    }

    fn reserve_with_clock(
        &self,
        provenance: &HostProvenance,
        clock: impl FnOnce() -> Instant,
    ) -> Result<(), crate::ProtocolError> {
        if provenance.plugin_id() != self.plugin_id {
            return Err(crate::ProtocolError::HostcallLimiterIdentityMismatch);
        }
        let mut recent_calls = self
            .recent_calls
            .lock()
            .map_err(|_| crate::ProtocolError::HostcallLimiterUnavailable)?;
        let now = clock();
        while recent_calls.front().is_some_and(|recorded| {
            now.saturating_duration_since(*recorded) >= Duration::from_secs(1)
        }) {
            recent_calls.pop_front();
        }
        if recent_calls.len() >= APPROVED_RESOURCE_POLICY.max_hostcalls_per_plugin_second as usize {
            return Err(crate::ProtocolError::PluginHostcallRateLimitExceeded);
        }
        recent_calls.push_back(now);
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn reserve_at(
        &self,
        provenance: &HostProvenance,
        now: Instant,
    ) -> Result<(), crate::ProtocolError> {
        self.reserve_with_clock(provenance, || now)
    }
}

/// Non-cloneable token that owns the assessed worker transport until it is
/// consumed by `WorkerSession`. It is not a proof of OS enforcement.
pub struct AdmissionAssessmentToken<T: WorkerTransport> {
    provenance: HostProvenance,
    approved_policy: ResourcePolicy,
    transport: Option<T>,
}

impl<T: WorkerTransport> AdmissionAssessmentToken<T> {
    /// Validate and consume one platform-assessed worker.
    pub fn validate(
        assessed_worker: AssessedWorker<T>,
        expected_provenance: HostProvenance,
    ) -> Result<Self, AdmissionError> {
        let (assessment, mut transport) = assessed_worker.into_parts();
        let rejection = if assessment.provenance != expected_provenance {
            Some(AdmissionError::ProvenanceMismatch)
        } else if assessment.assessed_policy != APPROVED_RESOURCE_POLICY {
            // Until the dispatcher and codec apply variable limits, accept
            // only the exact policy that they actually enforce.
            Some(AdmissionError::PolicyDiffersFromApproved)
        } else {
            REQUIRED_CONTROLS
                .iter()
                .find(|control| !assessment.assessed_controls.contains(control))
                .copied()
                .map(AdmissionError::RequiredControlNotAssessed)
        };

        if let Some(reason) = rejection {
            return match request_and_reap(&mut transport, cleanup_deadline()) {
                Ok(()) => Err(reason),
                Err(kind) => Err(AdmissionError::WorkerCleanupFailed(kind)),
            };
        }

        Ok(Self {
            provenance: expected_provenance,
            approved_policy: APPROVED_RESOURCE_POLICY,
            transport: Some(transport),
        })
    }

    pub(crate) fn into_parts(mut self) -> (HostProvenance, ResourcePolicy, T) {
        (
            self.provenance.clone(),
            self.approved_policy,
            self.transport
                .take()
                .expect("admission token is consumed once"),
        )
    }

    pub(crate) fn provenance(&self) -> &HostProvenance {
        &self.provenance
    }

    /// Explicitly report cleanup failures when a caller rejects admission
    /// after validation. The transport is consumed exactly once so `Drop`
    /// cannot perform an unobservable second cleanup attempt.
    pub(crate) fn cleanup_rejected(mut self) -> Result<(), io::ErrorKind> {
        let Some(mut transport) = self.transport.take() else {
            return Ok(());
        };
        request_and_reap(&mut transport, cleanup_deadline())
    }
}

impl<T: WorkerTransport> Drop for AdmissionAssessmentToken<T> {
    fn drop(&mut self) {
        if let Some(transport) = self.transport.as_mut() {
            request_and_reap(transport, cleanup_deadline());
        }
    }
}

/// One-use capability grants issued by the host permission broker for one
/// exact plugin, artifact, session, workspace, run, and generation.
pub struct HostAuthorization {
    provenance: HostProvenance,
    granted_capabilities: BTreeSet<String>,
    hostcall_rate_limiter: Arc<PluginHostcallRateLimiter>,
}

impl HostAuthorization {
    /// Bind permission-broker grants to host-resolved worker provenance.
    ///
    /// # Safety
    ///
    /// The caller must supply the current grant set returned by the host's
    /// permission broker for this exact provenance. It must not widen grants
    /// based on worker input or configuration that the broker has not
    /// approved. It must also pass the host-owned rate limiter shared by all
    /// sessions for this plugin identity; constructing a fresh limiter for
    /// each authorization would not enforce the per-plugin rate ceiling.
    pub unsafe fn from_permission_broker(
        provenance: HostProvenance,
        granted_capabilities: impl IntoIterator<Item = String>,
        hostcall_rate_limiter: Arc<PluginHostcallRateLimiter>,
    ) -> Result<Self, crate::ProtocolError> {
        if hostcall_rate_limiter.plugin_id != provenance.plugin_id() {
            return Err(crate::ProtocolError::HostcallLimiterIdentityMismatch);
        }
        Ok(Self {
            provenance,
            granted_capabilities: granted_capabilities.into_iter().collect(),
            hostcall_rate_limiter,
        })
    }

    pub(crate) fn into_parts(
        self,
    ) -> (
        HostProvenance,
        BTreeSet<String>,
        Arc<PluginHostcallRateLimiter>,
    ) {
        (
            self.provenance,
            self.granted_capabilities,
            self.hostcall_rate_limiter,
        )
    }
}

fn cleanup_deadline() -> Instant {
    Instant::now()
        + Duration::from_millis(APPROVED_RESOURCE_POLICY.forced_termination_reap_deadline_ms)
}

fn request_and_reap<T: WorkerTransport>(
    transport: &mut T,
    deadline: Instant,
) -> Result<(), io::ErrorKind> {
    transport.request_termination();
    transport
        .reap_until(deadline)
        .map_err(|error| error.kind())?;
    if Instant::now() >= deadline {
        return Err(io::ErrorKind::TimedOut);
    }
    Ok(())
}

#[cfg(test)]
pub(crate) struct SyntheticTestTransport;

#[cfg(test)]
impl DeadlineReader for SyntheticTestTransport {
    fn read_with_deadline(&mut self, _buffer: &mut [u8], _deadline: Instant) -> io::Result<usize> {
        Ok(0)
    }
}

#[cfg(test)]
unsafe impl WorkerTransport for SyntheticTestTransport {
    fn write_with_deadline(&mut self, _frame: &[u8], _deadline: Instant) -> io::Result<()> {
        Ok(())
    }

    fn request_termination(&mut self) {}

    fn reap_until(&mut self, _deadline: Instant) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn synthetic_test_token(
    provenance: HostProvenance,
) -> AdmissionAssessmentToken<SyntheticTestTransport> {
    synthetic_test_token_with_transport(provenance, SyntheticTestTransport)
}

#[cfg(test)]
pub(crate) fn synthetic_test_token_with_transport<T: WorkerTransport>(
    provenance: HostProvenance,
    transport: T,
) -> AdmissionAssessmentToken<T> {
    let assessment = unsafe {
        PlatformAssessment::from_adapter(
            provenance.clone(),
            APPROVED_RESOURCE_POLICY,
            REQUIRED_CONTROLS.iter().copied(),
        )
    };
    let worker = unsafe { AssessedWorker::from_adapter(assessment, transport) };
    AdmissionAssessmentToken::validate(worker, provenance)
        .expect("synthetic test assessment is complete")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provenance() -> HostProvenance {
        provenance_for_scope("session-fixture", "workspace-fixture", "run-fixture")
    }

    fn provenance_for_scope(session_id: &str, workspace_id: &str, run_id: &str) -> HostProvenance {
        HostProvenance::from_host_catalog(
            "fixture/plugin",
            "1.0.0",
            "a".repeat(64),
            "synthetic-catalog",
            crate::HostTrustLevel::Verified,
            session_id,
            workspace_id,
            run_id,
            1,
        )
        .unwrap()
    }

    fn all_controls() -> impl Iterator<Item = EnforcementControl> {
        REQUIRED_CONTROLS.iter().copied()
    }

    fn assessed_worker(
        provenance: HostProvenance,
        policy: ResourcePolicy,
        controls: impl IntoIterator<Item = EnforcementControl>,
    ) -> AssessedWorker<SyntheticTestTransport> {
        let assessment = unsafe { PlatformAssessment::from_adapter(provenance, policy, controls) };
        unsafe { AssessedWorker::from_adapter(assessment, SyntheticTestTransport) }
    }

    #[test]
    fn issues_a_one_use_token_only_for_complete_synthetic_controls() {
        let provenance = provenance();
        let worker = assessed_worker(provenance.clone(), APPROVED_RESOURCE_POLICY, all_controls());

        let token = AdmissionAssessmentToken::validate(worker, provenance.clone()).unwrap();

        assert_eq!(token.provenance, provenance);
        assert_eq!(token.approved_policy, APPROVED_RESOURCE_POLICY);
    }

    #[test]
    fn denies_an_assessment_with_any_unverified_control() {
        let provenance = provenance();
        for missing_control in all_controls() {
            let controls = all_controls().filter(|control| *control != missing_control);
            let worker = assessed_worker(provenance.clone(), APPROVED_RESOURCE_POLICY, controls);

            assert!(matches!(
                AdmissionAssessmentToken::validate(worker, provenance.clone()),
                Err(AdmissionError::RequiredControlNotAssessed(control))
                    if control == missing_control
            ));
        }
    }

    #[test]
    fn denies_each_policy_value_that_differs_from_the_frozen_policy() {
        let provenance = provenance();
        let mut policies = Vec::new();
        macro_rules! vary_field {
            ($field:ident) => {{
                let mut policy = APPROVED_RESOURCE_POLICY;
                policy.$field += 1;
                policies.push(policy);
                if APPROVED_RESOURCE_POLICY.$field > 0 {
                    let mut policy = APPROVED_RESOURCE_POLICY;
                    policy.$field -= 1;
                    policies.push(policy);
                }
            }};
        }
        vary_field!(max_artifact_bytes);
        vary_field!(max_ipc_frame_bytes);
        vary_field!(max_result_bytes);
        vary_field!(max_stdout_bytes_per_invocation);
        vary_field!(max_stderr_bytes_per_invocation);
        vary_field!(max_wasm_memory_bytes);
        vary_field!(max_helper_rss_bytes);
        vary_field!(max_total_helper_rss_bytes);
        vary_field!(wasmtime_fuel_per_invocation);
        vary_field!(wasmtime_fuel_per_plugin_minute);
        vary_field!(cpu_basis_points_of_one_core);
        vary_field!(handshake_timeout_ms);
        vary_field!(startup_timeout_ms);
        vary_field!(execution_timeout_ms);
        vary_field!(lifecycle_timeout_ms);
        vary_field!(broker_timeout_ms);
        vary_field!(cooperative_cancel_grace_ms);
        vary_field!(forced_termination_reap_deadline_ms);
        vary_field!(max_hostcalls_per_invocation);
        vary_field!(max_hostcalls_per_plugin_second);
        vary_field!(max_pending_requests);
        vary_field!(max_helpers_per_plugin);
        vary_field!(max_helpers_per_application);
        vary_field!(max_guest_child_processes);
        vary_field!(max_kernel_handles_or_file_descriptors);
        assert_eq!(policies.len(), 49);

        for policy in policies {
            let worker = assessed_worker(provenance.clone(), policy, all_controls());
            assert!(matches!(
                AdmissionAssessmentToken::validate(worker, provenance.clone()),
                Err(AdmissionError::PolicyDiffersFromApproved)
            ));
        }
    }

    #[test]
    fn denies_assessment_bound_to_another_session_workspace_or_run() {
        for (session_id, workspace_id, run_id) in [
            ("other-session", "workspace-fixture", "run-fixture"),
            ("session-fixture", "other-workspace", "run-fixture"),
            ("session-fixture", "workspace-fixture", "other-run"),
        ] {
            let worker = assessed_worker(
                provenance_for_scope(session_id, workspace_id, run_id),
                APPROVED_RESOURCE_POLICY,
                all_controls(),
            );

            assert!(matches!(
                AdmissionAssessmentToken::validate(worker, provenance()),
                Err(AdmissionError::ProvenanceMismatch)
            ));
        }
    }
}
