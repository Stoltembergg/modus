use crate::report::{
    ChallengeEvidence, EnforcementState, ExitEvidence, LaunchEvidence, PolicyEvidence,
    ProbeScenario, ProcessCountEvidence, ReapEvidence, ScenarioResult, ScenarioStatus,
    TerminationEvidence,
};
use crate::worker::{MAX_WORKER_FRAME_BYTES, parse_child_ready_frame};
use std::mem::{size_of, size_of_val};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::slice;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::ReadFile;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicAccountingInformation,
    JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation, QueryInformationJobObject,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::{CreatePipe, PeekNamedPipe};
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    GetExitCodeProcess, GetProcessId, InitializeProcThreadAttributeList, OpenProcess,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, QueryFullProcessImageNameW, ResumeThread, STARTF_USESTDHANDLES,
    STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
};

const READY_DEADLINE: Duration = Duration::from_secs(3);
const REAP_DEADLINE: Duration = Duration::from_secs(2);
const JOB_TERMINATION_EXIT: u32 = 0xE001;
const STILL_ACTIVE: u32 = 259;

struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn new(raw: HANDLE) -> Self {
        Self(raw)
    }

    fn raw(&self) -> HANDLE {
        self.0
    }

    fn is_valid(&self) -> bool {
        !self.0.is_null()
    }

    fn close_checked(&mut self) -> bool {
        if self.0.is_null() {
            return true;
        }
        if unsafe { CloseHandle(self.0) } != 0 {
            self.0 = null_mut();
            true
        } else {
            false
        }
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        let _ = self.close_checked();
    }
}

struct AttributeList {
    raw: *mut core::ffi::c_void,
    storage: Vec<usize>,
    initialized: bool,
}

impl AttributeList {
    fn with_inherited_handles(handles: &[HANDLE]) -> Result<Self, String> {
        let mut required_bytes = 0usize;
        let probe_succeeded =
            unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut required_bytes) }
                != 0;
        let _probe_error = unsafe { GetLastError() };
        if probe_succeeded || required_bytes == 0 {
            return Err("InitializeProcThreadAttributeList size query was invalid".into());
        }

        let mut storage = vec![0usize; required_bytes.div_ceil(size_of::<usize>())];
        let raw = storage.as_mut_ptr().cast::<core::ffi::c_void>();
        if unsafe { InitializeProcThreadAttributeList(raw, 1, 0, &mut required_bytes) } == 0 {
            let error = unsafe { GetLastError() };
            return Err(format!("InitializeProcThreadAttributeList failed: {error}"));
        }
        let list = Self {
            raw,
            storage,
            initialized: true,
        };
        let updated = unsafe {
            UpdateProcThreadAttribute(
                list.raw,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),
                size_of_val(handles),
                null_mut(),
                null(),
            )
        } != 0;
        if !updated {
            let error = unsafe { GetLastError() };
            return Err(format!(
                "UpdateProcThreadAttribute handle list failed: {error}"
            ));
        }
        // Keep the backing allocation alive for the attribute list lifetime.
        let _ = list.storage.len();
        Ok(list)
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        if self.initialized {
            unsafe { DeleteProcThreadAttributeList(self.raw) };
            self.initialized = false;
        }
    }
}

fn last_error(context: &str) -> String {
    let code = unsafe { GetLastError() };
    format!("{context}: {code}")
}

fn create_pipe() -> Result<(OwnedHandle, OwnedHandle), String> {
    let mut security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let mut read = null_mut();
    let mut write = null_mut();
    if unsafe { CreatePipe(&mut read, &mut write, &mut security, 0) } == 0 {
        let error = last_error("CreatePipe failed");
        let mut read = OwnedHandle::new(read);
        let mut write = OwnedHandle::new(write);
        let _ = read.close_checked();
        let _ = write.close_checked();
        return Err(error);
    }
    Ok((OwnedHandle::new(read), OwnedHandle::new(write)))
}

