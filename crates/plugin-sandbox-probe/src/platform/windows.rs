use super::windows_runtime::{cpu_not_tested, unavailable};
use super::windows_supervisor::forward_child_tree_case;
use crate::report::{
    EnforcementState, ProbeReport, ProbeScenario, QuotaState, ScenarioResult, ScenarioStatus,
};

pub fn run_probe() -> Result<ProbeReport, String> {
    let mut report = ProbeReport::not_tested(std::env::consts::OS, std::env::consts::ARCH);
    report.quotas.memory = QuotaState::Unsupported;
    report.quotas.handles = QuotaState::Unsupported;

    let mut continuation_safe = true;
    for scenario in ProbeScenario::ALL {
        let Some(index) = report
            .scenarios
            .iter()
            .position(|result| result.scenario == scenario)
        else {
            return Err(format!(
                "scenario missing from initialized report: {scenario:?}"
            ));
        };

        if !continuation_safe {
            report.scenarios[index] = ScenarioResult::not_tested(scenario);
            continue;
        }

        match scenario {
            ProbeScenario::ChildProcessTree => match forward_child_tree_case() {
                Ok(result) => {
                    continuation_safe = result.tree_wait_completed
                        && result
                            .reap
                            .as_ref()
                            .is_some_and(|reap| reap.all_handles_closed && reap.job_handle_closed);
                    report.scenarios[index] = result;
                }
                Err(error) => {
                    continuation_safe = false;
                    report.scenarios[index].status = ScenarioStatus::Failed;
                    report.scenarios[index].reason = error;
                }
            },
            ProbeScenario::MemoryBomb => {
                report.scenarios[index].enforcement = EnforcementState::Unsupported;
                report.scenarios[index].status = ScenarioStatus::Failed;
                report.scenarios[index].reason = "bounded worker challenge not run: Windows Job memory limits constrain commit, not RSS; working-set maximum is not tamper resistant".into();
            }
            ProbeScenario::HandleLimit => {
                report.scenarios[index].enforcement = EnforcementState::Unsupported;
                report.scenarios[index].status = ScenarioStatus::Failed;
                report.scenarios[index].reason = "bounded worker challenge not run: no documented hard general kernel-handle quota of 64".into();
            }
            ProbeScenario::CpuLoop => {
                let outcome = cpu_not_tested();
                continuation_safe &= outcome.continuation_safe;
                report.scenarios[index] = outcome.result;
            }
            ProbeScenario::ProcessLimit => {
                let mut outcome = unavailable(
                    scenario,
                    "active-process attribution/runtime not implemented; no launch attempted",
                );
                outcome.result.enforcement = EnforcementState::Configured;
                continuation_safe &= outcome.continuation_safe;
                report.scenarios[index] = outcome.result;
            }
            ProbeScenario::WallClockTimeout => {
                let outcome = unavailable(
                    scenario,
                    "wall-clock runtime not implemented; no launch attempted",
                );
                continuation_safe &= outcome.continuation_safe;
                report.scenarios[index] = outcome.result;
            }
            ProbeScenario::HardKill => {
                let outcome = unavailable(
                    scenario,
                    "hard-kill runtime not implemented; no launch attempted",
                );
                continuation_safe &= outcome.continuation_safe;
                report.scenarios[index] = outcome.result;
            }
            ProbeScenario::ReapDeadline => {
                let outcome = unavailable(
                    scenario,
                    "reap-deadline runtime not implemented; no launch attempted",
                );
                continuation_safe &= outcome.continuation_safe;
                report.scenarios[index] = outcome.result;
            }
        }
    }

    report.quotas.processes = QuotaState::NotTested;
    report.quotas.duration = QuotaState::NotTested;
    report.evidence.push(
        "The fixed diagnostic worker is trusted host code; no plugin or external guest executes"
            .into(),
    );
    report.evidence.push(
        "RSS=256 MiB and general kernel handles=64 remain unsupported; release verdict NO_GO and A01-A04 remain open".into(),
    );
    report.process_tree_empty = report
        .scenarios
        .iter()
        .find(|result| result.scenario == ProbeScenario::ChildProcessTree)
        .is_some_and(|result| result.job_empty);
    report.termination_evidence = if report
        .scenarios
        .iter()
        .find(|result| result.scenario == ProbeScenario::ChildProcessTree)
        .is_some_and(|result| result.status == ScenarioStatus::Passed)
    {
        "child-tree diagnostic used TerminateJobObject, waited both processes, confirmed zero active members, and closed owned handles; other scenario trees not tested".into()
    } else {
        "child-tree scenario did not establish complete verified reap; other scenario trees not tested".into()
    };
    report.validate()?;
    Ok(report)
}

#[allow(dead_code)]
fn failed_scenario(scenario: ProbeScenario, reason: String) -> ScenarioResult {
    let mut result = ScenarioResult::not_tested(scenario);
    result.status = ScenarioStatus::Failed;
    result.reason = reason;
    result
}
