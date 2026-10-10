import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiSdkRuntime } from "../../pi-sdk-runtime";
import {
  resetFeatureFlagOverrides,
  setFeatureFlagOverrides,
  validateFeatureFlags,
} from "../feature-flags";
import { CredentialGuard } from "./credential-guard";
import { FilesystemBroker, GitBroker, NetworkBroker, ShellBroker } from "./permission-brokers";
import { PluginIsolationHost } from "./plugin-isolation-host";
import { type ExtendedPluginPermissions, PermissionDeniedError } from "./plugin-isolation-types";
import { SecurityAuditLogger } from "./security-audit-logger";

describe("Fase 13 — Plugin Isolation & Security", () => {
  beforeEach(() => {
    resetFeatureFlagOverrides();
    SecurityAuditLogger.resetInstance();
  });

  afterEach(() => {
    resetFeatureFlagOverrides();
    SecurityAuditLogger.resetInstance();
  });

  describe("13.1 — Cryptographic Security Audit Logger", () => {
    it("creates chained SHA-256 entries linking to previous hashes", () => {
      const logger = SecurityAuditLogger.getInstance();

      const e1 = logger.log({
        pluginId: "@modus/test",
        action: "filesystem.read",
        resource: "config.json",
        decision: "allow",
      });

      const e2 = logger.log({
        pluginId: "@modus/test",
        action: "network.connect",
        resource: "https://api.modus.local",
        decision: "deny",
        reason: "Untrusted domain",
      });

      expect(e1.previousHash).toBe("0".repeat(64));
      expect(e1.hash).toHaveLength(64);
      expect(e2.previousHash).toBe(e1.hash);
      expect(e2.hash).toHaveLength(64);

      const verification = logger.verifyChain();
      expect(verification.valid).toBe(true);
    });

    it("detects tampering when an audit entry hash or payload is modified", () => {
      const logger = SecurityAuditLogger.getInstance();

      logger.log({
        pluginId: "@modus/plugin-a",
        action: "shell.execute",
        resource: "ls",
        decision: "allow",
      });

      logger.log({
        pluginId: "@modus/plugin-b",
        action: "git.push",
        resource: "origin main",
        decision: "deny",
      });

      // Tamper with an entry in memory to simulate malicious modification
      const entries = logger.getEntries();
      const firstEntry = entries[0]!;
      firstEntry.resource = "cat /etc/shadow";

      // Chain verification must fail
      const verification = logger.verifyChain();
      expect(verification.valid).toBe(false);
      expect(verification.reason).toContain("Tampering detected");
    });

    it("filters audit entries by action, decision, or pluginId", () => {
      const logger = SecurityAuditLogger.getInstance();

      logger.log({ pluginId: "p1", action: "filesystem.read", resource: "a", decision: "allow" });
      logger.log({ pluginId: "p1", action: "filesystem.write", resource: "b", decision: "deny" });
      logger.log({ pluginId: "p2", action: "network.connect", resource: "c", decision: "allow" });

      expect(logger.getEntries({ pluginId: "p1" }).length).toBe(2);
      expect(logger.getEntries({ decision: "deny" }).length).toBe(1);
      expect(logger.getEntries({ action: "network.connect" }).length).toBe(1);
    });
  });

  describe("13.2 — Credential Guard", () => {
    it("identifies sensitive credential files and private keys", () => {
      expect(CredentialGuard.isSensitivePath(".env")).toBe(true);
      expect(CredentialGuard.isSensitivePath(".env.production")).toBe(true);
      expect(CredentialGuard.isSensitivePath("id_rsa")).toBe(true);
      expect(CredentialGuard.isSensitivePath("id_ed25519")).toBe(true);
      expect(CredentialGuard.isSensitivePath("keys/server.key")).toBe(true);
      expect(CredentialGuard.isSensitivePath("certs/cert.pem")).toBe(true);
      expect(CredentialGuard.isSensitivePath(".aws/credentials")).toBe(true);
      expect(CredentialGuard.isSensitivePath(".ssh/authorized_keys")).toBe(true);

      expect(CredentialGuard.isSensitivePath("src/main.ts")).toBe(false);
      expect(CredentialGuard.isSensitivePath("readme.md")).toBe(false);
    });

    it("identifies sensitive environment variable names", () => {
      expect(CredentialGuard.isSensitiveEnvKey("OPENAI_API_KEY")).toBe(true);
      expect(CredentialGuard.isSensitiveEnvKey("ANTHROPIC_KEY")).toBe(true);
      expect(CredentialGuard.isSensitiveEnvKey("AWS_ACCESS_KEY_ID")).toBe(true);
      expect(CredentialGuard.isSensitiveEnvKey("GITHUB_TOKEN")).toBe(true);
      expect(CredentialGuard.isSensitiveEnvKey("DB_PASSWORD")).toBe(true);
      expect(CredentialGuard.isSensitiveEnvKey("JWT_SECRET")).toBe(true);

      expect(CredentialGuard.isSensitiveEnvKey("NODE_ENV")).toBe(false);
      expect(CredentialGuard.isSensitiveEnvKey("PORT")).toBe(false);
    });

    it("filters environment dictionaries, stripping all sensitive variables unless whitelisted", () => {
      const rawEnv = {
        NODE_ENV: "production",
        PORT: "3000",
        OPENAI_API_KEY: "sk-secret-1234",
        GITHUB_TOKEN: "ghp_secret_token",
        ALLOWED_CUSTOM_KEY: "secret-but-explicitly-allowed",
      };

      const sanitized = CredentialGuard.filterEnv(rawEnv, ["ALLOWED_CUSTOM_KEY"]);
      expect(sanitized["NODE_ENV"]).toBe("production");
      expect(sanitized["PORT"]).toBe("3000");
      expect(sanitized["ALLOWED_CUSTOM_KEY"]).toBe("secret-but-explicitly-allowed");
      expect(sanitized["OPENAI_API_KEY"]).toBeUndefined();
      expect(sanitized["GITHUB_TOKEN"]).toBeUndefined();
    });

    it("masks secret values properly", () => {
      expect(CredentialGuard.maskSecret("sk-proj-1234567890")).toBe("sk-...890");
      expect(CredentialGuard.maskSecret("short")).toBe("******");
    });
  });

  describe("13.3 — Permission Brokers", () => {
    describe("FilesystemBroker", () => {
      it("blocks access to sensitive credentials even if in declared read scope", () => {
        const broker = new FilesystemBroker();
        const perms: ExtendedPluginPermissions = {
          filesystem: { read: ["."] },
        };

        expect(broker.canRead(".env", perms, "community-plugin")).toBe(false);
        expect(broker.canRead(".ssh/id_rsa", perms, "community-plugin")).toBe(false);
      });

      it("permits reading within declared read scopes and blocks out-of-scope files", () => {
        const broker = new FilesystemBroker();
        const perms: ExtendedPluginPermissions = {
          filesystem: {
            read: ["src", "public"],
            write: ["temp"],
          },
        };

        expect(broker.canRead("src/index.ts", perms, "plugin-a")).toBe(true);
        expect(broker.canRead("public/logo.png", perms, "plugin-a")).toBe(true);
        expect(broker.canRead("secrets/config.json", perms, "plugin-a")).toBe(false);

        expect(broker.canWrite("temp/output.txt", perms, "plugin-a")).toBe(true);
        expect(broker.canWrite("src/index.ts", perms, "plugin-a")).toBe(false);
      });

      it("throws PermissionDeniedError when readFile or writeFile violates permissions", async () => {
        const broker = new FilesystemBroker();
        const perms: ExtendedPluginPermissions = {
          filesystem: { read: ["allowed"] },
        };

        await expect(broker.readFile("forbidden/file.txt", perms, "p1")).rejects.toThrow(
          PermissionDeniedError,
        );
        await expect(broker.writeFile("forbidden/file.txt", "data", perms, "p1")).rejects.toThrow(
          PermissionDeniedError,
        );
      });
    });

    describe("NetworkBroker", () => {
      it("blocks cloud metadata IPs unconditionally", () => {
        const broker = new NetworkBroker();
        const perms: ExtendedPluginPermissions = {
          network: { domains: ["*"] },
        };

        expect(broker.canConnect("http://169.254.169.254/latest/meta-data", perms)).toBe(false);
        expect(broker.canConnect("http://metadata.google.internal/computeMetadata/v1", perms)).toBe(
          false,
        );
      });

      it("blocks localhost unless allowLocalhost is enabled", () => {
        const broker = new NetworkBroker();
        const permsNoLocalhost: ExtendedPluginPermissions = {
          network: { domains: ["localhost", "127.0.0.1"] },
        };
        const permsWithLocalhost: ExtendedPluginPermissions = {
          network: { domains: ["localhost", "127.0.0.1"], allowLocalhost: true },
        };

        expect(broker.canConnect("http://localhost:8080/api", permsNoLocalhost)).toBe(false);
        expect(broker.canConnect("http://127.0.0.1:3000", permsNoLocalhost)).toBe(false);
        expect(broker.canConnect("http://localhost:8080/api", permsWithLocalhost)).toBe(true);
      });

      it("validates destination domain against domain whitelist and wildcards", () => {
        const broker = new NetworkBroker();
        const perms: ExtendedPluginPermissions = {
          network: { domains: ["api.modus.org", "*.service.io"] },
        };

        expect(broker.canConnect("https://api.modus.org/v1", perms)).toBe(true);
        expect(broker.canConnect("https://sub.service.io/data", perms)).toBe(true);
        expect(broker.canConnect("https://evil.attacker.com", perms)).toBe(false);
      });
    });

    describe("ShellBroker", () => {
      it("blocks dangerous system destruction commands", () => {
        const broker = new ShellBroker();
        const perms: ExtendedPluginPermissions = {
          shell: { allow: ["rm", "shutdown", "format"] },
        };

        expect(broker.canExecute("rm -rf /", perms)).toBe(false);
        expect(broker.canExecute("shutdown /s", perms)).toBe(false);
        expect(broker.canExecute("format c:", perms)).toBe(false);
      });

      it("enforces command allow and deny lists", () => {
        const broker = new ShellBroker();
        const perms: ExtendedPluginPermissions = {
          shell: {
            allow: ["git", "npm"],
            deny: ["npm publish", "git push"],
          },
        };

        expect(broker.canExecute("git status", perms)).toBe(true);
        expect(broker.canExecute("npm test", perms)).toBe(true);
        expect(broker.canExecute("git push origin main", perms)).toBe(false);
        expect(broker.canExecute("npm publish", perms)).toBe(false);
        expect(broker.canExecute("curl http://malicious.com", perms)).toBe(false);
      });
    });

    describe("GitBroker", () => {
      it("prohibits git push without explicit allowPush permission", () => {
        const broker = new GitBroker();
        const permsNoPush: ExtendedPluginPermissions = {
          git: { allowPush: false },
        };
        const permsWithPush: ExtendedPluginPermissions = {
          git: { allowPush: true },
        };

        expect(broker.canPerform("push", permsNoPush, "p1")).toBe(false);
        expect(broker.canPerform("status", permsNoPush, "p1")).toBe(true);
        expect(broker.canPerform("push", permsWithPush, "p1")).toBe(true);
      });
    });
  });

  describe("13.4 — Plugin Isolation Host", () => {
    it("fails closed when OS-backed isolation is unavailable", async () => {
      const host = new PluginIsolationHost();
      let implementationCalled = false;

      const response = await host.executeIsolated({
        pluginId: "@community/text-helper",
        capability: "text.reverse",
        context: { text: "hello" },
        implementation: () => {
          implementationCalled = true;
          return "must not execute in the host process";
        },
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain("OS-backed plugin isolation is unavailable");
      expect(response.latencyMs).toBeGreaterThanOrEqual(0);
      expect(implementationCalled).toBe(false);

      const auditEntries = host.getAuditLogger().getEntries({ pluginId: "@community/text-helper" });
      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0]?.decision).toBe("deny");
    });

    it("does not call an untrusted implementation when returning a denial", async () => {
      const host = new PluginIsolationHost();
      let implementationCalled = false;

      const response = await host.executeIsolated({
        pluginId: "@community/flaky",
        capability: "data.process",
        context: {},
        implementation: () => {
          implementationCalled = true;
          return "must not execute";
        },
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain("OS-backed plugin isolation is unavailable");
      expect(implementationCalled).toBe(false);

      const auditEntries = host.getAuditLogger().getEntries({ pluginId: "@community/flaky" });
      expect(auditEntries.length).toBe(1);
      expect(auditEntries[0]?.decision).toBe("deny");
    });

    it("does not treat caller-supplied core trust as execution authority", async () => {
      const host = new PluginIsolationHost();
      let implementationCalled = false;
      const response = await host.executeIsolated({
        pluginId: "@community/forged-core",
        capability: "core.replace",
        trustLevel: "core",
        context: {},
        implementation: () => {
          implementationCalled = true;
          return "must not execute";
        },
      } as Parameters<typeof host.executeIsolated>[0]);

      expect(response.success).toBe(false);
      expect(response.error).toContain("OS-backed plugin isolation is unavailable");
      expect(implementationCalled).toBe(false);
    });

    it("does not instantiate WASM through the unisolated plugin facade", async () => {
      const host = new PluginIsolationHost();
      const response = await host.executeWasm({
        pluginId: "@community/wasm-helper",
        wasmBytes: new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
        functionName: "unused",
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain("OS-backed plugin isolation is unavailable");
      expect(
        host.getAuditLogger().getEntries({ pluginId: "@community/wasm-helper" }),
      ).toMatchObject([{ action: "wasm.execute.unused", decision: "deny" }]);
    });
  });

  describe("13.5 — PiSdkRuntime Integration & Feature Flags", () => {
    it("validates feature flag dependencies for MODUS_PLUGIN_ISOLATION", () => {
      const errors = validateFeatureFlags({
        MODUS_USE_KERNEL: true,
        MODUS_PLUGIN_ISOLATION: true,
        MODUS_PLUGINS: false,
      });
      expect(errors).toContain("MODUS_PLUGIN_ISOLATION requires MODUS_PLUGINS to be enabled");

      const kernelErrors = validateFeatureFlags({
        MODUS_USE_KERNEL: false,
        MODUS_PLUGIN_ISOLATION: true,
      });
      expect(kernelErrors).toContain(
        "MODUS_PLUGIN_ISOLATION requires MODUS_USE_KERNEL to be enabled",
      );
    });

    it("initializes PluginIsolationHost and SecurityAuditLogger in PiSdkRuntime when flag enabled", () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_CAPABILITY_REGISTRY: true,
        MODUS_PLUGINS: true,
        MODUS_PLUGIN_ISOLATION: true,
      });

      const runtime = new PiSdkRuntime();
      expect(runtime.getPluginIsolationHost()).toBeDefined();
      expect(runtime.getSecurityAuditLogger()).toBeDefined();
    });
  });

  describe("13.6 — Fase 13 review regressions: adversarial bypass hardening", () => {
    it("detects credential files with Windows trailing dots/spaces and name variants", () => {
      // Windows strips trailing dots/spaces: ".env " opens the same file as ".env".
      expect(CredentialGuard.isSensitivePath(".env ")).toBe(true);
      expect(CredentialGuard.isSensitivePath(".env.")).toBe(true);
      expect(CredentialGuard.isSensitivePath("C:\\secrets\\.ssh\\id_rsa ")).toBe(true);
      expect(CredentialGuard.isSensitivePath("tokens.json")).toBe(true);
      expect(CredentialGuard.isSensitivePath("credential")).toBe(true);
      // Non-sensitive names stay allowed.
      expect(CredentialGuard.isSensitivePath("src/main.ts")).toBe(false);
    });

    it("denies symlink escapes planted inside the declared scope", () => {
      const root = mkdtempSync(join(tmpdir(), "modus-fsprobe-"));
      try {
        const outside = join(root, "outside");
        const scope = join(root, "scope");
        mkdirSync(outside, { recursive: true });
        mkdirSync(scope, { recursive: true });
        writeFileSync(join(outside, "secret.txt"), "x");
        symlinkSync(outside, join(scope, "linkdir"), "junction");
        const broker = new FilesystemBroker(undefined as any, scope);
        const perms: ExtendedPluginPermissions = { filesystem: { read: ["."] } };
        expect(broker.canRead("linkdir/secret.txt", perms, "p1")).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("blocks obfuscated loopback IPs even with an open domain whitelist", () => {
      const broker = new NetworkBroker();
      const perms: ExtendedPluginPermissions = { network: { domains: ["*"] } };
      expect(broker.canConnect("http://0x7f.0.0.1/", perms)).toBe(false);
      expect(broker.canConnect("http://2130706433/", perms)).toBe(false);
      expect(broker.canConnect("http://localhost./", perms)).toBe(false);
    });

    it("requires token boundary on allow-list prefixes and rejects empty entries", () => {
      const broker = new ShellBroker();
      expect(broker.canExecute("github-evil --steal", { shell: { allow: ["git"] } })).toBe(false);
      expect(broker.canExecute("anything at all", { shell: { allow: [""] } })).toBe(false);
      // Legit prefix uses keep working.
      expect(broker.canExecute("git status", { shell: { allow: ["git"] } })).toBe(true);
    });

    it("catches home-wipe spellings through an allowed rm", () => {
      const broker = new ShellBroker();
      const perms: ExtendedPluginPermissions = { shell: { allow: ["rm"] } };
      expect(broker.canExecute("rm -rf $HOME", perms)).toBe(false);
      expect(broker.canExecute("rm -rf ~", perms)).toBe(false);
      // Scoped legitimate use (relative path, no absolute root) still allow-listed.
      expect(broker.canExecute("rm -rf tmp/cache", perms)).toBe(true);
    });
  });
});
