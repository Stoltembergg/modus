/**
 * Modus Harness Evolution — Fase 11, 14 & 15: Plugin Lifecycle, Dependency Intelligence & Resilience CLI
 * CLI Command Handler for Plugin Management, Dependency Intelligence, Rollback and Safe Mode.
 * Supports: install, list, enable, disable, upgrade, downgrade, status, uninstall,
 * blast-radius, tree, plan-updates, rollback, safe-mode, diagnose, recover.
 */

import type { BlastRadius, PluginUpdate } from "./plugin-dependency-types";
import type { PluginLifecycleService, PluginStatusReport } from "./plugin-lifecycle-service";
import type { DiagnosisReport, RecoveryReport, SafeModeLevel } from "./plugin-rollback-types";
import type { PluginRecord } from "./plugin-state-store";
import type { PluginManifest } from "./plugin-types";
import { UpdatePlanner } from "./update-planner";
import {
  FastAstTokenizer,
  FastContextCompactor,
  FastVectorDistance,
} from "./wasm/wasm-accelerators";
import {
  buildAddModule,
  buildFuelLoopModule,
  buildMemoryModule,
} from "./wasm/wasm-bytecode-builder";
import { WasmCapabilityHost } from "./wasm/wasm-capability-host";

export interface CliExecutionResult {
  success: boolean;
  command: string;
  output: string;
  data?: unknown;
  error?: string;
}

