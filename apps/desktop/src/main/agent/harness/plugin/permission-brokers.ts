/**
 * @file permission-brokers.ts
 * Fine-grained Permission Brokers for Filesystem, Network, Shell, and Git (Fase 13).
 * Enforces least-privilege access, blocks credential harvesting, and records all decisions
 * in the cryptographic security audit log.
 */

import fs from "fs";
import path from "path";
import type { TrustLevel } from "../capability/capability-types";
import { CredentialGuard } from "./credential-guard";
import { type ExtendedPluginPermissions, PermissionDeniedError } from "./plugin-isolation-types";
import { SecurityAuditLogger } from "./security-audit-logger";

// -----------------------------------------------------------------------------
// Filesystem Broker
// -----------------------------------------------------------------------------

export class FilesystemBroker {
  constructor(
    private audit = SecurityAuditLogger.getInstance(),
    private workspaceRoot: string = process.cwd(),
  ) {}

  /**
   * Resolves symlinks when the target exists so a link planted inside a
   * scope cannot silently redirect reads/writes outside of it. Missing
   * paths fall back to the lexical resolution (best available).
   */
  private resolveWithinRoot(targetPath: string): string {
    const resolved = path.resolve(this.workspaceRoot, targetPath);
    try {
      return fs.realpathSync(resolved);
    } catch {
      return resolved;
    }
  }

  public canRead(
    targetPath: string,
    permissions: ExtendedPluginPermissions = {},
    pluginId = "unknown",
    trustLevel: TrustLevel = "community",
  ): boolean {
    const action = "filesystem.read";

    // 1. Never allow sensitive credentials or secret keys
    if (CredentialGuard.isSensitivePath(targetPath)) {
      this.audit.log({
        pluginId,
        action,
        resource: targetPath,
        decision: "deny",
        reason: "Target is a protected credential or secret file",
      });
      return false;
    }

    // Core / official plugins have workspace access by default
    if (trustLevel === "core") {
      this.audit.log({
        pluginId,
        action,
        resource: targetPath,
        decision: "allow",
        reason: "Core plugin authorized",
      });
      return true;
    }

    const resolved = this.resolveWithinRoot(targetPath);
    const readScopes = permissions.filesystem?.read ?? [];

    if (readScopes.length === 0) {
      this.audit.log({
        pluginId,
        action,
        resource: targetPath,
        decision: "deny",
        reason: "No filesystem read permissions declared",
      });
      return false;
    }

    const allowed = readScopes.some((scope) => {
      const resolvedScope = this.resolveWithinRoot(scope);
      return resolved === resolvedScope || resolved.startsWith(resolvedScope + path.sep);
    });

    this.audit.log({
      pluginId,
      action,
      resource: targetPath,
      decision: allowed ? "allow" : "deny",
      reason: allowed ? "Path matches declared read scope" : "Path outside declared read scopes",
    });

    return allowed;
  }

  public canWrite(
    targetPath: string,
    permissions: ExtendedPluginPermissions = {},
    pluginId = "unknown",
    trustLevel: TrustLevel = "community",
  ): boolean {
    const action = "filesystem.write";

    // 1. Never allow writing to sensitive credentials or secret keys
    if (CredentialGuard.isSensitivePath(targetPath)) {
      this.audit.log({
        pluginId,
        action,
        resource: targetPath,
        decision: "deny",
        reason: "Target is a protected credential or secret file",
      });
      return false;
    }

    // Core plugins have workspace write access
    if (trustLevel === "core") {
      this.audit.log({
        pluginId,
        action,
        resource: targetPath,
        decision: "allow",
        reason: "Core plugin authorized",
      });
      return true;
    }

    const resolved = this.resolveWithinRoot(targetPath);
    const writeScopes = permissions.filesystem?.write ?? [];

    if (writeScopes.length === 0) {
      this.audit.log({
        pluginId,
        action,
        resource: targetPath,
        decision: "deny",
        reason: "No filesystem write permissions declared",
      });
      return false;
    }

    const allowed = writeScopes.some((scope) => {
      const resolvedScope = this.resolveWithinRoot(scope);
      return resolved === resolvedScope || resolved.startsWith(resolvedScope + path.sep);
    });

    this.audit.log({
      pluginId,
      action,
      resource: targetPath,
      decision: allowed ? "allow" : "deny",
      reason: allowed ? "Path matches declared write scope" : "Path outside declared write scopes",
    });

    return allowed;
  }

