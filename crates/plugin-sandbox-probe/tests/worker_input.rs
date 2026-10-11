use plugin_sandbox_probe::report::ProbeScenario;
use plugin_sandbox_probe::worker::{
    MAX_WORKER_FRAME_BYTES, WorkerObservation, WorkerRequest, child_ready_frame,
    encode_worker_frame, parse_child_ready_frame, parse_worker_frame,
    parse_worker_observation_frame, run_worker,
};

#[test]
fn fixed_scenario_protocol_rejects_unknown_out_of_order_and_oversized_requests() {
    assert_eq!(ProbeScenario::ALL.len(), 8);
    let request = WorkerRequest {
        protocol_version: 1,
        sequence: 0,
        scenario: ProbeScenario::CpuLoop,
    };
    assert_eq!(
        parse_worker_frame(&request.to_frame().unwrap()).unwrap(),
        request
    );
    for payload in [
        br#"{"protocol_version":1,"sequence":0,"scenario":"unknown"}"#.as_slice(),
        br#"{"protocol_version":1,"sequence":1,"scenario":"cpu_loop"}"#.as_slice(),
        br#"{"protocol_version":1,"sequence":0,"scenario":"cpu_loop","command":"cmd"}"#.as_slice(),
    ] {
        let frame = encode_worker_frame(payload).unwrap();
        assert!(parse_worker_frame(&frame).is_err());
    }
    assert!(encode_worker_frame(&vec![0; MAX_WORKER_FRAME_BYTES + 1]).is_err());
    assert!(parse_worker_frame(&vec![0xff; MAX_WORKER_FRAME_BYTES + 5]).is_err());
}

#[test]
fn child_readiness_frame_requires_fixed_identity_and_bounded_exact_frame() {
    let valid = encode_worker_frame(
        br#"{"type":"child_ready","protocol_version":1,"scenario":"child_process_tree","pid":1234}"#,
    ).unwrap();
    let ready = parse_child_ready_frame(&valid).unwrap();
    assert_eq!(ready.pid, 1234);
    for bad in [
        br#"{"type":"ready","protocol_version":1,"scenario":"child_process_tree","pid":1234}"#.as_slice(),
        br#"{"type":"child_ready","protocol_version":2,"scenario":"child_process_tree","pid":1234}"#.as_slice(),
        br#"{"type":"child_ready","protocol_version":1,"scenario":"cpu_loop","pid":1234}"#.as_slice(),
        br#"{"type":"child_ready","protocol_version":1,"scenario":"child_process_tree","pid":0}"#.as_slice(),
        br#"{"type":"child_ready","protocol_version":1,"scenario":"child_process_tree","pid":1234,"extra":true}"#.as_slice(),
    ] {
        assert!(parse_child_ready_frame(&encode_worker_frame(bad).unwrap()).is_err());
    }
    let mut overread = valid;
    overread.push(0);
    assert!(parse_child_ready_frame(&overread).is_err());
}

#[test]
fn child_ready_frame_builder_emits_the_fixed_v1_identity() {
    let frame = child_ready_frame(1234).unwrap();
    let ready = parse_child_ready_frame(&frame).unwrap();
    assert_eq!(ready.frame_type, "child_ready");
    assert_eq!(ready.protocol_version, 1);
    assert_eq!(ready.scenario, ProbeScenario::ChildProcessTree);
    assert_eq!(ready.pid, 1234);
}

