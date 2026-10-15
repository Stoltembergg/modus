//! Development-only real consumption test; never installed as an application binary.
#[cfg(target_os = "linux")]
fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use modus_decision_runtime::{
        artifacts::{read_locator, Bundle},
        inference::Engine,
        service,
    };
    use std::{fs, io, path::PathBuf};
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 5 {
        return Err("fixture-root locator locator-sha generation required".into());
    }
    let root = fs::canonicalize(&args[1])?;
    if !root.starts_with(std::env::temp_dir())
        || !root
            .file_name()
            .and_then(|x| x.to_str())
            .is_some_and(|x| x.starts_with("thx-artifact-fixture-"))
    {
        return Err("dedicated disposable fixture required".into());
    }
    let locator = PathBuf::from(&args[2]);
    if !fs::canonicalize(&locator)?.starts_with(&root) {
        return Err("fixture locator required".into());
    }
    let manifest = read_locator(&locator, &args[3])?;
    for file in &manifest.files {
        if !fs::canonicalize(&file.path)?.starts_with(&root) {
            return Err("fixture-only writes required".into());
        }
    }
    // Hold the directory itself: replacement never follows a mutable destination.
    let directory = fs::File::open(&root)?;
    for path in manifest
        .files
        .iter()
        .map(|f| &f.path)
        .chain(std::iter::once(&locator))
    {
        if path.parent() != Some(root.as_path()) {
            return Err("flat fixture directory required".into());
        }
    }
    let bundle = Bundle::load(&locator, &args[3])?;
    // Original M2.1 would reopen these now-substituted paths for tokenizer/dlopen/ORT.
    // The production consumer below must use ONLY the already authenticated buffers.
    for file in manifest.files {
        replace_entry(
            &directory,
            &file.path,
            b"synthetic replacement after authentication",
        )?;
    }
    replace_entry(&directory, &locator, b"synthetic locator replacement")?;
    let mut engine = Engine::from_verified_bundle(bundle)?;
    service::serve(
        io::stdin().lock(),
        io::stdout(),
        &args[4],
        &args[3],
        move |input, options| engine.observe(input, options),
    )
}
#[cfg(not(target_os = "linux"))]
fn main() {
    panic!("unvalidated platform");
}

#[cfg(target_os = "linux")]
fn replace_entry(
    directory: &std::fs::File,
    path: &std::path::Path,
    bytes: &[u8],
) -> std::io::Result<()> {
    use std::{
        ffi::CString,
        io::Write,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::ffi::OsStrExt,
        },
    };
    let name = CString::new(
        path.file_name()
            .ok_or_else(|| std::io::Error::other("filename"))?
            .as_bytes(),
    )?;
    let temporary = CString::new(format!(".replacement-{}", std::process::id())).unwrap();
    let dir = directory.as_raw_fd();
    let fd = unsafe {
        libc::openat(
            dir,
            temporary.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    let result = file.write_all(bytes).and_then(|()| {
        if unsafe { libc::renameat(dir, temporary.as_ptr(), dir, name.as_ptr()) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    });
    if result.is_err() {
        unsafe {
            libc::unlinkat(dir, temporary.as_ptr(), 0);
        }
    }
    result
}

#[cfg(all(test, target_os = "linux"))]
#[test]
fn replacement_does_not_follow_a_substituted_symlink() {
    let root = std::env::temp_dir().join(format!("thx-helper-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let sentinel = root.join("sentinel");
    std::fs::write(&sentinel, b"preserve").unwrap();
    let destination = root.join("target");
    std::os::unix::fs::symlink(&sentinel, &destination).unwrap();
    replace_entry(
        &std::fs::File::open(&root).unwrap(),
        &destination,
        b"replacement",
    )
    .unwrap();
    assert_eq!(std::fs::read(&sentinel).unwrap(), b"preserve");
    assert_eq!(std::fs::read(destination).unwrap(), b"replacement");
    std::fs::remove_dir_all(root).unwrap();
}
