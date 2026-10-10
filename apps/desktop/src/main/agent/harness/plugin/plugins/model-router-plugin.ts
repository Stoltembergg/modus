/**
 * Modus Internal Plugin — @modus/model-router (Fase 10A Piloto 2)
 * Preserves explicit model selection and routes execution targets without choosing replacements.
 */

import {
  type CapabilityImplementation,
  CapabilityUnavailableError,
} from "../../capability/capability-types";
import type { PluginManifest } from "../plugin-types";

export interface ModelRouteContext {
  task: string;
  complexity?: "simple" | "medium" | "complex" | undefined;
  tokenEstimate?: number | undefined;
  preferredModel?: string | undefined;
}

export interface ModelSelectionResult {
  selectedModel?: string | undefined;
  reason: string;
  fallbackModel?: string | undefined;
  temperature: number;
}

export interface RoutingDecision {
  target: "local" | "cloud" | "subagent_mesh";
  model?: string | undefined;
  speculativeVerification: boolean;
}

const modelSelectImpl: CapabilityImplementation<ModelRouteContext, ModelSelectionResult> = {
  execute: (ctx) => {
    const temperature =
      ctx.complexity === "complex" ? 0.1 : ctx.complexity === "simple" ? 0.3 : 0.2;
    if (ctx.preferredModel) {
      return {
        selectedModel: ctx.preferredModel,
        reason: "Explicitly requested by user preference",
        fallbackModel: ctx.preferredModel,
        temperature,
      };
    }
    return {
      reason: "No explicit model selected; defer to the session default",
      temperature,
    };
  },
};

const modelRouteImpl: CapabilityImplementation<ModelRouteContext, RoutingDecision> = {
  execute: () => {
    throw new CapabilityUnavailableError(
      "model.route",
      "routing targets are not connected to the user's session/provider selection",
    );
  },
};

export const modelRouterPluginManifest: PluginManifest = {
  id: "@modus/model-router",
  name: "Modus Model Router",
  version: "1.0.0",
  author: "Modus Core Team",
  description:
    "Preserves explicit model selection; routing targets are unavailable and never choose a provider",
  trustLevel: "core",

  provides: [
    {
      capability: "model.select",
      apiVersion: "1.0",
      implementation: modelSelectImpl,
    },
    {
      capability: "model.route",
      apiVersion: "1.0",
      implementation: modelRouteImpl,
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
