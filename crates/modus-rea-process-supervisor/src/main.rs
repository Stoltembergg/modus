/// Keeps the host's missing-runtime classification working (`spawn npm ENOENT`).
fn spawn_error(program: &str, error: std::io::Error) -> std::io::Error {
    if error.kind() == std::io::ErrorKind::NotFound {
        std::io::Error::new(error.kind(), format!("spawn {program} ENOENT: {error}"))
    } else {
        error
    }
}

#[cfg(unix)]
fn main() {
    use modus_rea_process_supervisor::forward;
    use std::{
        io,
        process::{Command, Stdio},
        thread,
        time::Duration,
    };

    // The host owns this PID and can kill its process group directly. Descendants (npm ci and
    // the REA worker) inherit the supervisor's group; do not put them into a separate group.
    if unsafe { libc::setpgid(0, 0) } != 0 {
        eprintln!(
            "failed to establish supervisor process group: {}",
            io::Error::last_os_error()
        );
        std::process::exit(1);
    }
    let install_root =
        match modus_rea_process_supervisor::install_root_from_args(std::env::args_os().skip(1)) {
            Ok(root) => root,
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        };
    // Locked install: npm ci from the embedded lockfile, install scripts off. npm's stdout
    // goes to stderr so it can never corrupt the MCP stdout stream.
    let install_dir = match modus_rea_process_supervisor::ensure_installed(&install_root, |dir| {
        Command::new("npm")
            .args(modus_rea_process_supervisor::NPM_CI_ARGS)
            .current_dir(dir)
            .stdin(Stdio::null())
            .stdout(io::stderr())
            .stderr(Stdio::inherit())
            .status()
            .map_err(|error| spawn_error("npm", error))
    }) {
        Ok(dir) => dir,
        Err(error) => {
            eprintln!("failed to install the locked REA runtime: {error}");
            std::process::exit(127);
        }
    };
    let mut command = Command::new("node");
    command
        .args(modus_rea_process_supervisor::worker_args(&install_dir))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!(
                "failed to start pinned REA worker: {}",
                spawn_error("node", error)
            );
            std::process::exit(127);
        }
    };
    let pid = child.id() as i32;
    let mut child_stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let input = thread::spawn(move || forward(io::stdin().lock(), &mut child_stdin));
    let _output = thread::spawn(move || forward(stdout, io::stdout().lock()));
    let _errors = thread::spawn(move || forward(stderr, io::stderr().lock()));

    // EOF on MCP stdin means the transport is shutting down. Give the worker a bounded opportunity
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
    // First ask the worker to exit without signaling this supervisor (a member of the same group).
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
struct JobHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        // Closing the kill-on-close job terminates every process assigned to it.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// Starts `command` suspended, assigns it to `job`, then resumes its primary thread, so the
/// process and all of its descendants belong to the job before any of its code runs.
#[cfg(windows)]
fn spawn_in_job(
    job: &JobHandle,
    command: &mut std::process::Command,
) -> std::io::Result<std::process::Child> {
    use modus_rea_process_supervisor::platform::windows::resume_thread_result;
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First,
                Thread32Next,
            },
            JobObjects::AssignProcessToJobObject,
            Threading::{CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };

    let mut child = command.creation_flags(CREATE_SUSPENDED).spawn()?;
    let process = child.as_raw_handle() as HANDLE;
    if unsafe { AssignProcessToJobObject(job.0, process) } == 0 {
        let error = io::Error::last_os_error();
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let pid = child.id();
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        let error = io::Error::last_os_error();
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut resumed: io::Result<bool> = Ok(false);
    let mut ok = unsafe { Thread32First(snapshot, &mut entry) };
    while ok != 0 {
        if entry.th32OwnerProcessID == pid {
            let thread_handle = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if !thread_handle.is_null() {
                let resume_result = unsafe { ResumeThread(thread_handle) };
                resumed = resume_thread_result(resume_result).map(|()| true);
                unsafe { CloseHandle(thread_handle) };
                break;
            }
        }
        ok = unsafe { Thread32Next(snapshot, &mut entry) };
    }
    unsafe {
        CloseHandle(snapshot);
    }
    match resumed {
        Ok(true) => Ok(child),
        Ok(false) => {
            let error = io::Error::last_os_error();
            let _ = child.kill();
            let _ = child.wait();
            Err(error)
        }
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(error)
        }
    }
}

#[cfg(windows)]
fn windows_main() -> std::io::Result<()> {
    use modus_rea_process_supervisor::forward;
    use std::{
        io,
        process::{Command, Stdio},
        thread,
    };
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject,
    };

    // Every process the supervisor starts (npm ci and the worker) is assigned to this job
    // before it runs. Job close is a final descendant-tree kill guarantee.
    let raw_job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if raw_job.is_null() {
        return Err(io::Error::last_os_error());
    }
    let job = JobHandle(raw_job);
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as _,
            std::mem::size_of_val(&limits) as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let install_root =
        modus_rea_process_supervisor::install_root_from_args(std::env::args_os().skip(1))?;
    // npm is a .cmd shim on Windows, so it runs through cmd.exe with a constant command line;
    // the install directory is passed as the working directory, never on the command line.
    let install_dir = modus_rea_process_supervisor::ensure_installed(&install_root, |dir| {
        let mut npm = Command::new("cmd.exe");
        npm.args([
            "/d",
            "/s",
            "/c",
            &modus_rea_process_supervisor::windows_npm_command_line(),
        ])
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(io::stderr())
        .stderr(Stdio::inherit());
        spawn_in_job(&job, &mut npm)?.wait()
    })
    .map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("failed to install the locked REA runtime: {error}"),
        )
    })?;
    let mut worker = Command::new("node");
    worker
        .args(modus_rea_process_supervisor::worker_args(&install_dir))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = spawn_in_job(&job, &mut worker).map_err(|error| spawn_error("node", error))?;
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let input = thread::spawn(move || forward(io::stdin().lock(), &mut stdin));
    let output = thread::spawn(move || forward(stdout, io::stdout().lock()));
    let errors = thread::spawn(move || forward(stderr, io::stderr().lock()));
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
    drop(job);
    let _ = child.wait();
    let _ = output.join();
    let _ = errors.join();
    Ok(())
}
