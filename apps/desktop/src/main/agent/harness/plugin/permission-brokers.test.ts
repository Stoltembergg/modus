import { describe, expect, it, vi } from "vitest";
import { FilesystemBroker, NetworkBroker, ShellBroker } from "./permission-brokers";
import type { ExtendedPluginPermissions } from "./plugin-isolation-types";
import type { SecurityAuditLogger } from "./security-audit-logger";

function createBroker(): NetworkBroker {
  return new NetworkBroker({ log: vi.fn() } as unknown as SecurityAuditLogger);
}

function createShellBroker(): ShellBroker {
  return new ShellBroker({ log: vi.fn() } as unknown as SecurityAuditLogger);
}

describe("NetworkBroker safe destination classification", () => {
  it("does not authorize even an exact public-domain grant without a pinned-I/O executor", () => {
    const audit = { log: vi.fn() } as unknown as SecurityAuditLogger;
    const broker = new NetworkBroker(audit);

    expect(
      broker.canConnect(
        "https://api.example.com/v1",
        { network: { domains: ["api.example.com"], ports: [443] } },
        "synthetic-plugin",
      ),
    ).toBe(false);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "network.connect",
        decision: "deny",
        reason: expect.stringContaining("DNS-pinned network executor"),
      }),
    );
  });

  it("distinguishes protected IPv6 ranges from public ranges denied for missing I/O", () => {
    const audit = { log: vi.fn() } as unknown as SecurityAuditLogger;
    const broker = new NetworkBroker(audit);
    const permissions: ExtendedPluginPermissions = { network: { domains: ["*"] } };

    expect(broker.canConnect("https://[3fff::1]/", permissions, "synthetic-plugin")).toBe(false);
    expect(audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        decision: "deny",
        reason: "Prohibited cloud metadata endpoint",
      }),
    );
    expect(broker.canConnect("https://[3fff:0fff::1]/", permissions, "synthetic-plugin")).toBe(
      false,
    );
    expect(broker.canConnect("https://[3fff:1000::1]/", permissions, "synthetic-plugin")).toBe(
      false,
    );
    expect(audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        decision: "deny",
        reason: "DNS-pinned network executor is unavailable",
      }),
    );
    expect(broker.canConnect("https://[64:ff9b:1::a00:1]/", permissions, "synthetic-plugin")).toBe(
      false,
    );
    expect(
      broker.canConnect("https://[64:ff9b:1::808:808]/", permissions, "synthetic-plugin"),
    ).toBe(false);
    expect(
      broker.canConnect("https://[64:ff9b::a9fe:a9fe]/", permissions, "synthetic-plugin"),
    ).toBe(false);
    expect(audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        decision: "deny",
        reason: "Prohibited cloud metadata endpoint",
      }),
    );
  });

  it("denies an explicitly matched global IPv6 destination without a pinned-I/O executor", () => {
    const broker = createBroker();
    const permissions: ExtendedPluginPermissions = {
      network: { domains: ["2606:4700:4700::1111"] },
    };

    expect(
      broker.canConnect("https://[2606:4700:4700::1111]/", permissions, "synthetic-plugin"),
    ).toBe(false);
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

describe("FilesystemBroker fail-closed authorization", () => {
  it("does not authorize in-scope reads or writes without a handle-bound executor", () => {
    const audit = { log: vi.fn() } as unknown as SecurityAuditLogger;
    const broker = new FilesystemBroker(audit);
    const permissions: ExtendedPluginPermissions = {
      filesystem: { read: ["."], write: ["."] },
    };

    expect(broker.canRead("package.json", permissions, "synthetic-plugin")).toBe(false);
    expect(broker.canWrite("package.json", permissions, "synthetic-plugin")).toBe(false);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "filesystem.read",
        decision: "deny",
        reason: expect.stringContaining("Handle-bound filesystem executor"),
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "filesystem.write",
        decision: "deny",
        reason: expect.stringContaining("Handle-bound filesystem executor"),
      }),
    );
  });
});
