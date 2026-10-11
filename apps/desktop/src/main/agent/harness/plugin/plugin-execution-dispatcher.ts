export interface HostPluginExecutionTarget {
  pluginId: string;
  pluginVersion: string;
  artifactSha256: string;
  artifactOrigin: string;
  trustLevel: "core" | "official" | "verified" | "community" | "local";
  generation: number;
  capabilities: readonly string[];
  hostGrantedCapabilities: readonly string[];
}

export interface HostPluginExecutionContext {
  sessionId: string;
  workspaceId: string;
  runId: string;
}

export interface PluginExecutionDispatchRequest {
  target: HostPluginExecutionTarget;
  context: HostPluginExecutionContext;
  capability: string;
  payload: unknown;
  signal?: AbortSignal;
}

export type PluginExecutionSupervisorRequest = Omit<HostPluginExecutionTarget, "capabilities"> & {
  requestId: string;
  sessionId: string;
  workspaceId: string;
  runId: string;
  capability: string;
  payload: unknown;
};

export type HostPluginExecutionCatalog = {
  resolve(pluginId: string): HostPluginExecutionTarget | undefined;
};

export type PluginExecutionSupervisor = PluginExecutionDispatcherOptions["execute"];

export interface PluginExecutionDispatcherOptions {
  authorize: (request: PluginExecutionSupervisorRequest) => Promise<boolean>;
  execute: (
    request: PluginExecutionSupervisorRequest,
    signal?: AbortSignal,
  ) => Promise<{ result: unknown }>;
}

export class PluginExecutionDispatcher {
  readonly #authorize: PluginExecutionDispatcherOptions["authorize"];
  readonly #execute: PluginExecutionDispatcherOptions["execute"];

  constructor(options: PluginExecutionDispatcherOptions) {
    this.#authorize = options.authorize;
    this.#execute = options.execute;
  }

  async dispatch(request: PluginExecutionDispatchRequest): Promise<unknown> {
    const { target, context, capability, signal } = request;
    if (!target.capabilities.includes(capability)) {
      throw new Error("Plugin capability is not present in the host catalog");
    }
    if (
      !target.pluginId ||
      !target.pluginVersion ||
      !/^[a-f0-9]{64}$/iu.test(target.artifactSha256) ||
      !target.artifactOrigin ||
      !Number.isSafeInteger(target.generation) ||
      target.generation <= 0 ||
      !context.sessionId ||
      !context.workspaceId ||
      !context.runId
    ) {
      throw new Error("Host plugin execution identity is invalid");
    }
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Plugin execution was cancelled before dispatch");
    }

    let payload: unknown;
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(request.payload);
      if (payloadJson === undefined) throw new Error("payload is not JSON serializable");
      if (Buffer.byteLength(payloadJson, "utf8") > MAX_WORKER_PAYLOAD_BYTES) {
        throw new Error("payload exceeds the bounded worker request size");
      }
      payload = JSON.parse(payloadJson);
    } catch (error) {
      if (error instanceof Error && error.message.includes("bounded worker request size")) {
        throw error;
      }
      throw new Error("Plugin execution payload must be bounded JSON");
    }

    const supervisorRequest: PluginExecutionSupervisorRequest = Object.freeze({
      requestId: randomUUID(),
      pluginId: target.pluginId,
      pluginVersion: target.pluginVersion,
      artifactSha256: target.artifactSha256.toLowerCase(),
      artifactOrigin: target.artifactOrigin,
      trustLevel: target.trustLevel,
      generation: target.generation,
      hostGrantedCapabilities: Object.freeze([...target.hostGrantedCapabilities]),
      sessionId: context.sessionId,
      workspaceId: context.workspaceId,
      runId: context.runId,
      capability,
      payload,
    });

    const authorized = await this.#authorize(supervisorRequest);
    if (!authorized) {
      throw new Error("Plugin execution was denied by the host permission broker");
    }
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Plugin execution was cancelled before worker admission");
    }

    const response = await this.#execute(supervisorRequest, signal);
    return response.result;
  }
}

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

const MAX_WORKER_PAYLOAD_BYTES = 64 * 1024;
