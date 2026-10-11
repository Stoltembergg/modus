import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("Linux worker packaging contract", () => {
  it("builds and bundles the fixed supervisor and worker binaries together", () => {
    const workspace = source("../../../Cargo.toml");
    const buildScript = source("./build-plugin-supervisor.mjs");
    const builderConfig = source("../electron-builder.config.ts");
    const ciWorkflow = source("../../../.github/workflows/ci.yml");
    const releaseWorkflow = source("../../../.github/workflows/release.yml");

    expect(workspace).toContain('"crates/plugin-execution-worker"');
    expect(buildScript).toContain('"modus-plugin-execution-worker"');
    expect(buildScript).toContain('"modus-plugin-worker"');
    expect(builderConfig).toMatch(
      /\.\.\.\(process\.platform === "linux"\s*\? \[[\s\S]*?modus-plugin-worker[\s\S]*?\]\s*:\s*\[\]\)/,
    );
    expect(builderConfig).toContain("../../target/release/modus-plugin-worker");
    expect(builderConfig).toContain('to: "bin/modus-plugin-worker"');
    expect(ciWorkflow).toContain("cargo test --locked -p modus-plugin-execution-worker");
    expect(ciWorkflow).toContain(
      "-p modus-plugin-execution-supervisor -p modus-plugin-execution-worker",
    );
    expect(releaseWorkflow).toContain('"crates/plugin-execution-worker/**"');
  });
});