fn query_job_pids(job: HANDLE) -> Result<Vec<u32>, String> {
    let header_bytes = 2 * size_of::<u32>();
    let mut capacity = 2usize;
    for _ in 0..5 {
        let byte_len = header_bytes + capacity * size_of::<usize>();
        let mut storage = vec![0usize; byte_len.div_ceil(size_of::<usize>())];
        let info = storage
            .as_mut_ptr()
            .cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
        if unsafe {
            QueryInformationJobObject(
                job,
                JobObjectBasicProcessIdList,
                info.cast(),
                byte_len as u32,
                null_mut(),
            )
        } == 0
        {
            return Err(last_error("QueryInformationJobObject process list failed"));
        }
        let assigned = unsafe { (*info).NumberOfAssignedProcesses as usize };
        let listed = unsafe { (*info).NumberOfProcessIdsInList as usize };
        if listed < assigned || listed > capacity {
            capacity = assigned.max(capacity.saturating_mul(2)).max(2);
            continue;
        }
        let ids = unsafe { slice::from_raw_parts((*info).ProcessIdList.as_ptr(), listed) };
        let mut pids = Vec::with_capacity(listed);
        for id in ids {
            let pid = u32::try_from(*id)
                .map_err(|_| "Job process ID does not fit in a Windows PID".to_string())?;
            pids.push(pid);
        }
        return Ok(pids);
    }
    Err("Job process ID list remained truncated after bounded retries".into())
}

fn query_active_processes(job: HANDLE) -> Result<u32, String> {
    let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    if unsafe {
        QueryInformationJobObject(
            job,
            JobObjectBasicAccountingInformation,
            (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
            size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
            null_mut(),
        )
    } == 0
    {
        return Err(last_error("QueryInformationJobObject accounting failed"));
    }
    Ok(accounting.ActiveProcesses)
}

fn read_pipe_exact(
    pipe: HANDLE,
    root_process: HANDLE,
    output: &mut [u8],
    deadline: Instant,
) -> Result<(), String> {
    let mut offset = 0usize;
    while offset < output.len() {
        if Instant::now() >= deadline {
            return Err("child readiness pipe deadline exceeded".into());
        }
        match unsafe { WaitForSingleObject(root_process, 0) } {
            WAIT_TIMEOUT => {}
            WAIT_OBJECT_0 => return Err("root worker exited before child readiness".into()),
            _ => {
                return Err(last_error(
                    "WaitForSingleObject root readiness check failed",
                ));
            }
        }
        let mut available = 0u32;
        if unsafe { PeekNamedPipe(pipe, null_mut(), 0, null_mut(), &mut available, null_mut()) }
            == 0
        {
            return Err(last_error("PeekNamedPipe failed"));
        }
        if available == 0 {
            std::thread::sleep(Duration::from_millis(2));
            continue;
        }
        let count = (output.len() - offset).min(available as usize) as u32;
        let mut read = 0u32;
        if unsafe {
            ReadFile(
                pipe,
                output[offset..].as_mut_ptr(),
                count,
                &mut read,
                null_mut(),
            )
        } == 0
        {
            return Err(last_error("ReadFile child readiness failed"));
        }
        if read == 0 {
            return Err("child readiness pipe returned EOF before frame completion".into());
        }
        offset += read as usize;
    }
    Ok(())
}

fn read_child_ready(pipe: HANDLE, root: HANDLE) -> Result<crate::worker::ChildReady, String> {
    let deadline = Instant::now() + READY_DEADLINE;
    let mut header = [0u8; 4];
    read_pipe_exact(pipe, root, &mut header, deadline)?;
    let payload_len = u32::from_le_bytes(header) as usize;
    if payload_len == 0 || payload_len > MAX_WORKER_FRAME_BYTES {
        return Err("child readiness frame exceeds the 4 KiB bound".into());
    }
    let mut frame = Vec::with_capacity(payload_len + 4);
    frame.extend_from_slice(&header);
    frame.resize(payload_len + 4, 0);
    read_pipe_exact(pipe, root, &mut frame[4..], deadline)?;
    let mut trailing = 0u32;
    if unsafe { PeekNamedPipe(pipe, null_mut(), 0, null_mut(), &mut trailing, null_mut()) } == 0 {
        return Err(last_error("PeekNamedPipe trailing-data check failed"));
    }
    if trailing != 0 {
        return Err("child emitted bytes beyond its single readiness frame".into());
    }
    parse_child_ready_frame(&frame)
}

fn process_image(process: HANDLE) -> Result<PathBuf, String> {
    let mut wide = vec![0u16; 32_768];
    let mut length = wide.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process, 0, wide.as_mut_ptr(), &mut length) } == 0 {
        return Err(last_error("QueryFullProcessImageNameW failed"));
    }
    let image = String::from_utf16(&wide[..length as usize])
        .map_err(|error| format!("child image path was invalid UTF-16: {error}"))?;
    Ok(PathBuf::from(image))
}

