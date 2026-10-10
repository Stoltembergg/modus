import { describe, expect, it, vi } from "vitest";
import { NetworkBroker, ShellBroker } from "./permission-brokers";
import type { ExtendedPluginPermissions } from "./plugin-isolation-types";
import type { SecurityAuditLogger } from "./security-audit-logger";

function createBroker(): NetworkBroker {
  return new NetworkBroker({ log: vi.fn() } as unknown as SecurityAuditLogger);
}

function createShellBroker(): ShellBroker {
  return new ShellBroker({ log: vi.fn() } as unknown as SecurityAuditLogger);
}

describe("NetworkBroker safe destination classification", () => {
  it("blocks documentation and local-use NAT64 IPv6 ranges without connecting", () => {
    const broker = createBroker();
    const permissions: ExtendedPluginPermissions = { network: { domains: ["*"] } };

    expect(broker.canConnect("https://[3fff::1]/", permissions, "synthetic-plugin")).toBe(false);
    expect(broker.canConnect("https://[3fff:0fff::1]/", permissions, "synthetic-plugin")).toBe(
      false,
    );
    expect(broker.canConnect("https://[3fff:1000::1]/", permissions, "synthetic-plugin")).toBe(
      true,
    );
    expect(broker.canConnect("https://[64:ff9b:1::a00:1]/", permissions, "synthetic-plugin")).toBe(
      false,
    );
    expect(
      broker.canConnect("https://[64:ff9b:1::808:808]/", permissions, "synthetic-plugin"),
    ).toBe(false);
  });

  it("continues to allow an explicitly matched global IPv6 destination", () => {
    const broker = createBroker();
    const permissions: ExtendedPluginPermissions = {
      network: { domains: ["2606:4700:4700::1111"] },
    };

    expect(
      broker.canConnect("https://[2606:4700:4700::1111]/", permissions, "synthetic-plugin"),
    ).toBe(true);
  });
});

describe("ShellBroker nested package execution policy", () => {
  it("denies package managers and shell wrappers even when the command is allow-listed", () => {
    const broker = createShellBroker();
    const permissions: ExtendedPluginPermissions = {
      shell: {
        allow: [
          "npm",
          "npm test",
          "npm.cmd test",
          '"npm" test',
          "command npm test",
          "exec npm test",
          "call npm test",
          "start npm test",
          "Start-Process npm test",
          "builtin npm test",
          "sudo npm test",
          "timeout 5 npm test",
          "time npm test",
          "nice npm test",
          "nohup npm test",
          "setsid npm test",
          "FOO=1 npm test",
          "n\\pm test",
          "npx",
          "npx vitest run",
          "npx.cmd vitest run",
          "'npx' vitest run",
          '"C:\\Program Files\\nodejs\\npm.cmd" test',
          "pnpm",
          "pnpm exec tsc",
          "pnpm.cmd exec tsc",
          "bunx vitest run",
          "yarn",
          "yarn test",
          "yarn.cmd test",
          "yarnpkg test",
          "corepack",
          "corepack npm test",
          "corepack.cmd npm test",
        ],
      },
    };

    for (const command of [
      "npm test",
      "npm.cmd test",
      '"npm" test',
      "command npm test",
      "exec npm test",
      "call npm test",
      "start npm test",
      "Start-Process npm test",
      "builtin npm test",
      "sudo npm test",
      "timeout 5 npm test",
      "time npm test",
      "nice npm test",
      "nohup npm test",
      "setsid npm test",
      "FOO=1 npm test",
      "n\\pm test",
      "npx vitest run",
      "npx.cmd vitest run",
      "'npx' vitest run",
      '"C:\\Program Files\\nodejs\\npm.cmd" test',
      "pnpm exec tsc",
      "pnpm.cmd exec tsc",
      "bunx vitest run",
      "yarn test",
      "yarn.cmd test",
      "yarnpkg test",
      "corepack npm test",
      "corepack.cmd npm test",
    ]) {
      expect(broker.canExecute(command, permissions, "synthetic-plugin"), command).toBe(false);
    }
  });
});