#[test]
fn scenario_child_ready_frames_are_closed_scenario_bound_and_keep_legacy_frame() {
    use plugin_sandbox_probe::worker::{
        parse_scenario_child_ready_frame, scenario_child_ready_frame,
    };

    for scenario in [ProbeScenario::HardKill, ProbeScenario::ReapDeadline] {
        let frame = scenario_child_ready_frame(scenario, 4321).unwrap();
        let ready = parse_scenario_child_ready_frame(&frame, scenario).unwrap();
        assert_eq!(ready.frame_type, "child_ready");
        assert_eq!(ready.protocol_version, 1);
        assert_eq!(ready.sequence, 0);
        assert_eq!(ready.scenario, scenario);
        assert_eq!(ready.pid, 4321);
        assert!(
            parse_scenario_child_ready_frame(
                &frame,
                if scenario == ProbeScenario::HardKill {
                    ProbeScenario::ReapDeadline
                } else {
                    ProbeScenario::HardKill
                }
            )
            .is_err()
        );
    }
    let invalid_sequence = encode_worker_frame(
        br#"{"type":"child_ready","protocol_version":1,"sequence":1,"scenario":"hard_kill","pid":4321}"#,
    )
    .unwrap();
    assert!(parse_scenario_child_ready_frame(&invalid_sequence, ProbeScenario::HardKill).is_err());
    assert!(scenario_child_ready_frame(ProbeScenario::ChildProcessTree, 4321).is_err());
    assert!(scenario_child_ready_frame(ProbeScenario::HardKill, 0).is_err());
    let legacy = child_ready_frame(4321).unwrap();
    let ready = parse_child_ready_frame(&legacy).unwrap();
    assert_eq!(ready.scenario, ProbeScenario::ChildProcessTree);
    assert_eq!(ready.pid, 4321);
}

#[test]
fn child_readiness_parser_rejects_every_invalid_field_and_frame_boundary() {
    for payload in [
        br#"{"type":"wrong","protocol_version":1,"scenario":"child_process_tree","pid":1234}"#.as_slice(),
        br#"{"type":"child_ready","protocol_version":2,"scenario":"child_process_tree","pid":1234}"#.as_slice(),
        br#"{"type":"child_ready","protocol_version":1,"scenario":"cpu_loop","pid":1234}"#.as_slice(),
        br#"{"type":"child_ready","protocol_version":1,"scenario":"child_process_tree","pid":0}"#.as_slice(),
        br#"{"type":"child_ready","protocol_version":1,"scenario":"child_process_tree","pid":1234,"extra":true}"#.as_slice(),
        br#"{"type":"child_ready","type":"child_ready","protocol_version":1,"scenario":"child_process_tree","pid":1234}"#.as_slice(),
        br#"{"type":"child_ready","protocol_version":1,"scenario":"child_process_tree","pid":1234} trailing"#.as_slice(),
        b"not json".as_slice(),
    ] {
        assert!(parse_child_ready_frame(&encode_worker_frame(payload).unwrap()).is_err());
    }

    assert!(child_ready_frame(0).is_err());
    assert!(parse_child_ready_frame(&[]).is_err());
    assert!(parse_child_ready_frame(&[0, 0, 0]).is_err());
    assert!(parse_child_ready_frame(&0u32.to_le_bytes()).is_err());
    assert!(parse_child_ready_frame(&(MAX_WORKER_FRAME_BYTES as u32 + 1).to_le_bytes()).is_err());

    let mut truncated = encode_worker_frame(br#"{"type":"child_ready","protocol_version":1,"scenario":"child_process_tree","pid":1234}"#).unwrap();
    truncated.pop();
    assert!(parse_child_ready_frame(&truncated).is_err());
    let mut trailing = child_ready_frame(1234).unwrap();
    trailing.push(0);
    assert!(parse_child_ready_frame(&trailing).is_err());

    let mut oversized = (MAX_WORKER_FRAME_BYTES as u32 + 1).to_le_bytes().to_vec();
    oversized.resize(MAX_WORKER_FRAME_BYTES + 5, b' ');
    assert!(parse_child_ready_frame(&oversized).is_err());
}

#[test]
fn readiness_and_observation_frames_are_bounded_and_never_claim_enforcement() {
    let ready = encode_worker_frame(br#"{"protocol_version":1,"ready":true}"#).unwrap();
    assert!(ready.len() <= MAX_WORKER_FRAME_BYTES + 4);
    let observation = WorkerObservation::not_tested(ProbeScenario::CpuLoop);
    assert!(!observation.policy_enforcement_claimed);
    let payload = serde_json::to_vec(&observation).unwrap();
    assert!(payload.len() <= MAX_WORKER_FRAME_BYTES);
    assert!(encode_worker_frame(&payload).is_ok());
}

#[test]
fn worker_emits_a_bounded_readiness_frame_before_observation() {
    let request = WorkerRequest {
        protocol_version: 1,
        sequence: 0,
        scenario: ProbeScenario::ChildProcessTree,
    }
    .to_frame()
    .unwrap();
    let mut output = Vec::new();
    run_worker(request.as_slice(), &mut output).unwrap();
    let ready_len = u32::from_le_bytes(output[..4].try_into().unwrap()) as usize;
    let ready: serde_json::Value = serde_json::from_slice(&output[4..4 + ready_len]).unwrap();
    assert_eq!(ready["type"], "ready");
    assert!(ready_len <= MAX_WORKER_FRAME_BYTES);
    let offset = 4 + ready_len;
    let observation_len =
        u32::from_le_bytes(output[offset..offset + 4].try_into().unwrap()) as usize;
    let observation: serde_json::Value =
        serde_json::from_slice(&output[offset + 4..offset + 4 + observation_len]).unwrap();
    assert_eq!(observation["type"], "observation");
    assert_eq!(observation["scenario"], "child_process_tree");
    assert_eq!(observation["sequence"], 0);
    assert_eq!(observation["policy_enforcement_claimed"], false);
}

#[test]
fn in_process_worker_api_returns_after_resource_observation() {
    let request = WorkerRequest {
        protocol_version: 1,
        sequence: 0,
        scenario: ProbeScenario::HandleLimit,
    }
    .to_frame()
    .unwrap();
    let mut output = Vec::new();
    run_worker(request.as_slice(), &mut output).unwrap();
    let frame_len = u32::from_le_bytes(output[..4].try_into().unwrap()) as usize;
    let observation_offset = 4 + frame_len;
    let observation_len = u32::from_le_bytes(
        output[observation_offset..observation_offset + 4]
            .try_into()
            .unwrap(),
    ) as usize;
    let observation = parse_worker_observation_frame(
        &output[observation_offset..observation_offset + 4 + observation_len],
    )
    .unwrap();
    assert_eq!(observation.scenario, ProbeScenario::HandleLimit);
    assert_eq!(observation.sequence, 0);
    assert!(!observation.policy_enforcement_claimed);
}

#[test]
fn worker_flushes_observation_before_return_or_parent_hold() {
    use std::io::{self, Write};

    #[derive(Default)]
    struct FlushWriter {
        bytes: Vec<u8>,
        flushes: usize,
    }
    impl Write for FlushWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            self.flushes += 1;
            Ok(())
        }
    }

    let request = WorkerRequest {
        protocol_version: 1,
        sequence: 0,
        scenario: ProbeScenario::ChildProcessTree,
    }
    .to_frame()
    .unwrap();
    let mut output = FlushWriter::default();
    run_worker(request.as_slice(), &mut output).unwrap();
    assert_eq!(output.flushes, 2, "ready and observation must both flush");
}