export async function executePluginCli(
  args: string[],
  service: PluginLifecycleService,
): Promise<CliExecutionResult> {
  if (!args || args.length === 0) {
    return {
      success: false,
      command: "help",
      output: getHelpText(),
      error: "No command specified",
    };
  }

  const command = args[0]!.toLowerCase();
  const subArgs = args.slice(1);

  try {
    switch (command) {
      case "list":
      case "ls": {
        const enabledOnly = subArgs.includes("--enabled");
        const asJson = subArgs.includes("--json");
        const list = await service.list({ enabledOnly });

        let output = "";
        if (asJson) {
          output = JSON.stringify(list, null, 2);
        } else {
          output = formatPluginList(list);
        }

        return {
          success: true,
          command,
          output,
          data: list,
        };
      }

      case "status": {
        const pluginId = subArgs[0];
        if (!pluginId) {
          return {
            success: false,
            command,
            output: "Usage: modus plugin status <plugin-id>",
            error: "Missing plugin-id",
          };
        }

        const report = await service.status(pluginId);
        if (!report) {
          return {
            success: false,
            command,
            output: `Plugin '${pluginId}' not found`,
            error: "Plugin not found",
          };
        }

        const asJson = subArgs.includes("--json");
        return {
          success: true,
          command,
          output: asJson ? JSON.stringify(report, null, 2) : formatStatusReport(report),
          data: report,
        };
      }

      case "install": {
        const target = subArgs[0];
        if (!target) {
          return {
            success: false,
            command,
            output: "Usage: modus plugin install <plugin-id | manifest-json>",
            error: "Missing plugin target",
          };
        }

        let manifest: PluginManifest | undefined;

        // Try parsing JSON directly
        if (target.startsWith("{")) {
          try {
            manifest = JSON.parse(target) as PluginManifest;
          } catch {
            return {
              success: false,
              command,
              output: "Invalid JSON manifest provided",
              error: "Invalid JSON",
            };
          }
        } else {
          // Look up from service catalog
          manifest = service.resolveManifest(target);
        }

        if (!manifest) {
          return {
            success: false,
            command,
            output: `Cannot find or resolve manifest for plugin '${target}'`,
            error: "Manifest resolution failed",
          };
        }

        const installed = await service.install(manifest);
        return {
          success: true,
          command,
          output: `Plugin '${installed.id}' v${installed.version} installed successfully.`,
          data: installed,
        };
      }

      case "enable": {
        const pluginId = subArgs[0];
        if (!pluginId) {
          return {
            success: false,
            command,
            output: "Usage: modus plugin enable <plugin-id>",
            error: "Missing plugin-id",
          };
        }

        await service.enable(pluginId);
        return {
          success: true,
          command,
          output: `Plugin '${pluginId}' enabled successfully.`,
        };
      }

      case "disable": {
        const pluginId = subArgs[0];
        if (!pluginId) {
          return {
            success: false,
            command,
            output: "Usage: modus plugin disable <plugin-id>",
            error: "Missing plugin-id",
          };
        }

        await service.disable(pluginId);
        return {
          success: true,
          command,
          output: `Plugin '${pluginId}' disabled successfully.`,
        };
      }

      case "upgrade": {
        const target = subArgs[0];
        if (!target) {
          return {
            success: false,
            command,
            output: "Usage: modus plugin upgrade <plugin-id@version | manifest-json>",
            error: "Missing upgrade target",
          };
        }

        let manifest: PluginManifest | undefined;
        if (target.startsWith("{")) {
          manifest = JSON.parse(target) as PluginManifest;
        } else if (target.includes("@") && !target.startsWith("@")) {
          const [id, ver] = target.split("@");
          manifest = service.resolveManifest(id!, ver);
        } else {
          const lastAt = target.lastIndexOf("@");
          if (lastAt > 0) {
            const id = target.substring(0, lastAt);
            const ver = target.substring(lastAt + 1);
            manifest = service.resolveManifest(id, ver);
          } else {
            manifest = service.resolveManifest(target);
          }
        }

        if (!manifest) {
          return {
            success: false,
            command,
            output: `Cannot resolve upgrade manifest for '${target}'`,
            error: "Manifest resolution failed",
          };
        }

        await service.upgrade(manifest);
        return {
          success: true,
          command,
          output: `Plugin '${manifest.id}' upgraded to version ${manifest.version} successfully.`,
          data: manifest,
        };
      }

      case "downgrade":
      case "rollback": {
        let pluginId = subArgs[0];
        let targetVersion = subArgs[1];

        if (pluginId && !targetVersion && pluginId.includes("@")) {
          const lastAt = pluginId.lastIndexOf("@");
          if (lastAt > 0) {
            targetVersion = pluginId.substring(lastAt + 1);
            pluginId = pluginId.substring(0, lastAt);
          }
        }

        if (!pluginId) {
          return {
            success: false,
            command,
            output: `Usage: modus plugin ${command} <plugin-id> [target-version]`,
            error: "Missing arguments",
          };
        }

        // If targetVersion is not provided, look for latest backup version
        if (!targetVersion) {
          const latestBackup = await service.getVersionManager().getLatestBackup(pluginId);
          if (latestBackup) {
            targetVersion = latestBackup.version;
          }
        }

        if (!targetVersion) {
          return {
            success: false,
            command,
            output: `Cannot determine rollback target version for plugin '${pluginId}'.`,
            error: "Missing target version",
          };
        }

        await service.getVersionManager().rollback(pluginId, targetVersion);
        return {
          success: true,
          command,
          output: `Plugin '${pluginId}' rolled back to version ${targetVersion} successfully.`,
          data: { pluginId, targetVersion },
        };
      }

      case "safe-mode": {
        const sm = service.getSafeModeManager();

        if (subArgs.includes("--exit") || subArgs.includes("--disable")) {
          const res = await sm.exit();
          return {
            success: true,
            command,
            output: `Safe Mode disabled. Restored ${res.restoredPlugins.length} plugin(s).`,
            data: res,
          };
        }

        if (subArgs.includes("--status")) {
          const status = sm.getStatus();
          return {
            success: true,
            command,
            output: `Safe Mode status: ${status.active ? `ACTIVE (${status.level})` : "INACTIVE"}, Disabled: [${status.disabledPlugins.join(", ")}]`,
            data: status,
          };
        }

        const validLevels: SafeModeLevel[] = ["core", "official", "verified"];
        const requestedLevel = subArgs.find((a) => validLevels.includes(a as SafeModeLevel)) as
          | SafeModeLevel
          | undefined;
        const level: SafeModeLevel = requestedLevel ?? "core";

        const result = await sm.enter(level);
        const allowed = sm.getTrustLevelsForMode(level);

        const lines = [
          `Modus Safe Mode (${level})`,
          "──────────────────────────────────────────",
          `Loaded plugins with trust: ${allowed.join(", ")}`,
          result.disabledPlugins.length > 0
            ? `Disabled ${result.disabledPlugins.length} untrusted plugin(s): ${result.disabledPlugins.join(", ")}`
            : "All active plugins satisfy trust threshold.",
          "",
          "To exit Safe Mode:",
          "  modus plugin safe-mode --exit",
        ];

        return {
          success: true,
          command,
          output: lines.join("\n"),
          data: result,
        };
      }

      case "diagnose": {
        const asJson = subArgs.includes("--json");
        const report: DiagnosisReport = await service.getRecoveryManager().diagnose();

        let output = "";
        if (asJson) {
          output = JSON.stringify(report, null, 2);
        } else {
          output = formatDiagnosisReport(report);
        }

        return {
          success: true,
          command,
          output,
          data: report,
        };
      }

      case "recover": {
        const dryRun = subArgs.includes("--dry-run");
        const asJson = subArgs.includes("--json");
        const report: RecoveryReport = await service.getRecoveryManager().recover({ dryRun });

        let output = "";
        if (asJson) {
          output = JSON.stringify(report, null, 2);
        } else {
          const lines = [
            dryRun ? "Simulating Plugin Recovery (dry-run):" : "Plugin Recovery Execution:",
            "──────────────────────────────────────────",
          ];

          if (report.actions.length === 0) {
            lines.push("No actions required. System is healthy.");
          } else {
            for (const a of report.actions) {
              lines.push(`• ${a.pluginId} [${a.issueType}]: ${a.actionTaken} (${a.details ?? ""})`);
            }
          }

          lines.push("");
          lines.push(`Status: ${report.recovered ? "FULLY RECOVERED" : "ISSUES REMAINING"}`);
          if (report.remainingIssues.length > 0) {
            lines.push(`Remaining issues: ${report.remainingIssues.length}`);
          }

          output = lines.join("\n");
        }

        return {
          success: true,
          command,
          output,
          data: report,
        };
      }

      case "uninstall": {
        const force = subArgs.includes("--force");
        const filtered = subArgs.filter((a) => a !== "--force");
        const pluginId = filtered[0];
        if (!pluginId) {
          return {
            success: false,
            command,
            output: "Usage: modus plugin uninstall <plugin-id> [--force]",
            error: "Missing plugin-id",
          };
        }

        await service.uninstall(pluginId, { force });
        return {
          success: true,
          command,
          output: `Plugin '${pluginId}' uninstalled successfully.`,
        };
      }

      case "blast-radius": {
        const asJson = subArgs.includes("--json");
        const filtered = subArgs.filter((a) => a !== "--json");
        const pluginId = filtered[0];
        if (!pluginId) {
          return {
            success: false,
            command,
            output: "Usage: modus plugin blast-radius <plugin-id> [--json]",
            error: "Missing plugin-id",
          };
        }

        const blast = service.getDependencyGraph().calculateBlastRadius(pluginId);
        return {
          success: true,
          command,
          output: asJson ? JSON.stringify(blast, null, 2) : formatBlastRadius(blast),
          data: blast,
        };
      }

      case "tree":
      case "dependencies": {
        const output = service.getDependencyGraph().visualize();
        return {
          success: true,
          command,
          output,
          data: service.getDependencyGraph().getAllPlugins(),
        };
      }

      case "plan-updates": {
        const asJson = subArgs.includes("--json");
        const rawTargets = subArgs.filter((a) => !a.startsWith("--"));

        if (rawTargets.length === 0) {
          return {
            success: false,
            command,
            output: "Usage: modus plugin plan-updates <plugin@targetVersion...> [--json]",
            error: "Missing update targets: specify at least one target plugin update",
          };
        }

        const targets: PluginUpdate[] = [];
        for (const item of rawTargets) {
          const lastAt = item.lastIndexOf("@");
          if (lastAt > 0) {
            const pluginId = item.substring(0, lastAt);
            const targetVersion = item.substring(lastAt + 1);
            const current = service.getStore().getPlugin(pluginId);
            targets.push({
              pluginId,
              currentVersion: current ? current.version : "0.0.0",
              targetVersion,
            });
          } else {
            const current = service.getStore().getPlugin(item);
            targets.push({
              pluginId: item,
              currentVersion: current ? current.version : "0.0.0",
              targetVersion: "latest",
            });
          }
        }

        const planner = new UpdatePlanner();
        const plan = planner.planUpdates(targets, service.getDependencyGraph());
        let output = "";
        if (asJson) {
          output = JSON.stringify(plan, null, 2);
        } else {
          output = [
            "Update plan:",
            ...plan.phases.map(
              (phase, i) =>
                `Phase ${i + 1} (${phase.length > 1 ? "parallel" : "sequential"}):\n` +
                phase
                  .map((u) => `  • ${u.pluginId} ${u.currentVersion} → ${u.targetVersion}`)
                  .join("\n"),
            ),
            "",
            `Estimated duration: ${plan.estimatedDurationSec} seconds`,
          ].join("\n");
        }

        return {
          success: true,
          command,
          output,
          data: plan,
        };
      }

      case "wasm": {
        const wasmAction = subArgs[0]?.toLowerCase();
        const target = subArgs[1];
        const asJson = subArgs.includes("--json");

        if (wasmAction === "inspect") {
          if (!target) {
            return {
              success: false,
              command,
              output:
                "Usage: modus plugin wasm inspect <vector|compactor|tokenizer|fuel|add|<file.wasm>> [--json]",
              error: "Missing target",
            };
          }

          let bytes: Uint8Array;
          if (target === "vector" || target === "tokenizer") {
            bytes = buildMemoryModule(2);
          } else if (target === "compactor") {
            bytes = buildMemoryModule(1);
          } else if (target === "add") {
            bytes = buildAddModule();
          } else if (target === "fuel") {
            bytes = buildFuelLoopModule();
          } else {
            const nodeFs = await import("node:fs");
            bytes = new Uint8Array(nodeFs.readFileSync(target));
          }

          const wasmHost = new WasmCapabilityHost();
          const module = await wasmHost.compileModule(bytes, target);
          const inspection = wasmHost.inspectModule(module);

          let output = "";
          if (asJson) {
            output = JSON.stringify(inspection, null, 2);
          } else {
            output = [
              `WASM Module Inspection: ${target}`,
              "──────────────────────────────────────────",
              `Exported Functions: ${inspection.exportedFunctions.join(", ") || "none"}`,
              `Exported Globals: ${inspection.exportedGlobals.join(", ") || "none"}`,
              `Imported Modules: ${inspection.importedModules.map((m) => `${m.module}.${m.name} (${m.kind})`).join(", ") || "none"}`,
              `WASI Detected: ${inspection.wasiDetected ? "YES" : "NO"}`,
            ].join("\n");
          }

          return {
            success: true,
            command,
            output,
            data: inspection,
          };
        }

        if (wasmAction === "benchmark") {
          const runsIdx = subArgs.indexOf("--runs");
          const runs =
            runsIdx !== -1 && subArgs[runsIdx + 1] ? parseInt(subArgs[runsIdx + 1]!, 10) : 1000;
          const benchTarget = target ?? "vector";

          let avgLatencyMs = 0;
          let details: Record<string, unknown> = {};

          if (benchTarget === "vector") {
            const v1 = new Float32Array(384).fill(0.5);
            const v2 = new Float32Array(384).fill(0.4);
            const start = performance.now();
            for (let i = 0; i < runs; i++) {
              FastVectorDistance.compute(v1, v2);
            }
            const totalMs = performance.now() - start;
            avgLatencyMs = totalMs / runs;
            details = {
              target: "FastVectorDistance (384 dims)",
              runs,
              avgLatencyMs,
              opsPerSec: Math.round(runs / (totalMs / 1000)),
            };
          } else if (benchTarget === "compactor") {
            const sample = "Line 1\n\n\nLine 2   \n\nLine 3\n";
            const start = performance.now();
            for (let i = 0; i < runs; i++) {
              FastContextCompactor.compact(sample);
            }
            const totalMs = performance.now() - start;
            avgLatencyMs = totalMs / runs;
            details = {
              target: "FastContextCompactor",
              runs,
              avgLatencyMs,
              opsPerSec: Math.round(runs / (totalMs / 1000)),
            };
          } else if (benchTarget === "tokenizer") {
            const code = "function add(a, b) { return a + b; }";
            const start = performance.now();
            for (let i = 0; i < runs; i++) {
              FastAstTokenizer.tokenize(code);
            }
            const totalMs = performance.now() - start;
            avgLatencyMs = totalMs / runs;
            details = {
              target: "FastAstTokenizer",
              runs,
              avgLatencyMs,
              opsPerSec: Math.round(runs / (totalMs / 1000)),
            };
          } else {
            const wasmHost = new WasmCapabilityHost();
            const bytes = buildAddModule();
            const { instance } = await wasmHost.createInstance(bytes);
            const start = performance.now();
            for (let i = 0; i < runs; i++) {
              instance.invoke("add", 10, 20);
            }
            const totalMs = performance.now() - start;
            avgLatencyMs = totalMs / runs;
            details = {
              target: "WASM add(10, 20)",
              runs,
              avgLatencyMs,
              opsPerSec: Math.round(runs / (totalMs / 1000)),
            };
          }

          let output = "";
          if (asJson) {
            output = JSON.stringify(details, null, 2);
          } else {
            output = [
              `WASM / Accelerator Benchmark: ${benchTarget}`,
              "──────────────────────────────────────────",
              `Runs: ${runs}`,
              `Average Latency: ${avgLatencyMs.toFixed(6)} ms (< 0.2ms SLO: ${avgLatencyMs < 0.2 ? "PASSED" : "FAILED"})`,
              `Throughput: ${(details.opsPerSec as number).toLocaleString()} ops/sec`,
            ].join("\n");
          }

          return {
            success: true,
            command,
            output,
            data: details,
          };
        }

        return {
          success: false,
          command,
          output: "Usage: modus plugin wasm <inspect|benchmark> <target> [--runs <n>] [--json]",
          error: "Unknown wasm subcommand",
        };
      }

      default:
        return {
          success: false,
          command,
          output: `Unknown command '${command}'.\n${getHelpText()}`,
          error: "Unknown command",
        };
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      command,
      output: `Error executing 'modus plugin ${command}': ${errorMsg}`,
      error: errorMsg,
    };
  }
}