  public async readFile(
    targetPath: string,
    permissions: ExtendedPluginPermissions = {},
    pluginId = "unknown",
    trustLevel: TrustLevel = "community",
    encoding: BufferEncoding = "utf-8",
  ): Promise<string> {
    if (!this.canRead(targetPath, permissions, pluginId, trustLevel)) {
      throw new PermissionDeniedError("filesystem.read", targetPath, pluginId);
    }
    const resolved = path.resolve(this.workspaceRoot, targetPath);
    return await fs.promises.readFile(resolved, encoding);
  }

  public async writeFile(
    targetPath: string,
    content: string | Uint8Array,
    permissions: ExtendedPluginPermissions = {},
    pluginId = "unknown",
    trustLevel: TrustLevel = "community",
  ): Promise<void> {
    if (!this.canWrite(targetPath, permissions, pluginId, trustLevel)) {
      throw new PermissionDeniedError("filesystem.write", targetPath, pluginId);
    }
    const resolved = path.resolve(this.workspaceRoot, targetPath);
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    await fs.promises.writeFile(resolved, content);
  }
}

// -----------------------------------------------------------------------------
// Network Broker
// -----------------------------------------------------------------------------

export class NetworkBroker {
  private static readonly BLOCKED_HOSTS = new Set([
    "169.254.169.254", // AWS / Cloud metadata
    "metadata.google.internal",
    "100.100.100.200", // Alibaba metadata
    "0.0.0.0",
    "::", // Unspecified IPv6
  ]);

  private static readonly LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

  constructor(private audit = SecurityAuditLogger.getInstance()) {}

  /**
   * Normalizes a hostname so obfuscated loopback/metadata literals cannot
   * dodge the block sets: trailing dots, hex/octal/decimal IPv4 notations
   * (`0x7f.0.0.1`, `0177.0.0.1`, `2130706433`) and IPv6 loopback forms.
   * Non-IP names pass through (lowercased, trailing dot stripped).
   */
  private static normalizeHost(host: string): string {
    let h = host.toLowerCase();
    if (h.endsWith(".")) h = h.slice(0, -1);

    if (h === "::1" || h === "::ffff:127.0.0.1") return "127.0.0.1";
    if (h === "::" || h === "::ffff:0.0.0.0") return "0.0.0.0";

    const canonicalIpv4 = NetworkBroker.parseObscuredIpv4(h);
    if (canonicalIpv4) return canonicalIpv4;

    return h;
  }

  private static parseIpv4Part(part: string): number | undefined {
    if (/^0x[0-9a-f]+$/i.test(part)) return parseInt(part, 16);
    if (/^0[0-7]+$/.test(part) && part.length > 1) return parseInt(part, 8);
    if (/^\d+$/.test(part)) return parseInt(part, 10);
    return undefined;
  }

  private static parseObscuredIpv4(host: string): string | undefined {
    const dotted = host.split(".");
    if (dotted.length === 4) {
      const nums = dotted.map((p) => NetworkBroker.parseIpv4Part(p));
      if (nums.some((n) => n === undefined || n < 0 || n > 255)) return undefined;
      return (nums as number[]).join(".");
    }
    if (dotted.length === 1) {
      const single = NetworkBroker.parseIpv4Part(dotted[0] ?? "");
      if (single === undefined || single < 0 || single > 0xffffffff) return undefined;
      return [
        (single >>> 24) & 255,
        (single >>> 16) & 255,
        (single >>> 8) & 255,
        single & 255,
      ].join(".");
    }
    return undefined;
  }

