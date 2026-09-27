import { describe, expect, it } from "vitest";
import type { UpdateState } from "../../shared/contracts";
import { IDLE, isCheckAllowed, reduceUpdateState, type UpdateEvent } from "./update-state-machine";

function run(events: UpdateEvent[], from: UpdateState = IDLE): UpdateState {
  return events.reduce(reduceUpdateState, from);
}

describe("reduceUpdateState", () => {
  it("walks the install path", () => {
    let state = run([{ type: "check-started" }]);
    expect(state).toEqual({ status: "checking" });
    state = run([{ type: "check-found", version: "1.2.0", action: "install" }], state);
    expect(state).toEqual({ status: "available", version: "1.2.0", action: "install" });
    state = run([{ type: "download-started", version: "1.2.0" }], state);
    expect(state).toEqual({ status: "downloading", version: "1.2.0", percent: 0 });
    state = run([{ type: "download-progress", percent: 42.44 }], state);
    expect(state).toEqual({ status: "downloading", version: "1.2.0", percent: 42.4 });
    state = run([{ type: "download-progress", percent: 10 }], state);
    expect(state).toMatchObject({ percent: 42.4 });
    state = run([{ type: "download-progress", percent: 400 }], state);
    expect(state).toMatchObject({ percent: 100 });
    state = run([{ type: "download-finished" }], state);
    expect(state).toEqual({ status: "ready", version: "1.2.0" });
    state = run([{ type: "restart-deferred" }], state);
    expect(state).toEqual({ status: "waiting-for-agents", version: "1.2.0" });
    state = run([{ type: "install-started" }], state);
    expect(state).toEqual({ status: "installing", version: "1.2.0" });
  });

  it("returns to idle when a check settles without an update", () => {
    expect(run([{ type: "check-started" }, { type: "check-settled" }])).toEqual(IDLE);
  });

  it("ignores late check results once a download started", () => {
    const downloading: UpdateState = { status: "downloading", version: "1.2.0", percent: 5 };
    expect(run([{ type: "check-found", version: "1.3.0", action: "install" }], downloading)).toBe(
      downloading,
    );
    expect(run([{ type: "check-settled" }], downloading)).toBe(downloading);
    expect(run([{ type: "check-started" }], downloading)).toBe(downloading);
  });

  it("keeps a visible failure when a background check finds the same version", () => {
    const failed: UpdateState = {
      status: "failed",
      version: "1.2.0",
      retryable: true,
      action: "install",
    };
    expect(run([{ type: "check-found", version: "1.2.0", action: "install" }], failed)).toBe(
      failed,
    );
    expect(run([{ type: "check-found", version: "1.3.0", action: "install" }], failed)).toEqual({
      status: "available",
      version: "1.3.0",
      action: "install",
    });
  });

  it("fails downloads and installs, and retries from failed", () => {
    const failed = run([{ type: "failed", retryable: true, action: "install" }], {
      status: "downloading",
      version: "1.2.0",
      percent: 50,
    });
    expect(failed).toEqual({
      status: "failed",
      version: "1.2.0",
      retryable: true,
      action: "install",
    });
    expect(run([{ type: "download-started", version: "1.2.0" }], failed)).toMatchObject({
      status: "downloading",
      percent: 0,
    });
    expect(run([{ type: "failed", retryable: true, action: "install" }], IDLE)).toBe(IDLE);
  });

  it("dismisses offers and failures only", () => {
    expect(
      run([{ type: "dismissed" }], { status: "available", version: "1", action: "install" }),
    ).toEqual(IDLE);
    const ready: UpdateState = { status: "ready", version: "1.2.0" };
    expect(run([{ type: "dismissed" }], ready)).toBe(ready);
  });
});

describe("isCheckAllowed", () => {
  it("never checks while checking, downloading or once an install is pending", () => {
    expect(isCheckAllowed(IDLE)).toBe(true);
    expect(isCheckAllowed({ status: "available", version: "1", action: "install" })).toBe(true);
    expect(isCheckAllowed({ status: "checking" })).toBe(false);
    expect(isCheckAllowed({ status: "downloading", version: "1", percent: 0 })).toBe(false);
    expect(isCheckAllowed({ status: "ready", version: "1" })).toBe(false);
    expect(isCheckAllowed({ status: "waiting-for-agents", version: "1" })).toBe(false);
    expect(isCheckAllowed({ status: "installing", version: "1" })).toBe(false);
  });
});
