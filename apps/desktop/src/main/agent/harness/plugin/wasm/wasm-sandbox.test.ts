/**
 * @file wasm-sandbox.test.ts
 * Comprehensive test suite for Fase 19 — High-Performance Sandboxing (WASM & Micro-VMs).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../../capability/capability-registry";
import {
  isFeatureFlagEnabled,
  resetFeatureFlagsOverride,
  setFeatureFlagsOverride,
  validateFeatureFlags,
} from "../../feature-flags";
import { executePluginCli } from "../plugin-cli";
import { PluginIsolationHost } from "../plugin-isolation-host";
import { PluginLifecycleService } from "../plugin-lifecycle-service";
import { PluginLoader } from "../plugin-loader";
import { PluginStateStore } from "../plugin-state-store";
import { SecurityAuditLogger } from "../security-audit-logger";
import {
  buildAddModule,
  buildFuelLoopModule,
  buildMemoryModule,
  FastAstTokenizer,
  FastContextCompactor,
  FastVectorDistance,
  WasiSandbox,
  WasmCapabilityHost,
  WasmCompilationError,
  WasmFuelExhaustedError,
  WasmFuelMeter,
  WasmMemoryOutOfBoundsError,
} from "./index";

describe("Fase 19 — High-Performance Sandboxing (WASM & Micro-VMs)", () => {
  let wasmHost: WasmCapabilityHost;

  beforeEach(() => {
    wasmHost = new WasmCapabilityHost();
    resetFeatureFlagsOverride();
  });

  describe("19.1 — Compilation, Module Inspection & Caching", () => {
    it("compiles valid WASM bytecode and caches module by SHA-256", async () => {
      const bytes = buildAddModule();
      const mod1 = await wasmHost.compileModule(bytes);
      const mod2 = await wasmHost.compileModule(bytes);

      expect(mod1).toBe(mod2); // Reused from cache
    });

    it("rejects malformed WASM bytecode with WasmCompilationError", async () => {
      const corruptBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x99, 0x99]);

      await expect(wasmHost.compileModule(corruptBytes, "corrupt-mod")).rejects.toThrow(
        WasmCompilationError,
      );
    });

    it("inspects exported functions, globals, imports, and WASI status", async () => {
      const loopBytes = buildFuelLoopModule();
      const module = await wasmHost.compileModule(loopBytes);
      const inspection = wasmHost.inspectModule(module);

      expect(inspection.exportedFunctions).toContain("run_loop");
      expect(inspection.importedModules.length).toBeGreaterThan(0);
      expect(inspection.importedModules[0]?.module).toBe("env");
      expect(inspection.importedModules[0]?.name).toBe("consume_fuel");
    });
  });

  describe("19.2 — Sub-Millisecond Execution SLO (< 0.2ms)", () => {
    it("executes WASM function with sub-millisecond latency (< 0.2ms)", async () => {
      const bytes = buildAddModule();
      const { instance } = await wasmHost.createInstance(bytes);

      const result = instance.invoke("add", 15, 27);
      expect(result).toBe(42);

      // Microbenchmark: 1,000 runs
      const runs = 1000;
      const start = performance.now();
      for (let i = 0; i < runs; i++) {
        instance.invoke("add", i, i + 1);
      }
      const totalMs = performance.now() - start;
      const avgLatencyMs = totalMs / runs;

      // Must be well below 0.2ms (typically < 0.001ms)
      expect(avgLatencyMs).toBeLessThan(0.2);
    });

    it("executes via executeWasm returning typed metrics and latency", async () => {
      const bytes = buildAddModule();
      const res = await wasmHost.executeWasm<unknown, number>(bytes, "add", [100, 200]);

      expect(res.success).toBe(true);
      expect(res.result).toBe(300);
      expect(res.metrics.latencyMs).toBeLessThan(15.0); // Full instantiation + run < 15ms
    });
  });

  describe("19.3 — Instruction / Fuel Metering & Loop Protection", () => {
    it("completes loop execution when fuel budget is sufficient", async () => {
      const bytes = buildFuelLoopModule();

      const { instance } = await wasmHost.createInstance(bytes, {
        fuel: { initialFuel: 50n },
      });

      // run 10 iterations (needs 10 fuel)
      const res = instance.invoke("run_loop", 10);
      expect(res).toBe(0);
      expect(instance.fuelMeter.getConsumedFuel()).toBeGreaterThanOrEqual(10n);
    });

    it("throws WasmFuelExhaustedError and cleanly interrupts infinite/runaway loop", async () => {
      const bytes = buildFuelLoopModule();

      // Give 25 fuel units, but request 1000 iterations
      const { instance } = await wasmHost.createInstance(bytes, {
        pluginId: "@test/runaway-plugin",
        fuel: { initialFuel: 25n },
      });

      expect(() => {
        instance.invoke("run_loop", 1000);
      }).toThrow(WasmFuelExhaustedError);

      expect(instance.fuelMeter.getRemainingFuel()).toBe(0n);
    });

    it("captures fuel exhaustion gracefully in executeWasm without crashing host", async () => {
      const bytes = buildFuelLoopModule();

      const res = await wasmHost.executeWasm(bytes, "run_loop", [500], {
        pluginId: "@test/loop-plugin",
        fuel: { initialFuel: 20n },
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain("fuel exhausted");
    });
  });

  describe("19.4 — Linear Memory Bounds & Isolation", () => {
    it("manages linear memory with allocation, string write, and string read", async () => {
      const bytes = buildMemoryModule(2); // 2 pages = 128KB
      const { instance } = await wasmHost.createInstance(bytes);

      expect(instance.getMemoryPagesUsed()).toBe(2);
      expect(instance.getMemoryBytesUsed()).toBe(131072);

      const writtenLen = instance.writeString(100, "Hello from Modus WASM Sandbox!");
      const readBack = instance.readString(100, writtenLen);
      expect(readBack).toBe("Hello from Modus WASM Sandbox!");
    });

    it("throws WasmMemoryOutOfBoundsError when accessing beyond allocated pages", async () => {
      const bytes = buildMemoryModule(1); // 1 page = 64KB (65536 bytes)
      const { instance } = await wasmHost.createInstance(bytes, {
        pluginId: "@test/memory-plugin",
      });

      expect(() => {
        // Attempt to write beyond 65536
        instance.writeBytes(65500, new Uint8Array(100));
      }).toThrow(WasmMemoryOutOfBoundsError);
    });
  });

  describe("19.5 — High-Throughput Capability Accelerators (< 0.2ms)", () => {
    it("FastVectorDistance: computes cosine similarity and distances in < 0.1ms", () => {
      const dim = 384;
      const v1 = new Float32Array(dim).fill(0.3);
      const v2 = new Float32Array(dim).fill(0.3);

      // Warmup
      FastVectorDistance.compute(v1, v2);

      const result = FastVectorDistance.compute(v1, v2);

      expect(result.cosineSimilarity).toBeCloseTo(1.0, 5);
      expect(result.euclideanDistance).toBeCloseTo(0.0, 5);
      expect(result.latencyMs).toBeLessThan(0.1);
    });

    it("FastContextCompactor: compresses context text and collapses blank lines in < 0.1ms", () => {
      const text = [
        "# Context Header",
        "",
        "",
        "This is content with whitespace.    ",
        "",
        "",
        "Another line.",
      ].join("\n");

      const result = FastContextCompactor.compact(text);

      expect(result.compactedText).toContain(
        "# Context Header\n\nThis is content with whitespace.\n\nAnother line.",
      );
      expect(result.reductionPercentage).toBeGreaterThan(0);
      expect(result.latencyMs).toBeLessThan(0.1);
    });

    it("FastAstTokenizer: scans source code tokens in < 0.2ms", () => {
      const source = `
        import { createServer } from 'http';
        export async function startApp(port: number) {
          const server = createServer();
          if (port > 8000) {
            return server.listen(port);
          }
        }
      `;

      // Warmup
      FastAstTokenizer.tokenize(source);

      const stats = FastAstTokenizer.tokenize(source);

      expect(stats.totalTokens).toBeGreaterThan(15);
      expect(stats.keywordsCount).toBeGreaterThan(3);
      expect(stats.identifiersCount).toBeGreaterThan(5);
      expect(stats.latencyMs).toBeLessThan(0.2);
    });
  });

  describe("19.6 — WASI Sandbox Environment", () => {
    it("initializes WASI sandbox and provides preview1 imports", () => {
      const wasi = new WasiSandbox({
        args: ["test-arg"],
        env: { MODUS_ENV: "sandbox" },
        preopens: { "/workspace": "." },
      });

      const imports = wasi.getImportObject();
      expect(imports.wasi_snapshot_preview1).toBeDefined();
    });
  });

  describe("19.7 — PluginIsolationHost & Feature Flags Integration", () => {
    it("executes WASM capabilities through PluginIsolationHost with audit logs", async () => {
      const audit = SecurityAuditLogger.getInstance();
      audit.clear();

      const host = new PluginIsolationHost({ auditLogger: audit });
      const bytes = buildAddModule();

      const res = await host.executeWasm<number>({
        pluginId: "@external/fast-math",
        wasmBytes: bytes,
        functionName: "add",
        args: [77, 33],
      });

      expect(res.success).toBe(true);
      expect(res.result).toBe(110);
      expect(res.latencyMs).toBeDefined();

      const entries = audit.getEntries({ pluginId: "@external/fast-math" });
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0]?.decision).toBe("allow");
      expect(entries[0]?.action).toBe("wasm.execute.add");
    });

    it("honors and validates MODUS_PLUGIN_WASM_SANDBOX feature flag", () => {
      setFeatureFlagsOverride({
        MODUS_USE_KERNEL: true,
        MODUS_CAPABILITY_REGISTRY: true,
        MODUS_PLUGINS: true,
        MODUS_PLUGIN_WASM_SANDBOX: true,
      });

      expect(isFeatureFlagEnabled("MODUS_PLUGIN_WASM_SANDBOX")).toBe(true);
      expect(validateFeatureFlags()).toEqual([]);

      // Invalid config: wasm sandbox without plugins flag
      setFeatureFlagsOverride({
        MODUS_USE_KERNEL: true,
        MODUS_PLUGINS: false,
        MODUS_PLUGIN_WASM_SANDBOX: true,
      });

      const errors = validateFeatureFlags();
      expect(errors).toContain("MODUS_PLUGIN_WASM_SANDBOX requires MODUS_PLUGINS to be enabled");
    });
  });

  describe("19.8 — CLI Integration (wasm inspect & benchmark)", () => {
    let service: PluginLifecycleService;

    beforeEach(() => {
      const store = new PluginStateStore(":memory:");
      const registry = new CapabilityRegistry();
      const loader = new PluginLoader(registry);
      service = new PluginLifecycleService(store, loader, registry);
    });

    it("executes `modus plugin wasm inspect` for accelerators", async () => {
      const res = await executePluginCli(["wasm", "inspect", "vector"], service);

      expect(res.success).toBe(true);
      expect(res.output).toContain("WASM Module Inspection: vector");
      expect(res.output).toContain("Exported Functions");
    });

    it("executes `modus plugin wasm benchmark` demonstrating < 0.2ms SLO pass", async () => {
      const res = await executePluginCli(["wasm", "benchmark", "vector", "--runs", "500"], service);

      expect(res.success).toBe(true);
      expect(res.output).toContain("< 0.2ms SLO: PASSED");
    });

    it("outputs JSON when `--json` is supplied to wasm subcommands", async () => {
      const res = await executePluginCli(["wasm", "inspect", "compactor", "--json"], service);

      expect(res.success).toBe(true);
      const parsed = JSON.parse(res.output);
      expect(parsed.exportedFunctions).toBeDefined();
    });
  });
});
