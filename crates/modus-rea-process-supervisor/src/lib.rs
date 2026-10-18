//! Locked REA runtime: the supervisor installs `rea-agents` from a lockfile that ships inside
//! this binary and then runs the installed entry point directly. It never resolves a
//! dependency tree on the user's machine (`npx -y`) and never runs npm install scripts.

use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::ExitStatus,
    time::{Duration, SystemTime},
};

/// Pinned `rea-agents` version. Must match `rea-runtime/package.json`.
pub const REA_AGENTS_VERSION: &str = "6.5.0";
/// Registry `dist.integrity` of `rea-agents@6.5.0`; `npm ci` refuses a tarball that differs.
pub const REA_AGENTS_INTEGRITY: &str = "sha512-C6BG7LyrAdR74mSjertM6PrxJkcNZ2bfQNOJornPo9erDEp2tyPRVYPnV5Yodr+1RqewCQla68WulXlVnveD+A==";
/// Our manifest and lockfile for the REA runtime, compiled into the supervisor so the
/// locked tree cannot drift from the binary that runs it.
pub const RUNTIME_PACKAGE_JSON: &str = include_str!("../rea-runtime/package.json");
pub const RUNTIME_PACKAGE_LOCK: &str = include_str!("../rea-runtime/package-lock.json");

/// `npm ci` installs exactly the lockfile (with integrity checks) or fails. Install scripts
/// stay off for every package; see `rea-runtime/README.md` for the one package that has one.
pub const NPM_CI_ARGS: [&str; 7] = [
    "ci",
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    "--loglevel=error",
];
/// Entry point of the installed package (its `bin.rea-agents`), relative to the install dir.
pub const REA_ENTRY: [&str; 4] = ["node_modules", "rea-agents", "scripts", "rea.mjs"];
pub const REA_MCP_ARGS: [&str; 1] = ["mcp"];
/// Argument naming REA's private runtime root (passed by the desktop host).
pub const INSTALL_ROOT_FLAG: &str = "--install-root";

const COMPLETE_MARKER: &str = ".modus-rea-installed";
const STAGING_PREFIX: &str = ".staging-";
const STALE_STAGING_AGE: Duration = Duration::from_secs(60 * 60);

