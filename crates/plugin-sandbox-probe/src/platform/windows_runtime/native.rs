//! Suspended, one-root Windows native session. This checkpoint intentionally
//! has no resume, worker IPC, or scenario API.

#[cfg(test)]
use super::ownership::QpcOrigin;
use super::ownership::{CaseClock, CaseTimestamp, ClockError, CloseEvidence, OwnedHandle};
use std::ffi::c_void;
use std::mem::{size_of, size_of_val};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, IntoRawHandle, OwnedHandle as StdOwnedHandle};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::slice;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
#[cfg(test)]
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Foundation::{
    DuplicateHandle, GetLastError, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation,
    WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicAccountingInformation,
    JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation, QueryInformationJobObject,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    GetCurrentProcess, GetExitCodeProcess, InitializeProcThreadAttributeList,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    QueryFullProcessImageNameW, STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject,
};

const SETUP_EXIT: u32 = 0xE101;
const JOB_EXIT: u32 = 0xE102;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum NativeStage {
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
    CleanupTerminateProcess,
    CleanupTerminateJob,
    CleanupWaitRoot,
    CleanupQueryJob,
    CleanupCloseJob,
    CleanupCloseRoot,
    CleanupCloseThread,
    CleanupCloseInputRead,
    CleanupCloseInputWrite,
    CleanupCloseOutputRead,
    CleanupCloseOutputWrite,
    CleanupWatchdogCompletion,
    #[cfg(test)]
    TestRootObserver,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct NativeOperationError {
    pub stage: NativeStage,
    pub raw_os_error: Option<u32>,
}

#[derive(Debug)]
pub(super) struct CleanupEvidence {
    pub continuation_safe: bool,
    pub root_termination_attempted: bool,
    pub root_termination_succeeded: bool,
    pub job_termination_attempted: bool,
    pub job_termination_succeeded: bool,
    pub root_wait_completed: bool,
    pub root_exit_code: Option<u32>,
    pub active_processes_after: Option<u32>,
    pub job_empty: bool,
    pub watchdog_completed: bool,
    pub watchdog_command_sent: bool,
    pub root_confirmation_sent: bool,
    pub watchdog_thread_ended: bool,
    pub watchdog_join_succeeded: bool,
    pub watchdog_recovery_confirmed: bool,
    pub watchdog_fired: bool,
    pub watchdog_intervened: bool,
    pub watchdog_duplicate_closed: bool,
    pub all_handles_closed: bool,
    pub clock_invalid: bool,
    pub clock_error: Option<u32>,
    pub cleanup_deadline: Option<Instant>,
    pub completed_at: Option<Instant>,
    #[cfg(test)]
    pub cleanup_deadline_qpc: Option<i64>,
    #[cfg(test)]
    pub completed_at_qpc: Option<i64>,
    pub close_errors: Vec<u32>,
    pub native_errors: Vec<u32>,
    #[cfg(test)]
    pub watchdog_duplicate_raw_for_test: Option<usize>,
    #[cfg(test)]
    pub watchdog_duplicate_close_backend_calls: usize,
    #[cfg(test)]
    pub job_close_raw_for_test: Option<usize>,
    #[cfg(test)]
    pub job_close_backend_calls: usize,
}

#[derive(Debug)]
pub(super) struct NativeFailure {
    pub initiating: NativeOperationError,
    pub cleanup: CleanupEvidence,
    pub root_pid: Option<u32>,
    #[cfg(test)]
    pub case_origin_for_test: Option<Instant>,
    #[cfg(test)]
    pub qpc_origin_for_test: Option<QpcOrigin>,
    #[cfg(test)]
    pub failure_observed_qpc: Option<i64>,
    #[cfg(test)]
    pub scheduled_stop_qpc: Option<i64>,
    #[cfg(test)]
    pub watchdog_duplicate_close_attempts: usize,
    #[cfg(test)]
    pub watchdog_spawn_failure_branch: bool,
    #[cfg(test)]
    pub watchdog_duplicate_raw_for_test: Option<usize>,
}

#[cfg(test)]
#[derive(Default)]
pub(super) struct ValidationOverrides {
    pub queried_job_limit_flags: Option<u32>,
    pub is_process_in_job: Option<bool>,
    pub job_process_ids: Option<Vec<u32>>,
    pub active_processes: Option<u32>,
}

#[derive(Clone, Copy, Debug)]
struct WatchdogResult {
    fired: bool,
    intervened: bool,
    recovery_confirmed: bool,
    termination_error: Option<u32>,
    wait_error: Option<u32>,
    clock_invalid: bool,
    duplicate_close: CloseEvidence,
    thread_ended: bool,
    join_succeeded: bool,
}

enum WatchdogCommand {
    BeginCleanup {
        recovery_at: CaseTimestamp,
        cleanup_deadline: CaseTimestamp,
    },
    RootTerminationConfirmed,
}

fn mark_watchdog_disconnected(
    clock: &CaseClock,
    commands_open: &mut bool,
    deadlines: &mut WatchdogDeadlines,
) {
    *commands_open = false;
    match clock.now_timestamp() {
        Ok(now) => deadlines.shorten_recovery(now),
        Err(_) => deadlines.invalid_clock = true,
    }
}

fn drain_watchdog_commands(
    commands: &Receiver<WatchdogCommand>,
    clock: &CaseClock,
    commands_open: &mut bool,
    deadlines: &mut WatchdogDeadlines,
    duplicate: HANDLE,
    wait_error: &mut Option<u32>,
    #[cfg(test)] confirmation_wait_error: &std::sync::atomic::AtomicBool,
) -> bool {
    if !*commands_open {
        return false;
    }
    loop {
        match commands.try_recv() {
            Ok(WatchdogCommand::BeginCleanup {
                recovery_at,
                cleanup_deadline,
            }) => {
                #[cfg(test)]
                clock.after_receive_for_test();
                deadlines.begin_cleanup(recovery_at, cleanup_deadline);
            }
            Ok(WatchdogCommand::RootTerminationConfirmed) => {
                #[cfg(test)]
                clock.after_receive_for_test();
                if observe_root_confirmation(
                    duplicate,
                    clock,
                    deadlines.cleanup_deadline,
                    wait_error,
                    &mut deadlines.invalid_clock,
                    #[cfg(test)]
                    confirmation_wait_error,
                ) {
                    return true;
                }
            }
            Err(mpsc::TryRecvError::Empty) => return false,
            Err(mpsc::TryRecvError::Disconnected) => {
                mark_watchdog_disconnected(clock, commands_open, deadlines);
                return false;
            }
        }
    }
}

fn observe_root_confirmation(
    duplicate: HANDLE,
    clock: &CaseClock,
    deadline: CaseTimestamp,
    wait_error: &mut Option<u32>,
    invalid_clock: &mut bool,
    #[cfg(test)] confirmation_wait_error: &std::sync::atomic::AtomicBool,
) -> bool {
    #[cfg(test)]
    if confirmation_wait_error.swap(false, std::sync::atomic::Ordering::SeqCst) {
        wait_error.get_or_insert(0xDEAD);
    }
    let result = unsafe { WaitForSingleObject(duplicate, 0) };
    let (wait_error_code, expired) = post_wait_evidence(
        result,
        || unsafe { GetLastError() },
        || {
            #[cfg(test)]
            clock.after_wait_for_test();
            match clock.is_due(deadline) {
                Ok(expired) => expired,
                Err(_) => {
                    *invalid_clock = true;
                    true
                }
            }
        },
    );
    match result {
        WAIT_OBJECT_0 => !expired,
        WAIT_TIMEOUT => false,
        _ => {
            let error = wait_error_code.unwrap_or_default();
            wait_error.get_or_insert(error);
            false
        }
    }
}

fn wait_for_watchdog_recovery(
    duplicate: HANDLE,
    commands: &Receiver<WatchdogCommand>,
    clock: &CaseClock,
    commands_open: &mut bool,
    deadlines: &mut WatchdogDeadlines,
    wait_error: &mut Option<u32>,
    #[cfg(test)] confirmation_wait_error: &std::sync::atomic::AtomicBool,
) -> bool {
    loop {
        if drain_watchdog_commands(
            commands,
            clock,
            commands_open,
            deadlines,
            duplicate,
            wait_error,
            #[cfg(test)]
            confirmation_wait_error,
        ) {
            return true;
        }
        let immediate = unsafe { WaitForSingleObject(duplicate, 0) };
        let cleanup_deadline = deadlines.cleanup_deadline;
        let (wait_error_code, expired) = post_wait_evidence(
            immediate,
            || unsafe { GetLastError() },
            || {
                #[cfg(test)]
                clock.after_wait_for_test();
                match clock.is_due(cleanup_deadline) {
                    Ok(expired) => expired,
                    Err(_) => {
                        deadlines.invalid_clock = true;
                        true
                    }
                }
            },
        );
        match immediate {
            WAIT_OBJECT_0 => return !expired,
            WAIT_TIMEOUT => {}
            _ => {
                let error = wait_error_code.unwrap_or_default();
                *wait_error = Some(error);
            }
        }
        let remaining = match clock.remaining(deadlines.cleanup_deadline) {
            Ok(remaining) => remaining,
            Err(_) => {
                deadlines.invalid_clock = true;
                return false;
            }
        };
        if remaining.is_zero() {
            return false;
        }
        let millis = remaining.min(Duration::from_millis(2)).as_millis().max(1) as u32;
        let waited = unsafe { WaitForSingleObject(duplicate, millis) };
        let cleanup_deadline = deadlines.cleanup_deadline;
        let (wait_error_code, deadline_expired) = post_wait_evidence(
            waited,
            || unsafe { GetLastError() },
            || {
                #[cfg(test)]
                clock.after_wait_for_test();
                match clock.is_due(cleanup_deadline) {
                    Ok(expired) => expired,
                    Err(_) => {
                        deadlines.invalid_clock = true;
                        true
                    }
                }
            },
        );
        match waited {
            WAIT_OBJECT_0 => return !deadline_expired,
            WAIT_TIMEOUT => {}
            _ => {
                let error = wait_error_code.unwrap_or_default();
                *wait_error = Some(error);
                return false;
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct WatchdogDeadlines {
    pub(super) setup_trigger: CaseTimestamp,
    pub(super) recovery_at: CaseTimestamp,
    pub(super) cleanup_deadline: CaseTimestamp,
    invalid_clock: bool,
}

impl WatchdogDeadlines {
    pub(super) fn new(
        setup_trigger: impl Into<CaseTimestamp>,
        cleanup_deadline: impl Into<CaseTimestamp>,
    ) -> Self {
        let setup_trigger = setup_trigger.into();
        Self {
            setup_trigger,
            recovery_at: setup_trigger,
            cleanup_deadline: cleanup_deadline.into(),
            invalid_clock: false,
        }
    }

    pub(super) fn begin_cleanup(
        &mut self,
        recovery_at: impl Into<CaseTimestamp>,
        cleanup_deadline: impl Into<CaseTimestamp>,
    ) {
        let recovery_at = recovery_at.into();
        let cleanup_deadline = cleanup_deadline.into();
        match super::ownership::compare_case_timestamps(self.cleanup_deadline, cleanup_deadline) {
            Ok(std::cmp::Ordering::Greater) => self.cleanup_deadline = cleanup_deadline,
            Ok(_) => {}
            Err(_) => self.invalid_clock = true,
        }
        match super::ownership::compare_case_timestamps(self.recovery_at, recovery_at) {
            Ok(std::cmp::Ordering::Greater) => self.recovery_at = recovery_at,
            Ok(_) => {}
            Err(_) => self.invalid_clock = true,
        }
    }

    fn shorten_recovery(&mut self, recovery_at: CaseTimestamp) {
        match super::ownership::compare_case_timestamps(self.recovery_at, recovery_at) {
            Ok(std::cmp::Ordering::Greater) => self.recovery_at = recovery_at,
            Ok(_) => {}
            Err(_) => self.invalid_clock = true,
        }
    }

    pub(super) fn recovery_at(scheduled_stop: Instant, cleanup_deadline: Instant) -> Instant {
        scheduled_stop.max(
            cleanup_deadline
                .checked_sub(Duration::from_secs(1))
                .unwrap_or(cleanup_deadline),
        )
    }

    fn recovery_for_clock(
        clock: &CaseClock,
        scheduled_stop: CaseTimestamp,
        cleanup_deadline: CaseTimestamp,
    ) -> CaseTimestamp {
        let one_second_before = clock
            .before(cleanup_deadline, Duration::from_secs(1))
            .unwrap_or(scheduled_stop);
        match super::ownership::compare_case_timestamps(scheduled_stop, one_second_before) {
            Ok(std::cmp::Ordering::Less) => one_second_before,
            Ok(_) | Err(_) => scheduled_stop,
        }
    }

    pub(super) fn trigger(&self) -> CaseTimestamp {
        match super::ownership::compare_case_timestamps(self.setup_trigger, self.recovery_at) {
            Ok(std::cmp::Ordering::Greater) => self.recovery_at,
            Ok(_) => self.setup_trigger,
            Err(_) => self.setup_trigger,
        }
    }

    pub(super) fn recovery_due(&self, now: impl Into<CaseTimestamp>) -> bool {
        self.invalid_clock
            || match super::ownership::compare_case_timestamps(now.into(), self.trigger()) {
                Ok(ordering) => ordering != std::cmp::Ordering::Less,
                Err(_) => true,
            }
    }
}

struct Watchdog {
    commands: Sender<WatchdogCommand>,
    result: Receiver<WatchdogResult>,
    join: Option<JoinHandle<()>>,
    cached: Option<WatchdogResult>,
}

struct WatchdogStartFailure {
    error: std::io::Error,
    duplicate_close: CloseEvidence,
    #[cfg(test)]
    close_attempts: usize,
}

impl Watchdog {
    #[cfg(test)]
    pub(super) fn wait_for_completed_result_for_test(
        clock: &CaseClock,
        deadline: CaseTimestamp,
    ) -> bool {
        let (commands, _commands_rx) = mpsc::channel();
        let (result_tx, result) = mpsc::channel();
        let _ = result_tx.send(WatchdogResult {
            fired: false,
            intervened: false,
            recovery_confirmed: true,
            termination_error: None,
            wait_error: None,
            clock_invalid: false,
            duplicate_close: CloseEvidence {
                attempted: true,
                closed: true,
                raw_os_error: None,
            },
            thread_ended: true,
            join_succeeded: true,
        });
        let mut watchdog = Self {
            commands,
            result,
            join: None,
            cached: None,
        };
        watchdog.wait_until_completed(clock, deadline).is_some()
    }

    fn start(
        duplicate: StdOwnedHandle,
        clock: CaseClock,
        setup_deadline: CaseTimestamp,
        setup_cleanup_deadline: CaseTimestamp,
        spawn_failure: Option<std::io::Error>,
        close_backend: Option<Box<dyn FnMut(HANDLE) -> Result<(), u32> + Send>>,
        #[cfg(test)] recovery_observer: Arc<Mutex<Option<Sender<(bool, bool, CaseTimestamp)>>>>,
        #[cfg(test)] recovery_gate: Arc<Mutex<Option<(Sender<()>, Receiver<()>)>>>,
        #[cfg(test)] confirmation_wait_error: Arc<std::sync::atomic::AtomicBool>,
        #[cfg(test)] panic_after_result: Arc<std::sync::atomic::AtomicBool>,
        #[cfg(test)] late_containment_attempted: Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<Self, WatchdogStartFailure> {
        #[cfg(not(test))]
        let _ = &close_backend;
        let (commands_tx, commands_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        // Retain a recoverable owner if thread creation fails. On success, the
        // watchdog takes the sole duplicate owner immediately on its thread.
        let pending = Arc::new(Mutex::new(Some(duplicate)));
        let thread_pending = Arc::clone(&pending);
        let thread_clock = clock.clone();
        #[cfg(test)]
        let close_backend = Arc::new(Mutex::new(close_backend));
        #[cfg(test)]
        let thread_close_backend = Arc::clone(&close_backend);
        #[cfg(test)]
        let thread_recovery_observer = Arc::clone(&recovery_observer);
        #[cfg(test)]
        let thread_recovery_gate = Arc::clone(&recovery_gate);
        #[cfg(test)]
        let thread_confirmation_wait_error = Arc::clone(&confirmation_wait_error);
        #[cfg(test)]
        let thread_panic_after_result = Arc::clone(&panic_after_result);
        #[cfg(test)]
        let thread_late_containment_attempted = Arc::clone(&late_containment_attempted);
        let thread_body = move || {
            let Some(std_handle) = thread_pending.lock().ok().and_then(|mut slot| slot.take())
            else {
                let _ = result_tx.send(WatchdogResult {
                    fired: false,
                    intervened: false,
                    recovery_confirmed: false,
                    termination_error: None,
                    wait_error: None,
                    clock_invalid: true,
                    duplicate_close: CloseEvidence {
                        attempted: false,
                        closed: false,
                        raw_os_error: None,
                    },
                    thread_ended: false,
                    join_succeeded: false,
                });
                return;
            };
            let raw = std_handle.into_raw_handle() as HANDLE;
            #[cfg(test)]
            let close_backend = thread_close_backend
                .lock()
                .ok()
                .and_then(|mut backend| backend.take());
            #[cfg(test)]
            let mut duplicate = match close_backend {
                Some(backend) => OwnedHandle::from_raw_with_backend(raw, backend),
                None => OwnedHandle::from_raw(raw),
            };
            #[cfg(not(test))]
            let mut duplicate = OwnedHandle::from_raw(raw);
            let mut deadlines = WatchdogDeadlines::new(setup_deadline, setup_cleanup_deadline);
            let mut commands_open = true;
            let mut fired = false;
            let mut intervened = false;
            let mut recovery_confirmed = false;
            let mut termination_error = None;
            let mut wait_error = None;
            loop {
                #[cfg(test)]
                if let Ok(mut gate_slot) = thread_recovery_gate.lock()
                    && let Some((entered, release)) = gate_slot.take()
                {
                    let remaining = thread_clock
                        .remaining(deadlines.cleanup_deadline)
                        .unwrap_or(Duration::ZERO);
                    let _ = entered.send(());
                    let _ = release.recv_timeout(remaining);
                }
                if drain_watchdog_commands(
                    &commands_rx,
                    &thread_clock,
                    &mut commands_open,
                    &mut deadlines,
                    duplicate.raw(),
                    &mut wait_error,
                    #[cfg(test)]
                    &thread_confirmation_wait_error,
                ) {
                    recovery_confirmed = true;
                    break;
                }
                let recovery_due = match thread_clock.now_timestamp() {
                    Ok(now) => deadlines.recovery_due(now),
                    Err(_) => {
                        deadlines.invalid_clock = true;
                        true
                    }
                };
                if recovery_due {
                    fired = true;
                    let immediate = unsafe { WaitForSingleObject(duplicate.raw(), 0) };
                    let cleanup_deadline = deadlines.cleanup_deadline;
                    let (wait_error_code, cleanup_expired) = post_wait_evidence(
                        immediate,
                        || unsafe { GetLastError() },
                        || {
                            #[cfg(test)]
                            thread_clock.after_wait_for_test();
                            match thread_clock.is_due(cleanup_deadline) {
                                Ok(expired) => expired,
                                Err(_) => {
                                    deadlines.invalid_clock = true;
                                    true
                                }
                            }
                        },
                    );
                    match immediate {
                        WAIT_OBJECT_0 => recovery_confirmed = !cleanup_expired,
                        WAIT_TIMEOUT => {
                            intervened = true;
                            #[cfg(test)]
                            thread_late_containment_attempted
                                .store(true, std::sync::atomic::Ordering::SeqCst);
                            if unsafe { TerminateProcess(duplicate.raw(), SETUP_EXIT) } == 0 {
                                termination_error = Some(unsafe { GetLastError() });
                            }
                        }
                        _ => {
                            let error = wait_error_code.unwrap_or_default();
                            wait_error.get_or_insert(error);
                            intervened = true;
                            #[cfg(test)]
                            thread_late_containment_attempted
                                .store(true, std::sync::atomic::Ordering::SeqCst);
                            if unsafe { TerminateProcess(duplicate.raw(), SETUP_EXIT) } == 0 {
                                termination_error = Some(unsafe { GetLastError() });
                            }
                        }
                    }
                    if !recovery_confirmed && !cleanup_expired {
                        recovery_confirmed = wait_for_watchdog_recovery(
                            duplicate.raw(),
                            &commands_rx,
                            &thread_clock,
                            &mut commands_open,
                            &mut deadlines,
                            &mut wait_error,
                            #[cfg(test)]
                            &thread_confirmation_wait_error,
                        );
                    }
                    #[cfg(test)]
                    if let Ok(observer) = thread_recovery_observer.lock()
                        && let Some(observer) = observer.as_ref()
                    {
                        let _ = observer.send((
                            intervened,
                            recovery_confirmed,
                            deadlines.cleanup_deadline,
                        ));
                    }
                    break;
                }
                let timeout = match thread_clock.remaining(deadlines.trigger()) {
                    Ok(timeout) => timeout,
                    Err(_) => {
                        deadlines.invalid_clock = true;
                        Duration::ZERO
                    }
                };
                if !commands_open {
                    thread::sleep(timeout.min(Duration::from_millis(2)));
                    continue;
                }
                let command = commands_rx.recv_timeout(timeout);
                #[cfg(test)]
                thread_clock.after_receive_for_test();
                let cleanup_expired = match thread_clock.is_due(deadlines.cleanup_deadline) {
                    Ok(expired) => expired,
                    Err(_) => {
                        deadlines.invalid_clock = true;
                        true
                    }
                };
                if cleanup_expired {
                    // The deadline invalidates timely recovery, but does not
                    // remove the watchdog's root-only containment authority.
                    fired = true;
                    intervened = true;
                    if unsafe { TerminateProcess(duplicate.raw(), SETUP_EXIT) } == 0 {
                        termination_error = Some(unsafe { GetLastError() });
                    }
                    #[cfg(test)]
                    thread_late_containment_attempted
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    break;
                }
                match command {
                    Ok(WatchdogCommand::BeginCleanup {
                        recovery_at,
                        cleanup_deadline,
                    }) => {
                        deadlines.begin_cleanup(recovery_at, cleanup_deadline);
                    }
                    Ok(WatchdogCommand::RootTerminationConfirmed) => {
                        if observe_root_confirmation(
                            duplicate.raw(),
                            &thread_clock,
                            deadlines.cleanup_deadline,
                            &mut wait_error,
                            &mut deadlines.invalid_clock,
                            #[cfg(test)]
                            &thread_confirmation_wait_error,
                        ) {
                            recovery_confirmed = true;
                            break;
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        mark_watchdog_disconnected(
                            &thread_clock,
                            &mut commands_open,
                            &mut deadlines,
                        );
                    }
                }
            }
            let duplicate_close = duplicate.close_checked();
            #[cfg(test)]
            drop(duplicate);
            let _ = result_tx.send(WatchdogResult {
                fired,
                intervened,
                recovery_confirmed,
                termination_error,
                wait_error,
                clock_invalid: deadlines.invalid_clock,
                duplicate_close,
                thread_ended: false,
                join_succeeded: false,
            });
            #[cfg(test)]
            if thread_panic_after_result.swap(false, std::sync::atomic::Ordering::SeqCst) {
                panic!("injected watchdog panic after result");
            }
        };
        let spawn = spawn_watchdog_thread(thread_body, spawn_failure);
        match spawn {
            Ok(join) => Ok(Self {
                commands: commands_tx,
                result: result_rx,
                join: Some(join),
                cached: None,
            }),
            Err(error) => {
                let mut duplicate_close = CloseEvidence {
                    attempted: false,
                    closed: false,
                    raw_os_error: None,
                };
                #[cfg(test)]
                let mut close_attempts = 0;
                if let Ok(mut slot) = pending.lock() {
                    if let Some(std_handle) = slot.take() {
                        let raw = std_handle.into_raw_handle() as HANDLE;
                        #[cfg(test)]
                        let close_backend = close_backend
                            .lock()
                            .ok()
                            .and_then(|mut backend| backend.take());
                        #[cfg(test)]
                        let mut owned = match close_backend {
                            Some(backend) => OwnedHandle::from_raw_with_backend(raw, backend),
                            None => OwnedHandle::from_raw(raw),
                        };
                        #[cfg(not(test))]
                        let mut owned = OwnedHandle::from_raw(raw);
                        #[cfg(test)]
                        let attempts = owned.close_attempt_counter();
                        duplicate_close = owned.close_checked();
                        #[cfg(test)]
                        {
                            drop(owned);
                            close_attempts = attempts.load(std::sync::atomic::Ordering::SeqCst);
                        }
                    }
                }
                Err(WatchdogStartFailure {
                    error,
                    duplicate_close,
                    #[cfg(test)]
                    close_attempts,
                })
            }
        }
    }

    fn poll(&mut self) -> Option<WatchdogResult> {
        if self.cached.is_none() {
            self.cached = self.result.try_recv().ok();
        }
        self.cached
    }

    fn begin_cleanup(
        &mut self,
        recovery_at: CaseTimestamp,
        cleanup_deadline: CaseTimestamp,
    ) -> Result<(), ()> {
        self.commands
            .send(WatchdogCommand::BeginCleanup {
                recovery_at,
                cleanup_deadline,
            })
            .map_err(|_| ())
    }

    fn root_termination_confirmed(&mut self) -> Result<(), ()> {
        self.commands
            .send(WatchdogCommand::RootTerminationConfirmed)
            .map_err(|_| ())
    }

    #[cfg(test)]
    fn disconnect_commands_for_test(&mut self) {
        let (disconnected, receiver) = mpsc::channel();
        drop(receiver);
        self.commands = disconnected;
    }

    fn wait_until_completed(
        &mut self,
        clock: &CaseClock,
        deadline: CaseTimestamp,
    ) -> Option<WatchdogResult> {
        loop {
            if clock.is_due(deadline).unwrap_or(true) {
                return None;
            }
            if self.cached.is_none() {
                let (received, timely) = receive_watchdog_result_until(
                    &self.result,
                    clock.remaining(deadline).unwrap_or(Duration::ZERO),
                    clock,
                    deadline,
                );
                self.cached = match received {
                    Ok(result) => Some(result),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => {
                        if self.join.as_ref().is_none_or(JoinHandle::is_finished) {
                            return None;
                        }
                        thread::sleep(
                            clock
                                .remaining(deadline)
                                .unwrap_or(Duration::ZERO)
                                .min(Duration::from_millis(2)),
                        );
                        None
                    }
                };
                if !timely {
                    return None;
                }
            }
            if self.cached.is_some() {
                if let Some(join) = self.join.as_ref() {
                    if join.is_finished() {
                        if let Some(join) = self.join.take() {
                            let join_succeeded = join.join().is_ok();
                            if let Some(result) = self.cached.as_mut() {
                                result.thread_ended = true;
                                result.join_succeeded = join_succeeded;
                            }
                        }
                        return self.cached;
                    }
                } else {
                    return self.cached;
                }
            }
            if clock.is_due(deadline).unwrap_or(true) {
                return None;
            }
            let remaining = clock.remaining(deadline).unwrap_or(Duration::ZERO);
            if let Some(join) = self.join.as_ref()
                && !join.is_finished()
            {
                let _ = self
                    .result
                    .recv_timeout(remaining.min(Duration::from_millis(2)));
                if clock.is_due(deadline).unwrap_or(true) {
                    return None;
                }
                if self.cached.is_none() {
                    self.cached = self.result.try_recv().ok();
                }
            }
        }
    }
}

#[cfg(test)]
pub(super) fn watchdog_wait_for_completed_result_for_test(
    clock: &CaseClock,
    deadline: CaseTimestamp,
) -> bool {
    Watchdog::wait_for_completed_result_for_test(clock, deadline)
}

pub(super) fn receive_watchdog_result_until<T>(
    receiver: &Receiver<T>,
    timeout: Duration,
    clock: &CaseClock,
    deadline: CaseTimestamp,
) -> (Result<T, RecvTimeoutError>, bool) {
    let received = receiver.recv_timeout(timeout);
    #[cfg(test)]
    clock.after_receive_for_test();
    let timely = !clock.is_due(deadline).unwrap_or(true);
    (received, timely)
}

fn spawn_watchdog_thread(
    thread_body: impl FnOnce() + Send + 'static,
    injected_failure: Option<std::io::Error>,
) -> std::io::Result<JoinHandle<()>> {
    if let Some(error) = injected_failure {
        return Err(error);
    }
    thread::Builder::new()
        .name("probe-root-watchdog".into())
        .spawn(thread_body)
}

fn clock_error_code(error: ClockError) -> Option<u32> {
    match error {
        ClockError::CounterQuery(code) | ClockError::FrequencyQuery(code) => Some(code),
        _ => None,
    }
}

pub(super) struct AttributeList {
    raw: *mut c_void,
    storage: Vec<usize>,
    initialized: bool,
    #[cfg(test)]
    delete_counter: Option<Arc<std::sync::atomic::AtomicUsize>>,
}

enum AttributeListError {
    Expired,
    Clock(ClockError),
    Win32(Option<u32>),
}

impl AttributeList {
    fn new(inherited: &[HANDLE], deadline: Instant) -> Result<Self, AttributeListError> {
        Self::new_with_clock(inherited, deadline, Instant::now, None)
    }

    fn new_for_case_clock(
        inherited: &[HANDLE],
        clock: &CaseClock,
        deadline: CaseTimestamp,
    ) -> Result<Self, AttributeListError> {
        Self::new_with_expiry(
            inherited,
            || clock.is_due(deadline).map_err(AttributeListError::Clock),
            None,
        )
    }

    #[cfg(test)]
    pub(super) fn new_for_test(
        inherited: &[HANDLE],
        deadline: Instant,
        clock: impl FnMut() -> Instant,
        delete_counter: Arc<std::sync::atomic::AtomicUsize>,
    ) -> Result<Self, Option<u32>> {
        Self::new_with_clock(inherited, deadline, clock, Some(delete_counter)).map_err(|error| {
            match error {
                AttributeListError::Expired | AttributeListError::Clock(_) => None,
                AttributeListError::Win32(error) => error,
            }
        })
    }

    fn new_with_clock(
        inherited: &[HANDLE],
        deadline: Instant,
        mut clock: impl FnMut() -> Instant,
        delete_counter: Option<Arc<std::sync::atomic::AtomicUsize>>,
    ) -> Result<Self, AttributeListError> {
        Self::new_with_expiry(inherited, || Ok(clock() >= deadline), delete_counter)
    }

    fn new_with_expiry(
        inherited: &[HANDLE],
        mut expired: impl FnMut() -> Result<bool, AttributeListError>,
        _delete_counter: Option<Arc<std::sync::atomic::AtomicUsize>>,
    ) -> Result<Self, AttributeListError> {
        if expired()? {
            return Err(AttributeListError::Expired);
        }
        let mut required = 0usize;
        let ok = unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut required) };
        let query_error = if ok == 0 {
            Some(unsafe { GetLastError() })
        } else {
            None
        };
        if expired()? {
            return Err(AttributeListError::Expired);
        }
        if ok != 0 || required == 0 {
            return Err(AttributeListError::Win32(query_error));
        }
        let mut storage = vec![0usize; required.div_ceil(size_of::<usize>())];
        let raw = storage.as_mut_ptr().cast();
        if expired()? {
            return Err(AttributeListError::Expired);
        }
        let initialized = unsafe { InitializeProcThreadAttributeList(raw, 1, 0, &mut required) };
        let initialize_error = if initialized == 0 {
            Some(unsafe { GetLastError() })
        } else {
            None
        };
        if initialized == 0 {
            return Err(AttributeListError::Win32(initialize_error));
        }
        let list = Self {
            raw,
            storage,
            initialized: true,
            #[cfg(test)]
            delete_counter: _delete_counter,
        };
        if expired()? {
            return Err(AttributeListError::Expired);
        }
        let updated = unsafe {
            UpdateProcThreadAttribute(
                list.raw,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                inherited.as_ptr().cast(),
                size_of_val(inherited),
                null_mut(),
                null(),
            )
        };
        let update_error = if updated == 0 {
            Some(unsafe { GetLastError() })
        } else {
            None
        };
        if expired()? {
            return Err(AttributeListError::Expired);
        }
        if updated == 0 {
            return Err(AttributeListError::Win32(update_error));
        }
        let _ = list.storage.len();
        Ok(list)
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        if self.initialized {
            unsafe { DeleteProcThreadAttributeList(self.raw) };
            #[cfg(test)]
            if let Some(counter) = self.delete_counter.as_ref() {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            self.initialized = false;
        }
    }
}

pub(super) struct NativeSession {
    clock: CaseClock,
    job: OwnedHandle,
    root: OwnedHandle,
    thread: OwnedHandle,
    input_read: OwnedHandle,
    input_write: OwnedHandle,
    output_read: OwnedHandle,
    output_write: OwnedHandle,
    watchdog: Option<Watchdog>,
    watchdog_start_close: Option<CloseEvidence>,
    watchdog_duplicate_acquired: bool,
    #[cfg(test)]
    watchdog_start_close_attempts: usize,
    #[cfg(test)]
    watchdog_spawn_failure_branch: bool,
    #[cfg(test)]
    watchdog_duplicate_raw_for_test: Option<usize>,
    #[cfg(test)]
    watchdog_duplicate_raw_capture: Arc<std::sync::atomic::AtomicUsize>,
    #[cfg(test)]
    watchdog_duplicate_close_calls: Arc<std::sync::atomic::AtomicUsize>,
    #[cfg(test)]
    watchdog_recovery_observer: Arc<Mutex<Option<Sender<(bool, bool, CaseTimestamp)>>>>,
    #[cfg(test)]
    watchdog_recovery_gate: Arc<Mutex<Option<(Sender<()>, Receiver<()>)>>>,
    #[cfg(test)]
    watchdog_confirmation_wait_error: Arc<std::sync::atomic::AtomicBool>,
    #[cfg(test)]
    watchdog_panic_after_result: Arc<std::sync::atomic::AtomicBool>,
    #[cfg(test)]
    watchdog_late_containment_attempted: Arc<std::sync::atomic::AtomicBool>,
    clock_invalid: bool,
    clock_error: Option<u32>,
    #[cfg(test)]
    root_acquired_observer: Option<Box<dyn FnMut(u32) -> bool + Send>>,
    #[cfg(test)]
    job_close_error: Arc<std::sync::atomic::AtomicUsize>,
    #[cfg(test)]
    job_close_raw_capture: Arc<std::sync::atomic::AtomicUsize>,
    #[cfg(test)]
    job_close_calls: Arc<std::sync::atomic::AtomicUsize>,
    root_pid: u32,
    job_process_ids: Vec<u32>,
    active_processes: u32,
    assigned: bool,
    assignment_uncertain: bool,
    fixed_worker_binary: bool,
    cleaned: bool,
    fault_hook: Option<Box<dyn FnMut(NativeStage) -> Option<u32>>>,
    #[cfg(test)]
    validation_overrides: ValidationOverrides,
}

struct NativePreparationOptions {
    clock: CaseClock,
    hook: Option<Box<dyn FnMut(NativeStage) -> Option<u32>>>,
    #[cfg(test)]
    root_acquired_observer: Option<Box<dyn FnMut(u32) -> bool + Send>>,
    #[cfg(test)]
    validation_overrides: ValidationOverrides,
}

impl NativeSession {
    pub(super) fn prepare() -> Result<Self, NativeFailure> {
        Self::prepare_with_core(NativePreparationOptions {
            clock: CaseClock::new(),
            hook: None,
            #[cfg(test)]
            root_acquired_observer: None,
            #[cfg(test)]
            validation_overrides: ValidationOverrides::default(),
        })
    }

    #[cfg(test)]
    pub(super) fn prepare_with_hook(
        hook: impl FnMut(NativeStage) -> Option<u32> + 'static,
    ) -> Result<Self, NativeFailure> {
        Self::prepare_with_and_observer(Some(Box::new(hook)), None)
    }

    #[cfg(test)]
    pub(super) fn prepare_with_root_observer(
        hook: impl FnMut(NativeStage) -> Option<u32> + 'static,
        observer: impl FnMut(u32) -> bool + Send + 'static,
    ) -> Result<Self, NativeFailure> {
        Self::prepare_with_and_observer(Some(Box::new(hook)), Some(Box::new(observer)))
    }

    #[cfg(test)]
    pub(super) fn prepare_with_validation_overrides(
        hook: impl FnMut(NativeStage) -> Option<u32> + 'static,
        validation_overrides: ValidationOverrides,
        observer: Option<Box<dyn FnMut(u32) -> bool + Send>>,
    ) -> Result<Self, NativeFailure> {
        Self::prepare_with_core(NativePreparationOptions {
            clock: CaseClock::new(),
            hook: Some(Box::new(hook)),
            root_acquired_observer: observer,
            validation_overrides,
        })
    }

    #[cfg(test)]
    pub(super) fn prepare_with_shared_qpc_for_test(
        clock: CaseClock,
        hook: impl FnMut(NativeStage) -> Option<u32> + 'static,
        validation_overrides: ValidationOverrides,
        observer: Option<Box<dyn FnMut(u32) -> bool + Send>>,
    ) -> Result<Self, NativeFailure> {
        Self::prepare_with_core(NativePreparationOptions {
            clock,
            hook: Some(Box::new(hook)),
            root_acquired_observer: observer,
            validation_overrides,
        })
    }

    #[cfg(test)]
    pub(super) fn watchdog_recovery_observer_for_test(
        &mut self,
    ) -> Receiver<(bool, bool, CaseTimestamp)> {
        let (sender, receiver) = mpsc::channel();
        if let Ok(mut observer) = self.watchdog_recovery_observer.lock() {
            *observer = Some(sender);
        }
        receiver
    }

    #[cfg(test)]
    pub(super) fn watchdog_recovery_gate_for_test(&mut self) -> (Receiver<()>, Sender<()>) {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        if let Ok(mut gate) = self.watchdog_recovery_gate.lock() {
            *gate = Some((entered_tx, release_rx));
        }
        (entered_rx, release_tx)
    }

    #[cfg(test)]
    pub(super) fn inject_watchdog_confirmation_wait_error_for_test(&self) {
        self.watchdog_confirmation_wait_error
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    #[cfg(test)]
    pub(super) fn panic_watchdog_after_result_for_test(&self) {
        self.watchdog_panic_after_result
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    #[cfg(test)]
    pub(super) fn watchdog_late_containment_attempted_for_test(
        &self,
    ) -> Arc<std::sync::atomic::AtomicBool> {
        Arc::clone(&self.watchdog_late_containment_attempted)
    }

    #[cfg(test)]
    pub(super) fn disconnect_watchdog_commands_for_test(&mut self) {
        if let Some(watchdog) = self.watchdog.as_mut() {
            watchdog.disconnect_commands_for_test();
        }
    }

    #[cfg(test)]
    pub(super) fn watchdog_shortener_for_test(
        &self,
    ) -> impl Fn(Instant, Instant) -> bool + Send + 'static {
        let sender = self
            .watchdog
            .as_ref()
            .map(|watchdog| watchdog.commands.clone());
        move |recovery_at, cleanup_deadline| {
            sender.as_ref().is_some_and(|sender| {
                sender
                    .send(WatchdogCommand::BeginCleanup {
                        recovery_at: CaseTimestamp::Local(recovery_at),
                        cleanup_deadline: CaseTimestamp::Local(cleanup_deadline),
                    })
                    .is_ok()
            })
        }
    }

    #[cfg(test)]
    pub(super) fn watchdog_timestamp_shortener_for_test(
        &self,
    ) -> impl Fn(CaseTimestamp, CaseTimestamp) -> bool + Send + 'static {
        let sender = self
            .watchdog
            .as_ref()
            .map(|watchdog| watchdog.commands.clone());
        move |recovery_at, cleanup_deadline| {
            sender.as_ref().is_some_and(|sender| {
                sender
                    .send(WatchdogCommand::BeginCleanup {
                        recovery_at,
                        cleanup_deadline,
                    })
                    .is_ok()
            })
        }
    }

    #[cfg(test)]
    pub(super) fn watchdog_confirmer_for_test(&self) -> impl Fn() -> bool + Send + 'static {
        let sender = self
            .watchdog
            .as_ref()
            .map(|watchdog| watchdog.commands.clone());
        move || {
            sender.as_ref().is_some_and(|sender| {
                sender
                    .send(WatchdogCommand::RootTerminationConfirmed)
                    .is_ok()
            })
        }
    }

    #[cfg(test)]
    fn prepare_with(
        hook: Option<Box<dyn FnMut(NativeStage) -> Option<u32>>>,
    ) -> Result<Self, NativeFailure> {
        Self::prepare_with_and_observer(hook, None)
    }

    #[cfg(test)]
    fn prepare_with_and_observer(
        hook: Option<Box<dyn FnMut(NativeStage) -> Option<u32>>>,
        root_acquired_observer: Option<Box<dyn FnMut(u32) -> bool + Send>>,
    ) -> Result<Self, NativeFailure> {
        Self::prepare_with_core(NativePreparationOptions {
            clock: CaseClock::new(),
            hook,
            #[cfg(test)]
            root_acquired_observer,
            #[cfg(test)]
            validation_overrides: ValidationOverrides::default(),
        })
    }

    fn prepare_with_core(options: NativePreparationOptions) -> Result<Self, NativeFailure> {
        let NativePreparationOptions {
            clock,
            hook,
            #[cfg(test)]
            root_acquired_observer,
            #[cfg(test)]
            validation_overrides,
        } = options;
        let mut session = Self {
            clock,
            job: OwnedHandle::invalid(),
            root: OwnedHandle::invalid(),
            thread: OwnedHandle::invalid(),
            input_read: OwnedHandle::invalid(),
            input_write: OwnedHandle::invalid(),
            output_read: OwnedHandle::invalid(),
            output_write: OwnedHandle::invalid(),
            watchdog: None,
            watchdog_start_close: None,
            watchdog_duplicate_acquired: false,
            #[cfg(test)]
            watchdog_start_close_attempts: 0,
            #[cfg(test)]
            watchdog_spawn_failure_branch: false,
            #[cfg(test)]
            watchdog_duplicate_raw_for_test: None,
            #[cfg(test)]
            watchdog_duplicate_raw_capture: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            #[cfg(test)]
            watchdog_duplicate_close_calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            #[cfg(test)]
            watchdog_recovery_observer: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            watchdog_recovery_gate: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            watchdog_confirmation_wait_error: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            #[cfg(test)]
            watchdog_panic_after_result: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            #[cfg(test)]
            watchdog_late_containment_attempted: Arc::new(std::sync::atomic::AtomicBool::new(
                false,
            )),
            clock_invalid: false,
            clock_error: None,
            #[cfg(test)]
            root_acquired_observer,
            #[cfg(test)]
            job_close_error: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            #[cfg(test)]
            job_close_raw_capture: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            #[cfg(test)]
            job_close_calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            root_pid: 0,
            job_process_ids: Vec::new(),
            active_processes: 0,
            assigned: false,
            assignment_uncertain: false,
            fixed_worker_binary: false,
            cleaned: false,
            fault_hook: hook,
            #[cfg(test)]
            validation_overrides,
        };
        if let Err(initiating) = session.prepare_inner() {
            let root_pid = session.root.is_valid().then_some(session.root_pid);
            let (_failure_observed, scheduled_stop) = match session.clock.now_timestamp() {
                Ok(observed) => match session.clock.scheduled_setup_failure(observed) {
                    Ok(scheduled) => (Some(observed), scheduled),
                    Err(error) => {
                        session.clock_invalid = true;
                        session.clock_error = clock_error_code(error);
                        (
                            Some(observed),
                            session
                                .clock
                                .setup_cutoff()
                                .unwrap_or(CaseTimestamp::Local(Instant::now())),
                        )
                    }
                },
                Err(error) => {
                    session.clock_invalid = true;
                    session.clock_error = clock_error_code(error);
                    (
                        None,
                        session
                            .clock
                            .setup_cutoff()
                            .unwrap_or(CaseTimestamp::Local(Instant::now())),
                    )
                }
            };
            let cleanup = session.perform_cleanup(scheduled_stop);
            session.cleaned = true;
            return Err(NativeFailure {
                initiating,
                cleanup,
                root_pid,
                #[cfg(test)]
                case_origin_for_test: match session.clock.origin_timestamp() {
                    CaseTimestamp::Local(origin) => Some(origin),
                    #[cfg(test)]
                    CaseTimestamp::SharedQpc(_) => None,
                },
                #[cfg(test)]
                qpc_origin_for_test: session.clock.shared_origin(),
                #[cfg(test)]
                failure_observed_qpc: match _failure_observed {
                    Some(CaseTimestamp::SharedQpc(value)) => Some(value),
                    _ => None,
                },
                #[cfg(test)]
                scheduled_stop_qpc: match scheduled_stop {
                    CaseTimestamp::SharedQpc(value) => Some(value),
                    _ => None,
                },
                #[cfg(test)]
                watchdog_duplicate_close_attempts: session.watchdog_start_close_attempts,
                #[cfg(test)]
                watchdog_spawn_failure_branch: session.watchdog_spawn_failure_branch,
                #[cfg(test)]
                watchdog_duplicate_raw_for_test: session.watchdog_duplicate_raw_for_test.or_else(
                    || {
                        let raw = session
                            .watchdog_duplicate_raw_capture
                            .load(std::sync::atomic::Ordering::SeqCst);
                        (raw != 0).then_some(raw)
                    },
                ),
            });
        }
        Ok(session)
    }

    fn prepare_inner(&mut self) -> Result<(), NativeOperationError> {
        self.before(NativeStage::CreateJob)?;
        let raw = unsafe { CreateJobObjectW(null(), null()) };
        if raw.is_null() {
            return Err(self.last_error(NativeStage::CreateJob));
        }
        #[cfg(test)]
        {
            let fail_close = Arc::clone(&self.job_close_error);
            let raw_capture = Arc::clone(&self.job_close_raw_capture);
            let calls = Arc::clone(&self.job_close_calls);
            self.job = OwnedHandle::from_raw_with_backend(raw, move |raw| {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let error = fail_close.load(std::sync::atomic::Ordering::SeqCst);
                if error != 0 {
                    raw_capture.store(raw as usize, std::sync::atomic::Ordering::SeqCst);
                    Err(error as u32)
                } else if unsafe { CloseHandle(raw) } != 0 {
                    Ok(())
                } else {
                    Err(unsafe { GetLastError() })
                }
            });
        }
        #[cfg(not(test))]
        {
            self.job = OwnedHandle::from_raw(raw);
        }
        self.after(NativeStage::CreateJob)?;

        let mut configured = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        configured.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        self.before(NativeStage::ConfigureJob)?;
        let ok = unsafe {
            SetInformationJobObject(
                self.job.raw(),
                JobObjectExtendedLimitInformation,
                (&configured as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } != 0;
        if !ok {
            return Err(self.last_error(NativeStage::ConfigureJob));
        }
        self.after(NativeStage::ConfigureJob)?;

        self.before(NativeStage::QueryJobPolicy)?;
        let mut queried = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        let ok = unsafe {
            QueryInformationJobObject(
                self.job.raw(),
                JobObjectExtendedLimitInformation,
                (&mut queried as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                null_mut(),
            )
        } != 0;
        if !ok {
            return Err(self.last_error(NativeStage::QueryJobPolicy));
        }
        #[cfg(test)]
        let flags = self
            .validation_overrides
            .queried_job_limit_flags
            .unwrap_or(queried.BasicLimitInformation.LimitFlags);
        #[cfg(not(test))]
        let flags = queried.BasicLimitInformation.LimitFlags;
        if flags != JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            || flags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK) != 0
        {
            return Err(NativeOperationError {
                stage: NativeStage::QueryJobPolicy,
                raw_os_error: None,
            });
        }
        self.after(NativeStage::QueryJobPolicy)?;

        self.before(NativeStage::CreatePipes)?;
        let mut security = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };
        let (mut in_read, mut in_write, mut out_read, mut out_write) =
            (null_mut(), null_mut(), null_mut(), null_mut());
        if unsafe { CreatePipe(&mut in_read, &mut in_write, &mut security, 0) } == 0 {
            let error = unsafe { GetLastError() };
            self.input_read = OwnedHandle::from_raw(in_read);
            self.input_write = OwnedHandle::from_raw(in_write);
            return Err(NativeOperationError {
                stage: NativeStage::CreatePipes,
                raw_os_error: Some(error),
            });
        }
        self.input_read = OwnedHandle::from_raw(in_read);
        self.input_write = OwnedHandle::from_raw(in_write);
        self.after(NativeStage::CreatePipes)?;
        self.before(NativeStage::CreatePipes)?;
        if unsafe { CreatePipe(&mut out_read, &mut out_write, &mut security, 0) } == 0 {
            let error = unsafe { GetLastError() };
            self.output_read = OwnedHandle::from_raw(out_read);
            self.output_write = OwnedHandle::from_raw(out_write);
            return Err(NativeOperationError {
                stage: NativeStage::CreatePipes,
                raw_os_error: Some(error),
            });
        }
        self.output_read = OwnedHandle::from_raw(out_read);
        self.output_write = OwnedHandle::from_raw(out_write);
        self.after(NativeStage::CreatePipes)?;

        self.before(NativeStage::SetPipeInheritance)?;
        if unsafe { SetHandleInformation(self.input_write.raw(), HANDLE_FLAG_INHERIT, 0) } == 0 {
            return Err(self.last_error(NativeStage::SetPipeInheritance));
        }
        self.after(NativeStage::SetPipeInheritance)?;
        self.before(NativeStage::SetPipeInheritance)?;
        if unsafe { SetHandleInformation(self.output_read.raw(), HANDLE_FLAG_INHERIT, 0) } == 0 {
            return Err(self.last_error(NativeStage::SetPipeInheritance));
        }
        self.after(NativeStage::SetPipeInheritance)?;

        self.before(NativeStage::CreateAttributeList)?;
        let inherited = [self.input_read.raw(), self.output_write.raw()];
        let attributes =
            match AttributeList::new_for_case_clock(&inherited, &self.clock, self.setup_deadline())
            {
                Ok(attributes) => attributes,
                Err(AttributeListError::Clock(error)) => {
                    self.clock_invalid = true;
                    if self.clock_error.is_none() {
                        self.clock_error = clock_error_code(error);
                    }
                    return Err(NativeOperationError {
                        stage: NativeStage::CreateAttributeList,
                        raw_os_error: None,
                    });
                }
                Err(AttributeListError::Expired) => {
                    return Err(NativeOperationError {
                        stage: NativeStage::CreateAttributeList,
                        raw_os_error: None,
                    });
                }
                Err(AttributeListError::Win32(error)) => {
                    return Err(NativeOperationError {
                        stage: NativeStage::CreateAttributeList,
                        raw_os_error: error,
                    });
                }
            };
        self.after(NativeStage::CreateAttributeList)?;

        let executable = resolve_worker_executable().map_err(|_| NativeOperationError {
            stage: NativeStage::CreateProcess,
            raw_os_error: None,
        })?;
        self.before(NativeStage::CreateProcess)?;
        let executable_wide: Vec<u16> = executable
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut command_line: Vec<u16> = format!("\"{}\" --worker", executable.display())
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = self.input_read.raw();
        startup.StartupInfo.hStdOutput = self.output_write.raw();
        startup.StartupInfo.hStdError = self.output_write.raw();
        startup.lpAttributeList = attributes.raw;
        let mut process = PROCESS_INFORMATION::default();
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
                &mut process,
            )
        } == 0
        {
            return Err(self.last_error(NativeStage::CreateProcess));
        }
        // Adopt process resources before any subsequent operation or deadline check.
        self.root = OwnedHandle::from_raw(process.hProcess);
        self.thread = OwnedHandle::from_raw(process.hThread);
        self.root_pid = process.dwProcessId;
        #[cfg(test)]
        if let Some(observer) = self.root_acquired_observer.as_mut() {
            if !observer(self.root_pid) {
                return Err(NativeOperationError {
                    stage: NativeStage::TestRootObserver,
                    raw_os_error: None,
                });
            }
        }
        let process_call_late = self.setup_is_due();
        let duplicate_started_in_time = !self.setup_is_due();
        let mut duplicate = null_mut();
        if unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                self.root.raw(),
                GetCurrentProcess(),
                &mut duplicate,
                PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                0,
                0,
            )
        } == 0
        {
            return Err(self.last_error(NativeStage::DuplicateRoot));
        }
        let std_duplicate = unsafe { StdOwnedHandle::from_raw_handle(duplicate as *mut c_void) };
        self.watchdog_duplicate_acquired = true;
        #[cfg(test)]
        let spawn_failure = self
            .injected(NativeStage::StartWatchdog)
            .map(|error| std::io::Error::from_raw_os_error(error as i32));
        #[cfg(not(test))]
        let spawn_failure = None;
        #[cfg(test)]
        let (close_backend, failed_duplicate_raw) = {
            let close_error = self.injected(NativeStage::WatchdogDuplicateClose);
            let backend_capture = Arc::clone(&self.watchdog_duplicate_raw_capture);
            let backend_calls = Arc::clone(&self.watchdog_duplicate_close_calls);
            let backend = close_error.map(|error| {
                Box::new(move |raw: HANDLE| {
                    backend_capture.store(raw as usize, std::sync::atomic::Ordering::SeqCst);
                    backend_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Err(error)
                }) as Box<dyn FnMut(HANDLE) -> Result<(), u32> + Send>
            });
            (backend, Arc::clone(&self.watchdog_duplicate_raw_capture))
        };
        #[cfg(not(test))]
        let close_backend = None;
        #[cfg(test)]
        let recovery_observer = Arc::clone(&self.watchdog_recovery_observer);
        #[cfg(test)]
        let recovery_gate = Arc::clone(&self.watchdog_recovery_gate);
        #[cfg(test)]
        let confirmation_wait_error = Arc::clone(&self.watchdog_confirmation_wait_error);
        #[cfg(test)]
        let panic_after_result = Arc::clone(&self.watchdog_panic_after_result);
        #[cfg(test)]
        let late_containment_attempted = Arc::clone(&self.watchdog_late_containment_attempted);
        self.watchdog = Some(
            match Watchdog::start(
                std_duplicate,
                self.clock.clone(),
                self.setup_deadline(),
                self.clock
                    .cleanup_cutoff(self.setup_deadline())
                    .unwrap_or(self.setup_deadline()),
                spawn_failure,
                close_backend,
                #[cfg(test)]
                recovery_observer,
                #[cfg(test)]
                recovery_gate,
                #[cfg(test)]
                confirmation_wait_error,
                #[cfg(test)]
                panic_after_result,
                #[cfg(test)]
                late_containment_attempted,
            ) {
                Ok(watchdog) => watchdog,
                Err(failure) => {
                    self.watchdog_start_close = Some(failure.duplicate_close);
                    #[cfg(test)]
                    {
                        self.watchdog_start_close_attempts = failure.close_attempts;
                        self.watchdog_spawn_failure_branch = true;
                        let raw = failed_duplicate_raw.load(std::sync::atomic::Ordering::SeqCst);
                        self.watchdog_duplicate_raw_for_test = (raw != 0).then_some(raw);
                    }
                    return Err(NativeOperationError {
                        stage: NativeStage::StartWatchdog,
                        raw_os_error: failure.error.raw_os_error().map(|code| code as u32),
                    });
                }
            },
        );
        drop(attributes);
        if !duplicate_started_in_time {
            return Err(NativeOperationError {
                stage: NativeStage::DuplicateRoot,
                raw_os_error: None,
            });
        }
        self.after(NativeStage::DuplicateRoot)?;
        if process_call_late {
            return Err(NativeOperationError {
                stage: NativeStage::CreateProcess,
                raw_os_error: None,
            });
        }
        self.after(NativeStage::CreateProcess)?;
        self.after(NativeStage::StartWatchdog)?;

        self.before(NativeStage::CloseChildPipeCopies)?;
        let input_child_closed = self.input_read.close_checked();
        let output_child_closed = self.output_write.close_checked();
        if !input_child_closed.closed || !output_child_closed.closed {
            return Err(NativeOperationError {
                stage: NativeStage::CloseChildPipeCopies,
                raw_os_error: input_child_closed
                    .raw_os_error
                    .or(output_child_closed.raw_os_error),
            });
        }
        self.after(NativeStage::CloseChildPipeCopies)?;

        self.assignment_uncertain = true;
        self.before(NativeStage::AssignRoot)?;
        if unsafe { AssignProcessToJobObject(self.job.raw(), self.root.raw()) } == 0 {
            return Err(self.last_error(NativeStage::AssignRoot));
        }
        self.assigned = true;
        self.assignment_uncertain = false;
        self.after(NativeStage::AssignRoot)?;

        self.before(NativeStage::VerifyMembership)?;
        let mut in_job = 0;
        if unsafe { IsProcessInJob(self.root.raw(), self.job.raw(), &mut in_job) } == 0 {
            return Err(self.last_error(NativeStage::VerifyMembership));
        }
        #[cfg(test)]
        let in_job = self
            .validation_overrides
            .is_process_in_job
            .map_or(in_job != 0, |value| value) as i32;
        if in_job == 0 {
            return Err(NativeOperationError {
                stage: NativeStage::VerifyMembership,
                raw_os_error: None,
            });
        }
        self.after(NativeStage::VerifyMembership)?;

        self.before(NativeStage::QueryJobPids)?;
        self.job_process_ids =
            query_job_pids(self.job.raw()).map_err(|error| NativeOperationError {
                stage: NativeStage::QueryJobPids,
                raw_os_error: Some(error),
            })?;
        #[cfg(test)]
        if let Some(job_process_ids) = self.validation_overrides.job_process_ids.take() {
            self.job_process_ids = job_process_ids;
        }
        if self.job_process_ids != [self.root_pid] {
            return Err(NativeOperationError {
                stage: NativeStage::QueryJobPids,
                raw_os_error: None,
            });
        }
        self.after(NativeStage::QueryJobPids)?;

        self.before(NativeStage::QueryAccounting)?;
        self.active_processes =
            query_active_processes(self.job.raw()).map_err(|error| NativeOperationError {
                stage: NativeStage::QueryAccounting,
                raw_os_error: Some(error),
            })?;
        #[cfg(test)]
        if let Some(active_processes) = self.validation_overrides.active_processes {
            self.active_processes = active_processes;
        }
        if self.active_processes != 1 {
            return Err(NativeOperationError {
                stage: NativeStage::QueryAccounting,
                raw_os_error: None,
            });
        }
        self.after(NativeStage::QueryAccounting)?;
        if self.watchdog.as_mut().and_then(Watchdog::poll).is_some() {
            return Err(NativeOperationError {
                stage: NativeStage::StartWatchdog,
                raw_os_error: None,
            });
        }
        self.before(NativeStage::CreateProcess)?;
        self.fixed_worker_binary =
            image_matches(self.root.raw(), &executable).map_err(|error| NativeOperationError {
                stage: NativeStage::CreateProcess,
                raw_os_error: Some(error),
            })?;
        self.after(NativeStage::CreateProcess)?;
        if !self.fixed_worker_binary {
            return Err(NativeOperationError {
                stage: NativeStage::CreateProcess,
                raw_os_error: None,
            });
        }
        Ok(())
    }

    fn before(&mut self, stage: NativeStage) -> Result<(), NativeOperationError> {
        if stage == NativeStage::AssignRoot {
            if let Some(error) = self.injected(NativeStage::AssignRootBefore) {
                return Err(NativeOperationError {
                    stage,
                    raw_os_error: Some(error),
                });
            }
        }
        if self.setup_is_due() {
            return Err(NativeOperationError {
                stage,
                raw_os_error: None,
            });
        }
        if self.watchdog.as_mut().and_then(Watchdog::poll).is_some() {
            return Err(NativeOperationError {
                stage,
                raw_os_error: None,
            });
        }
        Ok(())
    }

    fn after(&mut self, stage: NativeStage) -> Result<(), NativeOperationError> {
        if let Some(error) = self.injected(stage) {
            return Err(NativeOperationError {
                stage,
                raw_os_error: Some(error),
            });
        }
        self.before(stage)
    }

    fn injected(&mut self, stage: NativeStage) -> Option<u32> {
        self.fault_hook.as_mut().and_then(|hook| hook(stage))
    }

    fn setup_deadline(&self) -> CaseTimestamp {
        self.clock
            .setup_cutoff()
            .unwrap_or(CaseTimestamp::Local(Instant::now()))
    }

    fn setup_is_due(&mut self) -> bool {
        match self.clock.is_due(self.setup_deadline()) {
            Ok(expired) => expired,
            Err(error) => {
                self.clock_invalid = true;
                if self.clock_error.is_none() {
                    self.clock_error = clock_error_code(error);
                }
                true
            }
        }
    }

    fn last_error(&self, stage: NativeStage) -> NativeOperationError {
        NativeOperationError {
            stage,
            raw_os_error: Some(unsafe { GetLastError() }),
        }
    }

    pub(super) fn is_suspended(&self) -> bool {
        self.root.is_valid() && self.thread.is_valid()
    }

    pub(super) fn created_fixed_worker_binary(&self) -> bool {
        self.fixed_worker_binary
    }

    pub(super) fn root_pid(&self) -> u32 {
        self.root_pid
    }

    pub(super) fn job_process_ids(&self) -> &[u32] {
        &self.job_process_ids
    }

    pub(super) fn active_processes(&self) -> u32 {
        self.active_processes
    }

    pub(super) fn cleanup(mut self, scheduled_stop: Instant) -> CleanupEvidence {
        let evidence = self.perform_cleanup(CaseTimestamp::Local(scheduled_stop));
        self.cleaned = true;
        evidence
    }

    #[cfg(test)]
    pub(super) fn cleanup_timestamp_for_test(
        &mut self,
        scheduled_stop: CaseTimestamp,
    ) -> CleanupEvidence {
        let evidence = self.perform_cleanup(scheduled_stop);
        self.cleaned = true;
        evidence
    }

    fn perform_cleanup(&mut self, scheduled_stop: CaseTimestamp) -> CleanupEvidence {
        let cleanup_deadline = self.clock.cleanup_cutoff(scheduled_stop).ok();
        let mut clock_invalid = self.clock_invalid || cleanup_deadline.is_none();
        let deadline = cleanup_deadline.unwrap_or_else(|| {
            self.clock.now_timestamp().unwrap_or_else(|_| {
                clock_invalid = true;
                self.clock
                    .setup_cutoff()
                    .unwrap_or(CaseTimestamp::Local(Instant::now()))
            })
        });
        let had_process = self.root.is_valid();
        let mut native_errors = Vec::new();
        let mut close_errors = Vec::new();
        let mut watchdog_command_sent = false;
        if let Some(watchdog) = self.watchdog.as_mut() {
            let recovery_at =
                WatchdogDeadlines::recovery_for_clock(&self.clock, scheduled_stop, deadline);
            watchdog_command_sent = watchdog.begin_cleanup(recovery_at, deadline).is_ok();
        }
        let mut root_termination_attempted = false;
        let mut root_termination_succeeded = false;
        let mut job_termination_attempted = false;
        let mut job_termination_succeeded = false;

        if self.root.is_valid() {
            if !self.assigned || self.assignment_uncertain {
                root_termination_attempted = true;
                let injected = self.injected(NativeStage::CleanupTerminateProcess);
                if injected.is_none()
                    && unsafe { TerminateProcess(self.root.raw(), SETUP_EXIT) } != 0
                {
                    root_termination_succeeded = true;
                } else {
                    native_errors.push(injected.unwrap_or_else(|| unsafe { GetLastError() }));
                }
            }
            if self.assigned || self.assignment_uncertain {
                if self.job.is_valid() {
                    job_termination_attempted = true;
                    let injected = self.injected(NativeStage::CleanupTerminateJob);
                    if injected.is_none()
                        && unsafe { TerminateJobObject(self.job.raw(), JOB_EXIT) } != 0
                    {
                        job_termination_succeeded = true;
                        if self.assigned {
                            root_termination_attempted = true;
                            root_termination_succeeded = true;
                        }
                    } else {
                        native_errors.push(injected.unwrap_or_else(|| unsafe { GetLastError() }));
                        #[cfg(test)]
                        if let Some(error) = self.injected(NativeStage::CleanupCloseJob) {
                            self.job_close_error
                                .store(error as usize, std::sync::atomic::Ordering::SeqCst);
                        }
                        let emergency = self.job.close_checked();
                        if !emergency.closed {
                            if !close_errors.contains(&emergency.raw_os_error.unwrap_or(0)) {
                                close_errors.extend(emergency.raw_os_error);
                            }
                        }
                    }
                }
            }
        }

        let root_wait_completed = if !self.root.is_valid() {
            false
        } else if let Some(error) = self.injected(NativeStage::CleanupWaitRoot) {
            native_errors.push(error);
            false
        } else {
            match wait_until(self.root.raw(), &self.clock, deadline) {
                Ok(waited) => waited,
                Err(error) => {
                    native_errors.push(error);
                    false
                }
            }
        };
        let root_confirmation_sent = if root_wait_completed {
            self.watchdog
                .as_mut()
                .is_none_or(|watchdog| watchdog.root_termination_confirmed().is_ok())
        } else {
            false
        };
        let mut root_exit_code = None;
        if root_wait_completed {
            let mut code = 0;
            if unsafe { GetExitCodeProcess(self.root.raw(), &mut code) } != 0 {
                root_exit_code = Some(code);
            } else {
                native_errors.push(unsafe { GetLastError() });
            }
        }
        let mut active_processes_after = None;
        let mut job_empty = false;
        if had_process && (self.assigned || self.assignment_uncertain) && self.job.is_valid() {
            if let Some(error) = self.injected(NativeStage::CleanupQueryJob) {
                native_errors.push(error);
            } else {
                match query_active_processes(self.job.raw()) {
                    Ok(active) => {
                        active_processes_after = Some(active);
                        job_empty = active == 0;
                    }
                    Err(error) => native_errors.push(error),
                }
            }
        }

        let watchdog_result =
            if let Some(error) = self.injected(NativeStage::CleanupWatchdogCompletion) {
                native_errors.push(error);
                None
            } else {
                self.watchdog
                    .as_mut()
                    .and_then(|watchdog| watchdog.wait_until_completed(&self.clock, deadline))
            };
        let watchdog_thread_ended = watchdog_result.is_some_and(|result| result.thread_ended);
        let watchdog_join_succeeded = watchdog_result.is_some_and(|result| result.join_succeeded);
        let watchdog_completed = if self.watchdog.is_some() {
            watchdog_thread_ended && watchdog_join_succeeded
        } else {
            !had_process
        };
        #[cfg(test)]
        let late_containment_attempted = self
            .watchdog_late_containment_attempted
            .load(std::sync::atomic::Ordering::SeqCst);
        #[cfg(not(test))]
        let late_containment_attempted = false;
        let watchdog_fired =
            watchdog_result.is_some_and(|result| result.fired) || late_containment_attempted;
        let watchdog_intervened =
            watchdog_result.is_some_and(|result| result.intervened) || late_containment_attempted;
        if late_containment_attempted {
            root_termination_attempted = true;
        }
        if let Some(result) = watchdog_result {
            if let Some(error) = result.termination_error {
                native_errors.push(error);
            }
            if let Some(error) = result.wait_error {
                native_errors.push(error);
            }
            if result.intervened {
                root_termination_attempted = true;
                root_termination_succeeded |= result.termination_error.is_none();
            }
        }
        let watchdog_duplicate_closed = match watchdog_result {
            Some(result) => {
                if let Some(error) = result.duplicate_close.raw_os_error {
                    close_errors.push(error);
                }
                result.duplicate_close.closed
            }
            None => self.watchdog_start_close.map_or(!had_process, |evidence| {
                if let Some(error) = evidence.raw_os_error {
                    close_errors.push(error);
                }
                evidence.closed
            }),
        };
        let watchdog_recovery_confirmed = if self.watchdog.is_some() {
            watchdog_result.is_some_and(|result| result.recovery_confirmed)
        } else {
            self.watchdog_start_close
                .is_some_and(|evidence| evidence.closed)
        };
        clock_invalid |= watchdog_result.is_some_and(|result| result.clock_invalid);

        let close = |handle: &mut OwnedHandle, errors: &mut Vec<u32>| {
            let evidence = handle.close_checked();
            if let Some(error) = evidence.raw_os_error {
                errors.push(error);
            }
            evidence.closed || !evidence.attempted
        };
        let input_read_closed = close(&mut self.input_read, &mut close_errors);
        let input_write_closed = close(&mut self.input_write, &mut close_errors);
        let output_read_closed = close(&mut self.output_read, &mut close_errors);
        let output_write_closed = close(&mut self.output_write, &mut close_errors);
        let thread_closed = close(&mut self.thread, &mut close_errors);
        let root_closed = close(&mut self.root, &mut close_errors);
        let job_closed = close(&mut self.job, &mut close_errors);
        let startup_duplicate_closed = self.watchdog_start_close.is_none_or(|evidence| {
            if let Some(error) = evidence.raw_os_error {
                close_errors.push(error);
            }
            evidence.closed
        });
        let watchdog_duplicate_confirmed =
            !self.watchdog_duplicate_acquired || watchdog_duplicate_closed;
        let all_handles_closed = input_read_closed
            && input_write_closed
            && output_read_closed
            && output_write_closed
            && thread_closed
            && root_closed
            && job_closed
            && startup_duplicate_closed
            && watchdog_duplicate_confirmed;
        let completed_timestamp = match self.clock.now_timestamp() {
            Ok(timestamp) => Some(timestamp),
            Err(error) => {
                clock_invalid = true;
                if self.clock_error.is_none() {
                    self.clock_error = clock_error_code(error);
                }
                None
            }
        };
        let within_deadline = match self.clock.is_due(deadline) {
            Ok(expired) => !expired,
            Err(error) => {
                clock_invalid = true;
                if self.clock_error.is_none() {
                    self.clock_error = clock_error_code(error);
                }
                false
            }
        };
        let process_cleanup_safe = if had_process {
            root_termination_attempted
                && root_termination_succeeded
                && root_wait_completed
                && (if self.assigned { job_empty } else { true })
                && watchdog_completed
                && watchdog_thread_ended
                && watchdog_join_succeeded
                && watchdog_result.is_some_and(|result| {
                    result.wait_error.is_none() && result.termination_error.is_none()
                })
                && watchdog_command_sent
                && (root_confirmation_sent || watchdog_recovery_confirmed)
                && !watchdog_intervened
                && watchdog_recovery_confirmed
                && watchdog_duplicate_closed
        } else {
            !root_wait_completed && !job_empty && self.watchdog.is_none()
        };
        let continuation_safe = cleanup_deadline.is_some()
            && !clock_invalid
            && within_deadline
            && completed_timestamp.is_some()
            && process_cleanup_safe
            && all_handles_closed;
        CleanupEvidence {
            continuation_safe,
            root_termination_attempted,
            root_termination_succeeded,
            job_termination_attempted,
            job_termination_succeeded,
            root_wait_completed,
            root_exit_code,
            active_processes_after,
            job_empty,
            watchdog_completed,
            watchdog_command_sent,
            root_confirmation_sent,
            watchdog_thread_ended,
            watchdog_join_succeeded,
            watchdog_recovery_confirmed,
            watchdog_fired,
            watchdog_intervened,
            watchdog_duplicate_closed,
            all_handles_closed,
            clock_invalid,
            clock_error: self.clock_error,
            cleanup_deadline: cleanup_deadline.and_then(|deadline| match deadline {
                CaseTimestamp::Local(value) => Some(value),
                #[cfg(test)]
                CaseTimestamp::SharedQpc(_) => None,
            }),
            completed_at: match completed_timestamp {
                Some(CaseTimestamp::Local(value)) => Some(value),
                #[cfg(test)]
                Some(CaseTimestamp::SharedQpc(_)) | None => None,
                #[cfg(not(test))]
                None => None,
            },
            #[cfg(test)]
            cleanup_deadline_qpc: match cleanup_deadline {
                Some(CaseTimestamp::SharedQpc(value)) => Some(value),
                _ => None,
            },
            #[cfg(test)]
            completed_at_qpc: match completed_timestamp {
                Some(CaseTimestamp::SharedQpc(value)) => Some(value),
                _ => None,
            },
            close_errors,
            native_errors,
            #[cfg(test)]
            watchdog_duplicate_raw_for_test: {
                let raw = self
                    .watchdog_duplicate_raw_capture
                    .load(std::sync::atomic::Ordering::SeqCst);
                (raw != 0).then_some(raw)
            },
            #[cfg(test)]
            watchdog_duplicate_close_backend_calls: self
                .watchdog_duplicate_close_calls
                .load(std::sync::atomic::Ordering::SeqCst),
            #[cfg(test)]
            job_close_raw_for_test: {
                let raw = self
                    .job_close_raw_capture
                    .load(std::sync::atomic::Ordering::SeqCst);
                (raw != 0).then_some(raw)
            },
            #[cfg(test)]
            job_close_backend_calls: self
                .job_close_calls
                .load(std::sync::atomic::Ordering::SeqCst),
        }
    }
}

impl Drop for NativeSession {
    fn drop(&mut self) {
        if !self.cleaned {
            let scheduled_stop = self.clock.now_timestamp().unwrap_or_else(|error| {
                self.clock_invalid = true;
                self.clock_error = clock_error_code(error);
                self.clock
                    .setup_cutoff()
                    .unwrap_or(CaseTimestamp::Local(Instant::now()))
            });
            let _ = self.perform_cleanup(scheduled_stop);
            self.cleaned = true;
        }
    }
}

pub(super) fn wait_until(
    process: HANDLE,
    clock: &CaseClock,
    deadline: CaseTimestamp,
) -> Result<bool, u32> {
    let remaining = clock.remaining(deadline).map_err(|_| 87u32)?;
    if remaining.is_zero() {
        return Ok(false);
    }
    let millis = remaining
        .as_millis()
        .saturating_add(u128::from(remaining.subsec_nanos() % 1_000_000 != 0));
    let result = unsafe { WaitForSingleObject(process, millis.min(u32::MAX as u128) as u32) };
    let (wait_error_code, expired) = post_wait_evidence(
        result,
        || unsafe { GetLastError() },
        || {
            #[cfg(test)]
            clock.after_wait_for_test();
            clock.is_due(deadline).unwrap_or(true)
        },
    );
    match result {
        WAIT_OBJECT_0 => Ok(!expired),
        WAIT_TIMEOUT => Ok(false),
        _ => Err(wait_error_code.unwrap_or_default()),
    }
}

fn wait_handle_until(
    handle: HANDLE,
    clock: &CaseClock,
    deadline: CaseTimestamp,
) -> Result<bool, u32> {
    let remaining = clock.remaining(deadline).map_err(|_| 87u32)?;
    let millis = remaining
        .as_millis()
        .saturating_add(u128::from(remaining.subsec_nanos() % 1_000_000 != 0));
    let result = unsafe { WaitForSingleObject(handle, millis.min(u32::MAX as u128) as u32) };
    let (wait_error_code, expired) = post_wait_evidence(
        result,
        || unsafe { GetLastError() },
        || {
            #[cfg(test)]
            clock.after_wait_for_test();
            clock.is_due(deadline).unwrap_or(true)
        },
    );
    match result {
        WAIT_OBJECT_0 => Ok(!expired),
        WAIT_TIMEOUT => Ok(false),
        _ => Err(wait_error_code.unwrap_or_default()),
    }
}

pub(super) fn post_wait_evidence(
    result: u32,
    get_last_error: impl FnOnce() -> u32,
    deadline_expired: impl FnOnce() -> bool,
) -> (Option<u32>, bool) {
    let error = if result == WAIT_OBJECT_0 || result == WAIT_TIMEOUT {
        None
    } else {
        Some(get_last_error())
    };
    (error, deadline_expired())
}

fn query_active_processes(job: HANDLE) -> Result<u32, u32> {
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
        Err(unsafe { GetLastError() })
    } else {
        Ok(accounting.ActiveProcesses)
    }
}

fn query_job_pids(job: HANDLE) -> Result<Vec<u32>, u32> {
    let header_bytes = 2 * size_of::<u32>();
    let mut capacity = 2usize;
    for _ in 0..5 {
        let byte_len = header_bytes + capacity * size_of::<usize>();
        let mut storage = vec![0usize; byte_len.div_ceil(size_of::<usize>())];
        let info = storage
            .as_mut_ptr()
            .cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
        let queried = unsafe {
            QueryInformationJobObject(
                job,
                JobObjectBasicProcessIdList,
                info.cast(),
                byte_len as u32,
                null_mut(),
            )
        };
        if queried == 0 {
            return Err(unsafe { GetLastError() });
        }
        let assigned = unsafe { (*info).NumberOfAssignedProcesses as usize };
        let listed = unsafe { (*info).NumberOfProcessIdsInList as usize };
        if listed < assigned || listed > capacity {
            capacity = assigned.max(capacity.saturating_mul(2)).max(2);
            continue;
        }
        let ids = unsafe { slice::from_raw_parts((*info).ProcessIdList.as_ptr(), listed) };
        return ids
            .iter()
            .map(|id| u32::try_from(*id).map_err(|_| 87))
            .collect();
    }
    Err(122)
}

fn resolve_worker_executable() -> Result<PathBuf, std::io::Error> {
    let current = std::env::current_exe()?;
    if current
        .parent()
        .and_then(Path::file_name)
        .is_some_and(|name| name.eq_ignore_ascii_case("deps"))
    {
        let target = current
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| std::io::Error::other("test executable has no target directory"))?;
        Ok(target.join("plugin-sandbox-probe.exe"))
    } else {
        Ok(current)
    }
}

fn image_matches(process: HANDLE, expected: &Path) -> Result<bool, u32> {
    let mut image = vec![0u16; 32_768];
    let mut length = image.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process, 0, image.as_mut_ptr(), &mut length) } == 0 {
        return Err(unsafe { GetLastError() });
    }
    let actual = String::from_utf16_lossy(&image[..length as usize]);
    let actual = PathBuf::from(actual.clone())
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(actual));
    let expected = expected
        .canonicalize()
        .unwrap_or_else(|_| expected.to_path_buf());
    Ok(actual
        .to_string_lossy()
        .eq_ignore_ascii_case(&expected.to_string_lossy()))
}
