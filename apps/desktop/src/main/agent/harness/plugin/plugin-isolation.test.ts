import { createHash } from "node:crypto";
import fs, { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  let auditDatabase: DatabaseSync;

  beforeEach(() => {
    resetFeatureFlagOverrides();
    SecurityAuditLogger.resetInstance();
    auditDatabase = new DatabaseSync(":memory:");
    SecurityAuditLogger.getInstance({ database: auditDatabase });
  });

  afterEach(() => {
    resetFeatureFlagOverrides();
    SecurityAuditLogger.resetInstance();
    auditDatabase.close();
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

    it("does not expose mutable audit entries to callers", () => {
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

      // Public reads are snapshots; callers cannot mutate the stored evidence.
      const entries = logger.getEntries();
      const firstEntry = entries[0];
      expect(firstEntry).toBeDefined();
      if (!firstEntry) throw new Error("Expected a retained audit entry.");
      expect(() => {
        firstEntry.resource = "modified synthetic resource";
      }).toThrow();

      const verification = logger.verifyChain();
      expect(verification.valid).toBe(true);
      expect(logger.getEntries()[0]?.resource).toBe("ls");
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

    it("restores the audit chain from SQLite after logger recreation", () => {
      const logger = SecurityAuditLogger.getInstance();
      const entry = logger.log({
        pluginId: "@modus/restart-fixture",
        action: "capability.deny",
        resource: "synthetic-capability",
        decision: "deny",
        timestamp: 10,
      });

      SecurityAuditLogger.resetInstance();
      const restored = SecurityAuditLogger.getInstance({ database: auditDatabase });

      expect(restored.getEntries()).toEqual([entry]);
      expect(restored.verifyChain()).toEqual({ valid: true });
    });

    it("bounds retained rows and verifies the chain from its durable checkpoint", () => {
      const logger = new SecurityAuditLogger({ database: auditDatabase, maxEntries: 2 });
      for (let index = 0; index < 3; index++) {
        logger.log({
          pluginId: "@modus/bounded-fixture",
          action: "capability.deny",
          resource: `synthetic-${index}`,
          decision: "deny",
          timestamp: index + 1,
        });
      }

      expect(logger.getEntries().map((entry) => entry.resource)).toEqual([
        "synthetic-1",
        "synthetic-2",
      ]);
      expect(
        (
          auditDatabase.prepare("select count(*) as count from security_audit_events").get() as {
            count: number;
          }
        ).count,
      ).toBe(2);
      expect(logger.verifyChain()).toEqual({ valid: true });

      const restored = new SecurityAuditLogger({ database: auditDatabase, maxEntries: 2 });
      expect(restored.getEntries().map((entry) => entry.resource)).toEqual([
        "synthetic-1",
        "synthetic-2",
      ]);
      expect(restored.verifyChain()).toEqual({ valid: true });
    });

    it("refuses to claim a security decision when durable append fails", () => {
      const database = new DatabaseSync(":memory:");
      const logger = new SecurityAuditLogger({ database });
      database.close();

      expect(() =>
        logger.log({
          pluginId: "@modus/persistence-fixture",
          action: "capability.deny",
          resource: "synthetic-capability",
          decision: "deny",
        }),
      ).toThrow();
      expect(logger.getEntries()).toEqual([]);
    });

    it("rejects an oversized audit record before persisting it", () => {
      const logger = SecurityAuditLogger.getInstance();

      expect(() =>
        logger.log({
          pluginId: "@modus/bounds-fixture",
          action: "capability.deny",
          resource: "x".repeat(9_000),
          decision: "deny",
        }),
      ).toThrow("Security audit entry exceeds supported bounds");
      expect(logger.getEntries()).toEqual([]);
    });

    it("detects a persisted payload change and refuses later appends", () => {
      const directory = mkdtempSync(join(tmpdir(), "modus-audit-tamper-"));
      const databasePath = join(directory, "audit.sqlite");
      const database = new DatabaseSync(databasePath);
      const logger = new SecurityAuditLogger({ database });
      try {
        logger.log({
          pluginId: "@modus/tamper-fixture",
          action: "capability.deny",
          resource: "original synthetic resource",
          decision: "deny",
        });
        const tamperDatabase = new DatabaseSync(databasePath);
        try {
          tamperDatabase
            .prepare("update security_audit_events set resource = ? where sequence = 1")
            .run("changed synthetic resource");
        } finally {
          tamperDatabase.close();
        }

        expect(() =>
          logger.log({
            pluginId: "@modus/tamper-fixture",
            action: "capability.deny",
            resource: "later synthetic resource",
            decision: "deny",
          }),
        ).toThrow("Security audit chain is unavailable");
        expect(logger.verifyChain().valid).toBe(false);
      } finally {
        database.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("detects a persisted record ID change before a later append", () => {
      const directory = mkdtempSync(join(tmpdir(), "modus-audit-id-tamper-"));
      const databasePath = join(directory, "audit.sqlite");
      const database = new DatabaseSync(databasePath);
      const logger = new SecurityAuditLogger({ database });
      try {
        logger.log({
          pluginId: "@modus/id-tamper-fixture",
          action: "capability.deny",
          resource: "synthetic-resource",
          decision: "deny",
        });
        const tamperDatabase = new DatabaseSync(databasePath);
        try {
          tamperDatabase
            .prepare("update security_audit_events set id = ? where sequence = 1")
            .run("synthetic-replaced-id");
        } finally {
          tamperDatabase.close();
        }

        expect(() =>
          logger.log({
            pluginId: "@modus/id-tamper-fixture",
            action: "capability.deny",
            resource: "later synthetic resource",
            decision: "deny",
          }),
        ).toThrow("Security audit chain is unavailable");
      } finally {
        database.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("detects audit-row changes made on its own SQLite connection before appending", () => {
      const logger = SecurityAuditLogger.getInstance();
      logger.log({
        pluginId: "@modus/same-connection-tamper-fixture",
        action: "capability.deny",
        resource: "original synthetic resource",
        decision: "deny",
      });
      auditDatabase
        .prepare("update security_audit_events set resource = ? where sequence = 1")
        .run("changed synthetic resource");

      expect(() =>
        logger.log({
          pluginId: "@modus/same-connection-tamper-fixture",
          action: "capability.deny",
          resource: "later synthetic resource",
          decision: "deny",
        }),
      ).toThrow("Security audit chain is unavailable");
    });

    it("detects a checkpoint change on its own SQLite connection before appending", () => {
      const logger = SecurityAuditLogger.getInstance();
      auditDatabase
        .prepare("update security_audit_state set anchor_hash = ? where singleton = 1")
        .run("f".repeat(64));

      expect(() =>
        logger.log({
          pluginId: "@modus/checkpoint-tamper-fixture",
          action: "capability.deny",
          resource: "synthetic resource",
          decision: "deny",
        }),
      ).toThrow("Audit log was changed by another writer");
    });

    it("migrates an existing audit database without losing its retained chain", () => {
      const database = new DatabaseSync(":memory:");
      database.exec(`
        create table security_audit_state (
          singleton integer primary key check (singleton = 1),
          anchor_hash text not null,
          latest_hash text not null,
          next_sequence integer not null check (next_sequence >= 1)
        );
        create table security_audit_events (
          sequence integer primary key,
          id text not null unique,
          timestamp integer not null,
          plugin_id text not null,
          action text not null,
          resource text not null,
          decision text not null check (decision in ('allow','deny')),
          reason text not null,
          hash text not null,
          previous_hash text not null
        );
      `);
      const previousHash = "0".repeat(64);
      const id = "legacy-audit-row";
      const entry = {
        sequence: 1,
        id,
        previousHash,
        timestamp: 1,
        pluginId: "@modus/legacy-fixture",
        action: "capability.deny",
        resource: "legacy synthetic record",
        decision: "deny",
        reason: "",
      } as const;
      const hash = createHash("sha256")
        .update(
          JSON.stringify([
            entry.sequence,
            entry.id,
            entry.previousHash,
            entry.timestamp,
            entry.pluginId,
            entry.action,
            entry.resource,
            entry.decision,
            entry.reason,
          ]),
        )
        .digest("hex");
      database
        .prepare(
          `insert into security_audit_state
           (singleton, anchor_hash, latest_hash, next_sequence) values (1, ?, ?, 2)`,
        )
        .run(previousHash, hash);
      database
        .prepare(
          `insert into security_audit_events
           (sequence, id, timestamp, plugin_id, action, resource, decision, reason, hash, previous_hash)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.sequence,
          entry.id,
          entry.timestamp,
          entry.pluginId,
          entry.action,
          entry.resource,
          entry.decision,
          entry.reason,
          hash,
          entry.previousHash,
        );

      try {
        const logger = new SecurityAuditLogger({ database });
        expect(logger.getEntries().map((row) => row.resource)).toEqual(["legacy synthetic record"]);
        expect(logger.verifyChain()).toEqual({ valid: true });
        expect(
          database
            .prepare("pragma table_info(security_audit_state)")
            .all()
            .some((column) => (column as { name: string }).name === "revision"),
        ).toBe(true);
        logger.log({
          pluginId: "@modus/legacy-fixture",
          action: "capability.deny",
          resource: "post-migration synthetic record",
          decision: "deny",
        });
        expect(
          (
            database
              .prepare("select revision from security_audit_state where singleton = 1")
              .get() as { revision: number }
          ).revision,
        ).toBe(1);
        expect(logger.verifyChain()).toEqual({ valid: true });
      } finally {
        database.close();
      }
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

      it("denies a missing target when its nearest existing parent resolves outside scope", () => {
        const scope = path.resolve(process.cwd(), "synthetic-workspace");
        const redirectedParent = path.join(scope, "redirected-parent");
        const outside = path.resolve(process.cwd(), "synthetic-outside");
        const missing = Object.assign(new Error("synthetic missing path"), { code: "ENOENT" });
        const realpath = vi.spyOn(fs, "realpathSync").mockImplementation((candidate) => {
          const candidatePath = path.resolve(candidate.toString());
          if (candidatePath === scope) return scope;
          if (candidatePath === redirectedParent) return outside;
          throw missing;
        });

        try {
          const broker = new FilesystemBroker(undefined, scope);
          const permissions: ExtendedPluginPermissions = {
            filesystem: { write: ["."] },
          };

          expect(broker.canWrite("redirected-parent/new-file.txt", permissions, "p1")).toBe(false);
        } finally {
          realpath.mockRestore();
        }
      });

      it("denies a missing target below a dangling symbolic link", () => {
        const scope = path.resolve(process.cwd(), "synthetic-workspace");
        const linkPath = path.join(scope, "dangling-link");
        const missing = Object.assign(new Error("synthetic missing path"), { code: "ENOENT" });
        const realpath = vi.spyOn(fs, "realpathSync").mockImplementation((candidate) => {
          const candidatePath = path.resolve(candidate.toString());
          if (candidatePath === scope) return scope;
          throw missing;
        });
        const lstat = vi.spyOn(fs, "lstatSync").mockImplementation((candidate) => {
          if (path.resolve(candidate.toString()) === linkPath) {
            return { isSymbolicLink: () => true } as never;
          }
          throw missing;
        });

        try {
          const broker = new FilesystemBroker(undefined, scope);
          const permissions: ExtendedPluginPermissions = {
            filesystem: { write: ["."] },
          };

          expect(broker.canWrite("dangling-link/new-file.txt", permissions, "p1")).toBe(false);
        } finally {
          realpath.mockRestore();
          lstat.mockRestore();
        }
      });

      it("does not perform filesystem IO when no race-free host backend is available", async () => {
        const scope = path.resolve(process.cwd(), "synthetic-workspace");
        const broker = new FilesystemBroker(undefined, scope);
        const permissions: ExtendedPluginPermissions = {
          filesystem: { read: ["."], write: ["."] },
        };
        const readFile = vi
          .spyOn(fs.promises, "readFile")
          .mockResolvedValue("synthetic content" as never);
        const writeFile = vi.spyOn(fs.promises, "writeFile").mockResolvedValue();
        const mkdir = vi.spyOn(fs.promises, "mkdir").mockResolvedValue(undefined);

        try {
          await expect(broker.readFile("document.txt", permissions, "p1")).rejects.toThrow(
            "race-free filesystem backend is unavailable",
          );
          await expect(
            broker.writeFile("document.txt", "content", permissions, "p1"),
          ).rejects.toThrow("race-free filesystem backend is unavailable");
          expect(readFile).not.toHaveBeenCalled();
          expect(writeFile).not.toHaveBeenCalled();
          expect(mkdir).not.toHaveBeenCalled();
        } finally {
          readFile.mockRestore();
          writeFile.mockRestore();
          mkdir.mockRestore();
        }
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

      it("blocks bracketed and mapped IPv6 loopback literals", () => {
        const broker = new NetworkBroker();
        const openDomain: ExtendedPluginPermissions = { network: { domains: ["*"] } };

        expect(broker.canConnect("http://[::1]/", openDomain)).toBe(false);
        expect(broker.canConnect("http://[0:0:0:0:0:0:0:1]/", openDomain)).toBe(false);
        expect(broker.canConnect("http://[::ffff:7f00:1]/", openDomain)).toBe(false);
      });

      it("blocks the full IPv4 loopback, unspecified, and link-local ranges", () => {
        const broker = new NetworkBroker();
        const openDomain: ExtendedPluginPermissions = { network: { domains: ["*"] } };

        expect(broker.canConnect("http://127.0.0.2/", openDomain)).toBe(false);
        expect(broker.canConnect("http://0.0.0.1/", openDomain)).toBe(false);
        expect(broker.canConnect("http://169.254.0.1/", openDomain)).toBe(false);
      });

      it("blocks non-public IPv4 ranges despite an open domain whitelist", () => {
        const broker = new NetworkBroker();
        const openDomain: ExtendedPluginPermissions = { network: { domains: ["*"] } };

        for (const address of [
          "10.20.30.40",
          "172.16.0.1",
          "172.31.255.254",
          "192.168.1.1",
          "100.64.0.1",
          "100.127.255.254",
        ]) {
          expect(broker.canConnect(`http://${address}/`, openDomain), address).toBe(false);
        }
      });

      it("blocks non-public IPv6 ranges and mapped private IPv4 literals", () => {
        const broker = new NetworkBroker();
        const openDomain: ExtendedPluginPermissions = { network: { domains: ["*"] } };

        for (const address of [
          "[fc00::1]",
          "[fd12:3456::1]",
          "[fe80::1]",
          "[ff02::1]",
          "[::10.20.30.40]",
          "[::ffff:192.168.1.10]",
          "[64:ff9b::a9fe:a9fe]",
        ]) {
          expect(broker.canConnect(`http://${address}/`, openDomain), address).toBe(false);
        }
      });

      it("allows globally reachable protocol anycast addresses with exact grants", () => {
        const broker = new NetworkBroker();

        for (const address of ["192.0.0.9", "192.0.0.10"]) {
          expect(
            broker.canConnect(`https://${address}/`, { network: { domains: [address] } }),
            address,
          ).toBe(true);
        }
      });

      it("validates destination domain against domain whitelist and wildcards", () => {
        const broker = new NetworkBroker();
        const perms: ExtendedPluginPermissions = {
          network: { domains: ["api.modus.org", "*.service.io"] },
        };

        expect(broker.canConnect("https://api.modus.org/v1", perms)).toBe(true);
        expect(broker.canConnect("https://sub.service.io/data", perms)).toBe(true);
        expect(broker.canConnect("https://evil.attacker.com", perms)).toBe(false);
        expect(broker.canConnect("https://8.8.8.8/", { network: { domains: ["8.8.8.8"] } })).toBe(
          true,
        );
      });

      it("does not accept a caller-supplied core trust label as network authority", () => {
        const broker = new NetworkBroker();

        expect(
          Reflect.apply(broker.canConnect, broker, ["https://unlisted.example", {}, "p1", "core"]),
        ).toBe(false);
        expect(
          Reflect.apply(broker.canConnect, broker, [
            "http://localhost:8080/api",
            { network: { domains: ["localhost"] } },
            "p1",
            "core",
          ]),
        ).toBe(false);
      });
    });

    describe("ShellBroker", () => {
      it("keeps shell execution blocked with or without destructive syntax", () => {
        const broker = new ShellBroker();
        const perms: ExtendedPluginPermissions = {
          shell: { allow: ["rm", "shutdown", "format"] },
        };

        expect(broker.canExecute("rm -rf /", perms)).toBe(false);
        expect(broker.canExecute("shutdown /s", perms)).toBe(false);
        expect(broker.canExecute("format c:", perms)).toBe(false);
      });

      it("does not authorize shell strings through command or Git grants", () => {
        const broker = new ShellBroker();
        const perms: ExtendedPluginPermissions = {
          shell: {
            allow: ["git", "npm"],
            deny: ["npm publish", "git push"],
          },
          git: { allowStatus: true },
        };

        expect(broker.canExecute("git status", perms)).toBe(false);
        expect(broker.canExecute("npm test", perms)).toBe(false);
        expect(broker.canExecute("git push origin main", perms)).toBe(false);
        expect(broker.canExecute("npm publish", perms)).toBe(false);
        expect(broker.canExecute("curl http://malicious.com", perms)).toBe(false);
      });

      it("does not route Git commands through the unavailable shell executor", () => {
        const broker = new ShellBroker();
        const shellOnly: ExtendedPluginPermissions = { shell: { allow: ["git"] } };
        const pushGranted: ExtendedPluginPermissions = {
          shell: { allow: ["git"] },
          git: { allowPush: true },
        };

        expect(broker.canExecute("git push origin main", shellOnly, "p1")).toBe(false);
        expect(broker.canExecute("git push origin main", pushGranted, "p1")).toBe(false);
      });

      it("denies interpreter wrappers and direct executable variants", () => {
        const broker = new ShellBroker();
        const interpreterAllowed: ExtendedPluginPermissions = { shell: { allow: ["sh"] } };
        const gitExecutableAllowed: ExtendedPluginPermissions = {
          shell: { allow: ["git.exe"] },
        };

        expect(broker.canExecute('sh -c "git push origin main"', interpreterAllowed, "p1")).toBe(
          false,
        );
        expect(broker.canExecute("git.exe push origin main", gitExecutableAllowed, "p1")).toBe(
          false,
        );
      });

      it("denies shell composition even when the executable is allow-listed", () => {
        const broker = new ShellBroker();
        const permissions: ExtendedPluginPermissions = { shell: { allow: ["npm"] } };

        expect(broker.canExecute("npm test; echo harmless", permissions, "p1")).toBe(false);
        expect(broker.canExecute("npm test && echo harmless", permissions, "p1")).toBe(false);
        expect(broker.canExecute("npm $(printf harmless)", permissions, "p1")).toBe(false);
      });

      it("does not accept a caller-supplied core trust label as shell authority", () => {
        const broker = new ShellBroker();

        expect(Reflect.apply(broker.canExecute, broker, ["whoami", {}, "p1", "core"])).toBe(false);
      });
    });

    describe("GitBroker", () => {
      it("denies every Git operation unless its exact operation is granted", () => {
        const broker = new GitBroker();
        const operations = ["push", "pull", "clone", "fetch", "commit", "status"] as const;
        const grants: Record<(typeof operations)[number], ExtendedPluginPermissions> = {
          push: { git: { allowPush: true } },
          pull: { git: { allowPull: true } },
          clone: { git: { allowClone: true } },
          fetch: { git: { allowFetch: true } },
          commit: { git: { allowCommit: true } },
          status: { git: { allowStatus: true } },
        };

        for (const operation of operations) {
          expect(broker.canPerform(operation, {}, "p1")).toBe(false);
          expect(broker.canPerform(operation, grants[operation], "p1")).toBe(true);
        }
      });

      it("does not accept a caller-supplied core trust label as Git authority", () => {
        const broker = new GitBroker();

        expect(Reflect.apply(broker.canPerform, broker, ["clone", {}, "p1", "core"])).toBe(false);
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

      const auditEntries = SecurityAuditLogger.getInstance().getEntries({
        pluginId: "@community/text-helper",
      });
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

      const auditEntries = SecurityAuditLogger.getInstance().getEntries({
        pluginId: "@community/flaky",
      });
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
        SecurityAuditLogger.getInstance().getEntries({ pluginId: "@community/wasm-helper" }),
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

    it("does not expose a same-process isolation facade through PiSdkRuntime", async () => {
      setFeatureFlagOverrides({
        MODUS_USE_KERNEL: true,
        MODUS_CAPABILITY_REGISTRY: true,
        MODUS_PLUGINS: true,
        MODUS_PLUGIN_LIFECYCLE: true,
        MODUS_PLUGIN_ISOLATION: true,
      });

      const runtime = new PiSdkRuntime();
      try {
        await runtime.waitForPlugins();
        expect("getPluginIsolationHost" in runtime).toBe(false);
        expect("pluginIsolationHost" in runtime).toBe(false);
      } finally {
        await runtime.closePluginLifecycleStore();
      }
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

    it("keeps shell execution blocked even with a valid executable prefix grant", () => {
      const broker = new ShellBroker();
      expect(broker.canExecute("github-evil --steal", { shell: { allow: ["git"] } })).toBe(false);
      expect(broker.canExecute("anything at all", { shell: { allow: [""] } })).toBe(false);
      expect(broker.canExecute("git status", { shell: { allow: ["git"] } })).toBe(false);
    });

    it("keeps shell execution blocked even for a workspace-relative command", () => {
      const broker = new ShellBroker();
      const perms: ExtendedPluginPermissions = { shell: { allow: ["rm"] } };
      expect(broker.canExecute("rm -rf $HOME", perms)).toBe(false);
      expect(broker.canExecute("rm -rf ~", perms)).toBe(false);
      expect(broker.canExecute("rm -rf tmp/cache", perms)).toBe(false);
    });
  });
});
