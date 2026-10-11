use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::ExitStatusExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use modus_plugin_execution_protocol::HostProvenance;
use modus_plugin_execution_protocol::resource_policy::ResourcePolicy;

const REQUIRED_CONTROLLERS: [&str; 3] = ["cpu", "memory", "pids"];
const CPU_PERIOD_MICROS: u64 = 100_000;
const BASIS_POINTS_PER_CORE: u64 = 10_000;
const WORKER_BOOTSTRAP_CHALLENGE_ENV: &str = "MODUS_WORKER_BOOTSTRAP_CHALLENGE";
const PRE_EXEC_FAILURE_EXIT_CODE: i32 = 126;
const EXEC_FAILURE_EXIT_CODE: i32 = 127;
const PR_SET_NO_NEW_PRIVS: libc::c_int = 38;
const PR_GET_NO_NEW_PRIVS: libc::c_int = 39;
const PR_CAP_AMBIENT: libc::c_int = 47;
const PR_CAP_AMBIENT_CLEAR_ALL: libc::c_ulong = 4;
const LINUX_CAPABILITY_VERSION_3: u32 = 0x2008_0522;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct WorkerCgroupIdentity {
    plugin_id: String,
    session_id: String,
    workspace_id: String,
    run_id: String,
    generation: u64,
}

impl WorkerCgroupIdentity {
    pub(super) fn new(
        plugin_id: impl Into<String>,
        session_id: impl Into<String>,
        workspace_id: impl Into<String>,
        run_id: impl Into<String>,
        generation: u64,
    ) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            session_id: session_id.into(),
            workspace_id: workspace_id.into(),
            run_id: run_id.into(),
            generation,
        }
    }

    pub(super) fn from_provenance(provenance: &HostProvenance) -> Self {
        Self::new(
            provenance.plugin_id(),
            provenance.session_id(),
            provenance.workspace_id(),
            provenance.run_id(),
            provenance.generation(),
        )
    }

    fn generation(&self) -> u64 {
        self.generation
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CgroupV2Error {
    UnifiedHierarchyUnavailable,
    DelegationUnavailable,
    ControllerUnavailable,
    InvalidPolicy,
    LimitApplyFailed,
    ProcessPlacementVerificationFailed,
    IdentityMismatch,
    CleanupFailed,
}

pub(super) trait CgroupV2Fs: Send + Sync {
    fn read_text(&self, path: &Path) -> io::Result<String>;
    fn write_text(&self, path: &Path, contents: &str) -> io::Result<()>;
    fn create_dir(&self, path: &Path) -> io::Result<()>;
    fn remove_dir(&self, path: &Path) -> io::Result<()>;
    fn child_directories(&self, path: &Path) -> io::Result<Vec<PathBuf>>;
    fn open_directory(&self, path: &Path) -> io::Result<OwnedFd>;
}

struct SystemCgroupV2Fs;

impl CgroupV2Fs for SystemCgroupV2Fs {
    fn read_text(&self, path: &Path) -> io::Result<String> {
        fs::read_to_string(path)
    }

    fn write_text(&self, path: &Path, contents: &str) -> io::Result<()> {
        let mut file = OpenOptions::new().write(true).open(path)?;
        file.write_all(contents.as_bytes())
    }

    fn create_dir(&self, path: &Path) -> io::Result<()> {
        fs::create_dir(path)
    }

    fn remove_dir(&self, path: &Path) -> io::Result<()> {
        fs::remove_dir(path)
    }

    fn child_directories(&self, path: &Path) -> io::Result<Vec<PathBuf>> {
        fs::read_dir(path)?
            .filter_map(|entry| match entry {
                Ok(entry) => match entry.file_type() {
                    Ok(file_type) if file_type.is_dir() => Some(Ok(entry.path())),
                    Ok(_) => None,
                    Err(error) => Some(Err(error)),
                },
                Err(error) => Some(Err(error)),
            })
            .collect()
    }

    fn open_directory(&self, path: &Path) -> io::Result<OwnedFd> {
        use std::os::unix::fs::OpenOptionsExt;

        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
            .open(path)
            .map(Into::into)
    }
}

pub(super) struct LinuxCgroupV2 {
    delegated_root: PathBuf,
    fs: Arc<dyn CgroupV2Fs>,
    next_group_id: AtomicU64,
}

impl LinuxCgroupV2 {
    pub(super) fn discover() -> Result<Self, CgroupV2Error> {
        Ok(Self {
            delegated_root: discover_current_cgroup()?,
            fs: Arc::new(SystemCgroupV2Fs),
            next_group_id: AtomicU64::new(0),
        })
    }

    #[cfg(test)]
    fn with_delegated_root(delegated_root: PathBuf, fs: Arc<dyn CgroupV2Fs>) -> Self {
        Self {
            delegated_root,
            fs,
            next_group_id: AtomicU64::new(0),
        }
    }

    pub(super) fn prepare_worker(
        &self,
        identity: WorkerCgroupIdentity,
        policy: ResourcePolicy,
    ) -> Result<WorkerCgroupLease, CgroupV2Error> {
        let limits = CgroupLimits::from_policy(policy)?;
        self.require_delegated_controllers()?;
        let existing_groups = self
            .fs
            .child_directories(&self.delegated_root)
            .map_err(|_| CgroupV2Error::DelegationUnavailable)?;
        if existing_groups.iter().any(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("modus-worker-"))
        }) {
            self.cleanup_abandoned_worker_groups(&existing_groups)?;
        }

        let path = self.next_worker_path(identity.generation());
        self.fs
            .create_dir(&path)
            .map_err(|_| CgroupV2Error::DelegationUnavailable)?;

        let configured = self.configure_worker(&path, limits);
        if let Err(error) = configured {
            if remove_empty_group(self.fs.as_ref(), &path).is_err() {
                return Err(CgroupV2Error::CleanupFailed);
            }
            return Err(error);
        }

        let cgroup_fd = match self.fs.open_directory(&path) {
            Ok(fd) => fd,
            Err(_) => {
                return if remove_empty_group(self.fs.as_ref(), &path).is_ok() {
                    Err(CgroupV2Error::DelegationUnavailable)
                } else {
                    Err(CgroupV2Error::CleanupFailed)
                };
            }
        };
        Ok(WorkerCgroupLease {
            fs: Arc::clone(&self.fs),
            cgroup_fd,
            path,
            identity,
            process_id: None,
            removed: false,
        })
    }

    fn require_delegated_controllers(&self) -> Result<(), CgroupV2Error> {
        let available = self
            .fs
            .read_text(&self.delegated_root.join("cgroup.controllers"))
            .map_err(|_| CgroupV2Error::DelegationUnavailable)?;
        let enabled = self
            .fs
            .read_text(&self.delegated_root.join("cgroup.subtree_control"))
            .map_err(|_| CgroupV2Error::DelegationUnavailable)?;
        let available = tokens(&available);
        let enabled = tokens(&enabled);
        if REQUIRED_CONTROLLERS
            .iter()
            .all(|controller| available.contains(controller) && enabled.contains(controller))
        {
            Ok(())
        } else {
            Err(CgroupV2Error::ControllerUnavailable)
        }
    }

    fn cleanup_abandoned_worker_groups(
        &self,
        existing_groups: &[PathBuf],
    ) -> Result<(), CgroupV2Error> {
        for path in existing_groups.iter().filter(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("modus-worker-"))
        }) {
            let owner_pid = worker_owner_pid(path).ok_or(CgroupV2Error::CleanupFailed)?;
            if process_is_alive(owner_pid)? {
                return Err(CgroupV2Error::CleanupFailed);
            }
            remove_empty_group(self.fs.as_ref(), path)?;
        }
        Ok(())
    }

    fn configure_worker(&self, path: &Path, limits: CgroupLimits) -> Result<(), CgroupV2Error> {
        let controllers = self
            .fs
            .read_text(&path.join("cgroup.controllers"))
            .map_err(|_| CgroupV2Error::ControllerUnavailable)?;
        let controllers = tokens(&controllers);
        if !REQUIRED_CONTROLLERS
            .iter()
            .all(|controller| controllers.contains(controller))
        {
            return Err(CgroupV2Error::ControllerUnavailable);
        }

        for (name, expected) in [
            ("memory.max", limits.memory_bytes.to_string()),
            (
                "cpu.max",
                format!("{} {CPU_PERIOD_MICROS}", limits.cpu_quota_micros),
            ),
            ("pids.max", limits.max_tasks.to_string()),
        ] {
            let control = path.join(name);
            self.fs
                .write_text(&control, &expected)
                .map_err(|_| CgroupV2Error::LimitApplyFailed)?;
            let actual = self
                .fs
                .read_text(&control)
                .map_err(|_| CgroupV2Error::LimitApplyFailed)?;
            if actual.trim() != expected {
                return Err(CgroupV2Error::LimitApplyFailed);
            }
        }
        Ok(())
    }

    fn next_worker_path(&self, generation: u64) -> PathBuf {
        let sequence = self.next_group_id.fetch_add(1, Ordering::Relaxed);
        self.delegated_root.join(format!(
            "modus-worker-{}-{generation}-{sequence}",
            std::process::id()
        ))
    }

    #[cfg(test)]
    fn worker_path_for_test(&self, generation: u64) -> PathBuf {
        self.delegated_root.join(format!(
            "modus-worker-{}-{generation}-0",
            std::process::id()
        ))
    }
}

