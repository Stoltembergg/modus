import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CODE_REPAIR_FIXTURE, verifyCommandLine } from "./code-repair";
import type { QualityCheck, QualityFixture } from "./fixtures";
import { FIXTURE_VERIFY_REPAIR_TOOL } from "./scope";

export { FIXTURE_VERIFY_REPAIR_TOOL } from "./scope";

const CHECK_IDS = [
  "plain-command",
  "windows-quoted-path",
  "single-quoted-input",
  "empty-quoted-input",
  "blank-input",
  "existing-path-formatting",
  "existing-empty-formatting",
  "round-trip-basic-command",
  "round-trip-double-quote",
  "round-trip-single-quote",
  "round-trip-combined-quotes",
  "round-trip-empty-tokens",
  "round-trip-windows-backslashes",
  "round-trip-unicode-whitespace",
  "round-trip-quote-boundaries",
  "round-trip-empty-argument-list",
] as const;

export type IterativeRepairFeedback = { passed: boolean; failedCheckIds: string[] };

/** Uses the same independent behavioral checks as the frozen code-repair fixture. */
export function verifyIterativeRepairCandidate(source: string): QualityCheck[] {
  return verifyCommandLine(source);
}

/** Stable, deliberately small feedback for the model; no oracle values or host details. */
export function iterativeRepairFeedback(source: string): IterativeRepairFeedback {
  const checks = verifyIterativeRepairCandidate(source);
  const failedCheckIds = checks.flatMap((check, index) =>
    check.passed ? [] : [CHECK_IDS[index] ?? `check-${index + 1}`],
  );
  return { passed: failedCheckIds.length === 0, failedCheckIds };
}

export function registerIterativeRepairTool(input: {
  pi: ExtensionAPI;
  readCandidate: () => Promise<string | undefined>;
  onInvocation: () => boolean;
}): void {
  input.pi.registerTool({
    name: FIXTURE_VERIFY_REPAIR_TOOL,
    label: "Verify repair",
    description:
      "Run the independent fixture checks against command-line.ts. Takes no arguments. Use the fixed failedCheckIds to guide a repair, then verify again.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      if (!input.onInvocation()) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ passed: false, failedCheckIds: ["verification-limit"] }),
            },
          ],
          details: {},
        };
      }
      const source = await input.readCandidate();
      if (source === undefined) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ passed: false, failedCheckIds: ["candidate-unavailable"] }),
            },
          ],
          details: {},
        };
      }
      const feedback = iterativeRepairFeedback(source);
      return { content: [{ type: "text", text: JSON.stringify(feedback) }], details: {} };
    },
  });
}

export const ITERATIVE_REPAIR_FIXTURE: QualityFixture = {
  ...CODE_REPAIR_FIXTURE,
  id: "repair-command-line-iterative-pt",
  prompt:
    "Corrija o bug real em command-line.ts para que splitCommandLine(joinCommandLine(parts)) preserve qualquer token, inclusive aspas, barras, Unicode e strings vazias. Edite somente command-line.ts. Depois de cada correção, chame fixture_verify_repair sem argumentos. Use apenas os failedCheckIds devolvidos para orientar o próximo ajuste; continue até passed=true. Não tente executar testes ou comandos por outro meio e não declare sucesso sem a verificação positiva.",
  verify: ({ files }) => verifyIterativeRepairCandidate(files["command-line.ts"] ?? ""),
};
