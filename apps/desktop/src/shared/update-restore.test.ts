import { describe, expect, it } from "vitest";
import type { UpdateState } from "./contracts";
import { hasPendingDownloadedUpdate } from "./update-restore";

describe("hasPendingDownloadedUpdate", () => {
  it.each<[UpdateState, boolean]>([
    [{ status: "idle" }, false],
    [{ status: "checking" }, false],
    [{ status: "available", version: "1.3.0", action: "install" }, false],
    [{ status: "downloading", version: "1.3.0", percent: 40 }, false],
    [{ status: "ready", version: "1.3.0" }, true],
    [{ status: "waiting-for-agents", version: "1.3.0" }, true],
    [{ status: "installing", version: "1.3.0" }, true],
    [{ status: "failed", version: "1.3.0", retryable: true, action: "install" }, false],
    [
      {
        status: "failed",
        version: "1.3.0",
        retryable: true,
        action: "install",
        appliesOnQuit: true,
      },
      true,
    ],
  ])("%j -> %s", (state, expected) => {
    expect(hasPendingDownloadedUpdate(state)).toBe(expected);
  });
});