pub(super) struct WorkerCgroupLease {
    fs: Arc<dyn CgroupV2Fs>,
    cgroup_fd: OwnedFd,
    path: PathBuf,
    identity: WorkerCgroupIdentity,
    process_id: Option<u32>,
    removed: bool,
}

impl WorkerCgroupLease {
    #[cfg(test)]
    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn process_id(&self) -> Option<u32> {
        self.process_id
    }

    pub(super) fn verify_atomic_placement(
        &mut self,
        identity: &WorkerCgroupIdentity,
        process_id: u32,
    ) -> Result<(), CgroupV2Error> {
        if identity != &self.identity
            || process_id == 0
            || self.process_id.is_some()
            || self.removed
        {
            return Err(CgroupV2Error::IdentityMismatch);
        }
        self.process_id = Some(process_id);
        let process_file = self.path.join("cgroup.procs");
        let processes = self
            .fs
            .read_text(&process_file)
            .map_err(|_| CgroupV2Error::ProcessPlacementVerificationFailed)?;
        let populated = self
            .fs
            .read_text(&self.path.join("cgroup.events"))
            .map_err(|_| CgroupV2Error::ProcessPlacementVerificationFailed)?;
        let task_count = self
            .fs
            .read_text(&self.path.join("pids.current"))
            .map_err(|_| CgroupV2Error::ProcessPlacementVerificationFailed)?;
        if parse_pids(&processes) != [process_id]
            || parse_populated(&populated) != Some(true)
            || task_count.trim() != "1"
        {
            return Err(CgroupV2Error::ProcessPlacementVerificationFailed);
        }
        Ok(())
    }

    fn cgroup_fd(&self) -> RawFd {
        self.cgroup_fd.as_raw_fd()
    }

    pub(super) fn cleanup(&mut self) -> Result<(), CgroupV2Error> {
        if self.removed {
            return Ok(());
        }
        remove_empty_group(self.fs.as_ref(), &self.path)?;
        self.removed = true;
        Ok(())
    }
}

pub(super) trait WorkerTerminator {
    fn process_id(&self) -> u32;
    fn terminate_and_reap(&mut self, deadline: Instant) -> Result<(), ()>;
}

impl WorkerTerminator for LinuxWorkerProcess {
    fn process_id(&self) -> u32 {
        self.id()
    }

    fn terminate_and_reap(&mut self, deadline: Instant) -> Result<(), ()> {
        terminate_child_and_reap(self, deadline).map_err(|_| ())
    }
}

pub(super) struct LinuxWorkerProcess {
    pid: libc::pid_t,
    stdin: Option<File>,
    stdout: Option<File>,
    reaped: bool,
}

impl LinuxWorkerProcess {
    pub(super) fn id(&self) -> u32 {
        self.pid as u32
    }

    pub(super) fn stdin(&mut self) -> Option<File> {
        self.stdin.take()
    }

    pub(super) fn stdout(&mut self) -> Option<File> {
        self.stdout.take()
    }

    pub(super) fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        if self.reaped {
            return Ok(None);
        }
        loop {
            let mut status = 0;
            // SAFETY: `pid` is the direct child returned by clone3 and `status`
            // points to writable storage for waitpid's result.
            let result = unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG) };
            if result == 0 {
                return Ok(None);
            }
            if result == self.pid {
                self.reaped = true;
                return Ok(Some(std::process::ExitStatus::from_raw(status)));
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    pub(super) fn kill(&mut self) -> io::Result<()> {
        if self.reaped {
            return Ok(());
        }
        // SAFETY: `pid` is owned by this handle and SIGKILL has no pointer arguments.
        if unsafe { libc::kill(self.pid, libc::SIGKILL) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(error)
        }
    }
}

pub(super) trait Clone3Invoker {
    fn clone3(&mut self, args: &libc::clone_args) -> io::Result<libc::pid_t>;
}

struct SystemClone3Invoker;

impl Clone3Invoker for SystemClone3Invoker {
    fn clone3(&mut self, args: &libc::clone_args) -> io::Result<libc::pid_t> {
        // SAFETY: args follows the kernel clone_args ABI and remains alive for
        // the duration of the syscall. The child immediately execs using only
        // prebuilt argv/envp and async-signal-safe syscalls.
        let result = unsafe {
            libc::syscall(
                libc::SYS_clone3,
                args as *const libc::clone_args,
                std::mem::size_of::<libc::clone_args>(),
            )
        };
        if result < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(result as libc::pid_t)
        }
    }
}

fn build_clone_args(cgroup_fd: RawFd) -> libc::clone_args {
    libc::clone_args {
        flags: libc::CLONE_INTO_CGROUP as u64,
        pidfd: 0,
        child_tid: 0,
        parent_tid: 0,
        exit_signal: libc::SIGCHLD as u64,
        stack: 0,
        stack_size: 0,
        tls: 0,
        set_tid: 0,
        set_tid_size: 0,
        cgroup: cgroup_fd as u64,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct HostWorkerIdentity {
    uid: libc::uid_t,
    gid: libc::gid_t,
}

impl HostWorkerIdentity {
    fn from_ids(
        uids: [libc::uid_t; 3],
        gids: [libc::gid_t; 3],
    ) -> Result<Self, io::Error> {
        if uids[0] == 0
            || gids[0] == 0
            || uids.iter().any(|uid| *uid != uids[0])
            || gids.iter().any(|gid| *gid != gids[0])
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Linux worker requires one non-root host UID and GID",
            ));
        }
        Ok(Self {
            uid: uids[0],
            gid: gids[0],
        })
    }
}