/// Copies `reader` to `writer` with plain read/write calls, flushing after every chunk.
///
/// Deliberately not `std::io::copy`: on Linux that specializes into `splice`, which never
/// forwards anything when stdin is a Unix socket, which is what Node's `child_process`
/// pipes are. The MCP host would then never get past `initialize`.
pub fn forward<R: Read, W: Write>(mut reader: R, mut writer: W) {
    let mut buffer = [0u8; 64 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                if writer.write_all(&buffer[..read]).is_err() || writer.flush().is_err() {
                    break;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

#[cfg(windows)]
pub mod platform {
    pub mod windows;
}

/// 64-bit FNV-1a; used only to give each lockfile revision its own directory name.
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Directory name for the current manifest + lockfile revision.
pub fn runtime_key() -> String {
    let mut bytes = Vec::with_capacity(RUNTIME_PACKAGE_JSON.len() + RUNTIME_PACKAGE_LOCK.len() + 1);
    bytes.extend_from_slice(RUNTIME_PACKAGE_JSON.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(RUNTIME_PACKAGE_LOCK.as_bytes());
    format!("rea-agents-{REA_AGENTS_VERSION}-{:016x}", fnv1a64(&bytes))
}

/// Parses `--install-root <dir>` from the supervisor's arguments (program name excluded).
pub fn install_root_from_args<I, A>(args: I) -> io::Result<PathBuf>
where
    I: IntoIterator<Item = A>,
    A: Into<std::ffi::OsString>,
{
    let mut args = args.into_iter().map(Into::into);
    let missing = || {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("missing {INSTALL_ROOT_FLAG} <dir> for the locked REA runtime"),
        )
    };
    while let Some(arg) = args.next() {
        if arg == *INSTALL_ROOT_FLAG {
            return args
                .next()
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .ok_or_else(missing);
        }
    }
    Err(missing())
}

/// Path of the installed REA entry point inside `install_dir`.
pub fn entry_path(install_dir: &Path) -> PathBuf {
    REA_ENTRY
        .iter()
        .fold(install_dir.to_path_buf(), |path, part| path.join(part))
}

/// Arguments for `node`: the installed entry point followed by `mcp`.
pub fn worker_args(install_dir: &Path) -> Vec<std::ffi::OsString> {
    let mut args = vec![entry_path(install_dir).into_os_string()];
    args.extend(REA_MCP_ARGS.iter().map(std::ffi::OsString::from));
    args
}

/// The `cmd.exe /c` line used for npm on Windows (npm is a `.cmd` shim there).
pub fn windows_npm_command_line() -> String {
    format!("npm {}", NPM_CI_ARGS.join(" "))
}

fn is_complete(dir: &Path) -> bool {
    let marker_ok = fs::read_to_string(dir.join(COMPLETE_MARKER))
        .map(|value| value.trim() == runtime_key())
        .unwrap_or(false);
    let lock_ok = fs::read_to_string(dir.join("package-lock.json"))
        .map(|value| value == RUNTIME_PACKAGE_LOCK)
        .unwrap_or(false);
    marker_ok && lock_ok && entry_path(dir).is_file()
}

fn create_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

/// Removes staging directories left by a crashed install. Recent ones may belong to a
/// concurrent supervisor and are left alone.
fn sweep_stale_staging(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(STAGING_PREFIX) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > STALE_STAGING_AGE);
        if stale {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// True for a directory name this supervisor publishes: `rea-agents-<version>-<16 hex>`.
fn is_runtime_dir_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("rea-agents-") else {
        return false;
    };
    let Some((version, hash)) = rest.rsplit_once('-') else {
        return false;
    };
    !version.is_empty()
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '+')
        && hash.len() == 16
        && hash
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

/// Removes runtimes published for an older manifest or lockfile (`rea-agents-<old>-<hash>/`),
/// which otherwise pile up under `root` after every bump. Only real directories whose name
/// matches our exact pattern are touched; `keep` (the runtime in use) never is, nor are
/// symlinks, files or anything else in `root`. Each one is renamed aside first so a removal
/// that stops halfway never leaves a directory under a runtime name.
fn sweep_stale_runtimes(root: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name == keep || !is_runtime_dir_name(name) {
            continue;
        }
        let is_dir = fs::symlink_metadata(entry.path()).is_ok_and(|meta| meta.file_type().is_dir());
        if !is_dir {
            continue;
        }
        let aside = root.join(format!("{STAGING_PREFIX}old-{}", unique_suffix()));
        if fs::rename(entry.path(), &aside).is_ok() {
            let _ = fs::remove_dir_all(&aside);
        }
    }
}

/// Ensures the locked runtime is installed under `root` and returns its directory.
///
/// `run_npm_ci` must run `npm` with [`NPM_CI_ARGS`] in the given directory. Installs go to a
/// unique staging directory and are published with one atomic rename, so concurrent
/// supervisors never share a half-written tree: the first rename wins and later ones reuse it.
pub fn ensure_installed<F>(root: &Path, mut run_npm_ci: F) -> io::Result<PathBuf>
where
    F: FnMut(&Path) -> io::Result<ExitStatus>,
{
    create_private_dir(root)?;
    let key = runtime_key();
    let final_dir = root.join(&key);
    if is_complete(&final_dir) {
        sweep_stale_runtimes(root, &key);
        return Ok(final_dir);
    }
    if final_dir.exists() {
        // Present but not a complete install of this lockfile: move it aside, then drop it.
        let aside = root.join(format!("{STAGING_PREFIX}invalid-{}", unique_suffix()));
        if fs::rename(&final_dir, &aside).is_ok() {
            let _ = fs::remove_dir_all(&aside);
        }
    }
    sweep_stale_staging(root);

    let staging = root.join(format!("{STAGING_PREFIX}{}", unique_suffix()));
    create_private_dir(&staging)?;
    let result = (|| {
        fs::write(staging.join("package.json"), RUNTIME_PACKAGE_JSON)?;
        fs::write(staging.join("package-lock.json"), RUNTIME_PACKAGE_LOCK)?;
        let status = run_npm_ci(&staging)?;
        if !status.success() {
            return Err(io::Error::other(format!(
                "locked REA install failed: npm ci exited with {status}"
            )));
        }
        if !entry_path(&staging).is_file() {
            return Err(io::Error::other(
                "locked REA install did not produce the rea-agents entry point",
            ));
        }
        let mut marker = fs::File::create(staging.join(COMPLETE_MARKER))?;
        marker.write_all(runtime_key().as_bytes())?;
        marker.sync_all()?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    match fs::rename(&staging, &final_dir) {
        Ok(()) => {
            sweep_stale_runtimes(root, &key);
            Ok(final_dir)
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            if is_complete(&final_dir) {
                sweep_stale_runtimes(root, &key);
                Ok(final_dir)
            } else {
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npm_ci_is_locked_and_script_free() {
        assert_eq!(NPM_CI_ARGS[0], "ci");
        assert!(NPM_CI_ARGS.contains(&"--ignore-scripts"));
        assert!(NPM_CI_ARGS.contains(&"--omit=dev"));
        for arg in NPM_CI_ARGS {
            assert_ne!(arg, "-y");
            assert_ne!(arg, "--yes");
            assert!(
                !arg.contains("rea-agents"),
                "npm must install from the lockfile only"
            );
        }
        let windows = windows_npm_command_line();
        assert!(windows.starts_with("npm ci --ignore-scripts"));
        assert!(!windows.contains("npx"));
    }

    #[test]
    fn worker_runs_the_installed_entry_point() {
        let dir = Path::new("rea-root").join("runtime");
        let args = worker_args(&dir);
        assert_eq!(
            args,
            vec![
                dir.join("node_modules")
                    .join("rea-agents")
                    .join("scripts")
                    .join("rea.mjs")
                    .into_os_string(),
                "mcp".into(),
            ]
        );
    }

    #[test]
    fn embedded_lockfile_pins_rea_agents_with_integrity() {
        assert!(
            RUNTIME_PACKAGE_JSON.contains(&format!("\"rea-agents\": \"{REA_AGENTS_VERSION}\""))
        );
        assert!(RUNTIME_PACKAGE_LOCK.contains("\"lockfileVersion\": 3"));
        let entry = RUNTIME_PACKAGE_LOCK
            .split("\"node_modules/rea-agents\": {")
            .nth(1)
            .expect("lockfile has a rea-agents entry");
        let entry = &entry[..entry.find('}').unwrap()];
        assert!(entry.contains(&format!("\"version\": \"{REA_AGENTS_VERSION}\"")));
        assert!(entry.contains(&format!("\"integrity\": \"{REA_AGENTS_INTEGRITY}\"")));
        assert!(REA_AGENTS_INTEGRITY.starts_with("sha512-C6BG7Lyr"));
        let resolved = RUNTIME_PACKAGE_LOCK.matches("\"resolved\": ").count();
        let integrity = RUNTIME_PACKAGE_LOCK
            .matches("\"integrity\": \"sha512-")
            .count();
        assert!(
            resolved > 100,
            "lockfile should list the full transitive tree"
        );
        assert_eq!(
            resolved, integrity,
            "every resolved package needs a sha512 integrity"
        );
    }

    #[test]
    fn install_root_flag_is_required() {
        assert!(install_root_from_args(Vec::<String>::new()).is_err());
        assert!(install_root_from_args(vec![INSTALL_ROOT_FLAG.to_owned()]).is_err());
        assert_eq!(
            install_root_from_args(vec![INSTALL_ROOT_FLAG.to_owned(), "/tmp/rea".to_owned()])
                .unwrap(),
            PathBuf::from("/tmp/rea")
        );
    }

    #[test]
    fn forward_copies_every_chunk_until_eof() {
        let input = b"first\nsecond\n".repeat(10_000);
        let mut output = Vec::new();
        forward(&input[..], &mut output);
        assert_eq!(output, input);
    }

    #[test]
    fn runtime_key_tracks_the_lockfile() {
        let key = runtime_key();
        assert!(key.starts_with("rea-agents-6.5.0-"));
        assert_eq!(key, runtime_key());
        assert_ne!(fnv1a64(b"a"), fnv1a64(b"b"));
    }

    fn temp_root(label: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("modus-rea-sweep-{label}-{}", unique_suffix()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn fake_install(dir: &Path) -> io::Result<ExitStatus> {
        let entry = entry_path(dir);
        fs::create_dir_all(entry.parent().unwrap())?;
        fs::write(entry, "// rea")?;
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            Ok(ExitStatus::from_raw(0))
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::ExitStatusExt;
            Ok(ExitStatus::from_raw(0))
        }
    }

    #[test]
    fn runtime_dir_names_match_only_our_exact_pattern() {
        assert!(is_runtime_dir_name(&runtime_key()));
        assert!(is_runtime_dir_name("rea-agents-6.4.0-0123456789abcdef"));
        assert!(is_runtime_dir_name(
            "rea-agents-7.0.0-beta.1-0123456789abcdef"
        ));
        for other in [
            "rea-agents",
            "rea-agents-",
            "rea-agents-6.4.0",
            "rea-agents-6.4.0-0123456789ABCDEF",
            "rea-agents-6.4.0-0123456789abcde",
            "rea-agents-6.4.0-0123456789abcdef0",
            "rea-agents-6.4.0-0123456789abcdeg",
            "rea-agents-x/y-0123456789abcdef",
            "my-rea-agents-6.4.0-0123456789abcdef",
            ".staging-123",
            "node_modules",
        ] {
            assert!(!is_runtime_dir_name(other), "{other}");
        }
    }

    #[test]
    fn stale_runtimes_are_removed_and_the_active_one_and_everything_else_kept() {
        let root = temp_root("stale");
        let old = root.join("rea-agents-6.4.0-0123456789abcdef");
        let older = root.join("rea-agents-6.3.1-fedcba9876543210");
        fs::create_dir_all(entry_path(&old).parent().unwrap()).unwrap();
        fs::create_dir_all(&older).unwrap();
        let lookalike_file = root.join("rea-agents-6.2.0-aaaaaaaaaaaaaaaa");
        fs::write(&lookalike_file, "not a dir").unwrap();
        let unrelated = root.join("rea-agents-notes");
        fs::create_dir_all(&unrelated).unwrap();
        let user_dir = root.join("something-else");
        fs::create_dir_all(&user_dir).unwrap();

        let active = ensure_installed(&root, fake_install).unwrap();
        assert_eq!(active, root.join(runtime_key()));
        assert!(is_complete(&active));
        assert!(!old.exists());
        assert!(!older.exists());
        assert!(lookalike_file.is_file(), "files are never removed");
        assert!(unrelated.is_dir());
        assert!(user_dir.is_dir());

        // Reuse path: the active runtime survives and a new stale one is swept.
        let stale_again = root.join("rea-agents-6.0.0-1111111111111111");
        fs::create_dir_all(&stale_again).unwrap();
        let reused =
            ensure_installed(&root, |_| panic!("must reuse the complete install")).unwrap();
        assert_eq!(reused, active);
        assert!(is_complete(&active));
        assert!(!stale_again.exists());
        assert!(
            fs::read_dir(&root)
                .unwrap()
                .flatten()
                .all(|e| !e.file_name().to_string_lossy().starts_with(".staging-old-")),
            "nothing left aside"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_runtime_names_are_not_followed() {
        let root = temp_root("symlink");
        let outside = temp_root("outside");
        fs::write(outside.join("keep.txt"), "user data").unwrap();
        let link = root.join("rea-agents-6.4.0-0123456789abcdef");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        ensure_installed(&root, fake_install).unwrap();
        assert!(
            link.symlink_metadata().is_ok(),
            "the link itself is left alone"
        );
        assert!(outside.join("keep.txt").is_file());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }
}
