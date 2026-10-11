use crate::report::ProbeScenario;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::time::{Duration, Instant};

pub const MAX_WORKER_FRAME_BYTES: usize = 4096;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ChildReady {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub protocol_version: u8,
    pub scenario: ProbeScenario,
    pub pid: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ScenarioChildReady {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub protocol_version: u8,
    pub sequence: u8,
    pub scenario: ProbeScenario,
    pub pid: u32,
}

pub fn child_ready_frame(pid: u32) -> Result<Vec<u8>, String> {
    if pid == 0 {
        return Err("child readiness pid must be nonzero".into());
    }
    let ready = ChildReady {
        frame_type: "child_ready".into(),
        protocol_version: 1,
        scenario: ProbeScenario::ChildProcessTree,
        pid,
    };
    let payload = serde_json::to_vec(&ready).map_err(|error| error.to_string())?;
    encode_worker_frame(&payload)
}

pub fn scenario_child_ready_frame(scenario: ProbeScenario, pid: u32) -> Result<Vec<u8>, String> {
    if !matches!(
        scenario,
        ProbeScenario::HardKill | ProbeScenario::ReapDeadline
    ) {
        return Err("scenario child readiness is limited to hard_kill/reap_deadline".into());
    }
    if pid == 0 {
        return Err("scenario child readiness pid must be nonzero".into());
    }
    let ready = ScenarioChildReady {
        frame_type: "child_ready".into(),
        protocol_version: 1,
        sequence: 0,
        scenario,
        pid,
    };
    let payload = serde_json::to_vec(&ready).map_err(|error| error.to_string())?;
    encode_worker_frame(&payload)
}

pub fn parse_child_ready_frame(frame: &[u8]) -> Result<ChildReady, String> {
    if frame.len() < 4 || frame.len() > MAX_WORKER_FRAME_BYTES + 4 {
        return Err("child readiness frame size is invalid".into());
    }
    let length =
        u32::from_le_bytes(frame[..4].try_into().map_err(|_| "invalid frame header")?) as usize;
    if length == 0 || length > MAX_WORKER_FRAME_BYTES || frame.len() != length + 4 {
        return Err("child readiness frame length is invalid".into());
    }
    let ready: ChildReady =
        serde_json::from_slice(&frame[4..]).map_err(|error| error.to_string())?;
    if ready.frame_type != "child_ready"
        || ready.protocol_version != 1
        || ready.scenario != ProbeScenario::ChildProcessTree
        || ready.pid == 0
    {
        return Err("invalid child readiness identity".into());
    }
    Ok(ready)
}

pub fn parse_scenario_child_ready_frame(
    frame: &[u8],
    expected_scenario: ProbeScenario,
) -> Result<ScenarioChildReady, String> {
    if !matches!(
        expected_scenario,
        ProbeScenario::HardKill | ProbeScenario::ReapDeadline
    ) {
        return Err("scenario child readiness parser requires hard_kill/reap_deadline".into());
    }
    if frame.len() < 4 || frame.len() > MAX_WORKER_FRAME_BYTES + 4 {
        return Err("scenario child readiness frame size is invalid".into());
    }
    let length =
        u32::from_le_bytes(frame[..4].try_into().map_err(|_| "invalid frame header")?) as usize;
    if length == 0 || length > MAX_WORKER_FRAME_BYTES || frame.len() != length + 4 {
        return Err("scenario child readiness frame length is invalid".into());
    }
    let ready: ScenarioChildReady =
        serde_json::from_slice(&frame[4..]).map_err(|error| error.to_string())?;
    if ready.frame_type != "child_ready"
        || ready.protocol_version != 1
        || ready.sequence != 0
        || ready.scenario != expected_scenario
        || ready.pid == 0
    {
        return Err("scenario child readiness identity mismatch".into());
    }
    Ok(ready)
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorkerRequest {
    pub protocol_version: u8,
    pub sequence: u8,
    pub scenario: ProbeScenario,
}

impl WorkerRequest {
    pub fn to_frame(self) -> Result<Vec<u8>, String> {
        encode_worker_frame(&serde_json::to_vec(&self).map_err(|e| e.to_string())?)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorkerObservation {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub protocol_version: u8,
    pub sequence: u8,
    pub scenario: ProbeScenario,
    pub challenge_started: bool,
    pub challenge_detail: String,
    pub policy_enforcement_claimed: bool,
    #[serde(default)]
    pub failure_stage: Option<WorkerFailureStage>,
    #[serde(default)]
    pub reported_os_error: Option<i32>,
    #[serde(default)]
    pub successful_handle_opens: Option<u32>,
    #[serde(default)]
    pub observed_handle_count: Option<u32>,
    #[serde(default)]
    pub allocated_bytes: Option<u64>,
    #[serde(default)]
    pub touched_bytes: Option<u64>,
    #[serde(default)]
    pub child_spawn_succeeded: Option<bool>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkerFailureStage {
    ResolveExecutable,
    OpenHandle,
    CountHandles,
    SpawnChild,
}

impl WorkerObservation {
    pub fn not_tested(scenario: ProbeScenario) -> Self {
        Self {
            frame_type: "observation".into(),
            protocol_version: 1,
            sequence: 0,
            scenario,
            challenge_started: false,
            challenge_detail: "not tested".into(),
            policy_enforcement_claimed: false,
            failure_stage: None,
            reported_os_error: None,
            successful_handle_opens: None,
            observed_handle_count: None,
            allocated_bytes: None,
            touched_bytes: None,
            child_spawn_succeeded: None,
        }
    }
}

pub fn encode_worker_frame(payload: &[u8]) -> Result<Vec<u8>, String> {
    if payload.is_empty() || payload.len() > MAX_WORKER_FRAME_BYTES {
        return Err("worker frame exceeds configured bound".into());
    }
    let mut frame = Vec::with_capacity(payload.len() + 4);
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

pub fn parse_worker_frame(frame: &[u8]) -> Result<WorkerRequest, String> {
    if frame.len() < 4 || frame.len() > MAX_WORKER_FRAME_BYTES + 4 {
        return Err("worker frame size is invalid".into());
    }
    let length =
        u32::from_le_bytes(frame[..4].try_into().map_err(|_| "invalid frame header")?) as usize;
    if length == 0 || length > MAX_WORKER_FRAME_BYTES || frame.len() != length + 4 {
        return Err("worker frame length is invalid".into());
    }
    let request: WorkerRequest = serde_json::from_slice(&frame[4..]).map_err(|e| e.to_string())?;
    if request.protocol_version != 1 || request.sequence != 0 {
        return Err("unsupported or out-of-order worker request".into());
    }
    Ok(request)
}

pub fn parse_worker_observation_frame(frame: &[u8]) -> Result<WorkerObservation, String> {
    if frame.len() < 4 || frame.len() > MAX_WORKER_FRAME_BYTES + 4 {
        return Err("worker observation frame size is invalid".into());
    }
    let length =
        u32::from_le_bytes(frame[..4].try_into().map_err(|_| "invalid frame header")?) as usize;
    if length == 0 || length > MAX_WORKER_FRAME_BYTES || frame.len() != length + 4 {
        return Err("worker observation frame length is invalid".into());
    }
    let observation: WorkerObservation =
        serde_json::from_slice(&frame[4..]).map_err(|e| e.to_string())?;
    if observation.frame_type != "observation"
        || observation.protocol_version != 1
        || observation.sequence != 0
        || observation.policy_enforcement_claimed
    {
        return Err("invalid worker observation identity or enforcement claim".into());
    }
    Ok(observation)
}

pub fn process_resolution_failure(error: std::io::Error) -> WorkerObservation {
    let mut observation = WorkerObservation::not_tested(ProbeScenario::ProcessLimit);
    observation.challenge_detail = "current executable resolution failed before child spawn".into();
    observation.failure_stage = Some(WorkerFailureStage::ResolveExecutable);
    observation.reported_os_error = error.raw_os_error();
    observation
}

pub fn process_spawn_observation(result: Result<(), std::io::Error>) -> WorkerObservation {
    let mut observation = WorkerObservation::not_tested(ProbeScenario::ProcessLimit);
    observation.challenge_started = true;
    observation.challenge_detail = "fixed current-executable child spawn attempt".into();
    observation.child_spawn_succeeded = Some(result.is_ok());
    if let Err(error) = result {
        observation.failure_stage = Some(WorkerFailureStage::SpawnChild);
        observation.reported_os_error = error.raw_os_error();
    }
    observation
}

pub fn handle_operation_failure(
    stage: WorkerFailureStage,
    successful_opens: u32,
    error: Option<std::io::Error>,
) -> WorkerObservation {
    let mut observation = WorkerObservation::not_tested(ProbeScenario::HandleLimit);
    observation.challenge_started = true;
    observation.challenge_detail =
        "handle challenge operation failed; no handle-count measurement".into();
    observation.failure_stage = Some(stage);
    observation.reported_os_error = error.and_then(|error| error.raw_os_error());
    observation.successful_handle_opens = Some(successful_opens);
    observation
}

#[cfg(windows)]
fn measure_held_handles() -> (WorkerObservation, Vec<std::fs::File>) {
    use std::os::windows::io::AsRawHandle;
    let executable = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => {
            let mut observation = WorkerObservation::not_tested(ProbeScenario::HandleLimit);
            observation.challenge_detail = "handle target resolution failed".into();
            observation.failure_stage = Some(WorkerFailureStage::ResolveExecutable);
            observation.reported_os_error = error.raw_os_error();
            observation.successful_handle_opens = Some(0);
            return (observation, Vec::new());
        }
    };
    let mut handles = Vec::with_capacity(80);
    for _ in 0..80 {
        match std::fs::File::open(&executable) {
            Ok(handle) => handles.push(handle),
            Err(error) => {
                let observation = handle_operation_failure(
                    WorkerFailureStage::OpenHandle,
                    handles.len() as u32,
                    Some(error),
                );
                return (observation, handles);
            }
        }
    }
    let mut count = 0u32;
    // SAFETY: GetCurrentProcess returns a pseudo-handle valid for this process, and count is writable.
    let ok = unsafe {
        windows_sys::Win32::System::Threading::GetProcessHandleCount(
            windows_sys::Win32::System::Threading::GetCurrentProcess(),
            &mut count,
        )
    };
    if ok == 0 {
        let observation = handle_operation_failure(
            WorkerFailureStage::CountHandles,
            handles.len() as u32,
            Some(std::io::Error::last_os_error()),
        );
        return (observation, handles);
    }
    let _ = handles[0].as_raw_handle();
    let mut observation = WorkerObservation::not_tested(ProbeScenario::HandleLimit);
    observation.challenge_started = true;
    observation.challenge_detail =
        "observed live process handle count; telemetry only, no handle quota".into();
    observation.observed_handle_count = Some(count);
    observation.successful_handle_opens = Some(handles.len() as u32);
    (observation, handles)
}

#[cfg(windows)]
pub fn measure_held_handles_for_test() -> Result<WorkerObservation, String> {
    let (observation, _held_handles) = measure_held_handles();
    Ok(observation)
}

#[derive(Default)]
struct ChallengeResources {
    handles: Vec<std::fs::File>,
    allocation: Option<Vec<u8>>,
}

pub fn challenge_started_observation(scenario: ProbeScenario) -> Option<WorkerObservation> {
    let detail = match scenario {
        ProbeScenario::CpuLoop => "sustained_single_thread_cpu_demand",
        ProbeScenario::WallClockTimeout => {
            "noncooperative monotonic wall-clock spin; supervisor must terminate"
        }
        ProbeScenario::HardKill | ProbeScenario::ReapDeadline => {
            "fixed root+child tree challenge; supervisor must terminate"
        }
        _ => return None,
    };
    let mut observation = WorkerObservation::not_tested(scenario);
    observation.challenge_started = true;
    observation.challenge_detail = detail.into();
    Some(observation)
}

fn run_post_observation_challenge(scenario: ProbeScenario) -> Result<(), String> {
    match scenario {
        ProbeScenario::CpuLoop => {
            let start = Instant::now();
            let mut n = 0u64;
            while start.elapsed() < Duration::from_secs(30) {
                n = n.wrapping_add(1);
                std::hint::black_box(n);
            }
        }
        ProbeScenario::WallClockTimeout => loop {
            std::hint::spin_loop();
        },
        ProbeScenario::HardKill | ProbeScenario::ReapDeadline => {
            if !should_hold_for_parent(scenario) {
                return Err("tree challenge missing supervised hold selection".into());
            }
            let child = spawn_scenario_child(scenario)?;
            loop {
                std::hint::black_box(&child);
                std::hint::spin_loop();
            }
        }
        _ => {}
    }
    Ok(())
}

fn spawn_scenario_child(scenario: ProbeScenario) -> Result<std::process::Child, String> {
    let fixed_arg = match scenario {
        ProbeScenario::HardKill => "hard_kill",
        ProbeScenario::ReapDeadline => "reap_deadline",
        _ => return Err("unsupported fixed scenario child".into()),
    };
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    std::process::Command::new(executable)
        .arg("--worker-hold")
        .arg(fixed_arg)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())
}

fn run_fixed_challenge(scenario: ProbeScenario) -> (WorkerObservation, ChallengeResources) {
    let mut observation = WorkerObservation::not_tested(scenario);
    let mut resources = ChallengeResources::default();
    match scenario {
        ProbeScenario::MemoryBomb => {
            // The bounded allocation remains owned through observation framing/parent hold.
            let mut memory = Vec::new();
            let bytes = 300 * 1024 * 1024;
            if memory.try_reserve_exact(bytes).is_ok() {
                memory.resize(bytes, 0);
                for page in (0..memory.len()).step_by(4096) {
                    memory[page] = 1;
                }
                observation.challenge_started = true;
                observation.challenge_detail =
                    "fixed 300 MiB allocation touched per page; telemetry only".into();
                observation.allocated_bytes = Some(bytes as u64);
                observation.touched_bytes = Some(bytes as u64);
                std::hint::black_box(memory.as_ptr());
                resources.allocation = Some(memory);
            } else {
                observation.challenge_detail = "fixed 300 MiB allocation failed".into();
            }
        }
        ProbeScenario::CpuLoop
        | ProbeScenario::WallClockTimeout
        | ProbeScenario::HardKill
        | ProbeScenario::ReapDeadline => unreachable!("pre-observation challenges handled first"),
        ProbeScenario::ChildProcessTree | ProbeScenario::ProcessLimit => {
            if scenario == ProbeScenario::ProcessLimit {
                match std::env::current_exe() {
                    Err(error) => observation = process_resolution_failure(error),
                    Ok(exe) => {
                        let result = std::process::Command::new(exe)
                            .arg("--worker-hold")
                            .arg("process_limit")
                            .stdin(std::process::Stdio::null())
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .spawn()
                            .map(drop);
                        observation = process_spawn_observation(result);
                    }
                }
            } else {
                observation.challenge_detail = "challenge requires supervisor launch policy".into();
            }
        }
        ProbeScenario::HandleLimit => {
            #[cfg(windows)]
            {
                let (handle_observation, handles) = measure_held_handles();
                observation = handle_observation;
                resources.handles = handles;
            }
            #[cfg(not(windows))]
            {
                observation.challenge_detail =
                    "handle observation unsupported on this platform".into();
            }
        }
    }
    (observation, resources)
}

pub fn should_hold_for_parent(scenario: ProbeScenario) -> bool {
    matches!(
        scenario,
        ProbeScenario::MemoryBomb
            | ProbeScenario::HandleLimit
            | ProbeScenario::ProcessLimit
            | ProbeScenario::HardKill
            | ProbeScenario::ReapDeadline
    )
}

fn run_worker_with_hold<R: Read, W: Write>(
    mut input: R,
    mut output: W,
    hold_for_parent: bool,
) -> Result<(), String> {
    let mut header = [0; 4];
    input.read_exact(&mut header).map_err(|e| e.to_string())?;
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > MAX_WORKER_FRAME_BYTES {
        return Err("worker request exceeds bound".into());
    }
    let mut frame = Vec::with_capacity(length + 4);
    frame.extend_from_slice(&header);
    frame.resize(length + 4, 0);
    input
        .read_exact(&mut frame[4..])
        .map_err(|e| e.to_string())?;
    // The parent must close its one-request pipe after writing the frame.
    // Reject any second request or trailing bytes rather than silently ignoring them.
    let mut trailing = [0u8; 1];
    if input.read(&mut trailing).map_err(|e| e.to_string())? != 0 {
        return Err("worker accepts exactly one request frame".into());
    }
    let request = parse_worker_frame(&frame)?;
    if !hold_for_parent
        && matches!(
            request.scenario,
            ProbeScenario::HardKill | ProbeScenario::ReapDeadline | ProbeScenario::ProcessLimit
        )
    {
        return Err("child-creating scenarios require supervised subprocess mode".into());
    }
    let ready = serde_json::json!({
        "type": "ready",
        "protocol_version": 1,
        "sequence": 0,
        "scenario": request.scenario,
    });
    let ready_frame = encode_worker_frame(&serde_json::to_vec(&ready).map_err(|e| e.to_string())?)?;
    output.write_all(&ready_frame).map_err(|e| e.to_string())?;
    output.flush().map_err(|e| e.to_string())?;
    if let Some(observation) = challenge_started_observation(request.scenario) {
        let payload = serde_json::to_vec(&observation).map_err(|e| e.to_string())?;
        let response = encode_worker_frame(&payload)?;
        output.write_all(&response).map_err(|e| e.to_string())?;
        output.flush().map_err(|e| e.to_string())?;
        run_post_observation_challenge(request.scenario)?;
        return Ok(());
    }
    let (observation, resources) = run_fixed_challenge(request.scenario);
    let payload = serde_json::to_vec(&observation).map_err(|e| e.to_string())?;
    let response = encode_worker_frame(&payload)?;
    output.write_all(&response).map_err(|e| e.to_string())?;
    output.flush().map_err(|e| e.to_string())?;
    if hold_for_parent && should_hold_for_parent(request.scenario) {
        // Retain ownership of measured allocations/handles until parent termination.
        loop {
            std::hint::spin_loop();
        }
    }
    drop(resources);
    Ok(())
}

/// Runs one fixed challenge synchronously. CPU runs for its fixed interval and the
/// wall-clock challenge may never return. Child-creating scenarios require the
/// supervised subprocess mode; this API omits the post-observation resource hold.
pub fn run_worker<R: Read, W: Write>(input: R, output: W) -> Result<(), String> {
    run_worker_with_hold(input, output, false)
}

pub fn run_worker_supervised<R: Read, W: Write>(input: R, output: W) -> Result<(), String> {
    run_worker_with_hold(input, output, true)
}

pub fn hold_child(scenario: ProbeScenario) -> Result<(), String> {
    if !matches!(
        scenario,
        ProbeScenario::ChildProcessTree
            | ProbeScenario::ProcessLimit
            | ProbeScenario::HardKill
            | ProbeScenario::ReapDeadline
    ) {
        return Err("unsupported fixed hold scenario".into());
    }
    if matches!(
        scenario,
        ProbeScenario::ChildProcessTree | ProbeScenario::HardKill | ProbeScenario::ReapDeadline
    ) {
        let frame = if scenario == ProbeScenario::ChildProcessTree {
            child_ready_frame(std::process::id())?
        } else {
            scenario_child_ready_frame(scenario, std::process::id())?
        };
        let mut stdout = std::io::stdout().lock();
        stdout
            .write_all(&frame)
            .map_err(|error| error.to_string())?;
        stdout.flush().map_err(|error| error.to_string())?;
        drop(stdout);
    }
    loop {
        std::hint::spin_loop();
    }
}

#[cfg(test)]
mod supervised_liveness_tests {
    use super::should_hold_for_parent;
    use crate::report::ProbeScenario;

    #[test]
    fn resource_challenges_hold_live_resources_until_parent_termination() {
        for scenario in [
            ProbeScenario::MemoryBomb,
            ProbeScenario::HandleLimit,
            ProbeScenario::ProcessLimit,
            ProbeScenario::HardKill,
            ProbeScenario::ReapDeadline,
        ] {
            assert!(should_hold_for_parent(scenario), "{scenario:?}");
        }
    }

    #[test]
    fn other_fixed_challenges_do_not_enter_the_resource_hold_path() {
        for scenario in [
            ProbeScenario::CpuLoop,
            ProbeScenario::WallClockTimeout,
            ProbeScenario::ChildProcessTree,
        ] {
            assert!(!should_hold_for_parent(scenario), "{scenario:?}");
        }
    }
}
