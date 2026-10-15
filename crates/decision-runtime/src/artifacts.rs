//! Linux artifact authentication. Manifests locate files; compiled pins authorize bytes.
use crate::inference::{Manifest, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::CString,
    fs::{self, File, Metadata},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            ffi::OsStrExt,
            fs::{FileExt, MetadataExt},
        },
    },
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pin {
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrustRoot {
    pub revision: u32,
    pub checkpoint: String,
    pub ort_version: String,
    pub external_location: String,
    pub artifacts: BTreeMap<String, Pin>,
}
pub fn trust_root() -> Result<TrustRoot> {
    Ok(serde_json::from_str(include_str!(
        "../artifact-trust-root.json"
    ))?)
}

/// Walk relative to owned directory FDs; never follow any source-path symlink.
fn open_source(path: &Path) -> Result<File> {
    let raw = path.as_os_str().as_bytes();
    if !path.is_absolute() || raw.ends_with(b"/") {
        return Err("artifact_path".into());
    }
    let components: Vec<_> = raw[1..].split(|&b| b == b'/').collect();
    if components
        .iter()
        .any(|s| s.is_empty() || *s == b"." || *s == b"..")
    {
        return Err("artifact_traversal".into());
    }
    let mut directory = File::open("/")?;
    for (i, component) in components.iter().enumerate() {
        let name = CString::new(*component)?;
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | if i + 1 == components.len() {
                libc::O_NONBLOCK
            } else {
                libc::O_DIRECTORY
            };
        // SAFETY: valid owned directory FD and NUL-terminated component; returned FD is uniquely owned.
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        // SAFETY: openat returned a new live FD, transferred exactly once to File.
        directory = unsafe { File::from_raw_fd(fd) };
    }
    if !directory.metadata()?.is_file() {
        return Err("artifact_not_regular".into());
    }
    Ok(directory)
}
fn stable(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}
fn snapshot(mut file: File, max: u64, exact: Option<u64>, sha256: &str) -> Result<Vec<u8>> {
    if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("artifact_pin".into());
    }
    let before = file.metadata()?;
    if !before.is_file() || before.len() > max || exact.is_some_and(|n| before.len() != n) {
        return Err("artifact_size".into());
    }
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(usize::try_from(before.len())?)?;
    (&mut file)
        .take(max.checked_add(1).ok_or("artifact_size")?)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 != before.len() || !stable(&before, &file.metadata()?) {
        return Err("artifact_concurrent_change".into());
    }
    if format!("{:x}", Sha256::digest(&bytes)) != sha256 {
        return Err("artifact_digest".into());
    }
    Ok(bytes)
}
pub fn read_snapshot(path: &Path, bytes: u64, sha256: &str) -> Result<Vec<u8>> {
    snapshot(open_source(path)?, bytes, Some(bytes), sha256)
}
pub fn read_locator(path: &Path, sha256: &str) -> Result<Manifest> {
    Ok(serde_json::from_slice(&snapshot(
        open_source(path)?,
        64 * 1024,
        None,
        sha256,
    )?)?)
}

