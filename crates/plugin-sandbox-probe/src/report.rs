use serde::{Deserialize, Serialize};

pub const MAX_REPORT_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ProbeScenario {
    CpuLoop,
    MemoryBomb,
    WallClockTimeout,
    ChildProcessTree,
    HardKill,
    ReapDeadline,
    HandleLimit,
    ProcessLimit,
}

impl ProbeScenario {
    pub const ALL: [Self; 8] = [
        Self::CpuLoop,
        Self::MemoryBomb,
        Self::WallClockTimeout,
        Self::ChildProcessTree,
        Self::HardKill,
        Self::ReapDeadline,
        Self::HandleLimit,
        Self::ProcessLimit,
    ];
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScenarioStatus {
    Passed,
    Failed,
    NotTested,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EnforcementState {
    NotTested,
    Unsupported,
    Configured,
    Verified,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ScenarioResult {
    pub scenario: ProbeScenario,
    pub status: ScenarioStatus,
    pub required_policy: String,
    pub mechanism: Option<String>,
    pub effective_policy_verified: bool,
    pub enforcement: EnforcementState,
    pub raw_os_error: Option<u32>,
    pub challenge_observed: bool,
    pub independent_evidence: Option<String>,
    pub enforcement_attributed: bool,
    pub rss_enforced: bool,
    pub worker_terminated: bool,
    pub job_empty: bool,
    pub worker_wait_completed: bool,
    pub tree_wait_completed: bool,
    pub stop_to_reap_ms: Option<u64>,
    pub kill_to_reap_ms: Option<u64>,
    #[serde(default)]
    pub launch: Option<LaunchEvidence>,
    #[serde(default)]
    pub policy: Option<PolicyEvidence>,
    #[serde(default)]
    pub challenge: Option<ChallengeEvidence>,
    #[serde(default)]
    pub termination: Option<TerminationEvidence>,
    #[serde(default)]
    pub exit: Option<ExitEvidence>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub process_count: Option<ProcessCountEvidence>,
    #[serde(default)]
    pub reap: Option<ReapEvidence>,
    #[serde(default)]
    pub child: Option<ChildEvidence>,
    #[serde(default)]
    pub timing: Option<CaseTiming>,
    #[serde(default)]
    pub initiating_operation_error: Option<OperationError>,
    #[serde(default)]
    pub cleanup_errors: Vec<OperationError>,
    #[serde(default)]
    pub resource_telemetry: Option<ResourceTelemetry>,
    #[serde(default)]
    pub hard_general_handle_enforcement: bool,
    #[serde(default)]
    pub process_limit: Option<ProcessLimitEvidence>,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CaseTiming {
    #[serde(default)]
    pub overall_deadline_ms: Option<u64>,
    #[serde(default)]
    pub setup_deadline_ms: Option<u64>,
    #[serde(default)]
    pub handshake_deadline_ms: Option<u64>,
    #[serde(default)]
    pub work_deadline_ms: Option<u64>,
    #[serde(default)]
    pub cleanup_deadline_ms: Option<u64>,
    #[serde(default)]
    pub child_ready_ms: Option<u64>,
    pub resume_ms: Option<u64>,
    pub ready_ms: Option<u64>,
    pub observation_ms: Option<u64>,
    pub scheduled_stop_ms: Option<u64>,
    pub termination_call_ms: Option<u64>,
    pub worker_wait_ms: Option<u64>,
    pub tree_wait_ms: Option<u64>,
    pub empty_job_ms: Option<u64>,
    pub all_handles_closed_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperationStage {
    CreateJob,
    ConfigureJob,
    QueryJob,
    AssociateCompletionPort,
    CreatePipe,
    ReadPipe,
    WritePipe,
    CreateProcess,
    AssignProcess,
    ResumeThread,
    Ipc,
    QueryJobAccounting,
    TerminateJobObject,
    WaitProcess,
    WaitJob,
    CloseHandle,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OperationError {
    pub stage: OperationStage,
    pub reported_os_error: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResourceTelemetry {
    pub allocated_bytes: Option<u64>,
    pub touched_bytes: Option<u64>,
    pub private_commit_bytes: Option<u64>,
    pub working_set_bytes: Option<u64>,
    pub opened_handles: Option<u32>,
    pub observed_handle_count: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProcessLimitEvidence {
    pub configured_active_process_limit: Option<u32>,
    pub queried_active_process_limit: Option<u32>,
    #[serde(default)]
    pub fresh_job: bool,
    #[serde(default)]
    pub completion_port_associated: bool,
    #[serde(default)]
    pub completion_key_matches: bool,
    #[serde(default)]
    pub active_process_limit_event_observed: bool,
    #[serde(default)]
    pub null_overlapped_confirmed: bool,
    pub spawn_attempt_count: Option<u32>,
    #[serde(default)]
    pub spawn_attempted: bool,
    pub spawn_succeeded: Option<bool>,
    pub reported_spawn_os_error: Option<u32>,
    pub total_terminated_before_attempt: Option<u32>,
    pub total_terminated_after_attempt_before_termination: Option<u32>,
    pub active_before_attempt: Option<u32>,
    pub active_after_attempt_before_termination: Option<u32>,
    #[serde(default)]
    pub stable_root_only_membership: bool,
    #[serde(default)]
    pub active_member_samples: Vec<u32>,
    #[serde(default)]
    pub pre_execution_denial_semantics_proven_applicable: bool,
    #[serde(default)]
    pub ancestor_job_policy_resolved: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LaunchEvidence {
    pub created_suspended: bool,
    pub job_assigned_before_resume: bool,
    pub membership_verified: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PolicyEvidence {
    pub configured: Option<String>,
    pub queried: Option<String>,
    pub effective_verified: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ChallengeEvidence {
    pub kind: String,
    pub observed: bool,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TerminationEvidence {
    pub method: String,
    pub requested: bool,
    pub raw_os_error: Option<u32>,
    #[serde(default)]
    pub requested_exit_code: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ExitEvidence {
    pub worker_exit_code: Option<u32>,
    pub worker_wait_completed: bool,
    pub tree_wait_completed: bool,
    #[serde(default)]
    pub child_exit_code: Option<u32>,
    #[serde(default)]
    pub child_wait_completed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ChildEvidence {
    pub ready: bool,
    pub pid: Option<u32>,
    #[serde(default)]
    pub root_pid: Option<u32>,
    pub membership_verified: bool,
    pub process_handle_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProcessCountEvidence {
    pub active_before: Option<u32>,
    pub active_after: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ReapEvidence {
    pub stop_to_reap_ms: Option<u64>,
    pub kill_to_reap_ms: Option<u64>,
    pub deadline_ms: u64,
    pub tree_wait_completed: bool,
    #[serde(default)]
    pub all_handles_closed: bool,
    #[serde(default)]
    pub job_handle_closed: bool,
}

impl ScenarioResult {
    pub fn not_tested(scenario: ProbeScenario) -> Self {
        Self {
            scenario,
            status: ScenarioStatus::NotTested,
            required_policy: required_policy(scenario).into(),
            mechanism: None,
            effective_policy_verified: false,
            enforcement: EnforcementState::NotTested,
            raw_os_error: None,
            challenge_observed: false,
            independent_evidence: None,
            enforcement_attributed: false,
            rss_enforced: false,
            worker_terminated: false,
            job_empty: false,
            worker_wait_completed: false,
            tree_wait_completed: false,
            stop_to_reap_ms: None,
            kill_to_reap_ms: None,
            launch: None,
            policy: None,
            challenge: None,
            termination: None,
            exit: None,
            duration_ms: None,
            process_count: None,
            reap: None,
            child: None,
            timing: None,
            initiating_operation_error: None,
            cleanup_errors: Vec::new(),
            resource_telemetry: None,
            hard_general_handle_enforcement: false,
            process_limit: None,
            reason: "scenario not run; no unsandboxed fallback".into(),
        }
    }
}

fn required_policy(scenario: ProbeScenario) -> &'static str {
    match scenario {
        ProbeScenario::CpuLoop => "25% of one logical core hard Job CPU rate",
        ProbeScenario::MemoryBomb => "256 MiB process RSS hard limit",
        ProbeScenario::WallClockTimeout => "10 second work deadline; 2 second reap deadline",
        ProbeScenario::ChildProcessTree => "Job membership for diagnostic multi-process tree",
        ProbeScenario::HardKill => "TerminateJobObject kills live worker tree",
        ProbeScenario::ReapDeadline => "live worker tree reaped within 2 seconds",
        ProbeScenario::HandleLimit => "64 general kernel handles hard limit",
        ProbeScenario::ProcessLimit => "ActiveProcessLimit=1 blocks child execution",
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum Verdict {
    #[serde(rename = "NO_GO")]
    NoGo,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckOutcome {
    Denied,
    Allowed,
    Error,
    NotRun,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuotaState {
    Enforced,
    MeasuredOnly,
    Unsupported,
    Unavailable,
    NotTested,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProbeChecks {
    pub protected_path_read: CheckOutcome,
    pub protected_path_write: CheckOutcome,
    pub loopback_connect: CheckOutcome,
    pub child_spawn: CheckOutcome,
    pub environment: CheckOutcome,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProbeQuotas {
    pub memory: QuotaState,
    pub duration: QuotaState,
    pub handles: QuotaState,
    pub cpu_rate: QuotaState,
    pub processes: QuotaState,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProbeReport {
    pub schema_version: u8,
    pub verdict: Verdict,
    audit_findings_closed: bool,
    plugin_bytes_received: bool,
    pub os: String,
    pub architecture: String,
    pub checks: ProbeChecks,
    pub quotas: ProbeQuotas,
    pub evidence: Vec<String>,
    pub process_tree_empty: bool,
    pub termination_evidence: String,
    pub platform_probe_status: ScenarioStatus,
    pub scenarios: Vec<ScenarioResult>,
}

impl ProbeReport {
    pub fn not_tested(os: impl Into<String>, architecture: impl Into<String>) -> Self {
        Self {
            schema_version: 2,
            verdict: Verdict::NoGo,
            audit_findings_closed: false,
            plugin_bytes_received: false,
            os: os.into(),
            architecture: architecture.into(),
            checks: ProbeChecks {
                protected_path_read: CheckOutcome::NotRun,
                protected_path_write: CheckOutcome::NotRun,
                loopback_connect: CheckOutcome::NotRun,
                child_spawn: CheckOutcome::NotRun,
                environment: CheckOutcome::NotRun,
            },
            quotas: ProbeQuotas {
                memory: QuotaState::NotTested,
                duration: QuotaState::NotTested,
                handles: QuotaState::NotTested,
                cpu_rate: QuotaState::NotTested,
                processes: QuotaState::NotTested,
            },
            evidence: vec!["feasibility harness only; platform checks not tested".into()],
            process_tree_empty: false,
            termination_evidence: "not tested".into(),
            platform_probe_status: ScenarioStatus::NotTested,
            scenarios: ProbeScenario::ALL
                .into_iter()
                .map(ScenarioResult::not_tested)
                .collect(),
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 2 {
            return Err("unsupported report schema version".into());
        }
        if self.scenarios.len() != ProbeScenario::ALL.len() {
            return Err("report must contain exactly eight scenario results".into());
        }
        for expected in ProbeScenario::ALL {
            if self
                .scenarios
                .iter()
                .filter(|r| r.scenario == expected)
                .count()
                != 1
            {
                return Err("report scenarios must be complete and unique".into());
            }
        }
        for result in &self.scenarios {
            if result.required_policy.len() > 256
                || result.reason.len() > 4096
                || result.mechanism.as_ref().is_some_and(|v| v.len() > 256)
                || result
                    .independent_evidence
                    .as_ref()
                    .is_some_and(|v| v.len() > 4096)
            {
                return Err("scenario field exceeds configured bound".into());
            }
            if result.cleanup_errors.len() > 16 {
                return Err("scenario cleanup error count exceeds configured bound".into());
            }
            if result.status == ScenarioStatus::Passed {
                if !result.challenge_observed
                    || !result.effective_policy_verified
                    || result.enforcement != EnforcementState::Verified
                    || !result.enforcement_attributed
                    || !result.worker_terminated
                    || !result.job_empty
                    || !result.worker_wait_completed
                    || !result.tree_wait_completed
                    || result.stop_to_reap_ms.is_none()
                    || result.kill_to_reap_ms.is_none()
                    || result.stop_to_reap_ms.unwrap_or(u64::MAX) > 2_000
                    || result.kill_to_reap_ms.unwrap_or(u64::MAX) > 2_000
                    || result.independent_evidence.is_none()
                    || result.mechanism.is_none()
                    || result.launch.as_ref().is_none_or(|v| {
                        !v.created_suspended
                            || !v.job_assigned_before_resume
                            || !v.membership_verified
                    })
                    || result.policy.as_ref().is_none_or(|v| {
                        !v.effective_verified || v.configured.is_none() || v.queried.is_none()
                    })
                    || result.challenge.as_ref().is_none_or(|v| !v.observed)
                    || result.termination.as_ref().is_none_or(|v| !v.requested)
                    || result.exit.as_ref().is_none_or(|v| {
                        !v.worker_wait_completed
                            || !v.tree_wait_completed
                            || v.worker_exit_code.is_none()
                    })
                    || result.duration_ms.is_none()
                    || result
                        .process_count
                        .as_ref()
                        .is_none_or(|v| v.active_before.is_none() || v.active_after != Some(0))
                    || result.reap.as_ref().is_none_or(|v| {
                        !v.tree_wait_completed
                            || v.kill_to_reap_ms.is_none_or(|ms| ms > v.deadline_ms)
                            || v.stop_to_reap_ms.is_none_or(|ms| ms > v.deadline_ms)
                    })
                    || (result.scenario == ProbeScenario::MemoryBomb && !result.rss_enforced)
                {
                    return Err(
                        "passed scenario lacks required enforcement and reap evidence".into(),
                    );
                }
                if result.scenario == ProbeScenario::ChildProcessTree {
                    let exit = result.exit.as_ref().unwrap();
                    let termination = result.termination.as_ref().unwrap();
                    let process_count = result.process_count.as_ref().unwrap();
                    let reap = result.reap.as_ref().unwrap();
                    let timing_matches = result.stop_to_reap_ms == reap.stop_to_reap_ms
                        && result.kill_to_reap_ms == reap.kill_to_reap_ms
                        && result.stop_to_reap_ms == result.kill_to_reap_ms;
                    if result.child.as_ref().is_none_or(|v| {
                        !v.ready
                            || v.pid.is_none_or(|pid| pid == 0)
                            || v.root_pid.is_none_or(|pid| pid == 0 || Some(pid) == v.pid)
                            || !v.membership_verified
                            || !v.process_handle_retained
                    }) || process_count.active_before != Some(2)
                        || !exit.child_wait_completed
                        || exit.child_exit_code.is_none()
                        || exit.worker_exit_code != termination.requested_exit_code
                        || exit.child_exit_code != termination.requested_exit_code
                        || termination.raw_os_error.is_some()
                        || !termination.requested
                        || termination.method != "terminate_job_object"
                        || termination.method.trim().is_empty()
                        || termination.requested_exit_code.is_none()
                        || result
                            .mechanism
                            .as_deref()
                            .is_none_or(|value| value.trim().is_empty())
                        || result
                            .independent_evidence
                            .as_deref()
                            .is_none_or(|value| value.trim().is_empty())
                        || reap.deadline_ms != 2_000
                        || !reap.all_handles_closed
                        || !reap.job_handle_closed
                        || !timing_matches
                    {
                        return Err("passed child-tree scenario lacks consistent child identity, termination, or complete bounded cleanup evidence".into());
                    }
                } else if matches!(
                    result.scenario,
                    ProbeScenario::HardKill | ProbeScenario::ReapDeadline
                ) {
                    let exit = result.exit.as_ref().unwrap();
                    let termination = result.termination.as_ref().unwrap();
                    let process_count = result.process_count.as_ref().unwrap();
                    let reap = result.reap.as_ref().unwrap();
                    if result.child.as_ref().is_none_or(|child| {
                        !child.ready
                            || child.pid.is_none_or(|pid| pid == 0)
                            || child
                                .root_pid
                                .is_none_or(|pid| pid == 0 || Some(pid) == child.pid)
                            || !child.membership_verified
                            || !child.process_handle_retained
                    }) || process_count.active_before != Some(2)
                        || process_count.active_after != Some(0)
                        || !exit.child_wait_completed
                        || exit.worker_exit_code != termination.requested_exit_code
                        || exit.child_exit_code != termination.requested_exit_code
                        || termination.method != "terminate_job_object"
                        || termination.raw_os_error.is_some()
                        || termination.requested_exit_code.is_none()
                        || result.cleanup_errors.len() > 16
                        || !result.cleanup_errors.is_empty()
                        || result.initiating_operation_error.is_some()
                        || reap.deadline_ms != 2_000
                        || !reap.all_handles_closed
                        || !reap.job_handle_closed
                        || !new_case_timing_and_reap_valid(result)
                        || result.stop_to_reap_ms != reap.stop_to_reap_ms
                        || result.kill_to_reap_ms != reap.kill_to_reap_ms
                        || result
                            .timing
                            .as_ref()
                            .is_none_or(|timing| !timing_is_valid(result.scenario, timing))
                        || result
                            .mechanism
                            .as_deref()
                            .is_none_or(|value| value.trim().is_empty())
                        || result
                            .independent_evidence
                            .as_deref()
                            .is_none_or(|value| value.trim().is_empty())
                    {
                        return Err("passed tree scenario lacks complete root/child termination and cleanup evidence".into());
                    }
                } else {
                    let exit = result.exit.as_ref().unwrap();
                    let termination = result.termination.as_ref().unwrap();
                    let reap = result.reap.as_ref().unwrap();
                    if !reap.all_handles_closed
                        || !reap.job_handle_closed
                        || result.process_count.as_ref().and_then(|v| v.active_after) != Some(0)
                        || !exit.worker_wait_completed
                        || !exit.tree_wait_completed
                        || !termination.requested
                        || termination.method != "terminate_job_object"
                        || termination.raw_os_error.is_some()
                        || termination.requested_exit_code.is_none()
                        || exit.worker_exit_code != termination.requested_exit_code
                        || exit.child_exit_code.is_some()
                        || !result.cleanup_errors.is_empty()
                        || result.initiating_operation_error.is_some()
                        || result
                            .timing
                            .as_ref()
                            .is_none_or(|timing| !timing_is_valid(result.scenario, timing))
                        || !new_case_timing_and_reap_valid(result)
                    {
                        return Err(
                            "passed scenario lacks complete timed termination and cleanup evidence"
                                .into(),
                        );
                    }
                    if result.scenario == ProbeScenario::HandleLimit
                        && !result.hard_general_handle_enforcement
                    {
                        return Err(
                            "handle-limit pass requires hard general-handle enforcement".into()
                        );
                    }
                    if result.scenario == ProbeScenario::ProcessLimit
                        && result.process_limit.as_ref().is_none_or(|e| {
                            e.configured_active_process_limit != Some(1)
                                || e.queried_active_process_limit != Some(1)
                                || !e.fresh_job
                                || !e.completion_port_associated
                                || !e.completion_key_matches
                                || !e.active_process_limit_event_observed
                                || !e.null_overlapped_confirmed
                                || e.spawn_attempt_count != Some(1)
                                || !e.spawn_attempted
                                || e.spawn_succeeded != Some(false)
                                || e.total_terminated_before_attempt.is_none()
                                || e.total_terminated_after_attempt_before_termination
                                    .zip(e.total_terminated_before_attempt)
                                    .is_none_or(|(after, before)| after <= before)
                                || e.active_before_attempt != Some(1)
                                || e.active_after_attempt_before_termination != Some(1)
                                || !e.stable_root_only_membership
                                || e.active_member_samples.len() < 2
                                || e.active_member_samples.len() > 8
                                || e.active_member_samples.iter().any(|n| *n != 1)
                                || !e.pre_execution_denial_semantics_proven_applicable
                                || !e.ancestor_job_policy_resolved
                        })
                    {
                        return Err(
                            "passed process-limit scenario lacks correlated attribution evidence"
                                .into(),
                        );
                    }
                }
                if result.scenario == ProbeScenario::CpuLoop
                    && self.os.trim().eq_ignore_ascii_case("windows")
                {
                    return Err("Windows cpu_loop pass is blocked pending approved calibration and parent-Job contract".into());
                }
            }
        }
        let all_passed = self
            .scenarios
            .iter()
            .all(|r| r.status == ScenarioStatus::Passed);
        if self.platform_probe_status == ScenarioStatus::Passed && !all_passed {
            return Err("platform probe cannot pass unless all scenarios pass".into());
        }
        if self.verdict != Verdict::NoGo || self.audit_findings_closed || self.plugin_bytes_received
        {
            return Err("diagnostic release invariants violated".into());
        }
        if self.audit_findings_closed || self.plugin_bytes_received {
            return Err("feasibility report invariants violated".into());
        }
        if self.os.len() > 64
            || self.architecture.len() > 64
            || self.termination_evidence.len() > 4096
            || self.evidence.len() > 128
            || self.evidence.iter().any(|entry| entry.len() > 4096)
        {
            return Err("report field exceeds configured bound".into());
        }
        if serde_json::to_vec(self)
            .map_err(|error| error.to_string())?
            .len()
            > MAX_REPORT_BYTES
        {
            return Err("serialized report exceeds output limit".into());
        }
        Ok(())
    }
}

fn timing_is_valid(scenario: ProbeScenario, timing: &CaseTiming) -> bool {
    let (
        Some(resume),
        Some(ready),
        Some(observation),
        Some(stop),
        Some(termination),
        Some(worker_wait),
        Some(tree_wait),
        Some(empty_job),
        Some(handles_closed),
    ) = (
        timing.resume_ms,
        timing.ready_ms,
        timing.observation_ms,
        timing.scheduled_stop_ms,
        timing.termination_call_ms,
        timing.worker_wait_ms,
        timing.tree_wait_ms,
        timing.empty_job_ms,
        timing.all_handles_closed_ms,
    )
    else {
        return false;
    };
    let (
        Some(overall_deadline),
        Some(setup_deadline),
        Some(handshake_deadline),
        Some(cleanup_deadline),
    ) = (
        timing.overall_deadline_ms,
        timing.setup_deadline_ms,
        timing.handshake_deadline_ms,
        timing.cleanup_deadline_ms,
    )
    else {
        return false;
    };
    let expected_cleanup = stop.saturating_add(2_000).min(overall_deadline);
    if overall_deadline != 25_000
        || setup_deadline != 3_000
        || handshake_deadline != 13_000
        || cleanup_deadline != expected_cleanup
        || resume > setup_deadline
        || ready > handshake_deadline
        || observation > handshake_deadline
        || stop < observation
        || stop > overall_deadline
        || termination > overall_deadline
        || worker_wait > overall_deadline
        || tree_wait > overall_deadline
        || empty_job > overall_deadline
        || handles_closed > overall_deadline
        || ready < resume
        || observation < ready
        || termination < stop
        || worker_wait < termination
        || tree_wait < worker_wait
        || empty_job < tree_wait
        || handles_closed < empty_job
        || termination > cleanup_deadline
        || worker_wait > cleanup_deadline
        || tree_wait > cleanup_deadline
        || empty_job > cleanup_deadline
        || handles_closed > cleanup_deadline
    {
        return false;
    }
    if scenario == ProbeScenario::WallClockTimeout {
        timing.work_deadline_ms == Some(observation.saturating_add(10_000))
            && stop == observation.saturating_add(10_000)
    } else {
        timing.work_deadline_ms.is_none()
            && (!matches!(
                scenario,
                ProbeScenario::HardKill | ProbeScenario::ReapDeadline
            ) || timing.child_ready_ms.is_some_and(|ready| {
                ready >= observation && ready <= handshake_deadline && ready <= stop
            }))
    }
}

fn new_case_timing_and_reap_valid(result: &ScenarioResult) -> bool {
    let Some(timing) = result.timing.as_ref() else {
        return false;
    };
    let Some(duration) = result.duration_ms else {
        return false;
    };
    let Some(overall) = timing.overall_deadline_ms else {
        return false;
    };
    let Some(stop) = timing.scheduled_stop_ms else {
        return false;
    };
    let Some(termination) = timing.termination_call_ms else {
        return false;
    };
    let Some(closed) = timing.all_handles_closed_ms else {
        return false;
    };
    let Some(stop_reap) = closed.checked_sub(stop) else {
        return false;
    };
    let Some(kill_reap) = closed.checked_sub(termination) else {
        return false;
    };
    let Some(reap) = result.reap.as_ref() else {
        return false;
    };
    duration >= closed
        && duration <= overall
        && result.stop_to_reap_ms == Some(stop_reap)
        && result.kill_to_reap_ms == Some(kill_reap)
        && reap.stop_to_reap_ms == Some(stop_reap)
        && reap.kill_to_reap_ms == Some(kill_reap)
}

pub fn serialize_bounded(report: &ProbeReport) -> Result<String, String> {
    report.validate()?;
    let json = serde_json::to_string(report).map_err(|error| error.to_string())?;
    if json.len() > MAX_REPORT_BYTES {
        return Err("serialized report exceeds output limit".into());
    }
    Ok(json)
}
