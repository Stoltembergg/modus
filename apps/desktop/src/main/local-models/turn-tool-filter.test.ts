import { describe, expect, it } from "vitest";
import type { LocalModelFailure } from "./errors";
import { formatTurnToolFilterLog, turnToolFilterLogReason } from "./turn-tool-filter";

describe("turn tool filter log line", () => {
  it("maps every ranker failure to one of off / loading / busy / timeout / error", () => {
    const all: Record<LocalModelFailure | "exception" | "unknown", string> = {
      disabled: "off",
      "not-ready": "loading",
      busy: "busy",
      timeout: "timeout",
      "unsupported-platform": "error",
      missing: "error",
      "hash-mismatch": "error",
      "download-failed": "error",
      "load-failed": "error",
      "inference-failed": "error",
      crashed: "error",
      hung: "error",
      cancelled: "error",
      exception: "error",
      unknown: "error",
    };
    for (const [cause, reason] of Object.entries(all)) {
      expect(turnToolFilterLogReason(cause as keyof typeof all)).toBe(reason);
    }
  });

  it("formats the filtered and fallback lines (cause only when it adds information)", () => {
    expect(formatTurnToolFilterLog({ mode: "filtered", sent: 8, of: 38, core: 8, ms: 41.4 })).toBe(
      "[local-models] tool filter: filtered sent=8 of=38 core=8 ms=41",
    );
    expect(
      formatTurnToolFilterLog({
        mode: "fallback",
        cause: "timeout",
        sent: 38,
        of: 38,
        core: 8,
        ms: 76.6,
      }),
    ).toBe("[local-models] tool filter: fallback reason=timeout sent=38 of=38 core=8 ms=77");
    expect(
      formatTurnToolFilterLog({
        mode: "fallback",
        cause: "not-ready",
        sent: 38,
        of: 38,
        core: 8,
        ms: 2,
      }),
    ).toBe(
      "[local-models] tool filter: fallback reason=loading sent=38 of=38 core=8 ms=2 cause=not-ready",
    );
    expect(
      formatTurnToolFilterLog({
        mode: "fallback",
        cause: "busy",
        sent: 38,
        of: 38,
        core: 8,
        ms: -1,
      }),
    ).toBe("[local-models] tool filter: fallback reason=busy sent=38 of=38 core=8 ms=0");
  });
});
