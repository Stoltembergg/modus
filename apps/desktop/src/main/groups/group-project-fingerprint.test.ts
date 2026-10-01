import { describe, expect, it } from "vitest";
import {
  compareProjectFingerprints,
  computeProjectFingerprint,
  digestBytes,
  isProjectSetupManifestPath,
} from "./group-project-fingerprint";

describe("group project fingerprint", () => {
  it("is stable for the same branch, head, and manifests", () => {
    const input = {
      branch: "main",
      head: "abc123",
      manifests: [
        { path: "package.json", digest: digestBytes('{"name":"a"}') },
        { path: "Cargo.toml", digest: digestBytes("[package]") },
      ],
    };
    expect(computeProjectFingerprint(input)).toBe(computeProjectFingerprint(input));
    expect(computeProjectFingerprint(input)).toBe(
      computeProjectFingerprint({
        ...input,
        manifests: [...input.manifests].reverse(),
      }),
    );
  });

  it("changes when branch, head, or a manifest digest changes", () => {
    const base = {
      branch: "main",
      head: "abc",
      manifests: [{ path: "package.json", digest: digestBytes("one") }],
    };
    const baseHash = computeProjectFingerprint(base);
    expect(computeProjectFingerprint({ ...base, branch: "feat" })).not.toBe(baseHash);
    expect(computeProjectFingerprint({ ...base, head: "def" })).not.toBe(baseHash);
    expect(
      computeProjectFingerprint({
        ...base,
        manifests: [{ path: "package.json", digest: digestBytes("two") }],
      }),
    ).not.toBe(baseHash);
  });

  it("classifies match / partial / mismatch for incremental updates", () => {
    expect(
      compareProjectFingerprints({
        stored: "aaa",
        live: "aaa",
        storedBranch: "main",
        liveBranch: "main",
      }),
    ).toBe("match");
    expect(
      compareProjectFingerprints({
        stored: "aaa",
        live: "bbb",
        storedBranch: "main",
        liveBranch: "main",
      }),
    ).toBe("partial");
    expect(
      compareProjectFingerprints({
        stored: "aaa",
        live: "bbb",
        storedBranch: "main",
        liveBranch: "feat",
      }),
    ).toBe("mismatch");
  });

  it("recognizes setup manifest paths", () => {
    expect(isProjectSetupManifestPath("package.json")).toBe(true);
    expect(isProjectSetupManifestPath(".cursor/rules/foo.md")).toBe(true);
    expect(isProjectSetupManifestPath("src/main.ts")).toBe(false);
  });
});
