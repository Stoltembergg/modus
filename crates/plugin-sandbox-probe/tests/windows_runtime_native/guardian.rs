use serde::{Deserialize, Serialize};

use crate::ownership::{self, QpcOrigin, QpcSchedule};

pub(super) const GUARDIAN_PROTOCOL_VERSION: u16 = 1;
pub(super) const MAX_GUARDIAN_FRAME_BYTES: usize = 4096;
const PREFIX_BYTES: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(super) enum SetupFailurePoint {
    CreateJob,
    CreateAttributeList,
    OperationDeadline,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(super) enum ValidationMismatch {
    ProcessLimit,
    MemoryLimit,
    UiRestrictions,
    HandleLimit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "detail", deny_unknown_fields)]
pub(super) enum GuardianCase {
    SetupFailure(SetupFailurePoint),
    ValidationMismatch(ValidationMismatch),
}

impl GuardianCase {
    fn expected_deadline(self) -> Option<ExpectedOperationDeadline> {
        match self {
            Self::SetupFailure(SetupFailurePoint::OperationDeadline) => {
                Some(ExpectedOperationDeadline::Setup)
            }
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub(super) struct AttemptId(u64);

impl AttemptId {
    pub(super) fn new(value: u64) -> Result<Self, GuardianError> {
        if value == 0 {
            Err(GuardianError::InvalidAttempt)
        } else {
            Ok(Self(value))
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CaseIdentity {
    pub case: GuardianCase,
    pub attempt: AttemptId,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CaseMetadata {
    pub identity: CaseIdentity,
    pub origin: QpcMetadata,
    pub expected_operation_deadline: Option<ExpectedOperationDeadline>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct QpcMetadata {
    pub counter: i64,
    pub frequency: i64,
}

impl From<QpcOrigin> for QpcMetadata {
    fn from(origin: QpcOrigin) -> Self {
        Self {
            counter: origin.counter,
            frequency: origin.frequency,
        }
    }
}

impl QpcMetadata {
    fn validate(self) -> Result<QpcOrigin, GuardianError> {
        let origin = QpcOrigin {
            counter: self.counter,
            frequency: self.frequency,
        };
        if self.counter < 0 {
            return Err(GuardianError::InvalidQpc);
        }
        QpcSchedule::new(origin).map_err(|_| GuardianError::InvalidQpc)?;
        Ok(origin)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(super) enum ExpectedOperationDeadline {
    Setup,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(super) enum PreRootFailureStage {
    CreateJob,
    CreateAttributeList,
    CreateProcess,
}

impl PreRootFailureStage {
    fn matches_initiating(self, stage: InitiatingFailureStage) -> bool {
        matches!(
            (self, stage),
            (Self::CreateJob, InitiatingFailureStage::CreateJob)
                | (
                    Self::CreateAttributeList,
                    InitiatingFailureStage::CreateAttributeList
                )
                | (Self::CreateProcess, InitiatingFailureStage::CreateProcess)
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(super) enum InitiatingFailureStage {
    CreateJob,
    ConfigureJob,
    QueryJobPolicy,
    CreatePipes,
    SetPipeInheritance,
    CreateAttributeList,
    CreateProcess,
    DuplicateRoot,
    StartWatchdog,
    WatchdogDuplicateClose,
    CloseChildPipeCopies,
    AssignRootBefore,
    AssignRoot,
    VerifyMembership,
    QueryJobPids,
    QueryAccounting,
    TestRootObserver,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PreRootFailure {
    pub stage: PreRootFailureStage,
    pub root_created: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(super) enum ResultKind {
    Prepared,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct NativeResultProjection {
    pub outcome: ResultKind,
    pub failure_stage: Option<InitiatingFailureStage>,
    pub raw_os_code: Option<u32>,
    pub root_created: bool,
    pub root_pid: Option<u32>,
    pub continuation_safe: Option<bool>,
    pub root_terminate_attempted: Option<bool>,
    pub root_terminate_succeeded: Option<bool>,
    pub job_terminate_attempted: Option<bool>,
    pub job_terminate_succeeded: Option<bool>,
    pub root_wait_succeeded: Option<bool>,
    pub root_exit_code: Option<u32>,
    pub active_process_count: Option<u32>,
    pub job_empty: Option<bool>,
    pub watchdog_recovered: Option<bool>,
    pub handles_closed: Option<bool>,
    pub clock_invalid: Option<bool>,
    pub clock_error: Option<u32>,
    pub failure_observed_qpc: Option<i64>,
    pub scheduled_stop_qpc: Option<i64>,
    pub cleanup_cutoff_qpc: Option<i64>,
    pub completed_qpc: Option<i64>,
}

impl NativeResultProjection {
    fn simple(outcome: ResultKind, root_created: bool, root_pid: Option<u32>) -> Self {
        Self {
            outcome,
            failure_stage: None,
            raw_os_code: None,
            root_created,
            root_pid,
            continuation_safe: None,
            root_terminate_attempted: None,
            root_terminate_succeeded: None,
            job_terminate_attempted: None,
            job_terminate_succeeded: None,
            root_wait_succeeded: None,
            root_exit_code: None,
            active_process_count: None,
            job_empty: None,
            watchdog_recovered: None,
            handles_closed: None,
            clock_invalid: None,
            clock_error: None,
            failure_observed_qpc: None,
            scheduled_stop_qpc: None,
            cleanup_cutoff_qpc: None,
            completed_qpc: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub(super) enum GuardianFrame {
    StartCase {
        metadata: CaseMetadata,
    },
    Ready {
        identity: CaseIdentity,
    },
    PrepareAuthorized {
        identity: CaseIdentity,
    },
    RootOffer {
        identity: CaseIdentity,
        root_pid: u32,
    },
    RootOwned {
        identity: CaseIdentity,
        root_pid: u32,
    },
    NoRootCreated {
        identity: CaseIdentity,
        failure: PreRootFailure,
    },
    CaseResult {
        identity: CaseIdentity,
        result: NativeResultProjection,
    },
    Reap {
        identity: CaseIdentity,
    },
    RootSignaled {
        identity: CaseIdentity,
    },
    NegativeTestBarrierRelease {
        identity: CaseIdentity,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u16,
    frame: GuardianFrame,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub(super) struct GuardianEvidence {
    pub identity: Option<CaseIdentity>,
    pub result: Option<ResultKind>,
    pub root_created: Option<bool>,
    pub root_owned: Option<bool>,
    pub root_signaled: Option<bool>,
    pub job_empty: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum GuardianError {
    InvalidAttempt,
    InvalidQpc,
    InvalidDeadlineIntent,
    InvalidFrameLength,
    TruncatedFrame,
    MalformedFrame,
    WrongVersion,
    IdentityMismatch,
    InvalidTransition,
    InvalidRootProof,
}

pub(super) fn encode_frame(frame: &GuardianFrame) -> Result<Vec<u8>, GuardianError> {
    validate_identity(frame.identity())?;
    let envelope = Envelope {
        version: GUARDIAN_PROTOCOL_VERSION,
        frame: *frame,
    };
    let payload = serde_json::to_vec(&envelope).map_err(|_| GuardianError::MalformedFrame)?;
    let total = PREFIX_BYTES
        .checked_add(payload.len())
        .ok_or(GuardianError::InvalidFrameLength)?;
    if total > MAX_GUARDIAN_FRAME_BYTES || payload.len() > u32::MAX as usize {
        return Err(GuardianError::InvalidFrameLength);
    }
    let mut wire = Vec::with_capacity(total);
    wire.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    wire.extend_from_slice(&payload);
    Ok(wire)
}

pub(super) fn decode_frame(wire: &[u8]) -> Result<GuardianFrame, GuardianError> {
    if wire.len() < PREFIX_BYTES {
        return Err(GuardianError::TruncatedFrame);
    }
    if wire.len() > MAX_GUARDIAN_FRAME_BYTES {
        return Err(GuardianError::InvalidFrameLength);
    }
    let payload_len = u32::from_le_bytes(wire[..PREFIX_BYTES].try_into().unwrap()) as usize;
    let total = PREFIX_BYTES
        .checked_add(payload_len)
        .ok_or(GuardianError::InvalidFrameLength)?;
    if total > MAX_GUARDIAN_FRAME_BYTES {
        return Err(GuardianError::InvalidFrameLength);
    }
    if total != wire.len() {
        return Err(if total > wire.len() {
            GuardianError::TruncatedFrame
        } else {
            GuardianError::MalformedFrame
        });
    }
    if payload_len == 0 {
        return Err(GuardianError::MalformedFrame);
    }
    let envelope: Envelope =
        serde_json::from_slice(&wire[PREFIX_BYTES..]).map_err(|_| GuardianError::MalformedFrame)?;
    if envelope.version != GUARDIAN_PROTOCOL_VERSION {
        return Err(GuardianError::WrongVersion);
    }
    validate_identity(envelope.frame.identity())?;
    if let GuardianFrame::StartCase { metadata } = envelope.frame {
        metadata.origin.validate()?;
        if metadata.expected_operation_deadline != metadata.identity.case.expected_deadline() {
            return Err(GuardianError::InvalidDeadlineIntent);
        }
    }
    Ok(envelope.frame)
}

impl GuardianFrame {
    fn identity(self) -> CaseIdentity {
        match self {
            Self::StartCase { metadata } => metadata.identity,
            Self::Ready { identity }
            | Self::PrepareAuthorized { identity }
            | Self::RootOffer { identity, .. }
            | Self::RootOwned { identity, .. }
            | Self::NoRootCreated { identity, .. }
            | Self::CaseResult { identity, .. }
            | Self::Reap { identity }
            | Self::RootSignaled { identity }
            | Self::NegativeTestBarrierRelease { identity } => identity,
        }
    }
}

fn validate_identity(identity: CaseIdentity) -> Result<(), GuardianError> {
    if identity.attempt.0 == 0 {
        Err(GuardianError::InvalidAttempt)
    } else {
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    AwaitStart,
    AwaitReady,
    AwaitAuthorization,
    AwaitPrepareResult,
    AwaitOwnedResult,
    AwaitCaseResult,
    AwaitNoRootResult,
    AwaitReap,
    AwaitRootSignal,
    Complete,
}

pub(super) struct GuardianProtocol {
    phase: Phase,
    identity: Option<CaseIdentity>,
    root_pid: Option<u32>,
    negative_barrier_released: bool,
    evidence: GuardianEvidence,
    metadata: Option<CaseMetadata>,
    pre_root_failure: Option<PreRootFailure>,
}

impl GuardianProtocol {
    pub(super) fn new() -> Self {
        Self {
            phase: Phase::AwaitStart,
            identity: None,
            root_pid: None,
            negative_barrier_released: false,
            evidence: GuardianEvidence::default(),
            metadata: None,
            pre_root_failure: None,
        }
    }

    pub(super) fn accept(&mut self, frame: GuardianFrame) -> Result<(), GuardianError> {
        let identity = frame.identity();
        validate_identity(identity)?;
        if let Some(expected) = self.identity {
            if identity != expected {
                return Err(GuardianError::IdentityMismatch);
            }
        }
        match (self.phase, frame) {
            (Phase::AwaitStart, GuardianFrame::StartCase { metadata }) => {
                if metadata.expected_operation_deadline
                    != metadata.identity.case.expected_deadline()
                {
                    return Err(GuardianError::InvalidDeadlineIntent);
                }
                metadata.origin.validate()?;
                self.identity = Some(metadata.identity);
                self.metadata = Some(metadata);
                self.evidence.identity = Some(metadata.identity);
                self.phase = Phase::AwaitReady;
            }
            (Phase::AwaitReady, GuardianFrame::Ready { .. }) => {
                self.phase = Phase::AwaitAuthorization
            }
            (Phase::AwaitAuthorization, GuardianFrame::PrepareAuthorized { .. }) => {
                self.phase = Phase::AwaitPrepareResult
            }
            (Phase::AwaitPrepareResult, GuardianFrame::RootOffer { root_pid, .. })
                if root_pid != 0 =>
            {
                self.root_pid = Some(root_pid);
                self.evidence.root_created = Some(true);
                self.phase = Phase::AwaitOwnedResult;
            }
            (Phase::AwaitOwnedResult, GuardianFrame::RootOwned { root_pid, .. })
                if Some(root_pid) == self.root_pid =>
            {
                self.evidence.root_owned = Some(true);
                self.phase = Phase::AwaitCaseResult;
            }
            (Phase::AwaitCaseResult, GuardianFrame::NegativeTestBarrierRelease { .. })
                if !self.negative_barrier_released
                    && self
                        .identity
                        .is_some_and(|id| id.case.expected_deadline().is_some()) =>
            {
                self.negative_barrier_released = true;
            }
            (Phase::AwaitPrepareResult, GuardianFrame::NoRootCreated { failure, .. }) => {
                if failure.root_created
                    || !matches!(
                        failure.stage,
                        PreRootFailureStage::CreateJob
                            | PreRootFailureStage::CreateAttributeList
                            | PreRootFailureStage::CreateProcess
                    )
                {
                    return Err(GuardianError::InvalidRootProof);
                }
                self.evidence.root_created = Some(false);
                self.pre_root_failure = Some(failure);
                self.phase = Phase::AwaitNoRootResult;
            }
            (Phase::AwaitCaseResult, GuardianFrame::CaseResult { result, .. })
                if self.evidence.root_created == Some(true)
                    && self.evidence.root_owned == Some(true)
                    && self.root_pid == result.root_pid
                    && result.root_created
                    && (result.outcome == ResultKind::Failed || result.failure_stage.is_none())
                    && result
                        .failure_stage
                        .is_none_or(|_| result.outcome == ResultKind::Failed)
                    && self.validate_result_timing(result).is_ok() =>
            {
                self.evidence.result = Some(result.outcome);
                self.phase = Phase::AwaitReap
            }
            (Phase::AwaitNoRootResult, GuardianFrame::CaseResult { result, .. })
                if result.outcome == ResultKind::Failed
                    && !result.root_created
                    && result.root_pid.is_none()
                    && self.pre_root_failure.is_some_and(|failure| {
                        result
                            .failure_stage
                            .is_some_and(|stage| failure.stage.matches_initiating(stage))
                    })
                    && self.validate_result_timing(result).is_ok() =>
            {
                self.evidence.result = Some(result.outcome);
                self.phase = Phase::AwaitReap
            }
            (Phase::AwaitReap, GuardianFrame::Reap { .. })
                if self.evidence.root_created == Some(true) =>
            {
                self.phase = Phase::AwaitRootSignal
            }
            (Phase::AwaitReap, GuardianFrame::Reap { .. })
                if self.evidence.root_created == Some(false) =>
            {
                self.phase = Phase::Complete
            }
            (Phase::AwaitRootSignal, GuardianFrame::RootSignaled { .. }) => {
                self.evidence.root_signaled = Some(true);
                self.phase = Phase::Complete;
            }
            _ => return Err(GuardianError::InvalidTransition),
        }
        Ok(())
    }

    pub(super) fn evidence(&self) -> GuardianEvidence {
        self.evidence
    }

    fn validate_result_timing(&self, result: NativeResultProjection) -> Result<(), GuardianError> {
        let metadata = self.metadata.ok_or(GuardianError::InvalidTransition)?;
        let schedule =
            QpcSchedule::new(metadata.origin.validate()?).map_err(|_| GuardianError::InvalidQpc)?;
        if let Some(observed) = result.failure_observed_qpc {
            if observed < 0 {
                return Err(GuardianError::InvalidQpc);
            }
        }
        if let Some(stop) = result.scheduled_stop_qpc {
            match result.failure_observed_qpc {
                Some(observed) if schedule.scheduled_setup_failure(observed) == Some(stop) => {}
                None if result.clock_invalid == Some(true)
                    && schedule.setup_cutoff() == Some(stop) => {}
                _ => return Err(GuardianError::InvalidQpc),
            }
        } else if result.failure_observed_qpc.is_some() {
            return Err(GuardianError::InvalidQpc);
        }
        if let Some(cutoff) = result.cleanup_cutoff_qpc {
            let stop = result.scheduled_stop_qpc.ok_or(GuardianError::InvalidQpc)?;
            if schedule.cleanup_cutoff(stop) != Some(cutoff) {
                return Err(GuardianError::InvalidQpc);
            }
        }
        let completion_order = if let Some(completed) = result.completed_qpc {
            if ownership::compare_cross_process_qpc(completed, metadata.origin.counter)
                != Ok(std::cmp::Ordering::Greater)
            {
                return Err(GuardianError::InvalidQpc);
            }
            if let Some(cutoff) = result.cleanup_cutoff_qpc {
                let order = ownership::compare_cross_process_qpc(completed, cutoff)
                    .map_err(|_| GuardianError::InvalidQpc)?;
                if order == std::cmp::Ordering::Greater && result.continuation_safe != Some(false) {
                    return Err(GuardianError::InvalidQpc);
                }
                Some(order)
            } else {
                None
            }
        } else {
            None
        };
        if result.root_terminate_succeeded == Some(true)
            && result.root_terminate_attempted != Some(true)
            || result.job_terminate_succeeded == Some(true)
                && result.job_terminate_attempted != Some(true)
            || result.root_wait_succeeded == Some(true) && !result.root_created
            || result.job_empty == Some(true)
                && result.active_process_count.is_some_and(|count| count != 0)
            || (!result.root_created
                && (result.root_terminate_attempted == Some(true)
                    || result.root_terminate_succeeded == Some(true)
                    || result.root_wait_succeeded == Some(true)
                    || result.root_exit_code.is_some()))
            || result.continuation_safe == Some(true) && result.handles_closed == Some(false)
            || result.continuation_safe == Some(true)
                && (result.clock_invalid == Some(true)
                    || result.clock_error.is_some()
                    || completion_order != Some(std::cmp::Ordering::Less)
                    || result.completed_qpc.is_none()
                    || result.cleanup_cutoff_qpc.is_none())
            || result.root_created
                && result.continuation_safe == Some(true)
                && (result.root_wait_succeeded == Some(false)
                    || result.root_terminate_attempted == Some(false)
                    || result.root_terminate_succeeded == Some(false)
                    || result.watchdog_recovered == Some(false))
            || !result.root_created
                && result.continuation_safe == Some(true)
                && (result.job_empty == Some(true) || result.active_process_count == Some(0))
        {
            return Err(GuardianError::InvalidRootProof);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(case: GuardianCase) -> CaseIdentity {
        CaseIdentity {
            case,
            attempt: AttemptId::new(7).unwrap(),
        }
    }

    fn metadata(case: GuardianCase) -> CaseMetadata {
        CaseMetadata {
            identity: identity(case),
            origin: QpcMetadata {
                counter: 1_000,
                frequency: 10_000_000,
            },
            expected_operation_deadline: case.expected_deadline(),
        }
    }

    fn root_case() -> GuardianCase {
        GuardianCase::ValidationMismatch(ValidationMismatch::ProcessLimit)
    }

    fn result(
        outcome: ResultKind,
        root_created: bool,
        root_pid: Option<u32>,
    ) -> NativeResultProjection {
        NativeResultProjection::simple(outcome, root_created, root_pid)
    }

    fn owned_protocol(case: GuardianCase) -> GuardianProtocol {
        let id = identity(case);
        let mut protocol = started(case);
        for frame in [
            GuardianFrame::Ready { identity: id },
            GuardianFrame::PrepareAuthorized { identity: id },
            GuardianFrame::RootOffer {
                identity: id,
                root_pid: 42,
            },
            GuardianFrame::RootOwned {
                identity: id,
                root_pid: 42,
            },
        ] {
            protocol.accept(frame).unwrap();
        }
        protocol
    }

    fn started(case: GuardianCase) -> GuardianProtocol {
        let mut protocol = GuardianProtocol::new();
        protocol
            .accept(GuardianFrame::StartCase {
                metadata: metadata(case),
            })
            .unwrap();
        protocol
    }

    #[test]
    fn roundtrips_every_frame_kind_with_exact_length_prefix() {
        let case = root_case();
        let id = identity(case);
        let frames = [
            GuardianFrame::StartCase {
                metadata: metadata(case),
            },
            GuardianFrame::Ready { identity: id },
            GuardianFrame::PrepareAuthorized { identity: id },
            GuardianFrame::RootOffer {
                identity: id,
                root_pid: 42,
            },
            GuardianFrame::RootOwned {
                identity: id,
                root_pid: 42,
            },
            GuardianFrame::NoRootCreated {
                identity: id,
                failure: PreRootFailure {
                    stage: PreRootFailureStage::CreateJob,
                    root_created: false,
                },
            },
            GuardianFrame::CaseResult {
                identity: id,
                result: result(ResultKind::Prepared, true, Some(42)),
            },
            GuardianFrame::Reap { identity: id },
            GuardianFrame::RootSignaled { identity: id },
            GuardianFrame::NegativeTestBarrierRelease { identity: id },
        ];
        for frame in frames {
            let wire = encode_frame(&frame).unwrap();
            let declared = u32::from_le_bytes(wire[..4].try_into().unwrap()) as usize;
            assert_eq!(wire.len(), PREFIX_BYTES + declared);
            assert_eq!(wire.len() <= MAX_GUARDIAN_FRAME_BYTES, true);
            assert_eq!(decode_frame(&wire).unwrap(), frame);
        }
    }

    #[test]
    fn rejects_invalid_length_prefixes_and_malformed_payloads() {
        let mut wire = encode_frame(&GuardianFrame::Ready {
            identity: identity(root_case()),
        })
        .unwrap();
        let mut wrong = wire.clone();
        wrong[..4].copy_from_slice(&1u32.to_le_bytes());
        assert_eq!(decode_frame(&wrong), Err(GuardianError::MalformedFrame));
        wire.pop();
        assert_eq!(decode_frame(&wire), Err(GuardianError::TruncatedFrame));
        let mut trailing = encode_frame(&GuardianFrame::Ready {
            identity: identity(root_case()),
        })
        .unwrap();
        trailing.push(0);
        let payload_len = (trailing.len() - PREFIX_BYTES) as u32;
        trailing[..4].copy_from_slice(&payload_len.to_le_bytes());
        assert_eq!(decode_frame(&trailing), Err(GuardianError::MalformedFrame));
        let malformed = [5, 0, 0, 0, b'{', b'x', b'}', 0];
        assert!(decode_frame(&malformed).is_err());
    }

    #[test]
    fn rejects_total_frame_over_limit() {
        let mut oversized = vec![0; MAX_GUARDIAN_FRAME_BYTES + 1];
        let payload_len = (oversized.len() - PREFIX_BYTES) as u32;
        oversized[..4].copy_from_slice(&payload_len.to_le_bytes());
        assert_eq!(
            decode_frame(&oversized),
            Err(GuardianError::InvalidFrameLength)
        );
        let frame = GuardianFrame::CaseResult {
            identity: identity(root_case()),
            result: result(ResultKind::Prepared, true, Some(42)),
        };
        let mut wire = encode_frame(&frame).unwrap();
        wire.resize(MAX_GUARDIAN_FRAME_BYTES, b' ');
        wire[0..4]
            .copy_from_slice(&((MAX_GUARDIAN_FRAME_BYTES - PREFIX_BYTES) as u32).to_le_bytes());
        assert_eq!(decode_frame(&wire), Ok(frame));
    }

    #[test]
    fn rejects_unknown_duplicate_version_recipe_and_identity_fields() {
        let valid = encode_frame(&GuardianFrame::Ready {
            identity: identity(root_case()),
        })
        .unwrap();
        assert!(decode_frame(&valid).is_ok());
        let mut json: serde_json::Value = serde_json::from_slice(&valid[PREFIX_BYTES..]).unwrap();
        json["version"] = 99.into();
        let wrong_version = frame_bytes(serde_json::to_vec(&json).unwrap());
        assert_eq!(
            decode_frame(&wrong_version),
            Err(GuardianError::WrongVersion)
        );
        assert_eq!(AttemptId::new(0), Err(GuardianError::InvalidAttempt));
        let baseline_text = String::from_utf8(valid[PREFIX_BYTES..].to_vec()).unwrap();
        let duplicate = frame_bytes(
            baseline_text
                .replacen("\"version\":1", "\"version\":1,\"version\":1", 1)
                .into_bytes(),
        );
        assert_eq!(decode_frame(&duplicate), Err(GuardianError::MalformedFrame));
        let unknown_field = frame_bytes(
            baseline_text
                .replacen("\"version\":1", "\"version\":1,\"extra\":0", 1)
                .into_bytes(),
        );
        assert_eq!(
            decode_frame(&unknown_field),
            Err(GuardianError::MalformedFrame)
        );
        let unknown_variant_field = frame_bytes(
            baseline_text
                .replacen("\"kind\":\"Ready\"", "\"kind\":\"Ready\",\"extra\":0", 1)
                .into_bytes(),
        );
        assert_eq!(
            decode_frame(&unknown_variant_field),
            Err(GuardianError::MalformedFrame)
        );
        let duplicate_identity_field = frame_bytes(
            baseline_text
                .replacen("\"attempt\":7", "\"attempt\":7,\"attempt\":7", 1)
                .into_bytes(),
        );
        assert_eq!(
            decode_frame(&duplicate_identity_field),
            Err(GuardianError::MalformedFrame)
        );
        let zero_attempt = frame_bytes(
            baseline_text
                .replacen("\"attempt\":7", "\"attempt\":0", 1)
                .into_bytes(),
        );
        assert_eq!(
            decode_frame(&zero_attempt),
            Err(GuardianError::InvalidAttempt)
        );
        let wrong_recipe = frame_bytes(
            baseline_text
                .replacen("\"PROCESS_LIMIT\"", "\"NO_SUCH_RECIPE\"", 1)
                .into_bytes(),
        );
        assert_eq!(
            decode_frame(&wrong_recipe),
            Err(GuardianError::MalformedFrame)
        );
        let nested_unknown = frame_bytes(
            baseline_text
                .replacen("\"attempt\":7", "\"attempt\":7,\"nested_extra\":0", 1)
                .into_bytes(),
        );
        assert_eq!(
            decode_frame(&nested_unknown),
            Err(GuardianError::MalformedFrame)
        );
    }

    fn frame_bytes(payload: Vec<u8>) -> Vec<u8> {
        let mut wire = Vec::with_capacity(PREFIX_BYTES + payload.len());
        wire.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        wire.extend(payload);
        wire
    }

    #[test]
    fn validates_recipe_deadline_qpc_and_checked_schedule() {
        let mut protocol = GuardianProtocol::new();
        let mut bad = metadata(GuardianCase::SetupFailure(
            SetupFailurePoint::OperationDeadline,
        ));
        bad.expected_operation_deadline = None;
        assert_eq!(
            protocol.accept(GuardianFrame::StartCase { metadata: bad }),
            Err(GuardianError::InvalidDeadlineIntent)
        );
        bad.expected_operation_deadline = Some(ExpectedOperationDeadline::Setup);
        bad.origin.frequency = 0;
        assert_eq!(
            protocol.accept(GuardianFrame::StartCase { metadata: bad }),
            Err(GuardianError::InvalidQpc)
        );
        bad.origin.frequency = 10;
        bad.origin.counter = i64::MAX - 2;
        assert_eq!(
            protocol.accept(GuardianFrame::StartCase { metadata: bad }),
            Err(GuardianError::InvalidQpc)
        );
    }

    #[test]
    fn root_created_terminal_sequence_requires_matching_offer_ownership_and_reap() {
        let case = root_case();
        let id = identity(case);
        let mut protocol = started(case);
        protocol
            .accept(GuardianFrame::Ready { identity: id })
            .unwrap();
        protocol
            .accept(GuardianFrame::PrepareAuthorized { identity: id })
            .unwrap();
        protocol
            .accept(GuardianFrame::RootOffer {
                identity: id,
                root_pid: 42,
            })
            .unwrap();
        assert_eq!(
            protocol.accept(GuardianFrame::RootOffer {
                identity: id,
                root_pid: 42
            }),
            Err(GuardianError::InvalidTransition)
        );
        let mismatch = CaseIdentity {
            attempt: AttemptId::new(8).unwrap(),
            ..id
        };
        assert_eq!(
            protocol.accept(GuardianFrame::RootOwned {
                identity: mismatch,
                root_pid: 42
            }),
            Err(GuardianError::IdentityMismatch)
        );
        let other_recipe = CaseIdentity {
            case: GuardianCase::ValidationMismatch(ValidationMismatch::MemoryLimit),
            ..id
        };
        assert_eq!(
            protocol.accept(GuardianFrame::RootOwned {
                identity: other_recipe,
                root_pid: 42
            }),
            Err(GuardianError::IdentityMismatch)
        );
        assert_eq!(
            protocol.accept(GuardianFrame::RootOwned {
                identity: id,
                root_pid: 43
            }),
            Err(GuardianError::InvalidTransition)
        );
        protocol
            .accept(GuardianFrame::RootOwned {
                identity: id,
                root_pid: 42,
            })
            .unwrap();
        protocol
            .accept(GuardianFrame::CaseResult {
                identity: id,
                result: result(ResultKind::Prepared, true, Some(42)),
            })
            .unwrap();
        protocol
            .accept(GuardianFrame::Reap { identity: id })
            .unwrap();
        assert_eq!(
            protocol.accept(GuardianFrame::RootSignaled { identity: id }),
            Ok(())
        );
        let evidence = protocol.evidence();
        assert_eq!(evidence.identity, Some(id));
        assert_eq!(evidence.root_created, Some(true));
        assert_eq!(evidence.result, Some(ResultKind::Prepared));
        assert_eq!(evidence.root_owned, Some(true));
        assert_eq!(evidence.root_signaled, Some(true));
        assert_eq!(evidence.job_empty, None);
    }

    #[test]
    fn root_owned_failed_result_remains_root_created_through_reap_and_signal() {
        let case = root_case();
        let id = identity(case);
        let mut protocol = started(case);
        for frame in [
            GuardianFrame::Ready { identity: id },
            GuardianFrame::PrepareAuthorized { identity: id },
            GuardianFrame::RootOffer {
                identity: id,
                root_pid: 42,
            },
            GuardianFrame::RootOwned {
                identity: id,
                root_pid: 42,
            },
        ] {
            protocol.accept(frame).unwrap();
        }
        assert_eq!(
            protocol.accept(GuardianFrame::CaseResult {
                identity: id,
                result: result(ResultKind::Failed, true, Some(42)),
            }),
            Ok(())
        );
        assert_eq!(protocol.evidence().root_created, Some(true));
        assert_eq!(protocol.evidence().root_owned, Some(true));
        assert_eq!(protocol.evidence().result, Some(ResultKind::Failed));
        protocol
            .accept(GuardianFrame::Reap { identity: id })
            .unwrap();
        protocol
            .accept(GuardianFrame::RootSignaled { identity: id })
            .unwrap();
        assert_eq!(protocol.evidence().root_signaled, Some(true));
    }

    #[test]
    fn projection_wire_accepts_native_preparation_failure_stage() {
        let frame = GuardianFrame::CaseResult {
            identity: identity(root_case()),
            result: {
                let mut projection = result(ResultKind::Failed, true, Some(42));
                projection.failure_stage = Some(InitiatingFailureStage::CreateJob);
                projection
            },
        };
        let wire = encode_frame(&frame).unwrap();
        assert_eq!(decode_frame(&wire), Ok(frame));
        let payload = String::from_utf8(wire[PREFIX_BYTES..].to_vec()).unwrap();
        let extended = frame_bytes(
            payload
                .replace("CREATE_JOB", "QUERY_JOB_POLICY")
                .into_bytes(),
        );
        let mut projected = frame;
        if let GuardianFrame::CaseResult { result, .. } = &mut projected {
            result.failure_stage = Some(InitiatingFailureStage::QueryJobPolicy);
        }
        assert_eq!(decode_frame(&extended), Ok(projected));
        let stages = [
            InitiatingFailureStage::CreateJob,
            InitiatingFailureStage::ConfigureJob,
            InitiatingFailureStage::QueryJobPolicy,
            InitiatingFailureStage::CreatePipes,
            InitiatingFailureStage::SetPipeInheritance,
            InitiatingFailureStage::CreateAttributeList,
            InitiatingFailureStage::CreateProcess,
            InitiatingFailureStage::DuplicateRoot,
            InitiatingFailureStage::StartWatchdog,
            InitiatingFailureStage::WatchdogDuplicateClose,
            InitiatingFailureStage::CloseChildPipeCopies,
            InitiatingFailureStage::AssignRootBefore,
            InitiatingFailureStage::AssignRoot,
            InitiatingFailureStage::VerifyMembership,
            InitiatingFailureStage::QueryJobPids,
            InitiatingFailureStage::QueryAccounting,
            InitiatingFailureStage::TestRootObserver,
        ];
        for stage in stages {
            let mut candidate = frame;
            if let GuardianFrame::CaseResult { result, .. } = &mut candidate {
                result.failure_stage = Some(stage);
            }
            assert_eq!(
                decode_frame(&encode_frame(&candidate).unwrap()),
                Ok(candidate)
            );
        }
    }

    #[test]
    fn continuation_safe_root_failure_rejects_incomplete_root_cleanup_evidence() {
        let id = identity(root_case());
        let mut projection = result(ResultKind::Failed, true, Some(42));
        projection.continuation_safe = Some(true);
        projection.failure_observed_qpc = Some(2_000_000);
        projection.scheduled_stop_qpc = Some(2_000_000);
        projection.cleanup_cutoff_qpc = Some(22_000_000);
        projection.completed_qpc = Some(20_000_000);
        projection.handles_closed = Some(false);
        assert_eq!(
            owned_protocol(root_case()).accept(GuardianFrame::CaseResult {
                identity: id,
                result: projection
            }),
            Err(GuardianError::InvalidTransition)
        );
        projection.handles_closed = Some(true);
        projection.root_wait_succeeded = Some(false);
        assert_eq!(
            owned_protocol(root_case()).accept(GuardianFrame::CaseResult {
                identity: id,
                result: projection
            }),
            Err(GuardianError::InvalidTransition)
        );
    }

    #[test]
    fn continuation_safe_root_failure_rejects_missing_watchdog_recovery() {
        let id = identity(root_case());
        let mut projection = result(ResultKind::Failed, true, Some(42));
        projection.continuation_safe = Some(true);
        projection.root_terminate_attempted = Some(true);
        projection.root_terminate_succeeded = Some(true);
        projection.root_wait_succeeded = Some(true);
        projection.handles_closed = Some(true);
        projection.watchdog_recovered = Some(false);
        projection.failure_observed_qpc = Some(2_000_000);
        projection.scheduled_stop_qpc = Some(2_000_000);
        projection.cleanup_cutoff_qpc = Some(22_000_000);
        projection.completed_qpc = Some(20_000_000);
        assert_eq!(
            owned_protocol(root_case()).accept(GuardianFrame::CaseResult {
                identity: id,
                result: projection,
            }),
            Err(GuardianError::InvalidTransition)
        );

        projection.watchdog_recovered = None;
        assert_eq!(
            owned_protocol(root_case()).validate_result_timing(projection),
            Ok(())
        );
    }

    #[test]
    fn explicit_no_root_failure_rejects_root_cleanup_claims() {
        let case = GuardianCase::SetupFailure(SetupFailurePoint::CreateJob);
        let id = identity(case);
        for claim in 0..4 {
            let mut protocol = started(case);
            protocol
                .accept(GuardianFrame::Ready { identity: id })
                .unwrap();
            protocol
                .accept(GuardianFrame::PrepareAuthorized { identity: id })
                .unwrap();
            protocol
                .accept(GuardianFrame::NoRootCreated {
                    identity: id,
                    failure: PreRootFailure {
                        stage: PreRootFailureStage::CreateJob,
                        root_created: false,
                    },
                })
                .unwrap();
            let mut projection = result(ResultKind::Failed, false, None);
            projection.failure_stage = Some(InitiatingFailureStage::CreateJob);
            match claim {
                0 => projection.root_terminate_succeeded = Some(true),
                1 => projection.root_wait_succeeded = Some(true),
                2 => projection.root_exit_code = Some(0),
                _ => projection.root_terminate_attempted = Some(true),
            }
            assert_eq!(
                protocol.accept(GuardianFrame::CaseResult {
                    identity: id,
                    result: projection
                }),
                Err(GuardianError::InvalidTransition)
            );
        }
    }

    #[test]
    fn no_root_continuation_safe_rejects_open_handles() {
        let case = GuardianCase::SetupFailure(SetupFailurePoint::CreateJob);
        let id = identity(case);
        let mut protocol = started(case);
        protocol
            .accept(GuardianFrame::Ready { identity: id })
            .unwrap();
        protocol
            .accept(GuardianFrame::PrepareAuthorized { identity: id })
            .unwrap();
        protocol
            .accept(GuardianFrame::NoRootCreated {
                identity: id,
                failure: PreRootFailure {
                    stage: PreRootFailureStage::CreateJob,
                    root_created: false,
                },
            })
            .unwrap();

        let mut projection = result(ResultKind::Failed, false, None);
        projection.failure_stage = Some(InitiatingFailureStage::CreateJob);
        projection.continuation_safe = Some(true);
        projection.handles_closed = Some(false);
        projection.failure_observed_qpc = Some(2_000_000);
        projection.scheduled_stop_qpc = Some(2_000_000);
        projection.cleanup_cutoff_qpc = Some(22_000_000);
        projection.completed_qpc = Some(21_000_000);

        assert_eq!(
            protocol.accept(GuardianFrame::CaseResult {
                identity: id,
                result: projection,
            }),
            Err(GuardianError::InvalidTransition)
        );
    }

    #[test]
    fn no_root_continuation_safe_rejects_empty_job_evidence() {
        let case = GuardianCase::SetupFailure(SetupFailurePoint::CreateJob);
        let id = identity(case);
        let started_no_root = || {
            let mut protocol = started(case);
            protocol
                .accept(GuardianFrame::Ready { identity: id })
                .unwrap();
            protocol
                .accept(GuardianFrame::PrepareAuthorized { identity: id })
                .unwrap();
            protocol
                .accept(GuardianFrame::NoRootCreated {
                    identity: id,
                    failure: PreRootFailure {
                        stage: PreRootFailureStage::CreateJob,
                        root_created: false,
                    },
                })
                .unwrap();
            protocol
        };
        let safe_result = || {
            let mut projection = result(ResultKind::Failed, false, None);
            projection.failure_stage = Some(InitiatingFailureStage::CreateJob);
            projection.continuation_safe = Some(true);
            projection.handles_closed = Some(true);
            projection.failure_observed_qpc = Some(2_000_000);
            projection.scheduled_stop_qpc = Some(2_000_000);
            projection.cleanup_cutoff_qpc = Some(22_000_000);
            projection.completed_qpc = Some(21_000_000);
            projection
        };

        let mut unknown = safe_result();
        assert_eq!(
            started_no_root().accept(GuardianFrame::CaseResult {
                identity: id,
                result: unknown,
            }),
            Ok(())
        );

        unknown = safe_result();
        unknown.job_empty = Some(true);
        assert_eq!(
            started_no_root().accept(GuardianFrame::CaseResult {
                identity: id,
                result: unknown,
            }),
            Err(GuardianError::InvalidTransition)
        );

        let mut zero_active = safe_result();
        zero_active.active_process_count = Some(0);
        assert_eq!(
            started_no_root().accept(GuardianFrame::CaseResult {
                identity: id,
                result: zero_active,
            }),
            Err(GuardianError::InvalidTransition)
        );
    }

    #[test]
    fn completion_qpc_rejects_ambiguous_origin_and_cutoff_ordering() {
        let protocol = owned_protocol(root_case());
        let mut projection = result(ResultKind::Failed, true, Some(42));
        projection.failure_observed_qpc = Some(2_000_000);
        projection.scheduled_stop_qpc = Some(2_000_000);
        projection.cleanup_cutoff_qpc = Some(22_000_000);
        for completion in [999, 1_000, 1_001, 22_000_000, 21_999_999, 22_000_001] {
            projection.completed_qpc = Some(completion);
            assert_eq!(
                protocol.validate_result_timing(projection),
                Err(GuardianError::InvalidQpc),
                "completion={completion}"
            );
        }
        projection.completed_qpc = Some(1_002);
        assert_eq!(protocol.validate_result_timing(projection), Ok(()));
        projection.completed_qpc = Some(21_999_998);
        assert_eq!(protocol.validate_result_timing(projection), Ok(()));
        projection.completed_qpc = Some(22_000_002);
        projection.continuation_safe = Some(false);
        assert_eq!(protocol.validate_result_timing(projection), Ok(()));
        projection.continuation_safe = Some(true);
        assert_eq!(
            protocol.validate_result_timing(projection),
            Err(GuardianError::InvalidQpc)
        );
    }

    #[test]
    fn result_projection_preserves_typed_evidence_and_checks_setup_schedule() {
        let case = root_case();
        let id = identity(case);
        let owned = || {
            let mut protocol = started(case);
            for frame in [
                GuardianFrame::Ready { identity: id },
                GuardianFrame::PrepareAuthorized { identity: id },
                GuardianFrame::RootOffer {
                    identity: id,
                    root_pid: 42,
                },
                GuardianFrame::RootOwned {
                    identity: id,
                    root_pid: 42,
                },
            ] {
                protocol.accept(frame).unwrap();
            }
            protocol
        };
        let mut projection = result(ResultKind::Failed, true, Some(42));
        projection.failure_stage = Some(InitiatingFailureStage::CreateProcess);
        projection.raw_os_code = Some(5);
        projection.continuation_safe = Some(false);
        projection.root_terminate_attempted = Some(true);
        projection.root_terminate_succeeded = Some(false);
        projection.failure_observed_qpc = Some(2_000_000);
        projection.scheduled_stop_qpc = Some(2_000_000);
        projection.cleanup_cutoff_qpc = Some(22_000_000);
        projection.completed_qpc = Some(21_000_000);
        let mut protocol = owned();
        assert_eq!(protocol.validate_result_timing(projection), Ok(()));
        protocol
            .accept(GuardianFrame::CaseResult {
                identity: id,
                result: projection,
            })
            .unwrap();
        assert_eq!(protocol.phase, Phase::AwaitReap);

        projection.scheduled_stop_qpc = Some(2_000_001);
        let mut protocol = owned();
        assert_eq!(
            protocol.accept(GuardianFrame::CaseResult {
                identity: id,
                result: projection
            }),
            Err(GuardianError::InvalidTransition)
        );
        projection.scheduled_stop_qpc = Some(2_000_000);
        projection.cleanup_cutoff_qpc = Some(22_000_001);
        let mut protocol = owned();
        assert_eq!(
            protocol.accept(GuardianFrame::CaseResult {
                identity: id,
                result: projection
            }),
            Err(GuardianError::InvalidTransition)
        );
        projection = result(ResultKind::Failed, false, None);
        let mut protocol = owned();
        assert_eq!(
            protocol.accept(GuardianFrame::CaseResult {
                identity: id,
                result: projection
            }),
            Err(GuardianError::InvalidTransition)
        );

        let mut fallback = result(ResultKind::Failed, true, Some(42));
        fallback.clock_invalid = Some(true);
        fallback.continuation_safe = Some(false);
        fallback.scheduled_stop_qpc = Some(30_001_000);
        fallback.cleanup_cutoff_qpc = Some(50_001_000);
        fallback.completed_qpc = Some(50_001_002);
        let protocol = owned();
        assert_eq!(protocol.validate_result_timing(fallback), Ok(()));
        let absent = result(ResultKind::Failed, true, Some(42));
        assert_eq!(absent.failure_observed_qpc, None);
        assert_eq!(absent.scheduled_stop_qpc, None);
        assert_eq!(absent.cleanup_cutoff_qpc, None);
    }

    #[test]
    fn explicit_pre_root_failure_is_not_inferred_from_missing_offer() {
        let case = GuardianCase::SetupFailure(SetupFailurePoint::CreateJob);
        let id = identity(case);
        let mut protocol = started(case);
        protocol
            .accept(GuardianFrame::Ready { identity: id })
            .unwrap();
        protocol
            .accept(GuardianFrame::PrepareAuthorized { identity: id })
            .unwrap();
        assert_eq!(protocol.evidence().root_created, None);
        protocol
            .accept(GuardianFrame::NoRootCreated {
                identity: id,
                failure: PreRootFailure {
                    stage: PreRootFailureStage::CreateJob,
                    root_created: false,
                },
            })
            .unwrap();
        protocol
            .accept(GuardianFrame::CaseResult {
                identity: id,
                result: {
                    let mut projection = result(ResultKind::Failed, false, None);
                    projection.failure_stage = Some(InitiatingFailureStage::CreateJob);
                    projection
                },
            })
            .unwrap();
        protocol
            .accept(GuardianFrame::Reap { identity: id })
            .unwrap();
        assert_eq!(protocol.evidence().root_created, Some(false));
        assert_eq!(protocol.evidence().result, Some(ResultKind::Failed));
        assert_eq!(protocol.evidence().root_signaled, None);
        assert_eq!(
            protocol.accept(GuardianFrame::RootSignaled { identity: id }),
            Err(GuardianError::InvalidTransition)
        );
    }

    #[test]
    fn rejects_out_of_order_frames_and_root_signal_without_reap() {
        let case = root_case();
        let id = identity(case);
        let mut protocol = GuardianProtocol::new();
        assert_eq!(
            protocol.accept(GuardianFrame::RootSignaled { identity: id }),
            Err(GuardianError::InvalidTransition)
        );
        let mut protocol = started(case);
        protocol
            .accept(GuardianFrame::Ready { identity: id })
            .unwrap();
        protocol
            .accept(GuardianFrame::PrepareAuthorized { identity: id })
            .unwrap();
        protocol
            .accept(GuardianFrame::RootOffer {
                identity: id,
                root_pid: 42,
            })
            .unwrap();
        protocol
            .accept(GuardianFrame::RootOwned {
                identity: id,
                root_pid: 42,
            })
            .unwrap();
        protocol
            .accept(GuardianFrame::CaseResult {
                identity: id,
                result: result(ResultKind::Prepared, true, Some(42)),
            })
            .unwrap();
        assert_eq!(
            protocol.accept(GuardianFrame::RootSignaled { identity: id }),
            Err(GuardianError::InvalidTransition)
        );
        assert_eq!(
            protocol.accept(GuardianFrame::NegativeTestBarrierRelease { identity: id }),
            Err(GuardianError::InvalidTransition)
        );
    }

    #[test]
    fn negative_barrier_release_is_a_fixed_recipe_message() {
        let case = GuardianCase::SetupFailure(SetupFailurePoint::OperationDeadline);
        let id = identity(case);
        let mut protocol = started(case);
        protocol
            .accept(GuardianFrame::Ready { identity: id })
            .unwrap();
        protocol
            .accept(GuardianFrame::PrepareAuthorized { identity: id })
            .unwrap();
        assert_eq!(
            protocol.accept(GuardianFrame::NegativeTestBarrierRelease { identity: id }),
            Err(GuardianError::InvalidTransition)
        );
        let wrong = CaseIdentity {
            case: root_case(),
            ..id
        };
        assert_eq!(
            protocol.accept(GuardianFrame::NegativeTestBarrierRelease { identity: wrong }),
            Err(GuardianError::IdentityMismatch)
        );
        protocol
            .accept(GuardianFrame::RootOffer {
                identity: id,
                root_pid: 42,
            })
            .unwrap();
        protocol
            .accept(GuardianFrame::RootOwned {
                identity: id,
                root_pid: 42,
            })
            .unwrap();
        protocol
            .accept(GuardianFrame::NegativeTestBarrierRelease { identity: id })
            .unwrap();
        assert_eq!(
            protocol.accept(GuardianFrame::NegativeTestBarrierRelease { identity: id }),
            Err(GuardianError::InvalidTransition)
        );
        protocol
            .accept(GuardianFrame::CaseResult {
                identity: id,
                result: result(ResultKind::Failed, true, Some(42)),
            })
            .unwrap();
        assert_eq!(
            protocol.accept(GuardianFrame::NegativeTestBarrierRelease { identity: id }),
            Err(GuardianError::InvalidTransition)
        );
    }
}