fn same_image(actual: &Path, expected: &Path) -> bool {
    let actual = actual
        .canonicalize()
        .unwrap_or_else(|_| actual.to_path_buf());
    let expected = expected
        .canonicalize()
        .unwrap_or_else(|_| expected.to_path_buf());
    actual
        .to_string_lossy()
        .eq_ignore_ascii_case(&expected.to_string_lossy())
}

fn wait_until(handle: HANDLE, deadline: Instant) -> bool {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return false;
    }
    let millis = remaining
        .as_millis()
        .saturating_add(u128::from(remaining.subsec_nanos() % 1_000_000 != 0))
        .min(u32::MAX as u128) as u32;
    millis > 0 && unsafe { WaitForSingleObject(handle, millis) } == WAIT_OBJECT_0
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CleanupDecision {
    CloseJobBeforeWait,
    RetainJobForPolling,
    TerminateRoot,
}

fn cleanup_decision(assigned: bool, job_termination_succeeded: bool) -> CleanupDecision {
    match (assigned, job_termination_succeeded) {
        (true, false) => CleanupDecision::CloseJobBeforeWait,
        (true, true) => CleanupDecision::RetainJobForPolling,
        (false, _) => CleanupDecision::TerminateRoot,
    }
}

fn child_wait_completed(child_handle_acquired: bool, child_waited: bool) -> bool {
    child_handle_acquired && child_waited
}