pub struct Bundle {
    pub(crate) graph: Vec<u8>,
    pub(crate) data: Vec<u8>,
    pub(crate) tokenizer: Vec<u8>,
    pub(crate) config: Vec<u8>,
    pub(crate) calibration: Vec<u8>,
    pub(crate) library: Vec<u8>,
    pub(crate) external_location: String,
}
impl Bundle {
    pub fn load(path: &Path, locator_sha: &str) -> Result<Self> {
        let manifest = read_locator(path, locator_sha)?;
        let root = trust_root()?;
        if root.revision != 1
            || root.checkpoint != "01262517979528a0103108ba473b78d6baeec016"
            || manifest.ort_version != root.ort_version
        {
            return Err("artifact_root".into());
        }
        if manifest.files.len() != 6 {
            return Err("artifact_unlisted".into());
        }
        let data = PathBuf::from(format!("{}.data", manifest.graph.display()));
        let roles = [
            ("graph", &manifest.graph),
            ("external_data", &data),
            ("tokenizer", &manifest.tokenizer),
            ("tokenizer_config", &manifest.tokenizer_config),
            ("calibration", &manifest.calibration),
            ("ort_library", &manifest.ort_library),
        ];
        let mut buffers = BTreeMap::new();
        let unique: std::collections::BTreeSet<_> = roles.iter().map(|(_, path)| *path).collect();
        if unique.len() != 6 {
            return Err("artifact_alias".into());
        }
        for (role, path) in roles {
            let pin = root.artifacts.get(role).ok_or("artifact_role")?;
            let matches: Vec<_> = manifest.files.iter().filter(|f| &f.path == path).collect();
            if matches.len() != 1
                || matches[0].sha256 != pin.sha256
                || matches[0].bytes != pin.bytes
            {
                return Err("artifact_unapproved_identity".into());
            }
        }
        for (role, path) in roles {
            let pin = root.artifacts.get(role).ok_or("artifact_role")?;
            buffers.insert(role, read_snapshot(path, pin.bytes, &pin.sha256)?);
        }
        Ok(Self {
            graph: buffers.remove("graph").ok_or("artifact_role")?,
            data: buffers.remove("external_data").ok_or("artifact_role")?,
            tokenizer: buffers.remove("tokenizer").ok_or("artifact_role")?,
            config: buffers.remove("tokenizer_config").ok_or("artifact_role")?,
            calibration: buffers.remove("calibration").ok_or("artifact_role")?,
            library: buffers.remove("ort_library").ok_or("artifact_role")?,
            external_location: root.external_location,
        })
    }
}
/// The loader opens this immutable kernel object, never the original .so path.
pub struct SealedLibrary {
    file: File,
}
impl SealedLibrary {
    pub fn new(bytes: &[u8]) -> Result<Self> {
        let name = CString::new("modus-ort-verified")?;
        // SAFETY: immutable NUL-terminated name and documented memfd flags.
        let fd = unsafe {
            libc::memfd_create(name.as_ptr(), libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING)
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        // SAFETY: newly returned FD transferred exactly once.
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(bytes)?;
        let seals =
            libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
        // SAFETY: valid owned memfd and documented fcntl seal operations.
        if unsafe { libc::fcntl(fd, libc::F_ADD_SEALS, seals) } < 0
            || unsafe { libc::fcntl(fd, libc::F_GET_SEALS) } & seals != seals
        {
            return Err("artifact_seal".into());
        }
        authenticate_sealed(&file, bytes)?;
        Ok(Self { file })
    }
    pub fn path(&self) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", self.file.as_raw_fd()))
    }
}

fn authenticate_sealed(file: &File, original: &[u8]) -> Result<()> {
    let seals = libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
    // SAFETY: owned memfd; F_GET_SEALS has no pointer argument.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GET_SEALS) } & seals != seals
        || file.metadata()?.len() != original.len() as u64
    {
        return Err("artifact_seal".into());
    }
    // A same-UID writer could have reached the memfd BEFORE sealing. Authenticate
    // the sealed object itself, not merely the source buffer copied into it.
    let mut actual = Sha256::new();
    let mut offset = 0u64;
    let mut buffer = vec![0; 1024 * 1024];
    while offset < original.len() as u64 {
        let n = file.read_at(&mut buffer, offset)?;
        if n == 0 {
            return Err("artifact_seal".into());
        }
        actual.update(&buffer[..n]);
        offset += n as u64;
    }
    if actual.finalize() != Sha256::digest(original) {
        return Err("artifact_sealed_digest".into());
    }
    Ok(())
}
#[cfg(test)]
mod seal_tests {
    use super::*;
    #[test]
    fn detects_bytes_changed_before_the_seal_became_effective() {
        let altered = SealedLibrary::new(b"replaced-before-seal").unwrap();
        assert_eq!(
            authenticate_sealed(&altered.file, b"approved-before-seal")
                .err()
                .unwrap()
                .to_string(),
            "artifact_sealed_digest"
        );
    }
}