function getHelpText(): string {
  return [
    "Modus Plugin CLI — Usage:",
    "  modus plugin list [--enabled] [--json]",
    "  modus plugin status <plugin-id> [--json]",
    "  modus plugin install <plugin-id | manifest-json>",
    "  modus plugin enable <plugin-id>",
    "  modus plugin disable <plugin-id>",
    "  modus plugin upgrade <plugin-id@version | manifest-json>",
    "  modus plugin downgrade <plugin-id> <version>",
    "  modus plugin rollback <plugin-id> [version]",
    "  modus plugin uninstall <plugin-id> [--force]",
    "  modus plugin blast-radius <plugin-id> [--json]",
    "  modus plugin tree",
    "  modus plugin plan-updates [--json]",
    "  modus plugin safe-mode [core|official|verified] [--exit|--status]",
    "  modus plugin diagnose [--json]",
    "  modus plugin recover [--dry-run] [--json]",
    "  modus plugin wasm inspect <target> [--json]",
    "  modus plugin wasm benchmark <target> [--runs <n>] [--json]",
  ].join("\n");
}

function formatPluginList(plugins: PluginRecord[]): string {
  if (plugins.length === 0) {
    return "No plugins found.";
  }

  const rows = plugins.map(
    (p) => `${p.id.padEnd(30)} ${p.version.padEnd(10)} ${p.state.padEnd(12)} ${p.trust_level}`,
  );

  return [
    `${"ID".padEnd(30)} ${"VERSION".padEnd(10)} ${"STATE".padEnd(12)} TRUST_LEVEL`,
    "-".repeat(70),
    ...rows,
  ].join("\n");
}

