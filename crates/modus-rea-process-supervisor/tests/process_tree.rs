use std::{
    fs,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
#[test]
fn windows_command_line_quoting_preserves_spaced_unicode_paths() {
    use modus_rea_process_supervisor::platform::windows::quote_windows_arg;
    let path = r#"C:\Users\José Smith\Modus App\bin\node.exe"#;
    assert_eq!(
        quote_windows_arg(path),
        r#""C:\Users\José Smith\Modus App\bin\node.exe""#
    );
}

#[test]
fn eof_terminates_fake_npx_parent_and_grandchild() {
    assert_eq!(
        modus_rea_process_supervisor::NPX_ARGS,
        ["-y", "rea-agents@6.5.0", "mcp"]
    );
    let root = std::env::temp_dir().join(format!("modus rea supervisor-é-{}", std::process::id()));
    let bin = root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let marker = root.join("pids.json");
    let graceful_marker = root.join("graceful-exit.txt");
    let marker_js = marker
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('\'', "\\'");
    let script = format!(
        "const fs=require('node:fs'); const {{spawn}}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{{}},1000)'],{{stdio:'ignore'}}); fs.writeFileSync('{marker_js}',process.pid+','+c.pid); process.stdin.on('end',()=>{{setTimeout(()=>{{fs.writeFileSync('{}','graceful');process.exit(0)}},150)}}); process.stdin.resume(); setInterval(()=>{{}},1000);",
        graceful_marker
            .to_string_lossy()
            .replace('\\', "\\\\")
            .replace('\'', "\\'")
    );
    fs::write(bin.join("fixture.js"), script).unwrap();
    #[cfg(unix)]
    {
        let npx = bin.join("npx");
        fs::write(
            &npx,
            "#!/bin/sh\nexec node \"$(dirname \"$0\")/fixture.js\"\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&npx, fs::Permissions::from_mode(0o755)).unwrap();
    }
    #[cfg(windows)]
    fs::write(
        bin.join("npx.cmd"),
        "@echo off\r\nnode \"%~dp0fixture.js\"\r\n",
    )
    .unwrap();

    let executable = env!("CARGO_BIN_EXE_modus-rea-process-supervisor");
    let path = std::env::var("PATH").unwrap_or_default();
    #[cfg(windows)]
    let path = format!("{};{}", bin.display(), path);
    #[cfg(unix)]
    let path = format!("{}:{}", bin.display(), path);
    let mut supervisor = Command::new(executable)
        .env("PATH", path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let _input = supervisor.stdin.take().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !marker.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(25));
    }
    assert!(marker.exists(), "fake npx did not start");
    let pids: Vec<u32> = fs::read_to_string(&marker)
        .unwrap()
        .split(',')
        .map(|pid| pid.parse().unwrap())
        .collect();
    drop(_input); // MCP transport EOF requests orderly worker shutdown.
    let status = supervisor.wait().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(libc::SIGKILL));
    }
    #[cfg(windows)]
    assert!(status.success(), "supervisor exited with {status}");
    assert!(
        graceful_marker.exists(),
        "child did not get a graceful EOF window"
    );
    for pid in pids {
        let deadline = Instant::now() + Duration::from_secs(5);
        while process_is_alive(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(
            !process_is_alive(pid),
            "owned process {pid} remained after supervisor EOF"
        );
    }
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(unix)]
#[test]
fn supervisor_pid_owns_worker_group_and_parent_group_kill_cleans_descendants() {
    let root = std::env::temp_dir().join(format!("modus rea group-é-{}", std::process::id()));
    let bin = root.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let marker = root.join("pids.txt");
    let escaped_marker = marker
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    fs::write(
        bin.join("fixture.js"),
        format!(
            "const fs=require('node:fs');const {{spawn}}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{{}},1000)'],{{stdio:'ignore'}});fs.writeFileSync(\"{escaped_marker}\",process.pid+','+c.pid);setInterval(()=>{{}},1000);"
        ),
    )
    .unwrap();
    let npx = bin.join("npx");
    fs::write(
        &npx,
        "#!/bin/sh\nexec node \"$(dirname \"$0\")/fixture.js\"\n",
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&npx, fs::Permissions::from_mode(0o755)).unwrap();

    let old_path = std::env::var("PATH").unwrap_or_default();
    let mut supervisor = Command::new(env!("CARGO_BIN_EXE_modus-rea-process-supervisor"))
        .env("PATH", format!("{}:{old_path}", bin.display()))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let supervisor_pid = supervisor.id() as libc::pid_t;
    let _input = supervisor.stdin.take().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !marker.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(25));
    }
    assert!(marker.exists(), "fake npx did not start");
    let pids: Vec<libc::pid_t> = fs::read_to_string(&marker)
        .unwrap()
        .split(',')
        .map(|pid| pid.parse().unwrap())
        .collect();
    let supervisor_group = unsafe { libc::getpgid(supervisor_pid) };
    let worker_group = unsafe { libc::getpgid(pids[0]) };
    let grandchild_group = unsafe { libc::getpgid(pids[1]) };

    // Simulate the host's direct-supervisor kill followed by killTree(supervisorPid).
    unsafe {
        libc::kill(supervisor_pid, libc::SIGKILL);
    }
    let _ = supervisor.wait();
    unsafe {
        libc::kill(-supervisor_pid, libc::SIGKILL);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while (process_is_alive(pids[0] as u32) || process_is_alive(pids[1] as u32))
        && Instant::now() < deadline
    {
        thread::sleep(Duration::from_millis(25));
    }
    let descendants_stopped =
        !process_is_alive(pids[0] as u32) && !process_is_alive(pids[1] as u32);

    // Ensure a failure on the old child-owned process group cannot leak fixture processes.
    unsafe {
        libc::kill(-pids[0], libc::SIGKILL);
    }
    let _ = fs::remove_dir_all(root);
    assert_eq!(
        supervisor_group, supervisor_pid,
        "supervisor was not a process-group leader"
    );
    assert_eq!(
        worker_group, supervisor_pid,
        "npx did not inherit supervisor process group"
    );
    assert_eq!(
        grandchild_group, supervisor_pid,
        "grandchild did not inherit supervisor process group"
    );
    assert!(
        descendants_stopped,
        "parent-side supervisor-group kill left a descendant running"
    );
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, STILL_ACTIVE},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return false;
    }
    let mut exit_code = 0;
    let query_succeeded = unsafe { GetExitCodeProcess(handle, &mut exit_code) } != 0;
    unsafe { CloseHandle(handle) };
    query_succeeded && exit_code == STILL_ACTIVE as u32
}

#[test]
fn test_fixture_uses_only_the_pinned_command() {
    assert_eq!(
        modus_rea_process_supervisor::NPX_ARGS,
        ["-y", "rea-agents@6.5.0", "mcp"]
    );
}
