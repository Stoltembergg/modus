/**
 * @file permission-brokers.ts
 * Fine-grained Permission Brokers for Filesystem, Network, Shell, and Git (Fase 13).
 * Enforces least-privilege access, blocks credential harvesting, and records all decisions
 * in the cryptographic security audit log.
 */

import { type ExtendedPluginPermissions, PermissionDeniedError } from "./plugin-isolation-types";
import { SecurityAuditLogger } from "./security-audit-logger";

// -----------------------------------------------------------------------------
// Filesystem Broker
// -----------------------------------------------------------------------------

export class FilesystemBroker {
  constructor(private audit = SecurityAuditLogger.getInstance()) {}

  private denyIoWithoutSafeBackend(
    action: "filesystem.read" | "filesystem.write",
    targetPath: string,
    pluginId: string,
  ): never {
    const reason = "Handle-bound filesystem executor is unavailable";
    this.audit.log({ pluginId, action, resource: targetPath, decision: "deny", reason });
    throw new PermissionDeniedError(action, targetPath, pluginId, reason);
  }

  public canRead(
    targetPath: string,
    _permissions: ExtendedPluginPermissions = {},
    pluginId = "unknown",
  ): boolean {
    const action = "filesystem.read";
    this.audit.log({
      pluginId,
      action,
      resource: targetPath,
      decision: "deny",
      reason: "Handle-bound filesystem executor is unavailable",
    });

    return false;
  }

  public canWrite(
    targetPath: string,
    _permissions: ExtendedPluginPermissions = {},
    pluginId = "unknown",
  ): boolean {
    const action = "filesystem.write";
    this.audit.log({
      pluginId,
      action,
      resource: targetPath,
      decision: "deny",
      reason: "Handle-bound filesystem executor is unavailable",
    });

    return false;
  }

  public async readFile(
    targetPath: string,
    _permissions: ExtendedPluginPermissions = {},
    pluginId = "unknown",
    _encoding: BufferEncoding = "utf-8",
  ): Promise<string> {
    return this.denyIoWithoutSafeBackend("filesystem.read", targetPath, pluginId);
  }

  public async writeFile(
    targetPath: string,
    _content: string | Uint8Array,
    _permissions: ExtendedPluginPermissions = {},
    pluginId = "unknown",
  ): Promise<void> {
    return this.denyIoWithoutSafeBackend("filesystem.write", targetPath, pluginId);
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

    if (h.startsWith("[") && h.endsWith("]")) {
      const literal = h.slice(1, -1);
      try {
        h = new URL(`http://[${literal}]/`).hostname.slice(1, -1);
      } catch {
        return literal;
      }
    }

    if (h.startsWith("::ffff:")) {
      const mapped = h.slice("::ffff:".length);
      if (mapped.includes(".")) return NetworkBroker.normalizeHost(mapped);

      const words = mapped.split(":");
      if (words.length === 2 && words.every((word) => /^[0-9a-f]{1,4}$/u.test(word))) {
        const high = Number.parseInt(words[0] ?? "", 16);
        const low = Number.parseInt(words[1] ?? "", 16);
        return NetworkBroker.normalizeHost(
          [high >>> 8, high & 255, low >>> 8, low & 255].join("."),
        );
      }
    }

    if (h === "::1") return "127.0.0.1";
    if (h === "::") return "0.0.0.0";

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

  private static isLoopbackHost(host: string): boolean {
    if (NetworkBroker.LOCALHOST_HOSTS.has(host)) return true;
    const address = host.split(".").map((part) => Number(part));
    return address.length === 4 && address.every(Number.isInteger) && address[0] === 127;
  }

  private static parseIpv6Groups(host: string): number[] | undefined {
    let address = host.toLowerCase();
    if (address.includes(".")) {
      const separator = address.lastIndexOf(":");
      if (separator === -1) return undefined;
      const ipv4 = NetworkBroker.parseObscuredIpv4(address.slice(separator + 1));
      if (!ipv4) return undefined;
      const octets = ipv4.split(".").map(Number);
      const [first, second, third, fourth] = octets;
      if ([first, second, third, fourth].some((octet) => octet === undefined)) return undefined;
      address = `${address.slice(0, separator + 1)}${(((first ?? 0) << 8) | (second ?? 0)).toString(16)}:${(((third ?? 0) << 8) | (fourth ?? 0)).toString(16)}`;
    }

    const compression = address.indexOf("::");
    if (compression !== -1 && address.indexOf("::", compression + 2) !== -1) return undefined;
    const left = (compression === -1 ? address : address.slice(0, compression))
      .split(":")
      .filter(Boolean);
    const right =
      compression === -1
        ? []
        : address
            .slice(compression + 2)
            .split(":")
            .filter(Boolean);
    const missingGroups = 8 - left.length - right.length;
    if (compression === -1 ? missingGroups !== 0 : missingGroups < 1) return undefined;

    const groups = [...left, ...Array.from({ length: missingGroups }, () => "0"), ...right];
    if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) {
      return undefined;
    }

    return groups.map((group) => Number.parseInt(group, 16));
  }

