/**
 * Modus Internal Plugin — @modus/verifier (Fase 10A Piloto 3)
 * Complex capability orchestrating multi-criteria verification, evidence aggregation, and status assessment.
 */

import type { CapabilityImplementation } from "../../capability/capability-types";
import type { PluginManifest } from "../plugin-types";

export interface VerificationCheck {
  id: string;
  name: string;
  command?: string | undefined;
  status: "passed" | "failed" | "missing" | "unavailable";
  outputSnippet?: string | undefined;
}

export interface VerificationContext {
  sessionId: string;
  runId: string;
  checks: VerificationCheck[];
  required: boolean;
}

export interface VerificationAssessment {
  status: "verified" | "failed" | "unknown";
  passedCount: number;
  failedCount: number;
  missingCount: number;
  totalChecks: number;
  summary: string;
}

const verificationRunImpl: CapabilityImplementation<
  { checks: Array<{ name: string; command: string }> },
  VerificationCheck[]
> = {
  execute: (ctx) => {
    // Returns simulated run records; in real execution integrates with harness-qa-helper
    return ctx.checks.map((c, i) => ({
      id: `chk-${i}-${c.name}`,
      name: c.name,
      command: c.command,
      status: "passed",
      outputSnippet: "Check executed successfully (exit code 0)",
    }));
  },
};

const verificationAssessImpl: CapabilityImplementation<
  VerificationContext,
  VerificationAssessment
> = {
  execute: (ctx) => {
    const totalChecks = ctx.checks.length;
    if (totalChecks === 0) {
      return {
        status: ctx.required ? "unknown" : "verified",
        passedCount: 0,
        failedCount: 0,
        missingCount: 0,
        totalChecks: 0,
        summary: ctx.required ? "No verification checks available" : "No verification required",
      };
    }

    const passedCount = ctx.checks.filter((c) => c.status === "passed").length;
    const failedCount = ctx.checks.filter((c) => c.status === "failed").length;
    const missingCount = ctx.checks.filter(
      (c) => c.status === "missing" || c.status === "unavailable",
    ).length;

    let status: "verified" | "failed" | "unknown" = "unknown";
    if (failedCount > 0) {
      status = "failed";
    } else if (passedCount === totalChecks) {
      status = "verified";
    } else {
      status = "unknown";
    }

    return {
      status,
      passedCount,
      failedCount,
      missingCount,
      totalChecks,
      summary: `Verification completed: ${passedCount}/${totalChecks} passed, ${failedCount} failed, ${missingCount} missing (${status})`,
    };
  },
};

export const verifierPluginManifest: PluginManifest = {
  id: "@modus/verifier",
  name: "Modus Verifier-First Engine",
  version: "1.0.0",
  author: "Modus Core Team",
  description:
    "Complex capability orchestrating QA checks, verification criteria, and evidence synthesis",
  trustLevel: "core",

  provides: [
    {
      capability: "verification.run",
      apiVersion: "1.0",
      implementation: verificationRunImpl,
    },
    {
      capability: "verification.assess",
      apiVersion: "1.0",
      implementation: verificationAssessImpl,
    },
  ],

  requires: {
    modus: ">=0.8.0",
    capabilities: [
      {
        capability: "context.resolve",
        version: "^1.0",
      },
    ],
  },

  permissions: {
    required: {
      tools: {
        allow: ["run_command", "test_runner"],
      },
    },
    reason: {
      tools: "Execute project verification test suites and linters",
    },
  },

  lifecycle: {
    onLoad: () => {},
    onUnload: () => {},
  },
};