fn root_controlled(path: &Path) -> Result<File> {
    let canonical = fs::canonicalize(path)?;
    if !canonical.starts_with("/usr/lib/x86_64-linux-gnu")
        && canonical != Path::new("/etc/ld.so.cache")
    {
        return Err("system_library_location".into());
    }
    for ancestor in canonical.ancestors() {
        let metadata = fs::symlink_metadata(ancestor)?;
        if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 || metadata.file_type().is_symlink()
        {
            return Err("system_library_ownership".into());
        }
    }
    let file = open_source(&canonical)?;
    let metadata = file.metadata()?;
    if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
        return Err("system_library_ownership".into());
    }
    // Reject root-looking metadata from an untrusted FUSE installation.
    let mut stats = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: valid file FD and storage for statfs initialized on success.
    if unsafe { libc::fstatfs(file.as_raw_fd(), stats.as_mut_ptr()) } != 0 {
        return Err("system_library_mount".into());
    }
    // SAFETY: fstatfs succeeded and initialized stats.
    if unsafe { stats.assume_init() }.f_type as u64 == 0x65735546 {
        return Err("system_library_fuse".into());
    }
    Ok(file)
}
/// OS loader/libs are an explicit privileged TCB, not authenticated by sidecar model manifests.
fn validate_loader_names(keys: impl Iterator<Item = std::ffi::OsString>) -> Result<()> {
    if keys
        .into_iter()
        .any(|key| key.as_bytes().starts_with(b"LD_") || key == "ORT_DYLIB_PATH")
    {
        return Err("system_loader_environment".into());
    }
    Ok(())
}
pub(crate) fn validate_loader_environment() -> Result<()> {
    validate_loader_names(std::env::vars_os().map(|(key, _)| key))?;
    let map = fs::read_to_string("/proc/self/uid_map")?;
    let ids: Vec<_> = map.split_whitespace().collect();
    if ids != ["0", "0", "4294967295"] {
        return Err("system_loader_user_namespace".into());
    }
    Ok(())
}
#[cfg(test)]
mod loader_tests {
    #[test]
    fn denies_native_library_override_channels() {
        for key in [
            "LD_LIBRARY_PATH",
            "LD_PRELOAD",
            "LD_AUDIT",
            "ORT_DYLIB_PATH",
        ] {
            assert!(super::validate_loader_names([key.into()].into_iter()).is_err());
        }
        assert!(super::validate_loader_names(
            ["LANG".into(), "TOKENIZERS_PARALLELISM".into()].into_iter()
        )
        .is_ok());
    }
}
pub struct SystemLibraries {
    _libraries: Vec<libloading::os::unix::Library>,
    _files: Vec<File>,
}
pub fn system_libraries() -> Result<SystemLibraries> {
    validate_loader_environment()?;
    let _cache = root_controlled(Path::new("/etc/ld.so.cache"))?;
    let _loader = root_controlled(Path::new("/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"))?;
    let mut libraries = Vec::new();
    let mut files = Vec::new();
    // All DT_NEEDED entries of the exact pinned ORT1.22 library; no arbitrary provider DLLs.
    for name in [
        "libc.so.6",
        "libm.so.6",
        "libgcc_s.so.1",
        "libstdc++.so.6",
        "libpthread.so.0",
        "librt.so.1",
        "libdl.so.2",
    ] {
        let file = root_controlled(&Path::new("/usr/lib/x86_64-linux-gnu").join(name))?;
        let descriptor = PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()));
        // SAFETY: application-selected OS library, privileged ownership/ancestors checked; immutable to the unprivileged artifact writer. OS/root is the TCB.
        let library = unsafe {
            libloading::os::unix::Library::open(
                Some(descriptor),
                libloading::os::unix::RTLD_NOW | libloading::os::unix::RTLD_GLOBAL,
            )
        }?;
        libraries.push(library);
        files.push(file); // Keep descriptor names unique; dlopen caches original path strings.
    }
    Ok(SystemLibraries {
        _libraries: libraries,
        _files: files,
    })
}
