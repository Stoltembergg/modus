#![cfg(target_os = "linux")]

use plugin_sandbox_probe::platform::run_probe;
use plugin_sandbox_probe::report::{CheckOutcome, QuotaState, Verdict};

#[test]
fn linux_preflight_is_honest_no_go_without_launching_a_worker() {
    let report = run_probe().expect("Linux feasibility preflight should produce a report");
    report.validate().expect("report invariants should hold");

    assert_eq!(report.verdict, Verdict::NoGo);
    assert_eq!(report.os, "linux");
    assert!(!report.process_tree_empty);
    assert_eq!(
        report.termination_evidence,
        "worker not launched; process-tree state not tested"
    );
    for check in [
        report.checks.protected_path_read,
        report.checks.protected_path_write,
        report.checks.loopback_connect,
        report.checks.child_spawn,
        report.checks.environment,
    ] {
        assert_eq!(check, CheckOutcome::NotRun);
    }
    assert_eq!(report.quotas.memory, QuotaState::Unsupported);
    assert_eq!(report.quotas.duration, QuotaState::NotTested);
    assert_eq!(report.quotas.handles, QuotaState::NotTested);
    assert_eq!(report.quotas.cpu_rate, QuotaState::NotTested);
    assert_eq!(report.quotas.processes, QuotaState::NotTested);
    assert!(report.evidence.iter().any(|line| line.contains("kernel")));
    assert!(report.evidence.iter().any(|line| {
        line.contains("access(W_OK)")
            && line.contains("not proof")
            && line.contains("control-file presence")
    }));
    assert!(report.evidence.iter().any(|line| {
        line.contains("namespace handles") && line.contains("not ability to create/join")
    }));
    assert!(report.evidence.iter().any(|line| {
        line.contains("current host process") && line.contains("Landlock ABI support")
    }));
    assert!(
        report
            .evidence
            .iter()
            .any(|line| line.contains("worker not launched"))
    );
}
