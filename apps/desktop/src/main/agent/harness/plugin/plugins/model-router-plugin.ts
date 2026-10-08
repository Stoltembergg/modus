/**
 * Modus Internal Plugin — @modus/model-router (Fase 10A Piloto 2)
 * Near-stateless capability providing intelligent model selection and execution routing.
 */

import type { CapabilityImplementation } from "../../capability/capability-types";
import type { PluginManifest } from "../plugin-types";

export interface ModelRouteContext {
  task: string;
  complexity?: "simple" | "medium" | "complex" | undefined;
  tokenEstimate?: number | undefined;
  preferredModel?: string | undefined;
}

export interface ModelSelectionResult {
  selectedModel: string;
  reason: string;
  fallbackModel: string;
  temperature: number;
}

export interface RoutingDecision {
  target: "local" | "cloud" | "subagent_mesh";
  model: string;
  speculativeVerification: boolean;
}

const modelSelectImpl: CapabilityImplementation<ModelRouteContext, ModelSelectionResult> = {
  execute: (ctx) => {
    if (ctx.preferredModel) {
      return {
        selectedModel: ctx.preferredModel,
        reason: "Explicitly requested by user preference",
        fallbackModel: "gemini-2.5-pro",
        temperature: 0.2,
      };
    }

    if (ctx.complexity === "complex" || (ctx.tokenEstimate && ctx.tokenEstimate > 8000)) {
      return {
        selectedModel: "claude-3-7-sonnet",
        reason: "Complex task or high context requirement",
        fallbackModel: "gemini-2.5-pro",
        temperature: 0.1,
      };
    }

    if (ctx.complexity === "simple") {
      return {
        selectedModel: "gemini-3.8-flash",
        reason: "Low complexity fast completion",
        fallbackModel: "claude-3-7-sonnet",
        temperature: 0.3,
      };
    }

    return {
      selectedModel: "gemini-2.5-pro",
      reason: "Standard balanced execution",
      fallbackModel: "claude-3-7-sonnet",
      temperature: 0.2,
    };
  },
};

const modelRouteImpl: CapabilityImplementation<ModelRouteContext, RoutingDecision> = {
  execute: (ctx) => {
    const isMultiTurnSpec =
      ctx.task.toLowerCase().includes("spec") || ctx.task.toLowerCase().includes("plan");
    return {
      target: isMultiTurnSpec ? "subagent_mesh" : "cloud",
      model: ctx.complexity === "complex" ? "claude-3-7-sonnet" : "gemini-2.5-pro",
      speculativeVerification: isMultiTurnSpec,
    };
  },
};

export const modelRouterPluginManifest: PluginManifest = {
  id: "@modus/model-router",
  name: "Modus Model Router",
  version: "1.0.0",
  author: "Modus Core Team",
  description: "Stateless capability providing dynamic model routing and selection",
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
    required: {
      network: { domains: ["*"] },
    },
    reason: {
      network: "Route requests to model inference endpoints",
    },
  },

  lifecycle: {
    onLoad: () => {},
    onUnload: () => {},
  },
};