#[test]
fn observation_decoder_accepts_only_bounded_typed_v1_observations() {
    let frame = encode_worker_frame(br#"{"type":"observation","protocol_version":1,"sequence":0,"scenario":"memory_bomb","challenge_started":true,"challenge_detail":"touched fixed allocation","policy_enforcement_claimed":false,"allocated_bytes":314572800,"touched_bytes":314572800}"#).unwrap();
    let observation = parse_worker_observation_frame(&frame).unwrap();
    assert_eq!(observation.allocated_bytes, Some(300 * 1024 * 1024));
    assert_eq!(observation.touched_bytes, Some(300 * 1024 * 1024));
    assert!(!observation.policy_enforcement_claimed);

    for bad in [
        br#"{"type":"observation","protocol_version":2,"sequence":0,"scenario":"memory_bomb","challenge_started":true,"challenge_detail":"x","policy_enforcement_claimed":true}"#.as_slice(),
        br#"{"type":"observation","protocol_version":1,"sequence":0,"scenario":"memory_bomb","challenge_started":true,"challenge_detail":"x","policy_enforcement_claimed":false,"reported_os_error":9223372036854775807}"#.as_slice(),
        br#"{"type":"observation","protocol_version":1,"sequence":0,"scenario":"memory_bomb","challenge_started":true,"challenge_detail":"x","policy_enforcement_claimed":false,"extra":true}"#.as_slice(),
    ] {
        let frame = encode_worker_frame(bad).unwrap();
        assert!(parse_worker_observation_frame(&frame).is_err());
    }
    assert!(parse_worker_observation_frame(&vec![0; MAX_WORKER_FRAME_BYTES + 5]).is_err());
}

#[test]
fn process_spawn_result_and_raw_error_are_typed_without_spawning_a_child() {
    use plugin_sandbox_probe::worker::{WorkerFailureStage, process_spawn_observation};
    let failed = process_spawn_observation(Err(std::io::Error::from_raw_os_error(5)));
    assert_eq!(failed.scenario, ProbeScenario::ProcessLimit);
    assert_eq!(failed.sequence, 0);
    assert_eq!(failed.child_spawn_succeeded, Some(false));
    assert_eq!(failed.reported_os_error, Some(5));
    assert_eq!(failed.failure_stage, Some(WorkerFailureStage::SpawnChild));
    assert!(!failed.policy_enforcement_claimed);
    let failure_frame = encode_worker_frame(&serde_json::to_vec(&failed).unwrap()).unwrap();
    let decoded_failure = parse_worker_observation_frame(&failure_frame).unwrap();
    assert_eq!(decoded_failure.child_spawn_succeeded, Some(false));
    assert_eq!(decoded_failure.reported_os_error, Some(5));
    let succeeded = process_spawn_observation(Ok(()));
    assert_eq!(succeeded.scenario, ProbeScenario::ProcessLimit);
    assert_eq!(succeeded.sequence, 0);
    assert_eq!(succeeded.child_spawn_succeeded, Some(true));
    assert_eq!(succeeded.reported_os_error, None);
    let success_frame = encode_worker_frame(&serde_json::to_vec(&succeeded).unwrap()).unwrap();
    let decoded_success = parse_worker_observation_frame(&success_frame).unwrap();
    assert_eq!(decoded_success.child_spawn_succeeded, Some(true));
}

#[test]
fn cpu_and_noncooperative_scenarios_have_started_observations_before_work() {
    use plugin_sandbox_probe::worker::challenge_started_observation;
    for scenario in [
        ProbeScenario::CpuLoop,
        ProbeScenario::WallClockTimeout,
        ProbeScenario::ReapDeadline,
    ] {
        let observation = challenge_started_observation(scenario).unwrap();
        assert!(observation.challenge_started);
        assert_eq!(observation.scenario, scenario);
        assert!(!observation.policy_enforcement_claimed);
    }
}

#[test]
fn executable_resolution_failure_is_not_reported_as_a_spawn_attempt() {
    use plugin_sandbox_probe::worker::{WorkerFailureStage, process_resolution_failure};
    let observation = process_resolution_failure(std::io::Error::from_raw_os_error(2));
    assert!(!observation.challenge_started);
    assert_eq!(observation.child_spawn_succeeded, None);
    assert_eq!(
        observation.failure_stage,
        Some(WorkerFailureStage::ResolveExecutable)
    );
    assert_eq!(observation.reported_os_error, Some(2));
}

#[test]
fn handle_failure_reports_stage_and_partial_open_count_without_measurement() {
    use plugin_sandbox_probe::worker::{WorkerFailureStage, handle_operation_failure};
    for stage in [
        WorkerFailureStage::OpenHandle,
        WorkerFailureStage::CountHandles,
    ] {
        let observation =
            handle_operation_failure(stage, 17, Some(std::io::Error::from_raw_os_error(6)));
        assert_eq!(observation.failure_stage, Some(stage));
        assert_eq!(observation.reported_os_error, Some(6));
        assert_eq!(observation.successful_handle_opens, Some(17));
        assert_eq!(observation.observed_handle_count, None);
        assert!(!observation.policy_enforcement_claimed);
    }
}

#[test]
fn worker_rejects_trailing_second_request_after_single_bounded_request() {
    let request = WorkerRequest {
        protocol_version: 1,
        sequence: 0,
        scenario: ProbeScenario::ChildProcessTree,
    }
    .to_frame()
    .unwrap();
    let mut input = request.clone();
    input.extend_from_slice(&request);
    let mut output = Vec::new();
    assert!(run_worker(input.as_slice(), &mut output).is_err());
}

#[cfg(windows)]
#[test]
fn in_process_worker_rejects_child_creating_scenarios_before_output() {
    use std::io::Write;
    use std::os::windows::io::AsRawHandle;
    use std::process::{Command, Stdio};
    use std::ptr::null;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
    };

    fn verify_one_scenario(scenario: ProbeScenario) {
        const KILL_CODE: u32 = 0xE004;
        const BOUND: Duration = Duration::from_secs(2);
        let job = unsafe { CreateJobObjectW(null(), null()) };
        assert!(!job.is_null(), "CreateJobObjectW failed");
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        limits.BasicLimitInformation.ActiveProcessLimit = 2;
        assert_ne!(
            unsafe {
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            },
            0,
            "SetInformationJobObject failed"
        );

        let request = WorkerRequest {
            protocol_version: 1,
            sequence: 0,
            scenario,
        }
        .to_frame()
        .unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("run_worker_guarded_child_helper")
            .arg("--ignored")
            .arg("--nocapture")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn isolated worker API helper");
        let process = child.as_raw_handle() as HANDLE;
        let assigned = unsafe { AssignProcessToJobObject(job, process) } != 0;
        let assignment_error = if assigned {
            None
        } else {
            Some(unsafe { GetLastError() })
        };

        if assigned {
            let request_write_error = child
                .stdin
                .take()
                .expect("helper stdin was piped")
                .write_all(&request)
                .err();
            // Dropping the request writer delivers the one-frame EOF contract.
            if let Some(error) = request_write_error {
                eprintln!("failed to send helper request: {error}");
            }
        }
        let deadline = Instant::now() + BOUND;
        let mut finished = false;
        while assigned && Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() {
                finished = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }

        // Kill any challenge descendants before asserting helper completion.
        let terminated = if assigned {
            (unsafe { TerminateJobObject(job, KILL_CODE) }) != 0
        } else {
            false
        };
        let termination_error = if assigned && !terminated {
            Some(unsafe { GetLastError() })
        } else {
            None
        };
        if !assigned {
            let _ = child.kill();
        }
        // Closing the kill-on-close Job is the fallback if explicit termination failed.
        let job_closed = unsafe { CloseHandle(job) } != 0;
        let reap_deadline = Instant::now() + BOUND;
        let mut exit_status = child.try_wait().ok().flatten().map(|status| status.code());
        while exit_status.is_none() && Instant::now() < reap_deadline {
            std::thread::sleep(Duration::from_millis(5));
            exit_status = child.try_wait().ok().flatten().map(|status| status.code());
        }
        if exit_status.is_none() {
            let _ = child.kill();
        }

        assert!(
            assigned,
            "AssignProcessToJobObject failed (parent/nested Job incompatibility): {assignment_error:?}"
        );
        assert!(
            finished,
            "in-process API helper did not return before cleanup"
        );
        assert_eq!(
            exit_status,
            Some(Some(0)),
            "helper did not satisfy the API contract"
        );
        assert!(
            terminated,
            "challenge Job termination failed: {termination_error:?}"
        );
        assert!(job_closed, "test Job handle did not close");
    }

    for scenario in [
        ProbeScenario::HardKill,
        ProbeScenario::ReapDeadline,
        ProbeScenario::ProcessLimit,
    ] {
        verify_one_scenario(scenario);
    }
}

#[cfg(windows)]
#[test]
#[ignore = "launched only inside the Job-contained API safety characterization"]
fn run_worker_guarded_child_helper() {
    use std::io::Read;
    let mut frame = Vec::new();
    std::io::stdin().read_to_end(&mut frame).unwrap();
    let mut output = Vec::new();
    let result = run_worker(frame.as_slice(), &mut output);
    assert!(result.is_err(), "in-process run_worker accepted child mode");
    assert!(
        output.is_empty(),
        "rejected child mode emitted protocol bytes"
    );
}

#[cfg(windows)]
#[test]
fn handle_challenge_reports_numeric_count_while_handles_remain_owned() {
    let observation = plugin_sandbox_probe::worker::measure_held_handles_for_test().unwrap();
    assert!(observation.observed_handle_count.unwrap() > 64);
    assert!(!observation.policy_enforcement_claimed);
}