  private static isBlockedHost(host: string): boolean {
    if (NetworkBroker.BLOCKED_HOSTS.has(host)) return true;
    const address = host.split(".").map((part) => Number(part));
    if (address.length === 4 && address.every(Number.isInteger)) {
      const [first, second, third] = address;
      return (
        first === 0 ||
        (first === 10 && second !== undefined) ||
        (first === 100 && second !== undefined && second >= 64 && second <= 127) ||
        (first === 169 && second === 254) ||
        (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
        (first === 192 && second === 0 && third === 0 && address[3] !== 9 && address[3] !== 10) ||
        (first === 192 && second === 0 && third === 2) ||
        (first === 192 && second === 168) ||
        (first === 198 && second !== undefined && (second === 18 || second === 19)) ||
        (first === 198 && second === 51 && third === 100) ||
        (first === 203 && second === 0 && third === 113) ||
        (first !== undefined && first >= 224)
      );
    }

    const groups = NetworkBroker.parseIpv6Groups(host);
    if (!groups) return false;
    const [first, second, third] = groups;
    const localUseNat64 = first === 0x0064 && second === 0xff9b && third === 0x0001;
    if (first === 0x0064 && second === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
      const [high, low] = groups.slice(6, 8);
      if (high === undefined || low === undefined) return true;
      const embeddedIpv4 = [high >>> 8, high & 255, low >>> 8, low & 255].join(".");
      return (
        NetworkBroker.isBlockedHost(embeddedIpv4) || NetworkBroker.isLoopbackHost(embeddedIpv4)
      );
    }

    return (
      (first !== undefined && (first & 0xfe00) === 0xfc00) ||
      (first !== undefined && (first & 0xffc0) === 0xfe80) ||
      (first !== undefined && (first & 0xff00) === 0xff00) ||
      groups.slice(0, 6).every((group) => group === 0) ||
      (first === 0x3fff && second !== undefined && (second & 0xf000) === 0) ||
      localUseNat64 ||
      (first === 0x2001 && second === 0x0db8) ||
      (first === 0x2001 && second === 0x0000) ||
      first === 0x2002
    );
  }

  public canConnect(
    urlString: string,
    permissions: ExtendedPluginPermissions = {},
    pluginId = "unknown",
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
    if (NetworkBroker.isBlockedHost(host)) {
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
    if (NetworkBroker.isLoopbackHost(host) && !permissions.network?.allowLocalhost) {
      this.audit.log({
        pluginId,
        action,
        resource: urlString,
        decision: "deny",
        reason: "Localhost network access prohibited without allowLocalhost permission",
      });
      return false;
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
      decision: "deny",
      reason: "DNS-pinned network executor is unavailable",
    });

    return false;
  }
}

// -----------------------------------------------------------------------------
// Shell Broker
// -----------------------------------------------------------------------------

export class ShellBroker {
  constructor(private audit = SecurityAuditLogger.getInstance()) {}

  public canExecute(
    command: string,
    _permissions: ExtendedPluginPermissions = {},
    pluginId = "unknown",
  ): boolean {
    this.audit.log({
      pluginId,
      action: "shell.execute",
      resource: command,
      decision: "deny",
      reason: "Shell execution is unavailable until a platform-isolated executor is integrated.",
    });
    return false;
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
  ): boolean {
    const action = `git.${operation}`;

    const grantByOperation = {
      push: "allowPush",
      pull: "allowPull",
      clone: "allowClone",
      fetch: "allowFetch",
      commit: "allowCommit",
      status: "allowStatus",
    } as const;
    const grant = grantByOperation[operation];
    const allowed = permissions.git?.[grant] === true;

    this.audit.log({
      pluginId,
      action,
      resource: operation,
      decision: allowed ? "allow" : "deny",
      reason: allowed
        ? `Git ${operation} explicitly authorized`
        : `Git ${operation} prohibited without explicit ${grant} permission`,
    });

    return allowed;
  }
}
