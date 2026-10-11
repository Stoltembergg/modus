//! One-use admission assessments for future platform workers.
//!
//! This module validates a host-side platform assessment, but it does not
//! implement or prove operating-system enforcement. No production adapter
//! currently implements [`PlatformAssessmentSource`], so no production caller
//! can mint an admission token and external worker execution remains
//! unavailable.
//!
//! An admission token is bound to host-owned artifact and run provenance,
//! carries the approved policy snapshot, and can only be issued after all
//! required controls and the frozen policy pass validation. It is consumed by
//! one dispatcher, but it is not bound to a process handle or IPC stream. The
//! future platform supervisor must own that binding and route all traffic
//! through the dispatcher before this API can authorize production execution.
//!
//! ```compile_fail
//! use modus_plugin_execution_protocol::{Dispatcher, HostProvenance, HostTrustLevel};
//! let provenance = HostProvenance::from_host_catalog(
//!     "plugin", "1.0.0", "0".repeat(64), "catalog", HostTrustLevel::Verified,
//!     "session", "workspace", "run", 1,
//! ).unwrap();
//! // Provenance alone is not enough to create a worker dispatcher.
//! let _dispatcher = Dispatcher::new("0".repeat(64), provenance, Vec::<String>::new());
//! ```
//!
//! ```compile_fail
//! use modus_plugin_execution_protocol::{HostProvenance};
//! use modus_plugin_execution_protocol::worker_admission::{
//!     AdmissionError, PlatformAssessment, PlatformAssessmentSource,
//! };
//! struct CallerClaimedAdapter;
//! impl PlatformAssessmentSource for CallerClaimedAdapter {
//!     fn assess_started_worker(
//!         self,
//!         _: &HostProvenance,
//!     ) -> Result<PlatformAssessment, AdmissionError>
//!     where Self: Sized {
//!         todo!()
//!     }
//! }
//! ```
//!
//! ```compile_fail
//! use modus_plugin_execution_protocol::worker_admission::AdmissionAssessmentToken;
//! fn require_clone<T: Clone>() {}
//! fn main() { require_clone::<AdmissionAssessmentToken>(); }
//! ```
//!
//! ```compile_fail
//! use modus_plugin_execution_protocol::{Dispatcher, worker_admission::AdmissionAssessmentToken};
//! fn dispatch_twice(token: AdmissionAssessmentToken) {
//!     let _ = Dispatcher::new(token, "a".repeat(64), Vec::<String>::new());
//!     let _ = Dispatcher::new(token, "a".repeat(64), Vec::<String>::new());
//! }
//! ```

use std::collections::BTreeSet;

use crate::HostProvenance;
use crate::resource_policy::{APPROVED_RESOURCE_POLICY, ResourcePolicy};

mod sealed {
    pub trait Sealed {}
}

/// A platform adapter that has already created a worker and assessed its
/// effective policy before any artifact bytes were transferred.
///
/// Implementations are sealed to this crate. A platform adapter must not
/// implement this contract by reporting configured values alone: it must
/// inspect the active OS policy, readiness, and termination path. This
/// assessment interface is not itself proof of those OS properties.
#[allow(private_bounds)]
pub trait PlatformAssessmentSource: sealed::Sealed {
    fn assess_started_worker(
        self,
        expected_provenance: &HostProvenance,
    ) -> Result<PlatformAssessment, AdmissionError>
    where
        Self: Sized;
}

/// Required control categories in the approved worker contract. A single list
/// defines both the enum and the required set to prevent a new category from
/// silently being omitted by the validator.
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

/// Adapter-supplied assessment. Its constructor is crate-private; it is not a
/// guest message and has no serialization format. The assessed control list
/// is only as reliable as the sealed adapter implementation.
#[derive(Debug, Eq, PartialEq)]
pub struct PlatformAssessment {
    provenance: HostProvenance,
    assessed_policy: ResourcePolicy,
    assessed_controls: BTreeSet<EnforcementControl>,
}

impl PlatformAssessment {
    pub(crate) fn from_adapter(
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

/// Rejection reason for an incomplete or inconsistent platform assessment.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdmissionError {
    AdapterUnavailable,
    ProvenanceMismatch,
    PolicyDiffersFromApproved,
    RequiredControlNotAssessed(EnforcementControl),
}

/// Opaque, one-use token for a validated adapter assessment. There is no
/// public constructor, Clone implementation, or deserializer. It does not own
/// or identify an OS process or IPC stream.
#[derive(Debug, Eq, PartialEq)]
pub struct AdmissionAssessmentToken {
    provenance: HostProvenance,
    approved_policy: ResourcePolicy,
}

impl AdmissionAssessmentToken {
    /// Validate an adapter assessment and mint a single-dispatcher token. The
    /// adapter must establish its platform controls before transferring any
    /// artifact bytes; this API cannot independently prove the adapter's OS
    /// calls or bind the token to a worker stream.
    pub fn validate_from_adapter<A: PlatformAssessmentSource>(
        adapter: A,
        provenance: HostProvenance,
    ) -> Result<Self, AdmissionError> {
        let assessment = adapter.assess_started_worker(&provenance)?;
        if assessment.provenance != provenance {
            return Err(AdmissionError::ProvenanceMismatch);
        }
        // Until Dispatcher and the codec enforce variable limits, accepting
        // tighter values would record a policy that is not actually applied.
        if assessment.assessed_policy != APPROVED_RESOURCE_POLICY {
            return Err(AdmissionError::PolicyDiffersFromApproved);
        }
        for &control in REQUIRED_CONTROLS {
            if !assessment.assessed_controls.contains(&control) {
                return Err(AdmissionError::RequiredControlNotAssessed(control));
            }
        }
        Ok(Self {
            provenance: assessment.provenance,
            approved_policy: APPROVED_RESOURCE_POLICY,
        })
    }

