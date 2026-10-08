import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

describe("Pi SDK extension containment", () => {
  it("does not import project or agent-directory extensions when disabled", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "modus-pi-project-"));
    const agentDir = await mkdtemp(join(tmpdir(), "modus-pi-agent-"));
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const projectMarker = `modusProjectExtension${suffix}`;
    const agentMarker = `modusAgentExtension${suffix}`;
    const global = globalThis as Record<string, unknown>;
    const approvedFactory = vi.fn() as unknown as ExtensionFactory;

    try {
      const projectExtensions = join(cwd, ".pi", "extensions");
      const agentExtensions = join(agentDir, "extensions");
      await mkdir(projectExtensions, { recursive: true });
      await mkdir(agentExtensions, { recursive: true });
      await writeFile(
        join(projectExtensions, "sentinel.js"),
        `globalThis[${JSON.stringify(projectMarker)}] = true;`,
      );
      await writeFile(
        join(agentExtensions, "sentinel.js"),
        `globalThis[${JSON.stringify(agentMarker)}] = true;`,
      );

      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        noExtensions: true,
        extensionFactories: [approvedFactory],
        settingsManager: SettingsManager.inMemory(),
      });
      await loader.reload();

      expect(global[projectMarker]).toBeUndefined();
      expect(global[agentMarker]).toBeUndefined();
      expect(approvedFactory).toHaveBeenCalledTimes(1);
    } finally {
      delete global[projectMarker];
      delete global[agentMarker];
      await Promise.all([
        rm(cwd, { recursive: true, force: true }),
        rm(agentDir, { recursive: true, force: true }),
      ]);
    }
  });
});