  public canConnect(
    urlString: string,
    permissions: ExtendedPluginPermissions = {},
    pluginId = "unknown",
    trustLevel: TrustLevel = "community",
  ): boolean {
    const action = "network.connect";
    let url: URL;

    try {
      url = new URL(urlString);
    } catch {
      this.audit.log({
        pluginId,
        action,
        resource: urlString,
        decision: "deny",
        reason: "Malformed URL",
      });
      return false;
    }

    const host = NetworkBroker.normalizeHost(url.hostname.toLowerCase());

    // 0. Only http(s) destinations are brokered: file/ftp/data URLs and
    // friends are denied by default rather than whitelisted by hostname.
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      this.audit.log({
        pluginId,
        action,
        resource: urlString,
        decision: "deny",
        reason: `Non-HTTP(S) URL scheme "${url.protocol}" is not permitted`,
      });
      return false;
    }

    // 1. Block metadata endpoints universally
    if (NetworkBroker.BLOCKED_HOSTS.has(host)) {
      this.audit.log({
        pluginId,
        action,
        resource: urlString,
        decision: "deny",
        reason: "Prohibited cloud metadata endpoint",
      });
      return false;
    }

    // 2. Localhost policy
    if (
      NetworkBroker.LOCALHOST_HOSTS.has(host) &&
      !permissions.network?.allowLocalhost &&
      trustLevel !== "core"
    ) {
      this.audit.log({
        pluginId,
        action,
        resource: urlString,
        decision: "deny",
        reason: "Localhost network access prohibited without allowLocalhost permission",
      });
      return false;
    }

    // Core plugins have broad network access
    if (trustLevel === "core") {
      this.audit.log({
        pluginId,
        action,
        resource: urlString,
        decision: "allow",
        reason: "Core plugin authorized",
      });
      return true;
    }

    const allowedDomains = permissions.network?.domains ?? [];
    if (allowedDomains.length === 0) {
      this.audit.log({
        pluginId,
        action,
        resource: urlString,
        decision: "deny",
        reason: "No network domains declared in permissions",
      });
      return false;
    }

    // Check domain whitelist (supports wildcard: *.example.com or exact: api.example.com)
    const domainMatch = allowedDomains.some((pattern) => {
      const pat = pattern.toLowerCase();
      if (pat === "*" || pat === host) return true;
      if (pat.startsWith("*.")) {
        const root = pat.slice(2);
        return host === root || host.endsWith("." + root);
      }
      return false;
    });

    if (!domainMatch) {
      this.audit.log({
        pluginId,
        action,
        resource: urlString,
        decision: "deny",
        reason: `Domain "${host}" not in network domain whitelist`,
      });
      return false;
    }

    // Check port whitelist if configured
    const allowedPorts = permissions.network?.ports;
    if (allowedPorts && allowedPorts.length > 0) {
      const port = url.port ? parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
      if (!allowedPorts.includes(port)) {
        this.audit.log({
          pluginId,
          action,
          resource: urlString,
          decision: "deny",
          reason: `Port ${port} not in network port whitelist`,
        });
        return false;
      }
    }

    this.audit.log({
      pluginId,
      action,
      resource: urlString,
      decision: "allow",
      reason: "Network destination matches whitelist",
    });

    return true;
  }
}

// -----------------------------------------------------------------------------
// Shell Broker
// -----------------------------------------------------------------------------

