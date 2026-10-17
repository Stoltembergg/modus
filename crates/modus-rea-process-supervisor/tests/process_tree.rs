use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use modus_rea_process_supervisor::{INSTALL_ROOT_FLAG, NPM_CI_ARGS, runtime_key};

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

fn js_string(path: &Path) -> String {
    format!(
        "\"{}\"",
        path.to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
    )
}

/// A fake `npm` on PATH that records its arguments and "installs" a fixture REA entry point
/// (an ES module run by the real `node`) into the staging directory it is started in.
struct Fixture {
    root: PathBuf,
    bin: PathBuf,
    install_root: PathBuf,
    marker: PathBuf,
    graceful_marker: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("modus rea {name}-é-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let marker = root.join("pids.txt");
        let graceful_marker = root.join("graceful-exit.txt");
        let worker = format!(
            "import fs from 'node:fs'; import {{ spawn }} from 'node:child_process';\n\
             if (process.argv[2] !== 'mcp' || process.argv.length !== 3) process.exit(9);\n\
             const c = spawn(process.execPath, ['-e', 'setInterval(()=>{{}},1000)'], {{ stdio: 'ignore' }});\n\
             fs.writeFileSync({marker}, process.pid + ',' + c.pid);\n\
             process.stdout.write('WORKER-READY\\n');\n\
             process.stdin.on('data', (d) => process.stdout.write('ECHO:' + d));\n\
             process.stdin.on('end', () => {{ setTimeout(() => {{ fs.writeFileSync({graceful}, 'graceful'); process.exit(0); }}, 150); }});\n\
             process.stdin.resume(); setInterval(() => {{}}, 1000);\n",
            marker = js_string(&marker),
            graceful = js_string(&graceful_marker),
        );
        fs::write(bin.join("rea.mjs"), worker).unwrap();
        #[cfg(unix)]
        {
            let npm = bin.join("npm");
            fs::write(
                &npm,
                "#!/bin/sh\n\
                 d=\"$(dirname \"$0\")\"\n\
                 printf '%s\\n' \"$*\" >> \"$d/npm-calls.log\"\n\
                 [ -f \"$d/fail\" ] && exit 1\n\
                 [ -f package-lock.json ] || exit 3\n\
                 mkdir -p node_modules/rea-agents/scripts\n\
                 cp \"$d/rea.mjs\" node_modules/rea-agents/scripts/rea.mjs\n\
                 echo 'added 1 package'\n",
            )
            .unwrap();
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&npm, fs::Permissions::from_mode(0o755)).unwrap();
        }
        #[cfg(windows)]
        fs::write(
            bin.join("npm.cmd"),
            "@echo off\r\n\
             echo %*>>\"%~dp0npm-calls.log\"\r\n\
             if exist \"%~dp0fail\" exit /b 1\r\n\
             if not exist package-lock.json exit /b 3\r\n\
             mkdir node_modules\\rea-agents\\scripts 2>nul\r\n\
             copy /y \"%~dp0rea.mjs\" node_modules\\rea-agents\\scripts\\rea.mjs >nul\r\n\
             echo added 1 package\r\n",
        )
        .unwrap();
        Fixture {
            install_root: root.join("runtime"),
            root,
            bin,
            marker,
            graceful_marker,
        }
    }

    fn spawn(&self, with_install_root: bool) -> Child {
        let path = std::env::var("PATH").unwrap_or_default();
        #[cfg(windows)]
        let path = format!("{};{}", self.bin.display(), path);
        #[cfg(unix)]
        let path = format!("{}:{}", self.bin.display(), path);
        let mut command = Command::new(env!("CARGO_BIN_EXE_modus-rea-process-supervisor"));
        if with_install_root {
            command.arg(INSTALL_ROOT_FLAG).arg(&self.install_root);
        }
        command
            .env("PATH", path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    fn npm_calls(&self) -> Vec<String> {
        fs::read_to_string(self.bin.join("npm-calls.log"))
            .unwrap_or_default()
            .lines()
            .map(|line| line.trim().to_owned())
            .filter(|line| !line.is_empty())
            .collect()
    }

    fn wait_for_marker(&self) -> Vec<u32> {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !self.marker.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(self.marker.exists(), "locked REA worker did not start");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let text = fs::read_to_string(&self.marker).unwrap_or_default();
            let pids: Vec<u32> = text
                .split(',')
                .filter_map(|pid| pid.trim().parse().ok())
                .collect();
            if pids.len() == 2 || Instant::now() >= deadline {
                return pids;
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    /// Starts the supervisor, waits for the worker, closes stdin, and returns its stdout.
    fn run_until_eof(&self) -> String {
        let _ = fs::remove_file(&self.marker);
        let _ = fs::remove_file(&self.graceful_marker);
        let mut supervisor = self.spawn(true);
        let mut stdout = supervisor.stdout.take().unwrap();
        let reader = thread::spawn(move || {
            let mut text = String::new();
            let _ = stdout.read_to_string(&mut text);
            text
        });
        let input = supervisor.stdin.take().unwrap();
        let pids = self.wait_for_marker();
        drop(input); // MCP transport EOF requests orderly worker shutdown.
        let status = supervisor.wait().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(status.signal(), Some(libc::SIGKILL));
        }
        #[cfg(windows)]
        assert!(status.success(), "supervisor exited with {status}");
        assert!(
            self.graceful_marker.exists(),
            "worker did not get a graceful EOF window"
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
        reader.join().unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn staging_or_runtime_dirs(root: &Path) -> Vec<String> {
    fs::read_dir(root)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn eof_terminates_locked_worker_and_grandchild_and_reuses_the_install() {
    let fixture = Fixture::new("supervisor");
    let stdout = fixture.run_until_eof();
    assert!(stdout.contains("WORKER-READY"), "worker stdout: {stdout:?}");
    assert!(
        !stdout.contains("added 1 package"),
        "npm output must not reach the MCP stdout stream"
    );
    assert_eq!(fixture.npm_calls(), vec![NPM_CI_ARGS.join(" ")]);
    let install_dir = fixture.install_root.join(runtime_key());
    assert_eq!(
        fs::read_to_string(install_dir.join("package-lock.json")).unwrap(),
        modus_rea_process_supervisor::RUNTIME_PACKAGE_LOCK
    );
    assert_eq!(
        staging_or_runtime_dirs(&fixture.install_root),
        vec![runtime_key()]
    );

    // A second start reuses the published install and does not run npm again.
    let stdout = fixture.run_until_eof();
    assert!(stdout.contains("WORKER-READY"));
    assert_eq!(fixture.npm_calls().len(), 1, "npm ci ran again");
}

#[test]
fn failed_locked_install_publishes_nothing_and_starts_no_worker() {
    let fixture = Fixture::new("failed-install");
    fs::write(fixture.bin.join("fail"), "").unwrap();
    let mut supervisor = fixture.spawn(true);
    let status = supervisor.wait().unwrap();
    assert!(!status.success());
    assert_eq!(fixture.npm_calls().len(), 1);
    assert!(
        !fixture.marker.exists(),
        "worker started after failed install"
    );
    assert!(
        staging_or_runtime_dirs(&fixture.install_root).is_empty(),
        "failed install left {:?}",
        staging_or_runtime_dirs(&fixture.install_root)
    );
}

#[test]
fn missing_install_root_never_runs_npm() {
    let fixture = Fixture::new("no-root");
    let mut supervisor = fixture.spawn(false);
    let status = supervisor.wait().unwrap();
    assert!(!status.success());
    assert!(fixture.npm_calls().is_empty());
    assert!(!fixture.marker.exists());
}

/// Node's `child_process` pipes are Unix sockets. The supervisor must forward MCP traffic
/// over them (std's `io::copy` uses `splice` there and never delivers anything).
#[cfg(unix)]
#[test]
fn forwards_mcp_traffic_over_unix_socket_stdio() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    let fixture = Fixture::new("socket-stdio");
    let (mut host_in, worker_in) = UnixStream::pair().unwrap();
    let (host_out, worker_out) = UnixStream::pair().unwrap();
    let path = format!(
        "{}:{}",
        fixture.bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let mut supervisor = Command::new(env!("CARGO_BIN_EXE_modus-rea-process-supervisor"))
        .arg(INSTALL_ROOT_FLAG)
        .arg(&fixture.install_root)
        .env("PATH", path)
        .stdin(Stdio::from(std::os::fd::OwnedFd::from(worker_in)))
        .stdout(Stdio::from(std::os::fd::OwnedFd::from(worker_out)))
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    fixture.wait_for_marker();
    host_in.write_all(b"ping\n").unwrap();
    host_out
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut reader = BufReader::new(host_out);
    let mut lines = Vec::new();
    let mut line = String::new();
    while lines.len() < 2 && reader.read_line(&mut line).is_ok_and(|read| read > 0) {
        lines.push(line.trim_end().to_owned());
        line.clear();
    }
    drop(host_in);
    let _ = supervisor.wait();
    assert_eq!(lines, vec!["WORKER-READY", "ECHO:ping"]);
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(unix)]
#[test]
fn supervisor_pid_owns_worker_group_and_parent_group_kill_cleans_descendants() {
    let fixture = Fixture::new("group");
    let mut supervisor = fixture.spawn(true);
    let supervisor_pid = supervisor.id() as libc::pid_t;
    let _input = supervisor.stdin.take().unwrap();
    let pids: Vec<libc::pid_t> = fixture
        .wait_for_marker()
        .into_iter()
        .map(|pid| pid as libc::pid_t)
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
    assert_eq!(
        supervisor_group, supervisor_pid,
        "supervisor was not a process-group leader"
    );
    assert_eq!(
        worker_group, supervisor_pid,
        "worker did not inherit supervisor process group"
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
fn supervisor_never_uses_npx() {
    let source = include_str!("../src/main.rs");
    assert!(!source.contains("Command::new(\"npx\")"));
    assert!(!source.contains("npx -y"));
    assert!(!modus_rea_process_supervisor::windows_npm_command_line().contains("npx"));
}
