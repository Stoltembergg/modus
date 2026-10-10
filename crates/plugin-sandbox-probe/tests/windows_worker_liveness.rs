#![cfg(windows)]

use plugin_sandbox_probe::{report, worker};

mod fixture {
    #![allow(dead_code)]

    use crate::{report, worker};
    use serde::Deserialize;
    use windows_sys::Win32::System::JobObjects::{
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
        JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::GetProcessHandleCount;

    include!("../src/platform/windows_supervisor.rs");

    const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
    const TERMINATION_TIMEOUT: Duration = Duration::from_secs(2);
    const TERMINATION_EXIT: u32 = 0xE002;

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ReadyFrame {
        #[serde(rename = "type")]
        frame_type: String,
        protocol_version: u8,
        sequence: u8,
        scenario: report::ProbeScenario,
    }

    #[derive(Clone, Copy)]
    struct JobPolicy {
        active_process_limit: u32,
    }

    struct CleanupEvidence {
        termination_succeeded: bool,
        termination_error: Option<u32>,
        root_waited: bool,
        child_waited: bool,
        root_exit: Option<u32>,
        child_exit: Option<u32>,
        active_after: Option<u32>,
        job_empty: bool,
        all_handles_closed: bool,
        elapsed: Duration,
    }

    struct WorkerGuard {
        job: OwnedHandle,
        root: OwnedHandle,
        thread: OwnedHandle,
        child: OwnedHandle,
        input_pipe: (OwnedHandle, OwnedHandle),
        output_pipe: (OwnedHandle, OwnedHandle),
        root_pid: u32,
        assigned: bool,
        resumed: bool,
        cleaned: bool,
    }

    impl WorkerGuard {
        fn launch(policy: JobPolicy) -> Result<Self, String> {
            let job = OwnedHandle::new(unsafe { CreateJobObjectW(null(), null()) });
            if !job.is_valid() {
                return Err(last_error("CreateJobObjectW failed"));
            }
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            limits.BasicLimitInformation.ActiveProcessLimit = policy.active_process_limit;
            if unsafe {
                SetInformationJobObject(
                    job.raw(),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            } == 0
            {
                return Err(last_error("SetInformationJobObject failed"));
            }
            let queried = query_job_policy(job.raw())?;
            if queried.BasicLimitInformation.LimitFlags
                & (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS)
                != JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                || queried.BasicLimitInformation.ActiveProcessLimit != policy.active_process_limit
                || queried.BasicLimitInformation.LimitFlags
                    & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)
                    != 0
            {
                return Err("queried Job policy mismatch or breakaway flag present".into());
            }

            let input_pipe = create_pipe()?;
            let output_pipe = create_pipe()?;
            if unsafe { SetHandleInformation(input_pipe.1.raw(), HANDLE_FLAG_INHERIT, 0) } == 0 {
                return Err(last_error("SetHandleInformation parent input failed"));
            }
            if unsafe { SetHandleInformation(output_pipe.0.raw(), HANDLE_FLAG_INHERIT, 0) } == 0 {
                return Err(last_error("SetHandleInformation parent output failed"));
            }
            let inherited = [input_pipe.0.raw(), output_pipe.1.raw()];
            let attributes = AttributeList::with_inherited_handles(&inherited)?;
            let mut startup = STARTUPINFOEXW::default();
            startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = input_pipe.0.raw();
            startup.StartupInfo.hStdOutput = output_pipe.1.raw();
            startup.StartupInfo.hStdError = output_pipe.1.raw();
            startup.lpAttributeList = attributes.raw;

            let executable = PathBuf::from(env!("CARGO_BIN_EXE_plugin-sandbox-probe"));
            if !executable.is_file() {
                return Err(format!(
                    "Cargo worker binary missing: {}",
                    executable.display()
                ));
            }
            let executable_wide: Vec<u16> = executable
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let mut command_line: Vec<u16> = format!("\"{}\" --worker", executable.display())
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let mut process_info = PROCESS_INFORMATION::default();
            if unsafe {
                CreateProcessW(
                    executable_wide.as_ptr(),
                    command_line.as_mut_ptr(),
                    null(),
                    null(),
                    1,
                    CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                    null(),
                    null(),
                    &startup.StartupInfo,
                    &mut process_info,
                )
            } == 0
            {
                return Err(last_error("CreateProcessW worker failed"));
            }

            // Immediately transfer both process handles and all launch resources to the guard.
            let mut guard = Self {
                job,
                root: OwnedHandle::new(process_info.hProcess),
                thread: OwnedHandle::new(process_info.hThread),
                child: OwnedHandle::new(null_mut()),
                input_pipe,
                output_pipe,
                root_pid: process_info.dwProcessId,
                assigned: false,
                resumed: false,
                cleaned: false,
            };
            drop(attributes);
            if !guard.input_pipe.0.close_checked() || !guard.output_pipe.1.close_checked() {
                return Err("closing child-only pipe ends failed".into());
            }
            Ok(guard)
        }

        fn assign_and_resume(&mut self) -> Result<(), String> {
            if unsafe { AssignProcessToJobObject(self.job.raw(), self.root.raw()) } == 0 {
                let error = unsafe { GetLastError() };
                return Err(format!(
                    "AssignProcessToJobObject failed (possible parent/nested-Job incompatibility; no breakaway fallback): {error}"
                ));
            }
            self.assigned = true;
            verify_job_member(self.root.raw(), self.job.raw())?;
            if query_job_pids(self.job.raw())? != [self.root_pid] {
                return Err("suspended Job PID list was not exactly the worker root".into());
            }
            if unsafe { ResumeThread(self.thread.raw()) } == u32::MAX {
                return Err(last_error("ResumeThread failed"));
            }
            self.resumed = true;
            Ok(())
        }

        fn handshake(
            &mut self,
            scenario: report::ProbeScenario,
        ) -> Result<worker::WorkerObservation, String> {
            self.assign_and_resume()?;
            let request = worker::WorkerRequest {
                protocol_version: 1,
                sequence: 0,
                scenario,
            }
            .to_frame()?;
            if !self.input_pipe.1.is_valid() {
                return Err("parent request writer unexpectedly closed".into());
            }
            write_pipe_all(self.input_pipe.1.raw(), &request)?;
            if !self.input_pipe.1.close_checked() {
                return Err("closing parent request pipe failed".into());
            }

            let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
            let ready = read_bounded_frame(self.output_pipe.0.raw(), self.root.raw(), deadline)?;
            let ready: ReadyFrame = serde_json::from_slice(&ready[4..])
                .map_err(|error| format!("invalid ready frame JSON: {error}"))?;
            if ready.frame_type != "ready"
                || ready.protocol_version != 1
                || ready.sequence != 0
                || ready.scenario != scenario
            {
                return Err("ready frame did not match requested protocol/scenario".into());
            }

            let observation_frame =
                read_bounded_frame(self.output_pipe.0.raw(), self.root.raw(), deadline)?;
            let observation = worker::parse_worker_observation_frame(&observation_frame)?;
            if observation.scenario != scenario || observation.sequence != 0 {
                return Err("observation scenario/sequence did not match request".into());
            }
            let mut available = 0u32;
            if unsafe {
                PeekNamedPipe(
                    self.output_pipe.0.raw(),
                    null_mut(),
                    0,
                    null_mut(),
                    &mut available,
                    null_mut(),
                )
            } == 0
            {
                return Err(last_error("PeekNamedPipe trailing output check failed"));
            }
            if available != 0 {
                return Err("worker emitted bytes after its bounded observation".into());
            }
            Ok(observation)
        }

        fn handshake_tree(
            &mut self,
            scenario: report::ProbeScenario,
        ) -> Result<(worker::WorkerObservation, worker::ScenarioChildReady), String> {
            if !matches!(
                scenario,
                report::ProbeScenario::HardKill | report::ProbeScenario::ReapDeadline
            ) {
                return Err(
                    "scenario-matched child handshake accepts only hard_kill/reap_deadline".into(),
                );
            }
            self.assign_and_resume()?;
            let request = worker::WorkerRequest {
                protocol_version: 1,
                sequence: 0,
                scenario,
            }
            .to_frame()?;
            write_pipe_all(self.input_pipe.1.raw(), &request)?;
            if !self.input_pipe.1.close_checked() {
                return Err("closing parent request pipe failed".into());
            }
            let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
            let ready_frame =
                read_bounded_frame(self.output_pipe.0.raw(), self.root.raw(), deadline)?;
            let ready: ReadyFrame = serde_json::from_slice(&ready_frame[4..])
                .map_err(|error| format!("invalid ready frame JSON: {error}"))?;
            if ready.frame_type != "ready"
                || ready.protocol_version != 1
                || ready.sequence != 0
                || ready.scenario != scenario
            {
                return Err("root ready frame did not match requested tree scenario".into());
            }
            let observation_frame =
                read_bounded_frame(self.output_pipe.0.raw(), self.root.raw(), deadline)?;
            let observation = worker::parse_worker_observation_frame(&observation_frame)?;
            if observation.scenario != scenario || observation.sequence != 0 {
                return Err("root observation scenario/sequence mismatch".into());
            }
            let child_frame =
                read_bounded_frame(self.output_pipe.0.raw(), self.root.raw(), deadline)?;
            let child_ready = worker::parse_scenario_child_ready_frame(&child_frame, scenario)?;
            if child_ready.scenario != scenario || child_ready.pid == 0 {
                return Err("scenario child-ready identity mismatch".into());
            }
            if child_ready.sequence != 0 {
                return Err("scenario child-ready sequence mismatch".into());
            }
            let mut available = 0u32;
            if unsafe {
                PeekNamedPipe(
                    self.output_pipe.0.raw(),
                    null_mut(),
                    0,
                    null_mut(),
                    &mut available,
                    null_mut(),
                )
            } == 0
            {
                return Err(last_error("PeekNamedPipe trailing tree data check failed"));
            }
            if available != 0 {
                return Err("tree worker emitted bytes after child-ready frame".into());
            }
            Ok((observation, child_ready))
        }

        fn open_job_child(&mut self, pid: u32) -> Result<(), String> {
            let child = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    pid,
                )
            };
            if child.is_null() {
                return Err(last_error("OpenProcess Job child failed"));
            }
            self.child = OwnedHandle::new(child);
            if unsafe { GetProcessId(self.child.raw()) } != pid {
                return Err("retained child process handle PID mismatch".into());
            }
            verify_job_member(self.child.raw(), self.job.raw())
        }

