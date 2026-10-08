import type {
  HarnessContext,
  HarnessHook,
  VerificationCheckInput,
  VerificationCheckOutput,
} from "./harness-hooks";

/**
 * Standard Verification Check Hook:
 * Inspects tool executions for failed commands, lint errors, or broken tests,
 * enforcing the Verifier-First pattern.
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

    const allPassed = violations.length === 0;
    context.state.set("verification_all_passed", allPassed);

    return {
      verified: allPassed,
      allPassed,
      violations,
      checksRun: executions.length,
      evidenceRef: `evidence-${input.runId}`,
      failureReason: allPassed ? undefined : violations.join("; "),
      suggestedAction: allPassed ? "proceed" : "retry",
    };
  },
};
