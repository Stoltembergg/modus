/**
 * Modus Internal Plugin — @modus/verifier (Fase 10A Piloto 3)
 * Complex capability orchestrating multi-criteria verification, evidence aggregation, and status assessment.
 */

import type { CapabilityImplementation } from "../../capability/capability-types";
import type { PluginManifest } from "../plugin-types";

export interface VerificationCheck {
  id?: string | undefined;
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
  status: "unknown" | "not_required";
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
    return ctx.checks.map((c) => ({
      name: c.name,
      command: c.command,
      status: "unavailable",
      outputSnippet: "This capability does not execute checks; use runtime QA evidence.",
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
        status: ctx.required ? "unknown" : "not_required",
        passedCount: 0,
        failedCount: 0,
        missingCount: 0,
        totalChecks: 0,
        summary: ctx.required ? "No verification checks available" : "No verification required",
      };
    }

    // Capability inputs are caller claims. This plugin cannot validate them
    // against the runtime's session/run/scope-bound evidence store.
    const passedCount = 0;
    const failedCount = 0;
    const missingCount = totalChecks;
    const status = "unknown" as const;

    return {
      status,
      passedCount,
      failedCount,
      missingCount,
      totalChecks,
      summary: `Verification is unavailable: ${missingCount} checks lack authoritative runtime evidence (${status})`,
    };
  },
};

export const verifierPluginManifest: PluginManifest = {
  id: "@modus/verifier",
  name: "Modus Verifier-First Engine",
  version: "1.0.0",
  author: "Modus Core Team",
  description:
    "Legacy adapter reports checks as unavailable; productive QA execution and evidence assessment use the runtime QA service",
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
  },

  permissions: {
    required: {},
  },

  lifecycle: {
    onLoad: () => {},
    onUnload: () => {},
  },
};
