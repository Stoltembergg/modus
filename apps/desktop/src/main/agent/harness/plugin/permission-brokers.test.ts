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

describe("ShellBroker fail-closed execution policy", () => {
  it("fails closed until a platform-isolated shell executor is integrated", () => {
    const audit = { log: vi.fn() } as unknown as SecurityAuditLogger;
    const broker = new ShellBroker(audit);
    const permissions: ExtendedPluginPermissions = {
      shell: { allow: ["git status"] },
      git: { allowStatus: true },
    };

    expect(broker.canExecute("git status", permissions, "synthetic-plugin")).toBe(false);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "shell.execute",
        decision: "deny",
        reason: expect.stringContaining("platform-isolated executor"),
      }),
    );
  });

  it.each([
    "echo safe",
    "git status",
    "npm test",
    "make test",
    "pkexec npm test",
    "run0 npm test",
    "unlisted-launcher --argument",
  ])("denies %s even under an exact grant without an executor", (command) => {
    const broker = createShellBroker();
    const permissions: ExtendedPluginPermissions = {
      shell: { allow: [command] },
      git: { allowStatus: true },
    };

    expect(broker.canExecute(command, permissions, "synthetic-plugin")).toBe(false);
  });
});
