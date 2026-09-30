import { describe, expect, it } from "vitest";
import { isActiveWaitingStatus } from "./GroupMessageList";

describe("isActiveWaitingStatus", () => {
  it("is true only for Waiting lines whose author is currently waiting", () => {
    expect(isActiveWaitingStatus("Waiting for you", "s-build", ["s-build"])).toBe(true);
    expect(isActiveWaitingStatus("Waiting for you", "s-build", ["s-other"])).toBe(false);
    expect(isActiveWaitingStatus("Waiting for you", "s-build", [])).toBe(false);
    expect(isActiveWaitingStatus("Turn stopped", "s-build", ["s-build"])).toBe(false);
    expect(
      isActiveWaitingStatus(
        "Waiting for you: this chain reached its limit of 6 turns.",
        undefined,
        ["s-build"],
      ),
    ).toBe(false);
  });
});
