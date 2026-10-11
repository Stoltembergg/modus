import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { app } from "electron";
import type { PluginExecutionSupervisorRequest } from "./plugin-execution-dispatcher";

const MAX_SUPERVISOR_MESSAGE_BYTES = 256 * 1024;
const SUPERVISOR_REQUEST_TIMEOUT_MS = 10_000;
const EXECUTABLE = "modus-plugin-execution-supervisor";

type SupervisorResponse =
  | { status: "completed"; requestId: string; result: unknown }
  | { status: "failed"; requestId: string; error: string }
  | { status: "cancelled"; requestId: string }
  | { status: "denied"; requestId: string; reason: string };

function resolveSupervisorPath(): string {
  const candidates = [
    app.isPackaged ? join(process.resourcesPath, "bin", EXECUTABLE) : undefined,
    resolve(process.cwd(), "target", "release", EXECUTABLE),
    resolve(process.cwd(), "..", "..", "target", "release", EXECUTABLE),
  ].filter((candidate): candidate is string => candidate !== undefined);
  const resolved = candidates.find((candidate) => isAbsolute(candidate) && existsSync(candidate));
  if (!resolved) {
    throw new Error(
      "Linux plugin worker supervisor is unavailable; external execution is blocked.",
    );
  }
  return resolved;
}

function parseResponse(value: string, requestId: string): SupervisorResponse {
  if (Buffer.byteLength(value, "utf8") > MAX_SUPERVISOR_MESSAGE_BYTES) {
    throw new Error("Linux plugin worker supervisor returned an oversized response.");
  }
  let response: unknown;
  try {
    response = JSON.parse(value);
  } catch {
    throw new Error("Linux plugin worker supervisor returned invalid JSON.");
  }
  if (
    !response ||
    typeof response !== "object" ||
    !("status" in response) ||
    !("requestId" in response) ||
    response.requestId !== requestId
  ) {
    throw new Error("Linux plugin worker supervisor returned an uncorrelated response.");
  }
  if (
    response.status === "completed" &&
    "result" in response &&
    Object.keys(response).every((key) => ["status", "requestId", "result"].includes(key))
  ) {
    return response as SupervisorResponse;
  }
  if (
    response.status === "failed" &&
    "error" in response &&
    typeof response.error === "string" &&
    Object.keys(response).every((key) => ["status", "requestId", "error"].includes(key))
  ) {
    return response as SupervisorResponse;
  }
  if (
    response.status === "cancelled" &&
    Object.keys(response).every((key) => ["status", "requestId"].includes(key))
  ) {
    return response as SupervisorResponse;
  }
  if (
    response.status === "denied" &&
    "reason" in response &&
    typeof response.reason === "string" &&
    Object.keys(response).every((key) => ["status", "requestId", "reason"].includes(key))
  ) {
    return response as SupervisorResponse;
  }
  throw new Error("Linux plugin worker supervisor returned an invalid response shape.");
}

/** Desktop IPC client for the Linux supervisor. It never starts a plugin directly. */
export class LinuxPluginWorkerSupervisor {
  async execute(
    request: PluginExecutionSupervisorRequest,
    signal?: AbortSignal,
  ): Promise<{ result: unknown }> {
    if (process.platform !== "linux") {
      throw new Error(`External plugin execution is blocked on ${process.platform}.`);
    }
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Plugin execution was cancelled before supervisor IPC");
    }

    const executable = resolveSupervisorPath();
    const requestJson = JSON.stringify(request);
    if (Buffer.byteLength(requestJson, "utf8") > MAX_SUPERVISOR_MESSAGE_BYTES) {
      throw new Error("Plugin execution request exceeds the bounded supervisor IPC size.");
    }

    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(executable, [], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
        env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" },
      });
      let stdout = "";
      let settled = false;
      const finish = (error?: Error, response?: SupervisorResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (error) {
          rejectPromise(error);
        } else if (!response) {
          rejectPromise(new Error("Linux plugin worker supervisor exited without a response."));
        } else if (response.status === "completed") {
          resolvePromise({ result: response.result });
        } else if (response.status === "failed") {
          rejectPromise(new Error(response.error));
        } else if (response.status === "cancelled") {
          rejectPromise(new Error("Linux plugin worker supervisor cancelled the invocation."));
        } else {
          rejectPromise(new Error(response.reason));
        }
      };
      const onAbort = (): void => {
        child.kill("SIGKILL");
        finish(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("Plugin invocation cancelled"),
        );
      };
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error("Linux plugin worker supervisor exceeded its request deadline."));
      }, SUPERVISOR_REQUEST_TIMEOUT_MS);

      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      if (settled) return;
      child.once("error", (error) =>
        finish(new Error(`Unable to start Linux plugin supervisor: ${error.message}`)),
      );
      child.stdin.once("error", (error) =>
        finish(new Error(`Unable to send request to Linux plugin supervisor: ${error.message}`)),
      );
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > MAX_SUPERVISOR_MESSAGE_BYTES) {
          child.kill("SIGKILL");
          finish(new Error("Linux plugin worker supervisor exceeded the response size limit."));
        }
      });
      child.once("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(
            new Error(`Linux plugin worker supervisor exited with status ${code ?? "unknown"}.`),
          );
          return;
        }
        try {
          finish(undefined, parseResponse(stdout.trim(), request.requestId));
        } catch (error) {
          finish(
            error instanceof Error
              ? error
              : new Error("Linux plugin worker supervisor response failed validation."),
          );
        }
      });

      child.stdin.end(requestJson);
    });
  }
}
