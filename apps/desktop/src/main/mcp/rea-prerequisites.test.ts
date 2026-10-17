import { describe, expect, it } from "vitest";
import {
  checkReaPrerequisites,
  isSupportedNodeVersion,
  REA_SUPPORTED_NODE_RANGE,
} from "./rea-prerequisites";

describe("REA prerequisite checks", () => {
  it("accepts only the pinned package's supported Node range", () => {
    for (const version of ["v22.19.0", "22.19.1", "v24.11.0", "v24.30.2", "v26.0.0", "v30.1.2"]) {
      expect(isSupportedNodeVersion(version)).toBe(true);
    }
    for (const version of [
      "v22.18.0",
      "v24.10.9",
      "v20.11.0",
      "v23.5.0",
      "v25.0.0",
      "not-a-version",
      "",
    ]) {
      expect(isSupportedNodeVersion(version)).toBe(false);
    }
  });

  it("reports needs_node with the supported range when Node is missing", async () => {
    const result = await checkReaPrerequisites({
      run: async (command) => {
        if (command === "node") throw new Error("spawn node ENOENT");
        return "1.0.0";
      },
    });
    expect(result).toMatchObject({ ok: false, status: "needs_node" });
    if (!result.ok) {
      expect(result.note).toContain(REA_SUPPORTED_NODE_RANGE);
      expect(result.note).not.toMatch(/(?:[A-Z]:\\|\/home\/|\/Users\/)/);
    }
  });

  it("reports needs_node with the found version when Node is unsupported", async () => {
    const result = await checkReaPrerequisites({ run: async () => "v23.4.0" });
    expect(result).toMatchObject({ ok: false, status: "needs_node" });
    if (!result.ok) {
      expect(result.note).toContain("v23.4.0");
      expect(result.note).toContain(REA_SUPPORTED_NODE_RANGE);
    }
  });

  it("reports needs_node when npm is missing even with a supported Node", async () => {
    const result = await checkReaPrerequisites({
      run: async (command) => {
        if (command === "npm") throw new Error("spawn npm ENOENT");
        return "v24.21.0";
      },
    });
    expect(result).toMatchObject({ ok: false, status: "needs_node" });
    if (!result.ok) expect(result.note).toContain(REA_SUPPORTED_NODE_RANGE);
  });

  it("passes when Node and npm are both available and supported", async () => {
    const seen: string[] = [];
    const result = await checkReaPrerequisites({
      run: async (command) => {
        seen.push(command);
        return command === "node" ? "v24.21.0" : "11.19.0";
      },
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual(["node", "npm"]);
  });
});