        fn cleanup(&mut self) -> CleanupEvidence {
            let started = Instant::now();
            let deadline = started + TERMINATION_TIMEOUT;
            let mut termination_error = None;
            let termination_succeeded = if self.assigned {
                let ok = unsafe { TerminateJobObject(self.job.raw(), TERMINATION_EXIT) } != 0;
                if !ok {
                    // Capture before the job close or any other API call.
                    termination_error = Some(unsafe { GetLastError() });
                    let _ = self.job.close_checked();
                }
                ok
            } else if self.root.is_valid() {
                let ok = unsafe {
                    windows_sys::Win32::System::Threading::TerminateProcess(
                        self.root.raw(),
                        TERMINATION_EXIT,
                    )
                } != 0;
                if !ok {
                    termination_error = Some(unsafe { GetLastError() });
                }
                ok
            } else {
                true
            };

            let root_waited = !self.root.is_valid() || wait_until(self.root.raw(), deadline);
            let child_waited = !self.child.is_valid() || wait_until(self.child.raw(), deadline);
            let mut active_after = None;
            let mut job_empty = false;
            if self.job.is_valid() {
                while Instant::now() < deadline {
                    match query_active_processes(self.job.raw()) {
                        Ok(active) => {
                            active_after = Some(active);
                            if active == 0 {
                                job_empty = true;
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
            }

            let root_exit = process_exit_code(self.root.raw());
            let child_exit = process_exit_code(self.child.raw());
            let child_closed = self.child.close_checked();
            let root_closed = self.root.close_checked();
            let thread_closed = self.thread.close_checked();
            let input_read_closed = self.input_pipe.0.close_checked();
            let input_write_closed = self.input_pipe.1.close_checked();
            let output_read_closed = self.output_pipe.0.close_checked();
            let output_write_closed = self.output_pipe.1.close_checked();
            let job_closed = self.job.close_checked();
            let all_handles_closed = child_closed
                && root_closed
                && thread_closed
                && input_read_closed
                && input_write_closed
                && output_read_closed
                && output_write_closed
                && job_closed;
            let elapsed = started.elapsed();
            self.cleaned = true;
            CleanupEvidence {
                termination_succeeded,
                termination_error,
                root_waited,
                child_waited,
                root_exit,
                child_exit,
                active_after,
                job_empty,
                all_handles_closed,
                elapsed,
            }
        }
    }

    impl Drop for WorkerGuard {
        fn drop(&mut self) {
            if !self.cleaned {
                let _ = self.cleanup();
            }
        }
    }

    fn query_job_policy(job: HANDLE) -> Result<JOBOBJECT_EXTENDED_LIMIT_INFORMATION, String> {
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        if unsafe {
            QueryInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&mut limits as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                null_mut(),
            )
        } == 0
        {
            return Err(last_error("QueryInformationJobObject policy failed"));
        }
        Ok(limits)
    }

    fn verify_job_member(process: HANDLE, job: HANDLE) -> Result<(), String> {
        let mut in_job = 0;
        if unsafe { IsProcessInJob(process, job, &mut in_job) } == 0 || in_job == 0 {
            return Err(last_error("IsProcessInJob exact membership check failed"));
        }
        Ok(())
    }

    fn write_pipe_all(pipe: HANDLE, bytes: &[u8]) -> Result<(), String> {
        let mut offset = 0usize;
        while offset < bytes.len() {
            let mut written = 0u32;
            let amount = (bytes.len() - offset).min(u32::MAX as usize) as u32;
            if unsafe {
                windows_sys::Win32::Storage::FileSystem::WriteFile(
                    pipe,
                    bytes[offset..].as_ptr(),
                    amount,
                    &mut written,
                    null_mut(),
                )
            } == 0
            {
                return Err(last_error("WriteFile worker request failed"));
            }
            if written == 0 {
                return Err("worker request pipe made no write progress".into());
            }
            offset += written as usize;
        }
        Ok(())
    }

    fn read_bounded_frame(
        pipe: HANDLE,
        root: HANDLE,
        deadline: Instant,
    ) -> Result<Vec<u8>, String> {
        let mut header = [0u8; 4];
        read_pipe_exact(pipe, root, &mut header, deadline)?;
        let payload_len = u32::from_le_bytes(header) as usize;
        if payload_len == 0 || payload_len > worker::MAX_WORKER_FRAME_BYTES {
            return Err("worker frame exceeds configured bound".into());
        }
        let mut frame = Vec::with_capacity(payload_len + 4);
        frame.extend_from_slice(&header);
        frame.resize(payload_len + 4, 0);
        read_pipe_exact(pipe, root, &mut frame[4..], deadline)?;
        Ok(frame)
    }

    fn process_exit_code(process: HANDLE) -> Option<u32> {
        if process.is_null() {
            return None;
        }
        let mut code = 0;
        (unsafe { GetExitCodeProcess(process, &mut code) } != 0).then_some(code)
    }

    fn worker_handle_count(process: HANDLE) -> Result<u32, String> {
        let mut count = 0;
        if unsafe { GetProcessHandleCount(process, &mut count) } == 0 {
            return Err(last_error("GetProcessHandleCount root telemetry failed"));
        }
        Ok(count)
    }

    fn worker_memory_telemetry(process: HANDLE) -> Result<(u64, u64), String> {
        let mut counters = PROCESS_MEMORY_COUNTERS_EX::default();
        counters.cb = size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        if unsafe {
            GetProcessMemoryInfo(
                process,
                (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX)
                    .cast::<PROCESS_MEMORY_COUNTERS>(),
                size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
            )
        } == 0
        {
            return Err(last_error("GetProcessMemoryInfo telemetry failed"));
        }
        Ok((counters.PrivateUsage as u64, counters.WorkingSetSize as u64))
    }

    fn worker_is_live(process: HANDLE) -> bool {
        (unsafe { WaitForSingleObject(process, 0) }) == WAIT_TIMEOUT
    }

    fn validate_cleanup(cleanup: &CleanupEvidence, expect_child: bool) -> Result<(), String> {
        if !cleanup.termination_succeeded {
            return Err(format!(
                "TerminateJobObject failed: {:?}",
                cleanup.termination_error
            ));
        }
        if !cleanup.root_waited || !cleanup.job_empty || cleanup.active_after != Some(0) {
            return Err(format!(
                "bounded root/Job reap incomplete: root_wait={} active_after={:?}",
                cleanup.root_waited, cleanup.active_after
            ));
        }
        if cleanup.root_exit != Some(TERMINATION_EXIT) {
            return Err(format!(
                "unexpected root termination exit: {:?}",
                cleanup.root_exit
            ));
        }
        if expect_child && (!cleanup.child_waited || cleanup.child_exit != Some(TERMINATION_EXIT)) {
            return Err(format!(
                "child termination/reap incomplete: waited={} exit={:?}",
                cleanup.child_waited, cleanup.child_exit
            ));
        }
        if !cleanup.all_handles_closed || cleanup.elapsed > TERMINATION_TIMEOUT {
            return Err(format!(
                "owned handles/deadline incomplete: closed={} elapsed={:?}",
                cleanup.all_handles_closed, cleanup.elapsed
            ));
        }
        Ok(())
    }

    fn memory_case() -> Result<(), String> {
        let mut guard = WorkerGuard::launch(JobPolicy {
            active_process_limit: 1,
        })?;
        let evidence = (|| -> Result<_, String> {
            let observation = guard.handshake(report::ProbeScenario::MemoryBomb)?;
            if !observation.challenge_started
                || observation.allocated_bytes != Some(300 * 1024 * 1024)
                || observation.touched_bytes != Some(300 * 1024 * 1024)
                || observation.policy_enforcement_claimed
            {
                return Err("worker memory challenge observation mismatch".into());
            }
            verify_job_member(guard.root.raw(), guard.job.raw())?;
            if query_job_pids(guard.job.raw())? != [guard.root_pid]
                || query_active_processes(guard.job.raw())? != 1
                || !worker_is_live(guard.root.raw())
            {
                return Err("memory worker was not the sole live Job root".into());
            }
            let first = worker_memory_telemetry(guard.root.raw())?;
            std::thread::sleep(Duration::from_millis(100));
            if !worker_is_live(guard.root.raw()) {
                return Err("memory worker exited between telemetry samples".into());
            }
            let second = worker_memory_telemetry(guard.root.raw())?;
            if !worker_is_live(guard.root.raw()) {
                return Err("memory worker exited after telemetry samples".into());
            }
            Ok((observation, first, second))
        })();
        let cleanup = guard.cleanup();
        validate_cleanup(&cleanup, false)?;
        let (observation, first, second) = evidence?;
        assert!(observation.challenge_started);
        assert_eq!(observation.allocated_bytes, Some(300 * 1024 * 1024));
        assert_eq!(observation.touched_bytes, Some(300 * 1024 * 1024));
        let required_private_commit = 300 * 1024 * 1024;
        assert!(
            first.0 >= required_private_commit,
            "first private-commit sample below fixed allocation: {} < {required_private_commit}",
            first.0
        );
        assert!(
            second.0 >= required_private_commit,
            "second private-commit sample below fixed allocation: {} < {required_private_commit}",
            second.0
        );
        // Private commit and working set are telemetry only; no RSS quota is inferred.
        eprintln!("memory telemetry private/working-set samples: {first:?}, {second:?}");
        Ok(())
    }

    fn challenge_start_case(scenario: report::ProbeScenario) -> Result<(), String> {
        let mut guard = WorkerGuard::launch(JobPolicy {
            active_process_limit: 1,
        })?;
        let evidence = (|| -> Result<worker::WorkerObservation, String> {
            let observation = guard.handshake(scenario)?;
            if !observation.challenge_started || observation.policy_enforcement_claimed {
                return Err(format!(
                    "{scenario:?} observation did not indicate a started challenge"
                ));
            }
            verify_job_member(guard.root.raw(), guard.job.raw())?;
            if query_job_pids(guard.job.raw())? != [guard.root_pid]
                || query_active_processes(guard.job.raw())? != 1
                || !worker_is_live(guard.root.raw())
            {
                return Err(format!(
                    "{scenario:?} worker was not the sole live Job root"
                ));
            }
            std::thread::sleep(Duration::from_millis(50));
            verify_job_member(guard.root.raw(), guard.job.raw())?;
            if query_job_pids(guard.job.raw())? != [guard.root_pid]
                || query_active_processes(guard.job.raw())? != 1
                || !worker_is_live(guard.root.raw())
            {
                return Err(format!(
                    "{scenario:?} worker did not remain live in its Job"
                ));
            }
            Ok(observation)
        })();
        // Terminate now; CPU is not allowed to run for its full 30-second interval.
        let cleanup = guard.cleanup();
        validate_cleanup(&cleanup, false)?;
        let observation = evidence?;
        assert_eq!(observation.scenario, scenario);
        assert_eq!(observation.sequence, 0);
        assert!(observation.challenge_started);
        Ok(())
    }

    fn handle_case() -> Result<(), String> {
        let mut guard = WorkerGuard::launch(JobPolicy {
            active_process_limit: 1,
        })?;
        let evidence = (|| -> Result<_, String> {
            let observation = guard.handshake(report::ProbeScenario::HandleLimit)?;
            if !observation.challenge_started
                || observation.observed_handle_count.unwrap_or(0) <= 64
                || observation.successful_handle_opens != Some(80)
                || observation.policy_enforcement_claimed
            {
                return Err("worker handle telemetry observation mismatch".into());
            }
            verify_job_member(guard.root.raw(), guard.job.raw())?;
            if query_job_pids(guard.job.raw())? != [guard.root_pid]
                || query_active_processes(guard.job.raw())? != 1
                || !worker_is_live(guard.root.raw())
            {
                return Err("handle worker was not the sole live Job root".into());
            }
            let first = worker_handle_count(guard.root.raw())?;
            std::thread::sleep(Duration::from_millis(100));
            let second = worker_handle_count(guard.root.raw())?;
            if first <= 64 || second <= 64 || !worker_is_live(guard.root.raw()) {
                return Err(format!(
                    "live handle telemetry samples were not >64: {first}, {second}"
                ));
            }
            Ok((observation, first, second))
        })();
        let cleanup = guard.cleanup();
        validate_cleanup(&cleanup, false)?;
        let (observation, first, second) = evidence?;
        assert_eq!(observation.successful_handle_opens, Some(80));
        assert!(observation.observed_handle_count.unwrap() > 64);
        // Handle counts are telemetry only; this does not assert a handle quota.
        eprintln!("handle telemetry samples: {first}, {second}");
        Ok(())
    }

    fn process_limit_child_case() -> Result<(), String> {
        // This test-only allowance of two is for successful contained child creation,
        // not a test of the actual ActiveProcessLimit=1 rejection case.
        let mut guard = WorkerGuard::launch(JobPolicy {
            active_process_limit: 2,
        })?;
        let evidence = (|| -> Result<_, String> {
            let observation = guard.handshake(report::ProbeScenario::ProcessLimit)?;
            if !observation.challenge_started
                || observation.child_spawn_succeeded != Some(true)
                || observation.reported_os_error.is_some()
                || observation.policy_enforcement_claimed
            {
                return Err(
                    "process-limit worker did not report successful fixed child spawn".into(),
                );
            }
            let pids = query_job_pids(guard.job.raw())?;
            if pids.len() != 2 || !pids.contains(&guard.root_pid) {
                return Err(format!("complete Job PID list not root+child: {pids:?}"));
            }
            let child_pid = *pids
                .iter()
                .find(|pid| **pid != guard.root_pid)
                .ok_or("Job PID list omitted child")?;
            guard.open_job_child(child_pid)?;
            let expected_image = PathBuf::from(env!("CARGO_BIN_EXE_plugin-sandbox-probe"));
            if !same_image(&process_image(guard.child.raw())?, &expected_image) {
                return Err("contained child image did not match Cargo worker binary".into());
            }
            verify_job_member(guard.root.raw(), guard.job.raw())?;
            verify_job_member(guard.child.raw(), guard.job.raw())?;
            if !worker_is_live(guard.root.raw())
                || !worker_is_live(guard.child.raw())
                || query_active_processes(guard.job.raw())? != 2
            {
                return Err("root and contained child were not both live".into());
            }
            let again = query_job_pids(guard.job.raw())?;
            if again.len() != 2 || !again.contains(&guard.root_pid) || !again.contains(&child_pid) {
                return Err(format!("requeried Job membership changed: {again:?}"));
            }
            verify_job_member(guard.root.raw(), guard.job.raw())?;
            verify_job_member(guard.child.raw(), guard.job.raw())?;
            if !worker_is_live(guard.root.raw()) || !worker_is_live(guard.child.raw()) {
                return Err("root or child exited before final containment check".into());
            }
            Ok((observation, child_pid))
        })();
        let cleanup = guard.cleanup();
        validate_cleanup(&cleanup, true)?;
        let (observation, child_pid) = evidence?;
        assert_eq!(observation.child_spawn_succeeded, Some(true));
        eprintln!(
            "contained child PID {child_pid}; this is not an ActiveProcessLimit=1 rejection test"
        );
        Ok(())
    }

    fn scenario_tree_case(scenario: report::ProbeScenario) -> Result<(), String> {
        let mut guard = WorkerGuard::launch(JobPolicy {
            active_process_limit: 2,
        })?;
        let evidence = (|| -> Result<_, String> {
            let (observation, child_ready) = guard.handshake_tree(scenario)?;
            if !observation.challenge_started
                || observation.policy_enforcement_claimed
                || child_ready.scenario != scenario
                || child_ready.pid == guard.root_pid
            {
                return Err(format!("{scenario:?} tree challenge frames mismatch"));
            }
            let pids = query_job_pids(guard.job.raw())?;
            if pids.len() != 2
                || !pids.contains(&guard.root_pid)
                || !pids.contains(&child_ready.pid)
                || pids[0] == pids[1]
            {
                return Err(format!(
                    "{scenario:?} Job PID list was not exact root+child: {pids:?}"
                ));
            }
            guard.open_job_child(child_ready.pid)?;
            let expected_image = PathBuf::from(env!("CARGO_BIN_EXE_plugin-sandbox-probe"));
            if !same_image(&process_image(guard.child.raw())?, &expected_image) {
                return Err(format!("{scenario:?} child image path mismatch"));
            }
            verify_job_member(guard.root.raw(), guard.job.raw())?;
            verify_job_member(guard.child.raw(), guard.job.raw())?;
            if query_active_processes(guard.job.raw())? != 2
                || !worker_is_live(guard.root.raw())
                || !worker_is_live(guard.child.raw())
            {
                return Err(format!("{scenario:?} root and child were not both live"));
            }
            let pids_after = query_job_pids(guard.job.raw())?;
            verify_job_member(guard.root.raw(), guard.job.raw())?;
            verify_job_member(guard.child.raw(), guard.job.raw())?;
            if pids_after.len() != 2
                || !pids_after.contains(&guard.root_pid)
                || !pids_after.contains(&child_ready.pid)
                || !worker_is_live(guard.root.raw())
                || !worker_is_live(guard.child.raw())
            {
                return Err(format!(
                    "{scenario:?} final membership/liveness check failed"
                ));
            }
            Ok((observation, child_ready))
        })();
        let cleanup = guard.cleanup();
        validate_cleanup(&cleanup, true)?;
        let (observation, child_ready) = evidence?;
        assert_eq!(observation.scenario, scenario);
        assert_eq!(observation.sequence, 0);
        assert!(observation.challenge_started);
        assert_eq!(child_ready.scenario, scenario);
        assert_eq!(child_ready.sequence, 0);
        assert_ne!(child_ready.pid, guard.root_pid);
        Ok(())
    }

    #[test]
    fn memory_worker_retains_fixed_allocation_under_fresh_job() {
        if let Err(error) = memory_case() {
            panic!("memory worker characterization failed after cleanup: {error}");
        }
    }

    #[test]
    fn handle_worker_retains_open_handles_under_fresh_job() {
        if let Err(error) = handle_case() {
            panic!("handle worker characterization failed after cleanup: {error}");
        }
    }

    #[test]
    fn process_limit_child_remains_in_its_test_job() {
        if let Err(error) = process_limit_child_case() {
            panic!("process child characterization failed after cleanup: {error}");
        }
    }

    #[test]
    fn cpu_worker_flushes_start_observation_before_fixed_loop() {
        if let Err(error) = challenge_start_case(report::ProbeScenario::CpuLoop) {
            panic!("CPU worker challenge-start characterization failed after cleanup: {error}");
        }
    }

    #[test]
    fn wall_clock_worker_flushes_start_observation_before_spin() {
        if let Err(error) = challenge_start_case(report::ProbeScenario::WallClockTimeout) {
            panic!("wall-clock worker characterization failed after cleanup: {error}");
        }
    }

    #[test]
    fn hard_kill_worker_starts_scenario_matched_tree_in_its_job() {
        if let Err(error) = scenario_tree_case(report::ProbeScenario::HardKill) {
            panic!("hard-kill tree characterization failed after cleanup: {error}");
        }
    }

    #[test]
    fn reap_deadline_worker_starts_scenario_matched_tree_in_its_job() {
        if let Err(error) = scenario_tree_case(report::ProbeScenario::ReapDeadline) {
            panic!("reap-deadline tree characterization failed after cleanup: {error}");
        }
    }
}
