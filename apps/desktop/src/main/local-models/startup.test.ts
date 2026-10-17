import { describe, expect, it, vi } from "vitest";
import { startLocalModels } from "./startup";

describe("startLocalModels", () => {
  it("flag off: imports nothing and starts nothing", () => {
    const importRanker = vi.fn();
    expect(startLocalModels("/tmp/user-data", () => false, importRanker)).toBeUndefined();
    expect(importRanker).not.toHaveBeenCalled();
  });

  it("flag off by default (MODUS_LOCAL_TOOL_FILTER unset)", () => {
    vi.stubEnv("MODUS_LOCAL_TOOL_FILTER", "");
    const importRanker = vi.fn();
    expect(startLocalModels("/tmp/user-data", undefined, importRanker)).toBeUndefined();
    expect(importRanker).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("flag on: prepares the shared ranker in the background, never throws", async () => {
    const prepare = vi.fn(async () => ({ state: "idle" as const }));
    const getLocalToolRanker = vi.fn(() => ({ prepare }));
    await startLocalModels(
      "/tmp/user-data",
      () => true,
      async () => ({ getLocalToolRanker }) as never,
    );
    expect(getLocalToolRanker).toHaveBeenCalledWith("/tmp/user-data");
    expect(prepare).toHaveBeenCalledTimes(1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      startLocalModels(
        "/tmp/user-data",
        () => true,
        async () => {
          throw new Error("boom");
        },
      ),
    ).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