fn current_host_worker_identity() -> Result<HostWorkerIdentity, io::Error> {
    let mut uids: [libc::uid_t; 3] = [0; 3];
    let mut gids: [libc::gid_t; 3] = [0; 3];
    // SAFETY: all output pointers refer to initialized writable stack storage.
    if unsafe {
        libc::syscall(
            libc::SYS_getresuid,
            &mut uids[0],
            &mut uids[1],
            &mut uids[2],
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: all output pointers refer to initialized writable stack storage.
    if unsafe {
        libc::syscall(
            libc::SYS_getresgid,
            &mut gids[0],
            &mut gids[1],
            &mut gids[2],
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    HostWorkerIdentity::from_ids(uids, gids)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PreExecSecurityFailure {
    DescriptorRestriction,
    NoNewPrivileges,
    IdentityRestriction,
    CapabilityDrop,
}

trait PreExecSecurityOperations {
    fn close_all_non_stdio_descriptors(&mut self) -> bool;
    fn set_no_new_privileges(&mut self) -> bool;
    fn no_new_privileges_is_set(&mut self) -> bool;
    fn set_gid(&mut self, gid: libc::gid_t) -> bool;
    fn gid_is_exact(&mut self, gid: libc::gid_t) -> bool;
    fn set_uid(&mut self, uid: libc::uid_t) -> bool;
    fn uid_is_exact(&mut self, uid: libc::uid_t) -> bool;
    fn clear_ambient_capabilities(&mut self) -> bool;
    fn drop_all_capabilities(&mut self) -> bool;
    fn capabilities_are_empty(&mut self) -> bool;
}

fn apply_pre_exec_security(
    operations: &mut impl PreExecSecurityOperations,
    identity: HostWorkerIdentity,
) -> Result<(), PreExecSecurityFailure> {
    if identity.uid == 0 || identity.gid == 0 {
        return Err(PreExecSecurityFailure::IdentityRestriction);
    }
    if !operations.close_all_non_stdio_descriptors() {
        return Err(PreExecSecurityFailure::DescriptorRestriction);
    }
    if !operations.set_no_new_privileges() || !operations.no_new_privileges_is_set() {
        return Err(PreExecSecurityFailure::NoNewPrivileges);
    }
    if !operations.set_gid(identity.gid) || !operations.gid_is_exact(identity.gid) {
        return Err(PreExecSecurityFailure::IdentityRestriction);
    }
    if !operations.set_uid(identity.uid) || !operations.uid_is_exact(identity.uid) {
        return Err(PreExecSecurityFailure::IdentityRestriction);
    }
    if !operations.clear_ambient_capabilities()
        || !operations.drop_all_capabilities()
        || !operations.capabilities_are_empty()
    {
        return Err(PreExecSecurityFailure::CapabilityDrop);
    }
    if !operations.no_new_privileges_is_set() {
        return Err(PreExecSecurityFailure::NoNewPrivileges);
    }
    Ok(())
}

struct SystemPreExecSecurityOperations;

#[repr(C)]
#[derive(Clone, Copy)]
struct CapabilityHeader {
    version: u32,
    pid: i32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CapabilityData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

impl PreExecSecurityOperations for SystemPreExecSecurityOperations {
    fn close_all_non_stdio_descriptors(&mut self) -> bool {
        // Linux close_range was added in 5.9. Failure is terminal; there is no
        // descriptor enumeration fallback that could race with host threads.
        // SAFETY: this closes the child's private descriptor table from fd 3 onward.
        unsafe { libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, 0u32) == 0 }
    }

    fn set_no_new_privileges(&mut self) -> bool {
        // SAFETY: prctl receives scalar arguments and operates on this child thread.
        unsafe {
            libc::syscall(
                libc::SYS_prctl,
                PR_SET_NO_NEW_PRIVS,
                1 as libc::c_ulong,
                0 as libc::c_ulong,
                0 as libc::c_ulong,
                0 as libc::c_ulong,
            ) == 0
        }
    }

    fn no_new_privileges_is_set(&mut self) -> bool {
        // SAFETY: PR_GET_NO_NEW_PRIVS has no pointer arguments.
        unsafe {
            libc::syscall(
                libc::SYS_prctl,
                PR_GET_NO_NEW_PRIVS,
                0 as libc::c_ulong,
                0 as libc::c_ulong,
                0 as libc::c_ulong,
                0 as libc::c_ulong,
            ) == 1
        }
    }

    fn set_gid(&mut self, gid: libc::gid_t) -> bool {
        // SAFETY: setresgid uses scalar IDs; raw syscall avoids post-fork libc coordination.
        unsafe {
            libc::syscall(
                libc::SYS_setresgid,
                gid as libc::c_ulong,
                gid as libc::c_ulong,
                gid as libc::c_ulong,
            ) == 0
        }
    }

    fn gid_is_exact(&mut self, expected: libc::gid_t) -> bool {
        let mut gids: [libc::gid_t; 3] = [0; 3];
        // SAFETY: all output pointers refer to initialized writable stack storage.
        unsafe {
            libc::syscall(
                libc::SYS_getresgid,
                &mut gids[0],
                &mut gids[1],
                &mut gids[2],
            ) == 0
                && gids == [expected; 3]
        }
    }

    fn set_uid(&mut self, uid: libc::uid_t) -> bool {
        // SAFETY: setresuid uses scalar IDs; raw syscall avoids post-fork libc coordination.
        unsafe {
            libc::syscall(
                libc::SYS_setresuid,
                uid as libc::c_ulong,
                uid as libc::c_ulong,
                uid as libc::c_ulong,
            ) == 0
        }
    }

    fn uid_is_exact(&mut self, expected: libc::uid_t) -> bool {
        let mut uids: [libc::uid_t; 3] = [0; 3];
        // SAFETY: all output pointers refer to initialized writable stack storage.
        unsafe {
            libc::syscall(
                libc::SYS_getresuid,
                &mut uids[0],
                &mut uids[1],
                &mut uids[2],
            ) == 0
                && uids == [expected; 3]
        }
    }

    fn clear_ambient_capabilities(&mut self) -> bool {
        // SAFETY: PR_CAP_AMBIENT_CLEAR_ALL is a scalar prctl operation on this child.
        unsafe {
            libc::syscall(
                libc::SYS_prctl,
                PR_CAP_AMBIENT,
                PR_CAP_AMBIENT_CLEAR_ALL,
                0 as libc::c_ulong,
                0 as libc::c_ulong,
                0 as libc::c_ulong,
            ) == 0
        }
    }

    fn drop_all_capabilities(&mut self) -> bool {
        let header = CapabilityHeader {
            version: LINUX_CAPABILITY_VERSION_3,
            pid: 0,
        };
        let empty = [CapabilityData::default(); 2];
        // SAFETY: both structures match the Linux capability v3 syscall ABI.
        unsafe { libc::syscall(libc::SYS_capset, &header, empty.as_ptr()) == 0 }
    }

    fn capabilities_are_empty(&mut self) -> bool {
        let header = CapabilityHeader {
            version: LINUX_CAPABILITY_VERSION_3,
            pid: 0,
        };
        let mut capabilities = [CapabilityData::default(); 2];
        // SAFETY: header and output array match the Linux capability v3 syscall ABI.
        unsafe {
            libc::syscall(libc::SYS_capget, &header, capabilities.as_mut_ptr()) == 0
                && capabilities.iter().all(|capability| {
                    capability.effective == 0
                        && capability.permitted == 0
                        && capability.inheritable == 0
                })
        }
    }
}

pub(super) fn launch_worker_in_cgroup(
    group: &WorkerCgroupLease,
    executable: &Path,
    challenge: &str,
) -> io::Result<LinuxWorkerProcess> {
    let identity = current_host_worker_identity()?;
    launch_worker_in_cgroup_with(
        group,
        executable,
        challenge,
        identity,
        &mut SystemClone3Invoker,
    )
}

fn launch_worker_in_cgroup_with(
    group: &WorkerCgroupLease,
    executable: &Path,
    challenge: &str,
    identity: HostWorkerIdentity,
    invoker: &mut impl Clone3Invoker,
) -> io::Result<LinuxWorkerProcess> {
    let executable = std::ffi::CString::new(executable.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid worker path"))?;
    let challenge = std::ffi::CString::new(format!("{WORKER_BOOTSTRAP_CHALLENGE_ENV}={challenge}"))
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid worker challenge"))?;
    let argv = [executable.as_ptr(), std::ptr::null()];
    let envp = [challenge.as_ptr(), std::ptr::null()];
    let stdin_pipe = create_pipe()?;
    let stdout_pipe = create_pipe()?;
    let null_stderr = open_null_stderr()?;
    let stdin_read = stdin_pipe[0].as_raw_fd();
    let stdin_write = stdin_pipe[1].as_raw_fd();
    let stdout_read = stdout_pipe[0].as_raw_fd();
    let stdout_write = stdout_pipe[1].as_raw_fd();
    let stderr_fd = null_stderr.as_raw_fd();
    let cgroup_fd = group.cgroup_fd();
    let descriptors = [
        stdin_read,
        stdin_write,
        stdout_read,
        stdout_write,
        stderr_fd,
        cgroup_fd,
    ];
    if descriptors.iter().any(|fd| *fd <= libc::STDERR_FILENO) {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "standard descriptors must be open before worker launch",
        ));
    }
    let clone_args = build_clone_args(cgroup_fd);
    let pid = invoker.clone3(&clone_args)?;
    if pid == 0 {
        // This branch runs in the child after clone3. Avoid allocation, locks,
        // and destructors; the pre-exec path uses only descriptor operations
        // and direct syscalls before execve.
        unsafe {
            exec_worker_child(
                stdin_read,
                stdout_write,
                stderr_fd,
                identity,
                executable.as_ptr(),
                argv.as_ptr(),
                envp.as_ptr(),
            )
        }
    }
    let [stdin_read, stdin_write] = stdin_pipe;
    let [stdout_read, stdout_write] = stdout_pipe;
    drop(stdin_read);
    drop(stdout_write);
    drop(null_stderr);
    Ok(LinuxWorkerProcess {
        pid,
        stdin: Some(File::from(stdin_write)),
        stdout: Some(File::from(stdout_read)),
        reaped: false,
    })
}

fn create_pipe() -> io::Result<[OwnedFd; 2]> {
    let mut descriptors = [-1; 2];
    // SAFETY: descriptors points to two writable integers and pipe2 initializes them.
    if unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: both descriptors were returned by pipe2 and are uniquely owned here.
    Ok(unsafe {
        [
            OwnedFd::from_raw_fd(descriptors[0]),
            OwnedFd::from_raw_fd(descriptors[1]),
        ]
    })
}

fn open_null_stderr() -> io::Result<OwnedFd> {
    let path = c"/dev/null";
    // SAFETY: the path is a static, NUL-terminated C string.
    let fd = unsafe { libc::open(path.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: open returned a new descriptor owned by the caller.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

unsafe fn exec_worker_child(
    stdin_read: RawFd,
    stdout_write: RawFd,
    stderr_fd: RawFd,
    identity: HostWorkerIdentity,
    executable: *const libc::c_char,
    argv: *const *const libc::c_char,
    envp: *const *const libc::c_char,
) -> ! {
    // SAFETY: these descriptors are open and their source values are above 2.
    if unsafe { libc::dup2(stdin_read, libc::STDIN_FILENO) } < 0 {
        unsafe { libc::_exit(PRE_EXEC_FAILURE_EXIT_CODE) };
    }
    // SAFETY: these descriptors are open and their source values are above 2.
    if unsafe { libc::dup2(stdout_write, libc::STDOUT_FILENO) } < 0 {
        unsafe { libc::_exit(PRE_EXEC_FAILURE_EXIT_CODE) };
    }
    // SAFETY: these descriptors are open and their source values are above 2.
    if unsafe { libc::dup2(stderr_fd, libc::STDERR_FILENO) } < 0 {
        unsafe { libc::_exit(PRE_EXEC_FAILURE_EXIT_CODE) };
    }
    let mut security = SystemPreExecSecurityOperations;
    if apply_pre_exec_security(&mut security, identity).is_err() {
        // SAFETY: child setup failed; no Rust destructors may run after clone3.
        unsafe { libc::_exit(PRE_EXEC_FAILURE_EXIT_CODE) };
    }
    // SAFETY: argv/envp and C strings were fully built before clone3.
    unsafe { libc::execve(executable, argv, envp) };
    // SAFETY: execve only returns on failure; _exit avoids running inherited Rust state.
    unsafe { libc::_exit(EXEC_FAILURE_EXIT_CODE) }
}

pub(super) fn terminate_worker_and_cleanup<T: WorkerTerminator>(
    process: &mut T,
    group: &mut WorkerCgroupLease,
    deadline: Instant,
) -> Result<(), CgroupV2Error> {
    if group
        .process_id()
        .is_some_and(|process_id| process_id != process.process_id())
    {
        return Err(CgroupV2Error::IdentityMismatch);
    }
    process
        .terminate_and_reap(deadline)
        .map_err(|_| CgroupV2Error::CleanupFailed)?;
    group.cleanup()
}

fn terminate_child_and_reap(
    child: &mut LinuxWorkerProcess,
    deadline: Instant,
) -> Result<(), CgroupV2Error> {
    match child.try_wait() {
        Ok(Some(_)) => Ok(()),
        Ok(None) => {
            child.kill().map_err(|_| CgroupV2Error::CleanupFailed)?;
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => return Ok(()),
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Ok(None) | Err(_) => return Err(CgroupV2Error::CleanupFailed),
                }
            }
        }
        Err(_) => Err(CgroupV2Error::CleanupFailed),
    }
}

#[derive(Clone, Copy)]
struct CgroupLimits {
    memory_bytes: u64,
    cpu_quota_micros: u64,
    max_tasks: u64,
}

impl CgroupLimits {
    fn from_policy(policy: ResourcePolicy) -> Result<Self, CgroupV2Error> {
        if policy.max_helper_rss_bytes == 0
            || policy.max_total_helper_rss_bytes == 0
            || policy.max_helpers_per_application == 0
            || policy.max_helpers_per_plugin == 0
        {
            return Err(CgroupV2Error::InvalidPolicy);
        }
        let memory_bytes = policy
            .max_helper_rss_bytes
            .min(policy.max_total_helper_rss_bytes);
        let cpu_quota_micros = CPU_PERIOD_MICROS
            .checked_mul(u64::from(policy.cpu_basis_points_of_one_core))
            .ok_or(CgroupV2Error::InvalidPolicy)?
            / BASIS_POINTS_PER_CORE;
        let max_tasks = u64::from(policy.max_guest_child_processes)
            .checked_add(1)
            .ok_or(CgroupV2Error::InvalidPolicy)?;
        if memory_bytes == 0 || cpu_quota_micros == 0 || max_tasks == 0 {
            return Err(CgroupV2Error::InvalidPolicy);
        }
        Ok(Self {
            memory_bytes,
            cpu_quota_micros,
            max_tasks,
        })
    }
}

fn remove_empty_group(fs: &dyn CgroupV2Fs, path: &Path) -> Result<(), CgroupV2Error> {
    let processes = fs
        .read_text(&path.join("cgroup.procs"))
        .map_err(|_| CgroupV2Error::CleanupFailed)?;
    let events = fs
        .read_text(&path.join("cgroup.events"))
        .map_err(|_| CgroupV2Error::CleanupFailed)?;
    let task_count = fs
        .read_text(&path.join("pids.current"))
        .map_err(|_| CgroupV2Error::CleanupFailed)?;
    if !parse_pids(&processes).is_empty()
        || parse_populated(&events) != Some(false)
        || task_count.trim() != "0"
    {
        return Err(CgroupV2Error::CleanupFailed);
    }
    fs.remove_dir(path)
        .map_err(|_| CgroupV2Error::CleanupFailed)
}

fn parse_pids(contents: &str) -> Vec<u32> {
    contents
        .split_whitespace()
        .filter_map(|value| value.parse().ok())
        .collect()
}

fn parse_populated(contents: &str) -> Option<bool> {
    contents.lines().find_map(|line| {
        let (key, value) = line.split_once(' ')?;
        if key != "populated" {
            return None;
        }
        match value {
            "0" => Some(false),
            "1" => Some(true),
            _ => None,
        }
    })
}

fn tokens(contents: &str) -> HashSet<&str> {
    contents.split_whitespace().collect()
}

fn worker_owner_pid(path: &Path) -> Option<u32> {
    path.file_name()?
        .to_str()?
        .strip_prefix("modus-worker-")?
        .split_once('-')?
        .0
        .parse()
        .ok()
}

fn process_is_alive(pid: u32) -> Result<bool, CgroupV2Error> {
    match fs::metadata(Path::new("/proc").join(pid.to_string())) {
        Ok(metadata) => Ok(metadata.is_dir()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(CgroupV2Error::DelegationUnavailable),
    }
}

fn discover_current_cgroup() -> Result<PathBuf, CgroupV2Error> {
    let cgroup_contents = fs::read_to_string("/proc/self/cgroup")
        .map_err(|_| CgroupV2Error::UnifiedHierarchyUnavailable)?;
    let cgroup_path = cgroup_contents
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .ok_or(CgroupV2Error::UnifiedHierarchyUnavailable)?;
    let cgroup_path = Path::new(cgroup_path);
    if !is_safe_absolute_path(cgroup_path) {
        return Err(CgroupV2Error::UnifiedHierarchyUnavailable);
    }

    let mountinfo = fs::read_to_string("/proc/self/mountinfo")
        .map_err(|_| CgroupV2Error::UnifiedHierarchyUnavailable)?;
    let (mount_point, candidate) = map_current_cgroup_to_mount(cgroup_path, &mountinfo)?;
    let mount =
        fs::canonicalize(mount_point).map_err(|_| CgroupV2Error::UnifiedHierarchyUnavailable)?;
    let delegated =
        fs::canonicalize(&candidate).map_err(|_| CgroupV2Error::DelegationUnavailable)?;
    if !delegated.starts_with(&mount) {
        return Err(CgroupV2Error::UnifiedHierarchyUnavailable);
    }
    Ok(delegated)
}

fn map_current_cgroup_to_mount(
    cgroup_path: &Path,
    mountinfo: &str,
) -> Result<(PathBuf, PathBuf), CgroupV2Error> {
    if !is_safe_absolute_path(cgroup_path) {
        return Err(CgroupV2Error::UnifiedHierarchyUnavailable);
    }
    let expected_mount = Path::new("/sys/fs/cgroup");
    for line in mountinfo.lines() {
        let Some((mount, filesystem)) = line.split_once(" - ") else {
            continue;
        };
        if filesystem.split_whitespace().next() != Some("cgroup2") {
            continue;
        }
        let fields = mount.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 5 {
            continue;
        }
        let Some(mount_root) = unescape_mount_path(fields[3]) else {
            continue;
        };
        let Some(mount_point) = unescape_mount_path(fields[4]) else {
            continue;
        };
        let mount_root = PathBuf::from(mount_root);
        let mount_point = PathBuf::from(mount_point);
        if mount_point != expected_mount
            || !is_safe_absolute_path(&mount_root)
            || !is_safe_absolute_path(&mount_point)
        {
            continue;
        }

        let relative = if cgroup_path == Path::new("/") {
            PathBuf::new()
        } else if mount_root == Path::new("/") {
            cgroup_path
                .strip_prefix("/")
                .map(Path::to_path_buf)
                .map_err(|_| CgroupV2Error::UnifiedHierarchyUnavailable)?
        } else {
            cgroup_path
                .strip_prefix(&mount_root)
                .map(Path::to_path_buf)
                .map_err(|_| CgroupV2Error::UnifiedHierarchyUnavailable)?
        };
        if !relative
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err(CgroupV2Error::UnifiedHierarchyUnavailable);
        }
        return Ok((mount_point.clone(), mount_point.join(relative)));
    }
    Err(CgroupV2Error::UnifiedHierarchyUnavailable)
}

fn is_safe_absolute_path(path: &Path) -> bool {
    path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::RootDir | Component::Normal(_)))
}

fn unescape_mount_path(value: &str) -> Option<String> {
    let mut result = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(character) = chars.next() {
        if character != '\\' {
            result.push(character);
            continue;
        }
        let escaped = chars.by_ref().take(3).collect::<String>();
        match escaped.as_str() {
            "040" => result.push(' '),
            "011" => result.push('\t'),
            "012" => result.push('\n'),
            "134" => result.push('\\'),
            _ => return None,
        }
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::{
        CgroupV2Error, CgroupV2Fs, Clone3Invoker, HostWorkerIdentity, LinuxCgroupV2,
        PreExecSecurityFailure, PreExecSecurityOperations, WorkerCgroupIdentity,
        apply_pre_exec_security, build_clone_args, launch_worker_in_cgroup_with,
        map_current_cgroup_to_mount, terminate_worker_and_cleanup,
    };
    use crate::REQUIRED_POLICY;
    use std::collections::{HashMap, HashSet};
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    const ROOT: &str = "/fixture/delegated";

    #[test]
    fn clone3_args_request_atomic_cgroup_placement_and_sigchld() {
        let args = build_clone_args(73);

        assert_eq!(std::mem::size_of::<libc::clone_args>(), 88);
        assert_eq!(args.flags, libc::CLONE_INTO_CGROUP as u64);
        assert_eq!(args.cgroup, 73);
        assert_eq!(args.exit_signal, libc::SIGCHLD as u64);
        assert_eq!(args.pidfd, 0);
        assert_eq!(args.stack, 0);
        assert_eq!(args.stack_size, 0);
        assert_eq!(args.child_tid, 0);
        assert_eq!(args.parent_tid, 0);
        assert_eq!(args.tls, 0);
        assert_eq!(args.set_tid, 0);
        assert_eq!(args.set_tid_size, 0);
    }

    #[test]
    fn child_applies_pre_exec_security_policy_before_execve() {
        let source = include_str!("linux_cgroup.rs");
        let child_start = source
            .find("unsafe fn exec_worker_child")
            .expect("child launch function must exist");
        let child = &source[child_start..];
        let policy_position = child
            .find("apply_pre_exec_security")
            .expect("child must apply the pre-exec security policy");
        let exec_position = child
            .find("libc::execve")
            .expect("child must execute only after policy setup");

        assert!(policy_position < exec_position);
    }

    #[test]
    fn child_requires_close_range_for_all_descriptors_above_stdio() {
        let source = include_str!("linux_cgroup.rs");
        let implementation = source
            .find("impl PreExecSecurityOperations for SystemPreExecSecurityOperations")
            .expect("system descriptor policy must exist");
        let start = source[implementation..]
            .find("fn close_all_non_stdio_descriptors")
            .map(|offset| implementation + offset)
            .expect("descriptor policy must exist");
        let end = source[start..]
            .find("fn set_no_new_privileges")
            .map(|offset| start + offset)
            .expect("descriptor policy must be bounded");
        let close_policy = &source[start..end];

        assert!(close_policy.contains("SYS_close_range"));
        assert!(close_policy.contains("3u32"));
        assert!(close_policy.contains("u32::MAX"));
        assert!(!close_policy.contains("fcntl"));
    }

    #[derive(Default)]
    struct FakePreExecSecurityOperations {
        calls: Vec<&'static str>,
        fail_at: Option<(&'static str, usize)>,
    }

    impl FakePreExecSecurityOperations {
        fn call(&mut self, name: &'static str) -> bool {
            self.calls.push(name);
            let occurrence = self.calls.iter().filter(|call| **call == name).count();
            self.fail_at != Some((name, occurrence))
        }
    }

    impl PreExecSecurityOperations for FakePreExecSecurityOperations {
        fn close_all_non_stdio_descriptors(&mut self) -> bool {
            self.call("close_fds")
        }

        fn set_no_new_privileges(&mut self) -> bool {
            self.call("set_no_new_privileges")
        }

        fn no_new_privileges_is_set(&mut self) -> bool {
            self.call("read_no_new_privileges")
        }

        fn set_gid(&mut self, _gid: libc::gid_t) -> bool {
            self.call("set_gid")
        }

        fn gid_is_exact(&mut self, _gid: libc::gid_t) -> bool {
            self.call("read_gid")
        }

        fn set_uid(&mut self, _uid: libc::uid_t) -> bool {
            self.call("set_uid")
        }

        fn uid_is_exact(&mut self, _uid: libc::uid_t) -> bool {
            self.call("read_uid")
        }

        fn clear_ambient_capabilities(&mut self) -> bool {
            self.call("clear_ambient_capabilities")
        }

        fn drop_all_capabilities(&mut self) -> bool {
            self.call("drop_capabilities")
        }

        fn capabilities_are_empty(&mut self) -> bool {
            self.call("read_capabilities")
        }
    }

    fn host_identity() -> HostWorkerIdentity {
        HostWorkerIdentity {
            uid: 1_000,
            gid: 1_000,
        }
    }

    #[test]
    fn pre_exec_security_applies_host_identity_and_confirms_no_privileges() {
        let mut operations = FakePreExecSecurityOperations::default();

        assert_eq!(
            apply_pre_exec_security(&mut operations, host_identity()),
            Ok(())
        );
        assert_eq!(
            operations.calls,
            [
                "close_fds",
                "set_no_new_privileges",
                "read_no_new_privileges",
                "set_gid",
                "read_gid",
                "set_uid",
                "read_uid",
                "clear_ambient_capabilities",
                "drop_capabilities",
                "read_capabilities",
                "read_no_new_privileges",
            ]
        );
    }

    #[test]
    fn pre_exec_security_fails_closed_for_each_required_control() {
        for (operation, occurrence, expected_failure) in [
            (
                "close_fds",
                1,
                PreExecSecurityFailure::DescriptorRestriction,
            ),
            (
                "set_no_new_privileges",
                1,
                PreExecSecurityFailure::NoNewPrivileges,
            ),
            (
                "read_no_new_privileges",
                1,
                PreExecSecurityFailure::NoNewPrivileges,
            ),
            (
                "read_no_new_privileges",
                2,
                PreExecSecurityFailure::NoNewPrivileges,
            ),
            ("set_gid", 1, PreExecSecurityFailure::IdentityRestriction),
            ("read_gid", 1, PreExecSecurityFailure::IdentityRestriction),
            ("set_uid", 1, PreExecSecurityFailure::IdentityRestriction),
            ("read_uid", 1, PreExecSecurityFailure::IdentityRestriction),
            (
                "clear_ambient_capabilities",
                1,
                PreExecSecurityFailure::CapabilityDrop,
            ),
            (
                "drop_capabilities",
                1,
                PreExecSecurityFailure::CapabilityDrop,
            ),
            (
                "read_capabilities",
                1,
                PreExecSecurityFailure::CapabilityDrop,
            ),
        ] {
            let mut operations = FakePreExecSecurityOperations {
                calls: Vec::new(),
                fail_at: Some((operation, occurrence)),
            };
            assert_eq!(
                apply_pre_exec_security(&mut operations, host_identity()),
                Err(expected_failure),
                "must fail closed when {operation} occurrence {occurrence} fails"
            );
            assert_eq!(operations.calls.last(), Some(&operation));
        }
    }

    #[test]
    fn pre_exec_identity_rejects_root_or_mixed_host_ids() {
        assert!(HostWorkerIdentity::from_ids([0, 0, 0], [1_000; 3]).is_err());
        assert!(HostWorkerIdentity::from_ids([1_000; 3], [0, 0, 0]).is_err());
        assert!(HostWorkerIdentity::from_ids([1_000, 1_001, 1_000], [1_000; 3]).is_err());
        assert!(HostWorkerIdentity::from_ids([1_000; 3], [1_000, 1_001, 1_000]).is_err());
    }

    #[test]
    fn pre_exec_security_rejects_root_before_applying_controls() {
        let mut operations = FakePreExecSecurityOperations::default();

        assert_eq!(
            apply_pre_exec_security(
                &mut operations,
                HostWorkerIdentity { uid: 0, gid: 1_000 },
            ),
            Err(PreExecSecurityFailure::IdentityRestriction)
        );
        assert!(operations.calls.is_empty());
    }

    struct FakeClone3 {
        calls: usize,
        result: Result<libc::pid_t, i32>,
        observed: Option<(u64, u64, u64)>,
        placement: Option<(Arc<FakeCgroupFs>, PathBuf)>,
    }

    impl Clone3Invoker for FakeClone3 {
        fn clone3(&mut self, args: &libc::clone_args) -> io::Result<libc::pid_t> {
            self.calls += 1;
            self.observed = Some((args.flags, args.cgroup, args.exit_signal));
            let pid = self.result.map_err(io::Error::from_raw_os_error)?;
            if pid > 0 {
                if let Some((fs, path)) = &self.placement {
                    fs.kernel_places_worker(path, pid as u32);
                }
            }
            Ok(pid)
        }
    }

    #[derive(Default)]
    struct FakeCgroupFs {
        files: Mutex<HashMap<PathBuf, String>>,
        directories: Mutex<HashSet<PathBuf>>,
        fail_writes: Mutex<HashSet<PathBuf>>,
        fail_removals: Mutex<HashSet<PathBuf>>,
        fail_create: Mutex<bool>,
        rewrite_after_write: Mutex<HashMap<PathBuf, String>>,
        cgroup_procs_write_attempts: AtomicUsize,
    }

    impl FakeCgroupFs {
        fn delegated() -> Arc<Self> {
            let fs = Arc::new(Self::default());
            let root = PathBuf::from(ROOT);
            fs.directories.lock().unwrap().insert(root.clone());
            fs.insert(&root.join("cgroup.controllers"), "cpu memory pids");
            fs.insert(&root.join("cgroup.subtree_control"), "cpu memory pids");
            fs
        }

        fn insert(&self, path: &Path, contents: &str) {
            self.files
                .lock()
                .unwrap()
                .insert(path.to_path_buf(), contents.to_owned());
        }

        fn contents(&self, path: &Path) -> String {
            self.files
                .lock()
                .unwrap()
                .get(path)
                .cloned()
                .unwrap_or_default()
        }

        fn deny_write(&self, path: &Path) {
            self.fail_writes.lock().unwrap().insert(path.to_path_buf());
        }

        fn deny_removal(&self, path: &Path) {
            self.fail_removals
                .lock()
                .unwrap()
                .insert(path.to_path_buf());
        }

        fn deny_create(&self) {
            *self.fail_create.lock().unwrap() = true;
        }

        fn rewrite_after_write(&self, path: &Path, readback: &str) {
            self.rewrite_after_write
                .lock()
                .unwrap()
                .insert(path.to_path_buf(), readback.to_owned());
        }

        fn set_worker_empty(&self, group: &Path) {
            self.insert(&group.join("cgroup.procs"), "");
            self.insert(&group.join("cgroup.events"), "populated 0\n");
            self.insert(&group.join("pids.current"), "0\n");
        }

        fn kernel_places_worker(&self, group: &Path, pid: u32) {
            self.insert(&group.join("cgroup.procs"), &format!("{pid}\n"));
            self.insert(&group.join("cgroup.events"), "populated 1\n");
            self.insert(&group.join("pids.current"), "1\n");
        }
    }

    impl CgroupV2Fs for FakeCgroupFs {
        fn read_text(&self, path: &Path) -> io::Result<String> {
            self.files
                .lock()
                .unwrap()
                .get(path)
                .cloned()
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "fixture file missing"))
        }

        fn write_text(&self, path: &Path, contents: &str) -> io::Result<()> {
            if path.file_name().is_some_and(|name| name == "cgroup.procs") {
                self.cgroup_procs_write_attempts
                    .fetch_add(1, Ordering::SeqCst);
            }
            if self.fail_writes.lock().unwrap().contains(path) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "fixture denied",
                ));
            }
            let readback = self
                .rewrite_after_write
                .lock()
                .unwrap()
                .get(path)
                .cloned()
                .unwrap_or_else(|| contents.to_owned());
            self.insert(path, &readback);
            Ok(())
        }

        fn create_dir(&self, path: &Path) -> io::Result<()> {
            if *self.fail_create.lock().unwrap() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "fixture denied",
                ));
            }
            if !self.directories.lock().unwrap().insert(path.to_path_buf()) {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "fixture exists",
                ));
            }
            let parent = path.parent().expect("fixture path has a parent");
            let controllers = self
                .read_text(&parent.join("cgroup.subtree_control"))
                .unwrap_or_default();
            self.insert(&path.join("cgroup.controllers"), &controllers);
            self.insert(&path.join("cgroup.subtree_control"), "");
            self.insert(&path.join("memory.max"), "max");
            self.insert(&path.join("cpu.max"), "max 100000");
            self.insert(&path.join("pids.max"), "max");
            self.insert(&path.join("pids.current"), "0\n");
            self.insert(&path.join("cgroup.procs"), "");
            self.insert(&path.join("cgroup.events"), "populated 0\n");
            Ok(())
        }

        fn remove_dir(&self, path: &Path) -> io::Result<()> {
            if self.fail_removals.lock().unwrap().contains(path) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "fixture denied",
                ));
            }
            self.directories.lock().unwrap().remove(path);
            self.files
                .lock()
                .unwrap()
                .retain(|file, _| !file.starts_with(path));
            Ok(())
        }

        fn child_directories(&self, path: &Path) -> io::Result<Vec<PathBuf>> {
            Ok(self
                .directories
                .lock()
                .unwrap()
                .iter()
                .filter(|child| child.parent() == Some(path))
                .cloned()
                .collect())
        }

        fn open_directory(&self, _path: &Path) -> io::Result<std::os::fd::OwnedFd> {
            use std::os::fd::{FromRawFd, IntoRawFd};

            let file = std::fs::File::open("/dev/null")?;
            // SAFETY: file owns the descriptor and is converted exactly once.
            Ok(unsafe { std::os::fd::OwnedFd::from_raw_fd(file.into_raw_fd()) })
        }
    }

    fn identity(generation: u64) -> WorkerCgroupIdentity {
        WorkerCgroupIdentity::new(
            "fixture/plugin",
            "fixture-session",
            "fixture-workspace",
            "fixture-run",
            generation,
        )
    }

    #[test]
    fn maps_only_the_current_unified_hierarchy_mount_without_path_escape() {
        let mountinfo =
            "29 23 0:26 /delegated/user.slice /sys/fs/cgroup rw,nosuid,nodev - cgroup2 cgroup rw";
        assert_eq!(
            map_current_cgroup_to_mount(Path::new("/"), mountinfo),
            Ok((
                PathBuf::from("/sys/fs/cgroup"),
                PathBuf::from("/sys/fs/cgroup"),
            )),
        );

        let host_path_mount = "29 23 0:26 / /sys/fs/cgroup rw,nosuid,nodev - cgroup2 cgroup rw";
        assert_eq!(
            map_current_cgroup_to_mount(Path::new("/user.slice/modus.service"), host_path_mount),
            Ok((
                PathBuf::from("/sys/fs/cgroup"),
                PathBuf::from("/sys/fs/cgroup/user.slice/modus.service"),
            )),
        );
        assert_eq!(
            map_current_cgroup_to_mount(Path::new("/other.slice/modus.service"), mountinfo,),
            Err(CgroupV2Error::UnifiedHierarchyUnavailable),
        );
        assert_eq!(
            map_current_cgroup_to_mount(Path::new("/../../tmp"), host_path_mount),
            Err(CgroupV2Error::UnifiedHierarchyUnavailable),
        );
        assert_eq!(
            map_current_cgroup_to_mount(Path::new("/"), "no cgroup2 mount"),
            Err(CgroupV2Error::UnifiedHierarchyUnavailable),
        );
    }

    fn adapter(fs: &Arc<FakeCgroupFs>) -> LinuxCgroupV2 {
        LinuxCgroupV2::with_delegated_root(PathBuf::from(ROOT), fs.clone())
    }

    #[test]
    fn mocked_clone3_receives_prepared_cgroup_and_no_unsafe_fallback_occurs() {
        let fs = FakeCgroupFs::delegated();
        let group = adapter(&fs)
            .prepare_worker(identity(14), REQUIRED_POLICY)
            .unwrap();
        let mut invoker = FakeClone3 {
            calls: 0,
            result: Err(libc::ENOSYS),
            observed: None,
            placement: None,
        };

        let result = launch_worker_in_cgroup_with(
            &group,
            Path::new("/bundled/modus-plugin-worker"),
            "synthetic-challenge",
            host_identity(),
            &mut invoker,
        );

        assert_eq!(result.err().unwrap().raw_os_error(), Some(libc::ENOSYS));
        assert_eq!(invoker.calls, 1);
        assert_eq!(
            invoker.observed,
            Some((
                libc::CLONE_INTO_CGROUP as u64,
                group.cgroup_fd() as u64,
                libc::SIGCHLD as u64
            ))
        );
        assert!(fs.contents(&group.path().join("cgroup.procs")).is_empty());
        assert_eq!(fs.cgroup_procs_write_attempts.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn mocked_atomic_creation_is_verified_as_already_in_the_prepared_cgroup() {
        let fs = FakeCgroupFs::delegated();
        let identity = identity(15);
        let mut group = adapter(&fs)
            .prepare_worker(identity.clone(), REQUIRED_POLICY)
            .unwrap();
        let mut invoker = FakeClone3 {
            calls: 0,
            result: Ok(5151),
            observed: None,
            placement: Some((fs.clone(), group.path().to_path_buf())),
        };

        let mut process = launch_worker_in_cgroup_with(
            &group,
            Path::new("/bundled/modus-plugin-worker"),
            "synthetic-challenge",
            host_identity(),
            &mut invoker,
        )
        .unwrap();
        group
            .verify_atomic_placement(&identity, process.id())
            .unwrap();

        assert_eq!(process.id(), 5151);
        assert_eq!(invoker.calls, 1);
        assert_eq!(fs.contents(&group.path().join("cgroup.procs")), "5151\n");
        assert_eq!(fs.cgroup_procs_write_attempts.load(Ordering::SeqCst), 0);
        drop(process.stdin());
        drop(process.stdout());
        drop(process);
        fs.set_worker_empty(group.path());
        group.cleanup().unwrap();
    }

    #[test]
    fn prepares_controls_before_verifying_kernel_placed_worker() {
        let fs = FakeCgroupFs::delegated();
        let mut group = adapter(&fs)
            .prepare_worker(identity(9), REQUIRED_POLICY)
            .unwrap();

        assert_eq!(fs.contents(&group.path().join("memory.max")), "268435456");
        assert_eq!(fs.contents(&group.path().join("cpu.max")), "25000 100000");
        // pids.max counts tasks, including threads; this worker is single-threaded.
        assert_eq!(fs.contents(&group.path().join("pids.max")), "1");
        assert!(fs.contents(&group.path().join("cgroup.procs")).is_empty());

        fs.kernel_places_worker(group.path(), 4242);
        group.verify_atomic_placement(&identity(9), 4242).unwrap();
        assert_eq!(group.process_id(), Some(4242));
        assert_eq!(fs.contents(&group.path().join("cgroup.procs")), "4242\n");
        assert_eq!(
            fs.contents(&group.path().join("cgroup.events")),
            "populated 1\n"
        );
    }

    #[test]
    fn refuses_unavailable_controller_without_creating_a_worker_group() {
        let fs = FakeCgroupFs::delegated();
        fs.insert(&Path::new(ROOT).join("cgroup.controllers"), "cpu memory");
        let result = adapter(&fs).prepare_worker(identity(1), REQUIRED_POLICY);
        assert_eq!(result.err(), Some(CgroupV2Error::ControllerUnavailable));
        assert_eq!(fs.directories.lock().unwrap().len(), 1);
    }

    #[test]
    fn refuses_controllers_that_are_present_but_not_delegated_to_children() {
        let fs = FakeCgroupFs::delegated();
        fs.insert(
            &Path::new(ROOT).join("cgroup.subtree_control"),
            "cpu memory",
        );
        let result = adapter(&fs).prepare_worker(identity(1), REQUIRED_POLICY);
        assert_eq!(result.err(), Some(CgroupV2Error::ControllerUnavailable));
        assert_eq!(fs.directories.lock().unwrap().len(), 1);
    }

    #[test]
    fn refuses_unwritable_delegation_without_creating_a_worker_group() {
        let fs = FakeCgroupFs::delegated();
        fs.deny_create();
        assert_eq!(
            adapter(&fs)
                .prepare_worker(identity(1), REQUIRED_POLICY)
                .err(),
            Some(CgroupV2Error::DelegationUnavailable)
        );
        assert_eq!(fs.directories.lock().unwrap().len(), 1);
    }

    #[test]
    fn blocks_new_workers_when_a_prior_worker_group_was_not_removed() {
        let fs = FakeCgroupFs::delegated();
        let abandoned = Path::new(ROOT).join("modus-worker-4294967295-4-0");
        fs.directories.lock().unwrap().insert(abandoned);
        assert_eq!(
            adapter(&fs)
                .prepare_worker(identity(5), REQUIRED_POLICY)
                .err(),
            Some(CgroupV2Error::CleanupFailed)
        );
        assert_eq!(fs.directories.lock().unwrap().len(), 2);
    }

    #[test]
    fn removes_an_empty_worker_group_only_after_its_supervisor_is_gone() {
        let fs = FakeCgroupFs::delegated();
        let abandoned = Path::new(ROOT).join("modus-worker-4294967295-4-0");
        fs.create_dir(&abandoned).unwrap();
        fs.set_worker_empty(&abandoned);
        let group = adapter(&fs)
            .prepare_worker(identity(5), REQUIRED_POLICY)
            .unwrap();
        assert!(!fs.directories.lock().unwrap().contains(&abandoned));
        assert!(fs.directories.lock().unwrap().contains(group.path()));
    }

    #[test]
    fn never_removes_a_worker_group_owned_by_a_live_supervisor() {
        let fs = FakeCgroupFs::delegated();
        let abandoned = Path::new(ROOT).join(format!("modus-worker-{}-4-0", std::process::id()));
        fs.create_dir(&abandoned).unwrap();
        fs.set_worker_empty(&abandoned);
        assert_eq!(
            adapter(&fs)
                .prepare_worker(identity(5), REQUIRED_POLICY)
                .err(),
            Some(CgroupV2Error::CleanupFailed)
        );
        assert!(fs.directories.lock().unwrap().contains(&abandoned));
    }

    #[test]
    fn rejects_identity_or_generation_mismatch_without_writing_cgroup_procs() {
        let fs = FakeCgroupFs::delegated();
        let mut group = adapter(&fs)
            .prepare_worker(identity(4), REQUIRED_POLICY)
            .unwrap();
        assert_eq!(
            group.verify_atomic_placement(&identity(5), 4242),
            Err(CgroupV2Error::IdentityMismatch)
        );
        assert!(fs.contents(&group.path().join("cgroup.procs")).is_empty());
    }

    #[test]
    fn rejects_control_write_or_readback_mismatch_and_removes_empty_group() {
        let fs = FakeCgroupFs::delegated();
        // The generated directory is deterministic for this test process and generation.
        let expected = adapter(&fs).worker_path_for_test(7);
        fs.deny_write(&expected.join("cpu.max"));
        assert_eq!(
            adapter(&fs)
                .prepare_worker(identity(7), REQUIRED_POLICY)
                .err(),
            Some(CgroupV2Error::LimitApplyFailed)
        );
        assert!(!fs.directories.lock().unwrap().contains(&expected));

        let fs = FakeCgroupFs::delegated();
        let expected = adapter(&fs).worker_path_for_test(11);
        fs.rewrite_after_write(&expected.join("cpu.max"), "max 100000");
        assert_eq!(
            adapter(&fs)
                .prepare_worker(identity(11), REQUIRED_POLICY)
                .err(),
            Some(CgroupV2Error::LimitApplyFailed)
        );
        assert!(!fs.directories.lock().unwrap().contains(&expected));
    }

    #[test]
    fn per_worker_memory_limit_cannot_exceed_the_aggregate_policy_ceiling() {
        let fs = FakeCgroupFs::delegated();
        let mut policy = REQUIRED_POLICY;
        policy.max_total_helper_rss_bytes = 32 * 1024 * 1024;
        let group = adapter(&fs).prepare_worker(identity(12), policy).unwrap();
        assert_eq!(fs.contents(&group.path().join("memory.max")), "33554432");
    }

    #[test]
    fn rejects_a_worker_missing_from_the_cgroup_after_mocked_clone3() {
        let fs = FakeCgroupFs::delegated();
        let identity = identity(16);
        let mut group = adapter(&fs)
            .prepare_worker(identity.clone(), REQUIRED_POLICY)
            .unwrap();

        assert_eq!(
            group.verify_atomic_placement(&identity, 6161),
            Err(CgroupV2Error::ProcessPlacementVerificationFailed)
        );
        assert_eq!(fs.cgroup_procs_write_attempts.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn refuses_cleanup_until_the_process_is_confirmed_reaped_then_removes_idempotently() {
        let fs = FakeCgroupFs::delegated();
        let mut group = adapter(&fs)
            .prepare_worker(identity(2), REQUIRED_POLICY)
            .unwrap();
        fs.kernel_places_worker(group.path(), 4242);
        group.verify_atomic_placement(&identity(2), 4242).unwrap();
        assert_eq!(group.cleanup(), Err(CgroupV2Error::CleanupFailed));
        assert!(fs.directories.lock().unwrap().contains(group.path()));

        fs.set_worker_empty(group.path());
        assert_eq!(group.cleanup(), Ok(()));
        assert_eq!(group.cleanup(), Ok(()));
        assert!(!fs.directories.lock().unwrap().contains(group.path()));
    }

    #[test]
    fn reports_cgroup_removal_failure_after_reap_instead_of_claiming_cleanup() {
        let fs = FakeCgroupFs::delegated();
        let mut group = adapter(&fs)
            .prepare_worker(identity(3), REQUIRED_POLICY)
            .unwrap();
        fs.deny_removal(group.path());
        assert_eq!(group.cleanup(), Err(CgroupV2Error::CleanupFailed));
        assert!(fs.directories.lock().unwrap().contains(group.path()));
    }

    #[test]
    fn cancellation_reaps_before_cgroup_cleanup_and_fails_closed_when_reap_is_unconfirmed() {
        let fs = FakeCgroupFs::delegated();
        let mut group = adapter(&fs)
            .prepare_worker(identity(6), REQUIRED_POLICY)
            .unwrap();
        fs.kernel_places_worker(group.path(), 4242);
        group.verify_atomic_placement(&identity(6), 4242).unwrap();
        let mut process = FixtureProcess {
            pid: 4242,
            reaped: false,
            fail_reap: true,
            fs: Arc::clone(&fs),
            group: group.path().to_path_buf(),
        };
        assert_eq!(
            terminate_worker_and_cleanup(&mut process, &mut group, Instant::now()),
            Err(CgroupV2Error::CleanupFailed)
        );
        assert!(!process.reaped);
        assert!(fs.directories.lock().unwrap().contains(group.path()));

        let fs = FakeCgroupFs::delegated();
        let mut group = adapter(&fs)
            .prepare_worker(identity(8), REQUIRED_POLICY)
            .unwrap();
        fs.kernel_places_worker(group.path(), 5252);
        group.verify_atomic_placement(&identity(8), 5252).unwrap();
        let mut process = FixtureProcess {
            pid: 5252,
            reaped: false,
            fail_reap: false,
            fs: Arc::clone(&fs),
            group: group.path().to_path_buf(),
        };
        assert_eq!(
            terminate_worker_and_cleanup(&mut process, &mut group, Instant::now()),
            Ok(())
        );
        assert!(process.reaped);
        assert!(!fs.directories.lock().unwrap().contains(group.path()));
    }

    #[test]
    fn supervisor_still_denies_after_synthetic_cgroup_setup_and_cleanup_succeed() {
        let fs = FakeCgroupFs::delegated();
        let cgroups = adapter(&fs);
        let command = serde_json::json!({
            "type": "invoke",
            "request": {
                "requestId": "fixture-request",
                "pluginId": "fixture/plugin",
                "pluginVersion": "1.0.0",
                "artifactSha256": "b".repeat(64),
                "artifactOrigin": "fixture-catalog",
                "trustLevel": "verified",
                "sessionId": "fixture-session",
                "workspaceId": "fixture-workspace",
                "runId": "fixture-run",
                "generation": 7,
                "capability": "plugin.transform",
                "payload": { "text": "synthetic" },
                "hostGrantedCapabilities": []
            }
        });
        let mut bootstrap = |provenance: &crate::HostProvenance| {
            let identity = WorkerCgroupIdentity::from_provenance(provenance);
            let mut group = cgroups
                .prepare_worker(identity.clone(), REQUIRED_POLICY)
                .map_err(|error| match error {
                    CgroupV2Error::CleanupFailed => crate::WorkerBootstrapFailure::CleanupFailed,
                    _ => crate::WorkerBootstrapFailure::CgroupUnavailable,
                })?;
            fs.kernel_places_worker(group.path(), 4242);
            group
                .verify_atomic_placement(&identity, 4242)
                .map_err(|_| crate::WorkerBootstrapFailure::CgroupUnavailable)?;
            fs.set_worker_empty(group.path());
            group
                .cleanup()
                .map_err(|_| crate::WorkerBootstrapFailure::CleanupFailed)?;
            Ok(())
        };
        let mut supervisor = crate::SupervisorService::default();
        let response = supervisor
            .handle_command_with_bootstrap(&serde_json::to_vec(&command).unwrap(), &mut bootstrap);
        assert!(matches!(
            response,
            Some(crate::WorkerInvocationResponse::Denied { reason, .. })
                if reason.contains("before artifact transfer")
        ));
        assert_eq!(supervisor.session_count(), 1);
        assert_eq!(fs.directories.lock().unwrap().len(), 1);
    }

    struct FixtureProcess {
        pid: u32,
        reaped: bool,
        fail_reap: bool,
        fs: Arc<FakeCgroupFs>,
        group: PathBuf,
    }

    impl super::WorkerTerminator for FixtureProcess {
        fn process_id(&self) -> u32 {
            self.pid
        }

        fn terminate_and_reap(&mut self, _deadline: Instant) -> Result<(), ()> {
            if self.fail_reap {
                return Err(());
            }
            self.reaped = true;
            self.fs.set_worker_empty(&self.group);
            Ok(())
        }
    }
}