export class ShellBroker {
  private static readonly DANGEROUS_COMMANDS = [
    /\brm\s+-rf\s+\//i,
    /\brm\s+.*(?:~|\$HOME|\$HOMEPATH|%HOME%|\/\*|--no-preserve-root)/i,
    /\bmkfs\b/i,
    /\bshutdown\b/i,
    /\breboot\b/i,
    /\bformat\s+[a-z]:/i,
    /:>{1,2}&/i, // fork bombs
    /\bdd\s+if=/i,
    /\bdeltree\b/i,
    /\b(del|rmdir|rd)\b.*\/s/i,
    /remove-item\b.*-recurse/i,
  ];

  constructor(private audit = SecurityAuditLogger.getInstance()) {}

  public canExecute(
    command: string,
    permissions: ExtendedPluginPermissions = {},
    pluginId = "unknown",
    trustLevel: TrustLevel = "community",
  ): boolean {
    const action = "shell.execute";

    // 1. Block destructive / system wipe commands universally
    if (ShellBroker.DANGEROUS_COMMANDS.some((pat) => pat.test(command))) {
      this.audit.log({
        pluginId,
        action,
        resource: command,
        decision: "deny",
        reason: "Dangerous system destruction command pattern detected",
      });
      return false;
    }

    // Core plugins have shell access
    if (trustLevel === "core") {
      this.audit.log({
        pluginId,
        action,
        resource: command,
        decision: "allow",
        reason: "Core plugin authorized",
      });
      return true;
    }

    // Check deny list first
    const denyList = permissions.shell?.deny ?? [];
    if (denyList.some((denied) => command.toLowerCase().includes(denied.toLowerCase()))) {
      this.audit.log({
        pluginId,
        action,
        resource: command,
        decision: "deny",
        reason: "Command matches shell deny list",
      });
      return false;
    }

    const allowList = permissions.shell?.allow ?? [];
    if (allowList.length === 0) {
      this.audit.log({
        pluginId,
        action,
        resource: command,
        decision: "deny",
        reason: "No shell permissions declared",
      });
      return false;
    }

    // Command must be exactly an allowed entry or start with it on a token
    // boundary. A bare prefix match would authorize unrelated binaries
    // ("github-evil" via allow "git") or everything (allow "").
    const lower = command.toLowerCase();
    const allowed = allowList.some((allowedPrefix) => {
      const pref = allowedPrefix.toLowerCase().trim();
      if (!pref) return false;
      if (lower === pref) return true;
      return lower.startsWith(pref) && /\s/.test(lower.charAt(pref.length));
    });

    this.audit.log({
      pluginId,
      action,
      resource: command,
      decision: allowed ? "allow" : "deny",
      reason: allowed ? "Command allowed by shell whitelist" : "Command not in shell whitelist",
    });

    return allowed;
  }
}

// -----------------------------------------------------------------------------
// Git Broker
// -----------------------------------------------------------------------------

export class GitBroker {
  constructor(private audit = SecurityAuditLogger.getInstance()) {}

  public canPerform(
    operation: "push" | "pull" | "clone" | "fetch" | "commit" | "status",
    permissions: ExtendedPluginPermissions = {},
    pluginId = "unknown",
    trustLevel: TrustLevel = "community",
  ): boolean {
    const action = `git.${operation}`;

    if (trustLevel === "core") {
      this.audit.log({
        pluginId,
        action,
        resource: operation,
        decision: "allow",
        reason: "Core plugin authorized",
      });
      return true;
    }

    if (operation === "push" && !permissions.git?.allowPush) {
      this.audit.log({
        pluginId,
        action,
        resource: operation,
        decision: "deny",
        reason: "Git push prohibited without explicit allowPush permission",
      });
      return false;
    }

    if (operation === "clone" && permissions.git && permissions.git.allowClone === false) {
      this.audit.log({
        pluginId,
        action,
        resource: operation,
        decision: "deny",
        reason: "Git clone explicitly denied",
      });
      return false;
    }

    this.audit.log({
      pluginId,
      action,
      resource: operation,
      decision: "allow",
      reason: "Git operation authorized by policy",
    });

    return true;
  }
}
