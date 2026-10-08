//! Runtime support for the Phase 1C Windows diagnostic cases.
//!
//! This module deliberately keeps runtime observations separate from policy
//! decisions. Scenario policy belongs in `windows.rs`; this module reports
//! whether cleanup was confirmed so orchestration can fail closed.

use crate::report::{ProbeScenario, ScenarioResult, ScenarioStatus};

mod native;
mod ownership;

/// Result of attempting a bounded runtime operation. A false value means the
/// caller must not start another worker because process cleanup is uncertain.
#[derive(Debug)]
pub(super) struct RuntimeOutcome {
    pub result: ScenarioResult,
    pub continuation_safe: bool,
}

/// Construct a conservative result for a case whose native lifecycle could
/// not be established. No enforcement or termination claim is made.
pub(super) fn unavailable(scenario: ProbeScenario, reason: impl Into<String>) -> RuntimeOutcome {
    let mut result = ScenarioResult::not_tested(scenario);
    result.status = ScenarioStatus::Failed;
    result.reason = reason.into();
    RuntimeOutcome {
        result,
        continuation_safe: true,
    }
}

/// CPU remains deliberately unlaunched until parent-Job eligibility and
/// calibration are independently resolved.
pub(super) fn cpu_not_tested() -> RuntimeOutcome {
    RuntimeOutcome {
        result: ScenarioResult::not_tested(ProbeScenario::CpuLoop),
        continuation_safe: true,
    }
}

#[cfg(test)]
mod tests {
    use super::{RuntimeOutcome, cpu_not_tested, unavailable};
    use crate::report::{ProbeScenario, ScenarioStatus};

    #[test]
    fn initiating_failure_with_confirmed_cleanup_allows_next_case() {
        let outcome = unavailable(
            ProbeScenario::WallClockTimeout,
            "setup failed; cleanup confirmed",
        );
        assert_eq!(outcome.result.status, ScenarioStatus::Failed);
        assert!(outcome.continuation_safe);
    }

    #[test]
    fn uncertain_cleanup_blocks_continuation() {
        let outcome = RuntimeOutcome {
            result: crate::report::ScenarioResult::not_tested(ProbeScenario::HardKill),
            continuation_safe: false,
        };
        assert!(!outcome.continuation_safe);
    }

    #[test]
    fn cpu_is_not_launched_while_calibration_is_unresolved() {
        let outcome = cpu_not_tested();
        assert_eq!(outcome.result.scenario, ProbeScenario::CpuLoop);
        assert_eq!(outcome.result.status, ScenarioStatus::NotTested);
    }
}
