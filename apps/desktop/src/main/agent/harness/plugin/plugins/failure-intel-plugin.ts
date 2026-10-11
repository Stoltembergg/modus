/**
 * Modus Internal Plugin — @modus/failure-intelligence (Fase 10B)
 * Core capability for failure classification, loop prevention, and recovery strategy recommendation.
 */

import {
  type CapabilityImplementation,
  CapabilityUnavailableError,
} from "../../capability/capability-types";
import type { PluginManifest } from "../plugin-types";

export interface FailureClassificationResult {
  category: "syntax" | "runtime" | "environment" | "timeout" | "model_hallucination";
  recoverable: boolean;
  strategy: "retry_with_fix" | "fallback_model" | "request_clarification" | "abort";
  confidence: number;
}

const failureClassifyImpl: CapabilityImplementation<
  { error: string; command?: string },
  FailureClassificationResult
> = {
  execute: () => {
    throw new CapabilityUnavailableError(
      "failure.classify",
      "the sample classifier is not connected to runtime failure evidence",
    );
  },
};

const failureRecoverImpl: CapabilityImplementation<
  { error: string; attempts: number },
  { shouldContinue: boolean; advice: string }
> = {
  execute: () => {
    throw new CapabilityUnavailableError(
      "failure.recover",
      "the sample recovery policy is not connected to runtime failure state",
    );
  },
};

export const failureIntelPluginManifest: PluginManifest = {
  id: "@modus/failure-intelligence",
  name: "Modus Failure Intelligence",
  version: "1.0.0",
  author: "Modus Core Team",
  description:
    "Legacy sample capability; runtime failure intelligence is implemented separately and this adapter is unavailable",
  trustLevel: "core",

  provides: [
    {
      capability: "failure.classify",
      apiVersion: "1.0",
      implementation: failureClassifyImpl,
    },
    {
      capability: "failure.recover",
      apiVersion: "1.0",
      implementation: failureRecoverImpl,
    },
  ],

  requires: {
    modus: ">=0.8.0",
  },

  permissions: {
    required: {},
  },
};
