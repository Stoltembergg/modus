use crate::report::{ProbeReport, QuotaState};
use std::fs;
use std::path::{Path, PathBuf};

/// Collects host feasibility evidence only. This adapter intentionally does not
/// attempt namespace/cgroup setup: a worker must never run before a complete,
/// verified confinement policy has been installed.
pub fn run_probe() -> Result<ProbeReport, String> {
    let mut report = ProbeReport::not_tested(std::env::consts::OS, std::env::consts::ARCH);
    report.quotas.memory = QuotaState::Unsupported;
    report.quotas.duration = QuotaState::NotTested;
    report.quotas.handles = QuotaState::NotTested;
    report.quotas.cpu_rate = QuotaState::NotTested;
    report.quotas.processes = QuotaState::NotTested;
    report.termination_evidence = "worker not launched; process-tree state not tested".into();

    let kernel = fs::read_to_string("/proc/sys/kernel/osrelease")
        .map(|value| value.trim().to_owned())
        .unwrap_or_else(|error| format!("unavailable ({error})"));
    report.evidence.push(format!("kernel version: {kernel}"));
    report
        .evidence
        .push(format!("architecture: {}", std::env::consts::ARCH));

    let cgroup = inspect_cgroup_v2();
    report
        .evidence
        .push(format!("cgroup v2 read-only preflight: {cgroup}"));
    report.evidence.push(
        "required cgroup policy not installed: cpu.max=25000 100000, pids.max=1, memory.max=268435456, cgroup.kill; memory.max is not the approved RSS-only cap".into(),
    );

    report.evidence.push(format!(
        "namespace/security feature checks: {}",
        inspect_security_features()
    ));
    report.evidence.push(
        "RLIMIT_NOFILE=64 not installed; seccomp/Landlock/no_new_privs policy not installed or verified; quotas not tested; no worker or policy enforcement claimed".into(),
    );
    report.evidence.push(
        "worker not launched: no complete confinement policy was installed and directly verified; all canaries remain not_run".into(),
    );
    report.validate()?;
    Ok(report)
}

fn inspect_cgroup_v2() -> String {
    let mounts = match fs::read_to_string("/proc/self/mountinfo") {
        Ok(mounts) => mounts,
        Err(error) => return format!("proc mountinfo unavailable ({error})"),
    };
    let mount = mounts.lines().find_map(|line| {
        let (before, after) = line.split_once(" - ")?;
        if !after.starts_with("cgroup2 ") {
            return None;
        }
        let fields: Vec<&str> = before.split_whitespace().collect();
        Some(PathBuf::from(fields.get(4).copied()?))
    });
    let Some(mount) = mount else {
        return "not mounted".into();
    };

    let membership = fs::read_to_string("/proc/self/cgroup")
        .ok()
        .and_then(|content| {
            content.lines().find_map(|line| {
                let (hierarchy, path) = line.split_once(':')?;
                let (controllers, path) = path.split_once(':')?;
                (hierarchy == "0" && controllers.is_empty()).then(|| path.to_owned())
            })
        });
    let Some(membership) = membership else {
        return format!(
            "mounted at {}; unified membership unavailable",
            mount.display()
        );
    };

    let relative = membership.trim_start_matches('/');
    let current = mount.join(relative);
    let writable_preflight = writable_directory(&current);
    let controllers = ["cpu.max", "pids.max", "memory.max", "cgroup.kill"]
        .iter()
        .map(|name| {
            let path = current.join(name);
            format!(
                "{name}={}",
                if path.exists() { "present" } else { "absent" }
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "mounted at {}; membership {}; access(W_OK) permission/access preflight={writable_preflight} (not proof a child cgroup/controller can be created or configured); control-file presence ({controllers}) is not proof of delegation",
        mount.display(),
        current.display()
    )
}

fn writable_directory(path: &Path) -> bool {
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()) else {
        return false;
    };
    // Read-only permission/access preflight only; it does not prove child cgroup
    // creation or controller configuration, and does not modify cgroup state.
    unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
}

fn inspect_security_features() -> String {
    let namespaces = ["user", "mnt", "net", "pid"]
        .iter()
        .map(|name| {
            let available = Path::new("/proc/self/ns").join(name).exists();
            format!("{name}={}", if available { "present" } else { "absent" })
        })
        .collect::<Vec<_>>()
        .join(",");
    let status = fs::read_to_string("/proc/self/status").unwrap_or_default();
    let field = |name: &str| {
        status
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .map(str::trim)
            .unwrap_or("unavailable")
    };
    let landlock = Path::new("/sys/kernel/security/landlock").exists();
    format!(
        "namespace handles ({namespaces}); presence indicates handles only, not ability to create/join namespaces; current host process NoNewPrivs={}; Seccomp={}; Landlock securityfs path={} (path presence does not establish Landlock ABI support)",
        field("NoNewPrivs:"),
        field("Seccomp:"),
        if landlock { "present" } else { "absent" }
    )
}
