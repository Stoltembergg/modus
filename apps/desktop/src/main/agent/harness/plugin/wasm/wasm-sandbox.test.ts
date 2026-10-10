/**
 * @file wasm-sandbox.test.ts
 * Comprehensive test suite for Fase 19 — High-Performance Sandboxing (WASM & Micro-VMs).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
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
  buildImportedMemoryModule,
  buildImportedMemoryStartTrapModule,
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
  WasmMemoryPolicyError,
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

      try {
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
      } finally {
        instance.dispose();
      }
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

      try {
        // run 10 iterations (needs 10 fuel)
        const res = instance.invoke("run_loop", 10);
        expect(res).toBe(0);
        expect(instance.fuelMeter.getConsumedFuel()).toBeGreaterThanOrEqual(10n);
      } finally {
        instance.dispose();
      }
    });

    it("throws WasmFuelExhaustedError and cleanly interrupts infinite/runaway loop", async () => {
      const bytes = buildFuelLoopModule();

      // Give 25 fuel units, but request 1000 iterations
      const { instance } = await wasmHost.createInstance(bytes, {
        pluginId: "@test/runaway-plugin",
        fuel: { initialFuel: 25n },
      });

      try {
        expect(() => {
          instance.invoke("run_loop", 1000);
        }).toThrow(WasmFuelExhaustedError);

        expect(instance.fuelMeter.getRemainingFuel()).toBe(0n);
      } finally {
        instance.dispose();
      }
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
    it("reports the module-owned memory instead of an unused host allocation", async () => {
      const bytes = buildMemoryModule(1, 2);
      const { instance } = await wasmHost.createInstance(bytes, {
        memory: { initialPages: 2, maxPages: 2 },
      });

      try {
        expect(instance.getMemoryPagesUsed()).toBe(1);
        expect(instance.growMemory(1)).toBe(1);
        expect(instance.getMemoryPagesUsed()).toBe(2);
      } finally {
        instance.dispose();
      }
    });

    it("manages linear memory with allocation, string write, and string read", async () => {
      const bytes = buildMemoryModule(2); // 2 pages = 128KB
      const { instance } = await wasmHost.createInstance(bytes);

      try {
        expect(instance.getMemoryPagesUsed()).toBe(2);
        expect(instance.getMemoryBytesUsed()).toBe(131072);

        const writtenLen = instance.writeString(100, "Hello from Modus WASM Sandbox!");
        const readBack = instance.readString(100, writtenLen);
        expect(readBack).toBe("Hello from Modus WASM Sandbox!");
      } finally {
        instance.dispose();
      }
    });

    it("throws WasmMemoryOutOfBoundsError when accessing beyond allocated pages", async () => {
      const bytes = buildMemoryModule(1); // 1 page = 64KB (65536 bytes)
      const { instance } = await wasmHost.createInstance(bytes, {
        pluginId: "@test/memory-plugin",
      });

      try {
        expect(() => {
          // Attempt to write beyond 65536
          instance.writeBytes(65500, new Uint8Array(100));
        }).toThrow(WasmMemoryOutOfBoundsError);
      } finally {
        instance.dispose();
      }
    });

    it("rejects a module whose declared maximum exceeds the configured per-instance cap", async () => {
      await expect(
        wasmHost.createInstance(buildMemoryModule(1, 3), {
          memory: { initialPages: 1, maxPages: 2 },
        }),
      ).rejects.toThrow(WasmMemoryPolicyError);
    });

    it("rejects a linear memory without an enforceable maximum", async () => {
      await expect(wasmHost.createInstance(buildMemoryModule(1, null))).rejects.toThrow(
        /must declare a maximum page count/,
      );
    });

    it("validates the same byte snapshot that was compiled", async () => {
      const host = new WasmCapabilityHost({ maxMemoryPagesPerInstance: 2 });
      const bytes = buildMemoryModule(1, 3);
      const originalCompile = host.compileModule.bind(host);
      let signalCompiled: () => void = () => {};
      let continueCompile: () => void = () => {};
      const compiled = new Promise<void>((resolve) => {
        signalCompiled = resolve;
      });
      const continueCompilation = new Promise<void>((resolve) => {
        continueCompile = resolve;
      });

      vi.spyOn(host, "compileModule").mockImplementation(async (input, cacheKey) => {
        const module = await originalCompile(input, cacheKey);
        signalCompiled();
        await continueCompilation;
        return module;
      });

      const pendingInstance = host.createInstance(bytes);
      await compiled;
      const memorySection = bytes.findIndex(
        (_, index) =>
          bytes[index] === 0x05 &&
          bytes[index + 1] === 0x04 &&
          bytes[index + 2] === 0x01 &&
          bytes[index + 3] === 0x01 &&
          bytes[index + 4] === 0x01 &&
          bytes[index + 5] === 0x03,
      );
      expect(memorySection).toBeGreaterThanOrEqual(0);
      bytes[memorySection + 5] = 0x02;
      continueCompile();

      try {
        await expect(pendingInstance).rejects.toThrow(WasmMemoryPolicyError);
      } finally {
        const created = await pendingInstance.catch(() => undefined);
        created?.instance.dispose();
      }
    });

    it("accounts imported memory against the aggregate cap and releases it on dispose", async () => {
      const host = new WasmCapabilityHost({
        maxMemoryPagesPerInstance: 2,
        maxAggregateMemoryPages: 2,
      });
      const bytes = buildImportedMemoryModule(1, 2);
      const { instance } = await host.createInstance(bytes, {
        memory: { initialPages: 1, maxPages: 2 },
      });

      const ownProperties = Object.getOwnPropertyNames(instance);
      expect(ownProperties).not.toContain("wasmInstance");
      expect(ownProperties).not.toContain("memory");
      expect(ownProperties).not.toContain("releaseMemoryReservation");
      expect(host.getReservedMemoryPages()).toBe(2);
      await expect(
        host.createInstance(bytes, { memory: { initialPages: 1, maxPages: 2 } }),
      ).rejects.toThrow(/Aggregate linear memory limit/);

      instance.dispose();
      expect(host.getReservedMemoryPages()).toBe(0);
      expect(instance.getMemoryPagesUsed()).toBe(0);
      expect(() => instance.growMemory(1)).toThrow(/disposed/);
      const replacement = await host.createInstance(bytes, {
        memory: { initialPages: 1, maxPages: 2 },
      });
      replacement.instance.dispose();
    });

    it("releases reserved memory after executeWasm returns", async () => {
      const host = new WasmCapabilityHost({ maxMemoryPagesPerInstance: 2 });
      const result = await host.executeWasm(buildMemoryModule(1, 2), "missing_function");

      expect(result.success).toBe(false);
      expect(host.getReservedMemoryPages()).toBe(0);
    });

    it("preserves actual memory metrics when a call fails after instantiation", async () => {
      const result = await wasmHost.executeWasm(buildMemoryModule(1, 2), "missing_function");

      expect(result.success).toBe(false);
      expect(result.metrics.memoryPagesUsed).toBe(1);
      expect(result.metrics.memoryBytesUsed).toBe(65536);
      expect(wasmHost.getReservedMemoryPages()).toBe(0);
    });

    it("reports available imported memory after a bounded start function traps", async () => {
      const result = await wasmHost.executeWasm(
        buildImportedMemoryStartTrapModule(),
        "never_called",
        [],
        { memory: { initialPages: 1, maxPages: 2 } },
      );

      expect(result.success).toBe(false);
      expect(result.metrics.memoryUsageAvailable).toBe(true);
      expect(result.metrics.memoryPagesUsed).toBe(2);
      expect(result.metrics.memoryBytesUsed).toBe(131072);
      expect(wasmHost.getReservedMemoryPages()).toBe(0);
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
    it.each([
      "wasi_snapshot_preview1",
      "wasi_unstable",
      "wasi_snapshot_preview2",
      "wasi:cli/run@0.2.0",
    ])("rejects WASI imports from %s when the host has no grant policy", async (moduleName) => {
      const encode = (value: string) => {
        const bytes = new TextEncoder().encode(value);
        return [bytes.length, ...bytes];
      };
      const typeSection = [1, 0x60, 1, 0x7f, 0]; // (i32) -> ()
      const importSection = [1, ...encode(moduleName), ...encode("proc_exit"), 0, 0];
      const bytes = Uint8Array.from([
        0x00,
        0x61,
        0x73,
        0x6d,
        0x01,
        0x00,
        0x00,
        0x00,
        1,
        typeSection.length,
        ...typeSection,
        2,
        importSection.length,
        ...importSection,
      ]);
      const instantiate = vi
        .spyOn(WebAssembly, "instantiate")
        .mockRejectedValue(new Error("WASM instantiation sentinel"));

      try {
        await expect(wasmHost.createInstance(bytes)).rejects.toThrow(
          "WASI imports are not authorized by the host",
        );
        await expect(wasmHost.createInstance(bytes, { wasi: { enabled: false } })).rejects.toThrow(
          "WASI imports are not authorized by the host",
        );
        await expect(
          wasmHost.createInstance(bytes, {
            wasi: {
              enabled: true,
              env: { MODUS_TEST_SECRET: "caller supplied" },
              preopens: { "/": "." },
            },
          }),
        ).rejects.toThrow("WASI imports are not authorized by the host");
        expect(instantiate).not.toHaveBeenCalled();
      } finally {
        instantiate.mockRestore();
      }
    });

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
    it("blocks WASM through PluginIsolationHost until OS-backed isolation exists", async () => {
      const audit = SecurityAuditLogger.getInstance();
      audit.clear();

      const host = new PluginIsolationHost({ auditLogger: audit });
      const bytes = buildAddModule();

      const res = await host.executeWasm<number>({
        pluginId: "@external/fast-math",
        wasmBytes: bytes,
        functionName: "add",
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain("OS-backed plugin isolation is unavailable");
      expect(res.latencyMs).toBeDefined();

      const entries = audit.getEntries({ pluginId: "@external/fast-math" });
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0]?.decision).toBe("deny");
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
