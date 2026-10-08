#![cfg(windows)]

use plugin_sandbox_probe::platform::run_probe;
use plugin_sandbox_probe::report::{ProbeScenario, ScenarioStatus, Verdict};

#[test]
fn orchestration_keeps_cpu_not_tested_and_reports_unsupported_quotas_as_failed() {
    let report = run_probe().expect("Windows probe should emit a bounded diagnostic report");
    report.validate().expect("report invariants should hold");
    assert_eq!(report.verdict, Verdict::NoGo);
    for (scenario, expected) in [
        (ProbeScenario::CpuLoop, ScenarioStatus::NotTested),
        (ProbeScenario::MemoryBomb, ScenarioStatus::Failed),
        (ProbeScenario::HandleLimit, ScenarioStatus::Failed),
    ] {
        assert_eq!(
            report
                .scenarios
                .iter()
                .find(|entry| entry.scenario == scenario)
                .unwrap()
                .status,
            expected,
        );
    }
    assert!(
        !report
            .scenarios
            .iter()
            .any(|entry| entry.status == ScenarioStatus::Passed
                && matches!(
                    entry.scenario,
                    ProbeScenario::MemoryBomb | ProbeScenario::HandleLimit
                ))
    );
}
