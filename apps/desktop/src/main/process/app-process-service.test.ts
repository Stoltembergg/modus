import { describe, expect, it } from "vitest";
import { isAppId, killApp, launchApp, listApps } from "./app-process-service";
import { pidAlive } from "./platform-process-ops";

/**
 * Real integration tests against actual OS processes (no mocks): launch a
 * long-lived child via the Node binary, verify the launcher tracks it as alive
 * with a real pid, then terminate it through the same path the agent uses.
 */
const NODE = process.execPath;
const SLEEP_ARGS = ["-e", "setInterval(() => {}, 1_000_000)"];

async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

describe("app-process-service", () => {
  it("launches a detached process, tracks its real pid as alive, then kills it", async () => {
    const result = await launchApp({
      path: NODE,
      args: SLEEP_ARGS,
      cwd: process.cwd(),
      sessionId: "test-session",
      runId: "test-run",
    });

    try {
      expect(result.alive).toBe(true);
      expect(result.pid).toBeGreaterThan(0);
      expect(pidAlive(result.pid)).toBe(true);
      expect(result.command).toBe(NODE);
      expect(result.name).toBeTruthy();
      expect(result.runId).toBe("test-run");
      expect(isAppId(result.id)).toBe(true);

      const listed = listApps({ sessionId: "test-session" }).find((a) => a.id === result.id);
      expect(listed?.status).toBe("running");

      const killed = await killApp(result.id);
      expect(killed).toBe(true);

      const dead = await waitUntil(() => !pidAlive(result.pid));
      expect(dead).toBe(true);
    } finally {
      // Defensive cleanup so a failed assertion never leaks a real process.
      await killApp(result.id).catch(() => undefined);
    }
  }, 20_000);

  it("kills a process when its launch is cancelled during readiness verification", async () => {
    const sessionId = "cancelled-launch-session";
    const controller = new AbortController();
    const launch = launchApp({
      path: NODE,
      args: SLEEP_ARGS,
      cwd: process.cwd(),
      sessionId,
      runId: "cancelled-run",
      signal: controller.signal,
    });
    const abortTimer = setTimeout(() => controller.abort(), 20);

    try {
      await expect(launch).rejects.toMatchObject({ name: "AbortError" });
      expect(listApps({ sessionId })).toHaveLength(0);
    } finally {
      clearTimeout(abortTimer);
      await Promise.all(listApps({ sessionId }).map((app) => killApp(app.id)));
    }
  }, 20_000);

  it("kills a detached launch when cancellation arrives before the spawn event", async () => {
    const sessionId = "cancelled-before-spawn-session";
    const controller = new AbortController();
    const launch = launchApp({
      path: NODE,
      args: SLEEP_ARGS,
      cwd: process.cwd(),
      sessionId,
      runId: "cancelled-before-spawn-run",
      signal: controller.signal,
    });
    controller.abort();

    try {
      await expect(launch).rejects.toMatchObject({ name: "AbortError" });
      expect(listApps({ sessionId })).toHaveLength(0);
    } finally {
      await Promise.all(listApps({ sessionId }).map((app) => killApp(app.id)));
    }
  }, 20_000);

  it("reports an unknown id as not an app and a no-op kill", async () => {
    expect(isAppId("does-not-exist")).toBe(false);
    expect(await killApp("does-not-exist")).toBe(false);
  });
});