    pub fn approved_policy(&self) -> ResourcePolicy {
        self.approved_policy
    }

    pub(crate) fn into_parts(self) -> (HostProvenance, ResourcePolicy) {
        (self.provenance, self.approved_policy)
    }
}

#[cfg(test)]
pub(crate) fn synthetic_test_token(provenance: HostProvenance) -> AdmissionAssessmentToken {
    AdmissionAssessmentToken {
        provenance,
        approved_policy: APPROVED_RESOURCE_POLICY,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct SyntheticAdapter(PlatformAssessment);

    impl sealed::Sealed for SyntheticAdapter {}

    impl PlatformAssessmentSource for SyntheticAdapter {
        fn assess_started_worker(
            self,
            _expected_provenance: &HostProvenance,
        ) -> Result<PlatformAssessment, AdmissionError> {
            Ok(self.0)
        }
    }

    fn provenance() -> HostProvenance {
        provenance_for("session-fixture", "run-fixture")
    }

    fn provenance_for(session_id: &str, run_id: &str) -> HostProvenance {
        provenance_for_scope(session_id, "workspace-fixture", run_id)
    }

    fn provenance_for_scope(
        session_id: &str,
        workspace_id: &str,
        run_id: &str,
    ) -> HostProvenance {
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

    fn adapter(
        provenance: HostProvenance,
        policy: ResourcePolicy,
        controls: impl IntoIterator<Item = EnforcementControl>,
    ) -> SyntheticAdapter {
        SyntheticAdapter(PlatformAssessment::from_adapter(provenance, policy, controls))
    }

    #[test]
    fn issues_a_one_use_assessment_token_only_for_complete_synthetic_controls() {
        let provenance = provenance();
        let adapter = adapter(
            provenance.clone(),
            APPROVED_RESOURCE_POLICY,
            all_controls(),
        );

        let token =
            AdmissionAssessmentToken::validate_from_adapter(adapter, provenance.clone()).unwrap();

        assert_eq!(token.provenance, provenance);
        assert_eq!(token.approved_policy(), APPROVED_RESOURCE_POLICY);
    }

    #[test]
    fn denies_an_assessment_with_any_unverified_control() {
        let provenance = provenance();
        for missing_control in all_controls() {
            let controls = all_controls().filter(|control| *control != missing_control);
            let adapter = adapter(provenance.clone(), APPROVED_RESOURCE_POLICY, controls);

            assert_eq!(
                AdmissionAssessmentToken::validate_from_adapter(adapter, provenance.clone()),
                Err(AdmissionError::RequiredControlNotAssessed(missing_control)),
                "missing {missing_control:?} must deny admission",
            );
        }
    }

    #[test]
    fn denies_each_policy_value_that_differs_from_the_frozen_policy() {
        let provenance = provenance();
        let mut policies_over_ceiling = Vec::new();
        macro_rules! vary_field {
            ($field:ident) => {{
                let mut policy = APPROVED_RESOURCE_POLICY;
                policy.$field += 1;
                policies_over_ceiling.push(policy);
                if APPROVED_RESOURCE_POLICY.$field > 0 {
                    let mut policy = APPROVED_RESOURCE_POLICY;
                    policy.$field -= 1;
                    policies_over_ceiling.push(policy);
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
        assert_eq!(policies_over_ceiling.len(), 49);

        for effective_policy in policies_over_ceiling {
            let adapter = adapter(
                provenance.clone(),
                effective_policy,
                all_controls(),
            );
            assert_eq!(AdmissionAssessmentToken::validate_from_adapter(adapter, provenance.clone()),
                Err(AdmissionError::PolicyDiffersFromApproved));
        }
    }

    #[test]
    fn denies_assessment_bound_to_another_session_workspace_or_run() {
        for (session_id, workspace_id, run_id) in [
            ("other-session", "workspace-fixture", "run-fixture"),
            ("session-fixture", "other-workspace", "run-fixture"),
            ("session-fixture", "workspace-fixture", "other-run"),
        ] {
            let adapter = adapter(
                provenance_for_scope(session_id, workspace_id, run_id),
                APPROVED_RESOURCE_POLICY,
                all_controls(),
            );

            assert_eq!(
                AdmissionAssessmentToken::validate_from_adapter(adapter, provenance()),
                Err(AdmissionError::ProvenanceMismatch),
            );
        }
    }
}