function formatStatusReport(report: PluginStatusReport): string {
  const lines: string[] = [
    `Plugin: ${report.id} (v${report.version})`,
    `State: ${report.state} (Runtime: ${report.runtimeStatus ?? "none"})`,
    `Trust Level: ${report.trustLevel}`,
    `Installed At: ${report.installedAt}`,
    `Last Enabled: ${report.lastEnabled ?? "never"}`,
    `Capabilities: ${report.capabilities.map((c) => `${c.capability_id} (${c.api_version})`).join(", ") || "none"}`,
    `Available Versions: ${report.availableVersions.join(", ") || report.version}`,
    `Recent Events:`,
    ...report.recentEvents.slice(0, 5).map((e) => `  - [${e.timestamp}] ${e.event_type}`),
  ];

  return lines.join("\n");
}

function formatBlastRadius(blast: BlastRadius): string {
  const lines: string[] = [
    `Removing ${blast.targetPluginId} would affect:`,
    "",
    "Direct dependents:",
  ];

  if (blast.directDependents.length === 0) {
    lines.push("  (none)");
  } else {
    for (const dep of blast.directDependents) {
      lines.push(`  • ${dep}`);
    }
  }

  lines.push("");
  lines.push("Transitive dependents:");
  if (blast.transitiveDependents.length === 0) {
    lines.push("  (none)");
  } else {
    for (const t of blast.transitiveDependents) {
      lines.push(`  • ${t.pluginId} (via ${t.via.join(" -> ")})`);
    }
  }

  lines.push("");
  lines.push(
    `Total affected: ${blast.totalAffected} plugin${blast.totalAffected === 1 ? "" : "s"}`,
  );
  lines.push(`Severity: ${blast.severity.toUpperCase()}`);

  if (blast.critical) {
    lines.push("");
    lines.push("This plugin is critical to dependent operations.");
    lines.push("Consider disabling instead of uninstalling, or use --force to override.");
  }

  return lines.join("\n");
}

function formatDiagnosisReport(report: DiagnosisReport): string {
  const lines: string[] = ["Plugin System Diagnosis", "──────────────────────────────────────────"];

  if (report.healthy) {
    lines.push("All plugins and dependencies are healthy. No issues detected.");
    return lines.join("\n");
  }

  for (const issue of report.issues) {
    lines.push(`✗ ${issue.pluginId}`);
    lines.push(`  Type: ${issue.type}`);
    lines.push(`  Severity: ${issue.severity.toUpperCase()}`);
    if (issue.error) {
      lines.push(`  Error: ${issue.error}`);
    }
    if (issue.missing && issue.missing.length > 0) {
      lines.push(`  Missing dependencies: ${issue.missing.join(", ")}`);
    }
    if (issue.cycle && issue.cycle.length > 0) {
      lines.push(`  Circular cycle: ${issue.cycle.join(" -> ")}`);
    }
    lines.push(`  Recommendation: ${issue.recommendation}`);
    lines.push("");
  }

  lines.push(`Found ${report.issues.length} issue(s).`);
  lines.push("Run 'modus plugin recover' to attempt automatic fixes.");

  return lines.join("\n");
}
