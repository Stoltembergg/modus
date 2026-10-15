#[cfg(unix)]
fn main() {
    use std::{
        io::{self, Read},
        process::{Command, Stdio},
        thread,
        time::Duration,
    };

    // The host owns this PID and can kill its process group directly. Descendants inherit
    // the supervisor's group; do not put npx into a separate group.
    if unsafe { libc::setpgid(0, 0) } != 0 {
        eprintln!(
            "failed to establish supervisor process group: {}",
            io::Error::last_os_error()
        );
        std::process::exit(1);
    }
    let mut command = Command::new("npx");
    command
        .args(modus_rea_process_supervisor::NPX_ARGS)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!("failed to start pinned REA worker: {error}");
            std::process::exit(127);
        }
    };
    let pid = child.id() as i32;
    let mut child_stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let input = thread::spawn(move || {
        let _ = io::copy(&mut io::stdin().lock(), &mut child_stdin);
    });
    let _output = thread::spawn(move || {
        let _ = io::copy(&mut stdout.take(u64::MAX), &mut io::stdout().lock());
    });
    let _errors = thread::spawn(move || {
        let _ = io::copy(&mut stderr.take(u64::MAX), &mut io::stderr().lock());
    });

    // EOF on MCP stdin means the transport is shutting down. Give npx a bounded opportunity
    // to finish after receiving EOF before terminating its owned process group.
    loop {
        if input.is_finished() || child.try_wait().ok().flatten().is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    if input.is_finished() {
        let _ = input.join();
        let graceful_deadline = std::time::Instant::now() + Duration::from_millis(500);
        while std::time::Instant::now() < graceful_deadline {
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => break,
                Ok(None) => thread::sleep(Duration::from_millis(20)),
            }
        }
    }
    // First ask npx to exit without signaling this supervisor (a member of the same group).
    if child.try_wait().ok().flatten().is_none() {
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
    let termination_deadline = std::time::Instant::now() + Duration::from_millis(500);
    while std::time::Instant::now() < termination_deadline {
        thread::sleep(Duration::from_millis(20));
    }
    // This group includes the supervisor itself. SIGKILL may therefore end this process,
    // which is intentional: the parent can use this PID as the single tree-termination handle.
    unsafe {
        libc::kill(-(std::process::id() as i32), libc::SIGKILL);
    }
}

#[cfg(windows)]
fn main() {
    if let Err(error) = windows_main() {
        eprintln!("REA process supervisor failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(windows)]
fn windows_main() -> std::io::Result<()> {
    use modus_rea_process_supervisor::platform::windows::resume_thread_result;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::{
        io::{self, Read},
        process::{Command, Stdio},
        thread,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First,
                Thread32Next,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            },
            Threading::{CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };

    // std creates the primary process suspended; the job assignment is complete before
    // the primary thread is resumed. Job close is a final descendant-tree kill guarantee.
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(io::Error::last_os_error());
    }
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as _,
            std::mem::size_of_val(&limits) as u32,
        )
    } == 0
    {
        unsafe {
            CloseHandle(job);
        }
        return Err(io::Error::last_os_error());
    }
    let mut child = Command::new("cmd.exe")
        .args(["/d", "/s", "/c", "npx -y rea-agents@6.5.0 mcp"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_SUSPENDED)
        .spawn()?;
    let process = child.as_raw_handle() as HANDLE;
    if unsafe { AssignProcessToJobObject(job, process) } == 0 {
        let _ = child.kill();
        unsafe {
            CloseHandle(job);
        }
        return Err(io::Error::last_os_error());
    }
    let pid = child.id();
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
        unsafe {
            CloseHandle(job);
        }
        return Err(io::Error::last_os_error());
    }
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut found = false;
    let mut ok = unsafe { Thread32First(snapshot, &mut entry) };
    while ok != 0 {
        if entry.th32OwnerProcessID == pid {
            let thread_handle = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if !thread_handle.is_null() {
                let resume_result = unsafe { ResumeThread(thread_handle) };
                if let Err(error) = resume_thread_result(resume_result) {
                    unsafe {
                        CloseHandle(thread_handle);
                        CloseHandle(snapshot);
                        CloseHandle(job);
                    }
                    let _ = child.wait();
                    return Err(error);
                }
                unsafe { CloseHandle(thread_handle) };
                found = true;
                break;
            }
        }
        ok = unsafe { Thread32Next(snapshot, &mut entry) };
    }
    unsafe {
        CloseHandle(snapshot);
    }
    if !found {
        unsafe {
            CloseHandle(job);
        }
        return Err(io::Error::last_os_error());
    }
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let input = thread::spawn(move || {
        let _ = io::copy(&mut io::stdin().lock(), &mut stdin);
    });
    let output = thread::spawn(move || {
        let _ = io::copy(&mut stdout.take(u64::MAX), &mut io::stdout().lock());
    });
    let errors = thread::spawn(move || {
        let _ = io::copy(&mut stderr.take(u64::MAX), &mut io::stderr().lock());
    });
    while !input.is_finished() && child.try_wait()?.is_none() {
        thread::sleep(std::time::Duration::from_millis(20));
    }
    if input.is_finished() {
        let _ = input.join();
        let graceful_deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        while std::time::Instant::now() < graceful_deadline {
            match child.try_wait()? {
                Some(_) => break,
                None => thread::sleep(std::time::Duration::from_millis(20)),
            }
        }
    }
    // Closing the kill-on-close job terminates the direct child and every descendant.
    unsafe {
        CloseHandle(job);
    }
    let _ = child.wait();
    let _ = output.join();
    let _ = errors.join();
    Ok(())
}