fn setup_child_wait_completed(
    resumed: bool,
    child_handle_acquired: bool,
    child_waited: bool,
) -> bool {
    if !resumed && !child_handle_acquired {
        return false;
    }
    child_wait_completed(child_handle_acquired, child_waited)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CleanupStep {
    CloseJobBeforeWait,
    WaitRoot,
    WaitChild,
    PollActiveProcesses,
}

fn cleanup_steps(
    assigned: bool,
    termination_succeeded: bool,
    child_handle_acquired: bool,
) -> Vec<CleanupStep> {
    let decision = cleanup_decision(assigned, termination_succeeded);
    let mut steps = Vec::with_capacity(4);
    if decision == CleanupDecision::CloseJobBeforeWait {
        steps.push(CleanupStep::CloseJobBeforeWait);
    }
    steps.push(CleanupStep::WaitRoot);
    if child_handle_acquired {
        steps.push(CleanupStep::WaitChild);
    }
    if decision == CleanupDecision::RetainJobForPolling {
        steps.push(CleanupStep::PollActiveProcesses);
    }
    steps
}

struct SetupCleanup {
    terminated: bool,
    termination_error: Option<u32>,
    root_waited: bool,
    child_waited: bool,
    active_after: Option<u32>,
    job_empty: bool,
    root_exit: Option<u32>,
    child_exit: Option<u32>,
    job_closed: bool,
    all_handles_closed: bool,
    elapsed_ms: u64,
}

fn terminate_failed_setup(
    job: &mut OwnedHandle,
    root: &mut OwnedHandle,
    child: &mut OwnedHandle,
    thread: &mut OwnedHandle,
    assigned: bool,
    resumed: bool,
    input_pipe: &mut (OwnedHandle, OwnedHandle),
    output_pipe: &mut (OwnedHandle, OwnedHandle),
) -> SetupCleanup {
    let started = Instant::now();
    let deadline = started + REAP_DEADLINE;
    let mut termination_error = None;
    let terminated = if assigned && job.is_valid() {
        let terminated = unsafe { TerminateJobObject(job.raw(), JOB_TERMINATION_EXIT) != 0 };
        if !terminated {
            // GetLastError must be captured before CloseHandle or any other API call.
            termination_error = Some(unsafe { GetLastError() });
        }
        terminated
    } else if root.is_valid() {
        let terminated = unsafe {
            windows_sys::Win32::System::Threading::TerminateProcess(
                root.raw(),
                JOB_TERMINATION_EXIT,
            ) != 0
        };
        if !terminated {
            termination_error = Some(unsafe { GetLastError() });
        }
        terminated
    } else {
        true
    };

    let steps = cleanup_steps(assigned, terminated, child.is_valid());
    let mut job_closed_before_wait = false;
    let mut root_waited = false;
    let mut child_waited_raw = false;
    let mut active_after = None;
    let mut job_empty = false;
    for step in steps {
        match step {
            CleanupStep::CloseJobBeforeWait => {
                job_closed_before_wait = job.close_checked();
            }
            CleanupStep::WaitRoot => {
                root_waited = !root.is_valid() || wait_until(root.raw(), deadline);
            }
            CleanupStep::WaitChild => {
                child_waited_raw = child.is_valid() && wait_until(child.raw(), deadline);
            }
            CleanupStep::PollActiveProcesses => {
                while Instant::now() < deadline {
                    match query_active_processes(job.raw()) {
                        Ok(active) => {
                            active_after = Some(active);
                            if active == 0 {
                                job_empty = true;
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        }
    }
    let child_waited = setup_child_wait_completed(resumed, child.is_valid(), child_waited_raw);
    let mut root_exit = 0;
    let root_exit =
        if root.is_valid() && unsafe { GetExitCodeProcess(root.raw(), &mut root_exit) } != 0 {
            Some(root_exit)
        } else {
            None
        };
    let mut child_exit = 0;
    let child_exit =
        if child.is_valid() && unsafe { GetExitCodeProcess(child.raw(), &mut child_exit) } != 0 {
            Some(child_exit)
        } else {
            None
        };
    let root_closed = root.close_checked();
    let child_closed = child.close_checked();
    let thread_closed = thread.close_checked();
    let input_read_closed = input_pipe.0.close_checked();
    let input_write_closed = input_pipe.1.close_checked();
    let output_read_closed = output_pipe.0.close_checked();
    let output_write_closed = output_pipe.1.close_checked();
    let job_closed = job_closed_before_wait || job.close_checked();
    SetupCleanup {
        terminated,
        termination_error,
        root_waited,
        child_waited,
        active_after,
        job_empty,
        root_exit,
        child_exit,
        job_closed,
        all_handles_closed: root_closed
            && child_closed
            && thread_closed
            && input_read_closed
            && input_write_closed
            && output_read_closed
            && output_write_closed
            && job_closed,
        elapsed_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
    }
}

#[cfg(test)]
mod cleanup_decision_tests {
    use super::{
        CleanupDecision, CleanupStep, child_wait_completed, cleanup_decision, cleanup_steps,
        setup_child_wait_completed,
    };

    #[test]
    fn failed_job_termination_closes_job_before_waiting() {
        assert_eq!(
            cleanup_decision(true, false),
            CleanupDecision::CloseJobBeforeWait
        );
    }

    #[test]
    fn successful_job_termination_keeps_job_for_active_count_polling() {
        assert_eq!(
            cleanup_decision(true, true),
            CleanupDecision::RetainJobForPolling
        );
    }

    #[test]
    fn missing_child_handle_cannot_complete_child_wait() {
        assert!(!child_wait_completed(false, true));
        assert!(child_wait_completed(true, true));
    }

    #[test]
    fn pre_resume_cleanup_without_child_handle_does_not_claim_child_wait() {
        assert!(!setup_child_wait_completed(false, false, false));
    }

    #[test]
    fn failed_termination_plan_closes_job_before_bounded_waits() {
        assert_eq!(
            cleanup_steps(true, false, true),
            [
                CleanupStep::CloseJobBeforeWait,
                CleanupStep::WaitRoot,
                CleanupStep::WaitChild,
            ]
        );
    }
}

pub(super) fn run_child_tree_case() -> Result<ScenarioResult, String> {
    let started = Instant::now();
    let mut job = OwnedHandle::new(unsafe { CreateJobObjectW(null(), null()) });
    if !job.is_valid() {
        return Err(last_error("CreateJobObjectW failed"));
    }
    let mut job_limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    job_limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.raw(),
            JobObjectExtendedLimitInformation,
            (&job_limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err(last_error("SetInformationJobObject failed"));
    }

    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let executable = if executable
        .parent()
        .and_then(|parent| parent.file_name())
        .is_some_and(|name| name == "deps")
    {
        executable
            .parent()
            .and_then(|parent| parent.parent())
            .ok_or("test executable has no target directory")?
            .join("plugin-sandbox-probe.exe")
    } else {
        executable
    };
    if !executable.is_file() {
        return Err(format!(
            "fixed worker executable is missing: {}",
            executable.display()
        ));
    }

    // CreatePipe marks both ends inheritable. Remove inheritance from the
    // parent-only ends; the handle-list attribute will whitelist the other two.
    let mut input_pipe = create_pipe()?; // child reads, parent closes writer for EOF
    let mut output_pipe = create_pipe()?; // parent reads, child writes readiness
    if unsafe { SetHandleInformation(input_pipe.1.raw(), HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(last_error("SetHandleInformation parent input end failed"));
    }
    if unsafe { SetHandleInformation(output_pipe.0.raw(), HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(last_error("SetHandleInformation parent output end failed"));
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

    let executable_wide: Vec<u16> = executable
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let command_line = format!("\"{}\" --worker-child-challenge", executable.display());
    let mut command_wide: Vec<u16> = command_line
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut process_info = PROCESS_INFORMATION::default();
    let created = unsafe {
        CreateProcessW(
            executable_wide.as_ptr(),
            command_wide.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
            null(),
            null(),
            &startup.StartupInfo,
            &mut process_info,
        )
    } != 0;
    if !created {
        return Err(last_error("CreateProcessW suspended pipe worker failed"));
    }
    let mut root = OwnedHandle::new(process_info.hProcess);
    let mut thread = OwnedHandle::new(process_info.hThread);
    let mut child = OwnedHandle::new(null_mut());
    drop(attributes);

    let child_stdin_closed = input_pipe.0.close_checked();
    let child_stdout_closed = output_pipe.1.close_checked();
    let parent_stdin_closed = input_pipe.1.close_checked();
    let mut assigned = false;
    let mut resumed = false;
    let setup = (|| -> Result<(u32, Vec<u32>, u32), String> {
        if !child_stdin_closed || !child_stdout_closed || !parent_stdin_closed {
            return Err(
                "one or more parent pipe-handle closes failed after worker creation".into(),
            );
        }
        if unsafe { AssignProcessToJobObject(job.raw(), root.raw()) } == 0 {
            return Err(last_error("AssignProcessToJobObject failed"));
        }
        assigned = true;
        let mut root_member = 0;
        if unsafe { IsProcessInJob(root.raw(), job.raw(), &mut root_member) } == 0
            || root_member == 0
        {
            return Err(last_error("root IsProcessInJob verification failed"));
        }
        let mut queried = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        if unsafe {
            QueryInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                (&mut queried as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                null_mut(),
            )
        } == 0
        {
            return Err(last_error("QueryInformationJobObject policy failed"));
        }
        if queried.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE == 0 {
            return Err("queried Job policy omitted KILL_ON_JOB_CLOSE".into());
        }
        let root_pids = query_job_pids(job.raw())?;
        if root_pids != [process_info.dwProcessId] {
            return Err(format!(
                "suspended root Job PID list was not exact: {root_pids:?}"
            ));
        }
        let launch = unsafe { ResumeThread(thread.raw()) };
        if launch == u32::MAX {
            return Err(last_error("ResumeThread failed"));
        }
        resumed = true;
        let ready = read_child_ready(output_pipe.0.raw(), root.raw())?;
        if ready.pid == process_info.dwProcessId {
            return Err("child readiness PID equals root worker PID".into());
        }
        let pids = query_job_pids(job.raw())?;
        if pids.len() != 2
            || !pids.contains(&process_info.dwProcessId)
            || !pids.contains(&ready.pid)
            || pids[0] == pids[1]
        {
            return Err(format!(
                "complete Job PID list did not contain exactly root+ready child: {pids:?}"
            ));
        }
        let child_handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                ready.pid,
            )
        };
        if child_handle.is_null() {
            return Err(last_error("OpenProcess correlated child PID failed"));
        }
        child = OwnedHandle::new(child_handle);
        if unsafe { GetProcessId(child.raw()) } != ready.pid {
            return Err("retained child handle PID did not match readiness frame".into());
        }
        let mut child_member = 0;
        if unsafe { IsProcessInJob(child.raw(), job.raw(), &mut child_member) } == 0
            || child_member == 0
        {
            return Err(last_error(
                "retained child IsProcessInJob verification failed",
            ));
        }
        if !same_image(&process_image(child.raw())?, &executable) {
            return Err("child full image path did not match the fixed probe executable".into());
        }
        if unsafe { WaitForSingleObject(child.raw(), 0) } != WAIT_TIMEOUT
            || unsafe { WaitForSingleObject(root.raw(), 0) } != WAIT_TIMEOUT
        {
            return Err("root or child exited before termination challenge".into());
        }
        let mut root_exit = 0;
        let mut child_exit = 0;
        if unsafe { GetExitCodeProcess(root.raw(), &mut root_exit) } == 0
            || unsafe { GetExitCodeProcess(child.raw(), &mut child_exit) } == 0
            || root_exit != STILL_ACTIVE
            || child_exit != STILL_ACTIVE
        {
            return Err("root or child was not still active at challenge observation".into());
        }
        let active = query_active_processes(job.raw())?;
        if active != 2 {
            return Err(format!(
                "expected two live Job processes, observed {active}"
            ));
        }
        Ok((ready.pid, pids, active))
    })();

    let (child_pid, pids_before, active_before) = match setup {
        Ok(observed) => observed,
        Err(error) => {
            let cleanup = terminate_failed_setup(
                &mut job,
                &mut root,
                &mut child,
                &mut thread,
                assigned,
                resumed,
                &mut input_pipe,
                &mut output_pipe,
            );
            let mut result = ScenarioResult::not_tested(ProbeScenario::ChildProcessTree);
            result.status = ScenarioStatus::Failed;
            result.mechanism = Some("Windows Job Object setup and bounded cleanup".into());
            result.raw_os_error = cleanup.termination_error;
            result.worker_terminated = cleanup.terminated
                && cleanup.root_waited
                && cleanup.root_exit == Some(JOB_TERMINATION_EXIT);
            result.job_empty = cleanup.job_empty;
            result.worker_wait_completed = cleanup.root_waited;
            result.tree_wait_completed =
                cleanup.root_waited && cleanup.child_waited && cleanup.job_empty;
            result.stop_to_reap_ms = Some(cleanup.elapsed_ms);
            result.kill_to_reap_ms = Some(cleanup.elapsed_ms);
            result.termination = Some(TerminationEvidence {
                method: if assigned {
                    "terminate_job_object".into()
                } else {
                    "terminate_process".into()
                },
                requested: cleanup.terminated,
                raw_os_error: cleanup.termination_error,
                requested_exit_code: Some(JOB_TERMINATION_EXIT),
            });
            result.exit = Some(ExitEvidence {
                worker_exit_code: cleanup.root_exit,
                worker_wait_completed: cleanup.root_waited,
                tree_wait_completed: result.tree_wait_completed,
                child_exit_code: cleanup.child_exit,
                child_wait_completed: cleanup.child_waited,
            });
            result.duration_ms = Some(started.elapsed().as_millis() as u64);
            result.process_count = Some(ProcessCountEvidence {
                active_before: None,
                active_after: cleanup.active_after,
            });
            result.reap = Some(ReapEvidence {
                stop_to_reap_ms: Some(cleanup.elapsed_ms),
                kill_to_reap_ms: Some(cleanup.elapsed_ms),
                deadline_ms: 2_000,
                tree_wait_completed: result.tree_wait_completed,
                all_handles_closed: cleanup.all_handles_closed,
                job_handle_closed: cleanup.job_closed,
            });
            result.reason = format!(
                "child-tree setup failed: {error}; termination_requested={} termination_error={:?} root_wait={} child_wait={} active_after={:?} job_empty={} handles_closed={} elapsed_ms={}",
                cleanup.terminated,
                cleanup.termination_error,
                cleanup.root_waited,
                cleanup.child_waited,
                cleanup.active_after,
                cleanup.job_empty,
                cleanup.all_handles_closed,
                cleanup.elapsed_ms
            );
            return Ok(result);
        }
    };

    let mut result = ScenarioResult::not_tested(ProbeScenario::ChildProcessTree);
    result.launch = Some(LaunchEvidence {
        created_suspended: true,
        job_assigned_before_resume: true,
        membership_verified: true,
    });
    result.policy = Some(PolicyEvidence {
        configured: Some("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (cleanup safeguard)".into()),
        queried: Some("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE".into()),
        effective_verified: true,
    });
    result.challenge = Some(ChallengeEvidence {
        kind: "host_owned_child_ready_frame".into(),
        observed: true,
        detail: Some(format!(
            "bounded child frame PID {child_pid}; complete fresh-Job PID list {pids_before:?}; retained child handle verified live and in exact Job"
        )),
    });
    result.challenge_observed = true;
    result.mechanism = Some("fresh Windows Job Object membership and TerminateJobObject".into());
    result.effective_policy_verified = true;
    result.enforcement = EnforcementState::Verified;
    result.independent_evidence = Some(format!(
        "CreateProcessW root PID {}; child PID {child_pid}; complete Job PID list {pids_before:?}; active_before={active_before}",
        process_info.dwProcessId
    ));
    result.enforcement_attributed = true;
    result.child = Some(crate::report::ChildEvidence {
        ready: true,
        pid: Some(child_pid),
        root_pid: Some(process_info.dwProcessId),
        membership_verified: true,
        process_handle_retained: true,
    });
    result.process_count = Some(ProcessCountEvidence {
        active_before: Some(active_before),
        active_after: None,
    });

    let kill_started = Instant::now();
    let cleanup_deadline = kill_started + REAP_DEADLINE;
    let terminated = unsafe { TerminateJobObject(job.raw(), JOB_TERMINATION_EXIT) } != 0;
    let termination_error = if terminated {
        None
    } else {
        Some(unsafe { GetLastError() })
    };
    let steps = cleanup_steps(assigned, terminated, child.is_valid());
    let mut job_closed_before_wait = false;
    let mut root_wait = false;
    let mut child_wait_raw = false;
    let mut active_after = None;
    let mut job_empty = false;
    for step in steps {
        match step {
            CleanupStep::CloseJobBeforeWait => {
                job_closed_before_wait = job.close_checked();
            }
            CleanupStep::WaitRoot => {
                root_wait = wait_until(root.raw(), cleanup_deadline);
            }
            CleanupStep::WaitChild => {
                child_wait_raw = child.is_valid() && wait_until(child.raw(), cleanup_deadline);
            }
            CleanupStep::PollActiveProcesses => {
                while Instant::now() < cleanup_deadline {
                    match query_active_processes(job.raw()) {
                        Ok(active) => {
                            active_after = Some(active);
                            if active == 0 {
                                job_empty = true;
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        }
    }
    let child_wait = child_wait_completed(child.is_valid(), child_wait_raw);
    let mut root_exit = 0;
    let root_exit_code = if unsafe { GetExitCodeProcess(root.raw(), &mut root_exit) } != 0 {
        Some(root_exit)
    } else {
        None
    };
    let mut child_exit = 0;
    let child_exit_code = if unsafe { GetExitCodeProcess(child.raw(), &mut child_exit) } != 0 {
        Some(child_exit)
    } else {
        None
    };
    let expected_codes = root_exit_code == Some(JOB_TERMINATION_EXIT)
        && child_exit_code == Some(JOB_TERMINATION_EXIT);

    // Release process references before checking accounting, then close the Job
    // last. The final elapsed time includes every owned handle close.
    let child_closed = child.close_checked();
    let root_closed = root.close_checked();
    let thread_closed = thread.close_checked();
    let output_read_closed = output_pipe.0.close_checked();
    let input_read_closed = input_pipe.0.close_checked();
    let input_write_closed = input_pipe.1.close_checked();
    let output_write_closed = output_pipe.1.close_checked();
    let job_closed = job_closed_before_wait || job.close_checked();
    let elapsed = kill_started.elapsed();
    let elapsed_ms = elapsed.as_millis().min(u64::MAX as u128) as u64;
    let all_handles_closed = child_closed
        && root_closed
        && thread_closed
        && output_read_closed
        && input_read_closed
        && input_write_closed
        && output_write_closed
        && job_closed;
    let complete = terminated
        && termination_error.is_none()
        && root_wait
        && child_wait
        && expected_codes
        && job_empty
        && all_handles_closed
        && elapsed <= REAP_DEADLINE;

    result.status = if complete {
        ScenarioStatus::Passed
    } else {
        ScenarioStatus::Failed
    };
    result.enforcement_attributed = complete;
    result.worker_terminated =
        terminated && root_wait && root_exit_code == Some(JOB_TERMINATION_EXIT);
    result.job_empty = job_empty;
    result.worker_wait_completed = root_wait;
    result.tree_wait_completed = root_wait && child_wait && job_empty;
    result.stop_to_reap_ms = Some(elapsed_ms);
    result.kill_to_reap_ms = Some(elapsed_ms);
    result.termination = Some(TerminationEvidence {
        method: "terminate_job_object".into(),
        requested: terminated,
        raw_os_error: termination_error,
        requested_exit_code: Some(JOB_TERMINATION_EXIT),
    });
    result.exit = Some(ExitEvidence {
        worker_exit_code: root_exit_code,
        worker_wait_completed: root_wait,
        tree_wait_completed: root_wait && child_wait && job_empty,
        child_exit_code,
        child_wait_completed: child_wait,
    });
    result.duration_ms = Some(started.elapsed().as_millis() as u64);
    result.process_count.as_mut().unwrap().active_after = active_after;
    result.reap = Some(ReapEvidence {
        stop_to_reap_ms: Some(elapsed_ms),
        kill_to_reap_ms: Some(elapsed_ms),
        deadline_ms: 2_000,
        tree_wait_completed: root_wait && child_wait && job_empty,
        all_handles_closed,
        job_handle_closed: job_closed,
    });
    result.reason = if complete {
        "fixed child readiness, exact Job membership, termination exits, and bounded cleanup verified".into()
    } else {
        format!(
            "child-tree cleanup incomplete: terminate={terminated} root_wait={root_wait} child_wait={child_wait} exit_codes={expected_codes} active_after={active_after:?} job_empty={job_empty} handles_closed={all_handles_closed} within_deadline={}",
            elapsed <= REAP_DEADLINE
        )
    };
    Ok(result)
}

// Keep the approved child-tree implementation private to this module while
// allowing the orchestration layer to preserve its existing behavior.
pub(super) fn forward_child_tree_case() -> Result<ScenarioResult, String> {
    run_child_tree_case()
}
