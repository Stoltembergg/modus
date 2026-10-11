import type {
  HarnessContext,
  HarnessHook,
  VerificationCheckInput,
  VerificationCheckOutput,
} from "./harness-hooks";

/**
 * Standard Verification Check Hook:
 * Reports tool errors but does not approve verification without authoritative
 * QA evidence linked to the run and its workspace scope.
 */
export const verificationCheckHook: HarnessHook<VerificationCheckInput, VerificationCheckOutput> = {
  name: "verification_check_qa",
  phase: "verification_check",
  priority: 10,
  isCritical: false,
  execute: async (
    input: VerificationCheckInput,
    context: HarnessContext,
  ): Promise<VerificationCheckOutput> => {
    const executions = input.toolExecutions ?? [];
    const violations: string[] = [];

    for (const exec of executions) {
      if (exec.isError) {
        violations.push(`Tool ${exec.toolName} failed: ${exec.output.slice(0, 100)}`);
      }
    }

    if (input.exitCode !== undefined && input.exitCode !== 0) {
      violations.push(`Command execution failed with exit code ${input.exitCode}`);
    }

    // This hook receives neither authoritative QA-store references nor a
    // check scope, so tool output alone cannot establish verification.
    context.state.set("verification_all_passed", false);

    return {
      verified: false,
      allPassed: false,
      violations,
      checksRun: 0,
      failureReason: violations.length
        ? violations.join("; ")
        : "No authoritative QA evidence is linked to this run.",
      suggestedAction: violations.length ? "retry" : "proceed",
    };
  },
};
