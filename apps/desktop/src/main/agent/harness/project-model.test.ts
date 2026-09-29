import { describe, expect, it } from "vitest";
import { estimateProjectImpact } from "./project-model";

describe("project-model", () => {
  it("labels empty typed scope as unknown rather than inventing impact", () => {
    const estimate = estimateProjectImpact({ changedPaths: [] });
    expect(estimate.blastRadius).toBe("unknown");
    expect(estimate.confidence).toBe("unknown");
    expect(estimate.unknownReasons).toContain("no_typed_paths");
    expect(estimate.unknownReasons).toContain("missing_revision");
  });

  it("estimates local vs cross-module blast radius from typed paths", () => {
    const local = estimateProjectImpact({
      revision: "abc",
      changedPaths: ["apps/desktop/src/main/agent/runtime.ts"],
      codegraphHits: [{ path: "apps/desktop/src/main/agent/runtime.ts", symbol: "prompt" }],
    });
    expect(local.blastRadius).toBe("local");
    expect(local.confidence).not.toBe("unknown");

    const cross = estimateProjectImpact({
      revision: "def",
      changedPaths: [
        "apps/desktop/src/main/agent/runtime.ts",
        "apps/desktop/src/main/git/git-service.ts",
        "apps/desktop/src/renderer/src/App.tsx",
        "apps/desktop/src/shared/contracts.ts",
        "packages/core/src/index.ts",
        "crates/pty-host/src/main.rs",
        "docs/readme.md",
        "scripts/generate.mjs",
      ],
    });
    expect(cross.blastRadius).toBe("cross_module");
    expect(cross.reasonCodes).toContain("cross_module_scope");
  });
});
