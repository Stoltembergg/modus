#![cfg(windows)]

use plugin_sandbox_probe::platform::run_probe;
use plugin_sandbox_probe::report::{ProbeScenario, ScenarioStatus, Verdict};

#[test]
fn windows_diagnostic_emits_eight_cases_and_only_passes_verified_child_supervision() {
    let report = run_probe().expect("Windows feasibility probe should produce a report");
    report.validate().expect("report invariants should hold");

    assert_eq!(report.verdict, Verdict::NoGo);
    assert_eq!(report.scenarios.len(), 8);
    assert!(report.process_tree_empty);
    for (actual, expected) in report.scenarios.iter().zip(ProbeScenario::ALL) {
        assert_eq!(actual.scenario, expected);
        if expected != ProbeScenario::ChildProcessTree {
            assert_ne!(actual.status, ScenarioStatus::Passed);
        }
    }
    assert_eq!(report.scenarios[0].status, ScenarioStatus::NotTested);
    assert_eq!(report.scenarios[1].status, ScenarioStatus::Failed);
    assert_eq!(report.scenarios[2].status, ScenarioStatus::Failed);
    assert_eq!(report.scenarios[4].status, ScenarioStatus::Failed);
    assert_eq!(report.scenarios[5].status, ScenarioStatus::Failed);
    assert_eq!(report.scenarios[6].status, ScenarioStatus::Failed);
    assert_eq!(report.scenarios[7].status, ScenarioStatus::Failed);
    let child_tree = &report.scenarios[3];
    assert_eq!(child_tree.status, ScenarioStatus::Passed);
}
