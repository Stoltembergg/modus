import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { getDatabase } from "../db/database";
import { type McpServerConfig, userMcpConfigPath } from "./mcp-config";

const MCP_TRUST_KEY_PREFIX = "mcp.trust:v1:";
const MAX_READ_ONLY_TOOL_ALLOWLIST = 100;
const MAX_TOOL_NAME_LENGTH = 256;

export type McpTrustState = {
  trusted: boolean;
  readOnlyToolAllowlist: string[];
};

type StoredMcpTrust = {
  version: 1;
  fingerprint: string;
  readOnlyToolAllowlist: string[];
};

function sortedRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function canonicalConfig(config: McpServerConfig, workspaceRoot: string): unknown {
  const common = {
    version: 1,
    workspaceRoot: resolve(workspaceRoot),
    source: resolve(config.source),
    name: config.name,
    enabled: config.enabled,
    transport: config.transport,
    requestedReadOnlyToolAllowlist: [...config.readOnlyToolAllowlist].sort(),
  };

  if (config.transport === "stdio") {
    return {
      ...common,
      command: config.command,
      args: config.args,
      env: sortedRecord(config.env),
      cwd: config.cwd === undefined ? undefined : resolve(config.cwd),
    };
  }

  return {
    ...common,
    url: config.url,
    headers: sortedRecord(config.headers),
  };
}

/** Fingerprint the effective host-resolved config without exposing its secrets. */
export function getMcpConfigFingerprint(config: McpServerConfig, workspaceRoot: string): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalConfig(config, workspaceRoot)))
    .digest("hex");
}

function trustKey(config: McpServerConfig, workspaceRoot: string): string {
  const identity = [resolve(workspaceRoot), resolve(config.source), config.name].join("\0");
  return `${MCP_TRUST_KEY_PREFIX}${createHash("sha256").update(identity).digest("hex")}`;
}

function validateAllowlist(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_READ_ONLY_TOOL_ALLOWLIST) return undefined;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      typeof item !== "string" ||
      !item.trim() ||
      item.length > MAX_TOOL_NAME_LENGTH ||
      seen.has(item)
    ) {
      return undefined;
    }
    seen.add(item);
    names.push(item);
  }
  return names;
}

function readStoredTrust(key: string): StoredMcpTrust | undefined {
  const row = getDatabase().prepare("select value from app_settings where key = ?").get(key) as
    | { value: string | null }
    | undefined;
  if (typeof row?.value !== "string") return undefined;

  try {
    const parsed: unknown = JSON.parse(row.value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const allowlist = validateAllowlist(record.readOnlyToolAllowlist);
    if (
      record.version !== 1 ||
      typeof record.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.fingerprint) ||
      allowlist === undefined
    ) {
      return undefined;
    }
    return { version: 1, fingerprint: record.fingerprint, readOnlyToolAllowlist: allowlist };
  } catch {
    return undefined;
  }
}

/** User-owned global settings keep their existing host-controlled policy. */
function isUserOwnedGlobalConfig(config: McpServerConfig): boolean {
  return resolve(config.source) === resolve(userMcpConfigPath());
}

export function readMcpTrust(config: McpServerConfig, workspaceRoot: string): McpTrustState {
  if (isUserOwnedGlobalConfig(config)) {
    return {
      trusted: true,
      readOnlyToolAllowlist: validateAllowlist(config.readOnlyToolAllowlist) ?? [],
    };
  }

  const stored = readStoredTrust(trustKey(config, workspaceRoot));
  if (!stored || stored.fingerprint !== getMcpConfigFingerprint(config, workspaceRoot)) {
    return { trusted: false, readOnlyToolAllowlist: [] };
  }
  return { trusted: true, readOnlyToolAllowlist: stored.readOnlyToolAllowlist };
}

/** Store a host decision only when the reviewed fingerprint is still current. */
export function approveMcpTrust(
  config: McpServerConfig,
  workspaceRoot: string,
  expectedFingerprint: string,
  readOnlyToolAllowlist: string[],
): void {
  const fingerprint = getMcpConfigFingerprint(config, workspaceRoot);
  if (expectedFingerprint !== fingerprint) {
    throw new Error("MCP server configuration changed; review it again before connecting.");
  }
  const allowlist = validateAllowlist(readOnlyToolAllowlist);
  if (allowlist === undefined) throw new Error("Invalid MCP read-only tool allowlist.");

  getDatabase()
    .prepare(
      `insert into app_settings (key, value, updated_at)
       values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(
      trustKey(config, workspaceRoot),
      JSON.stringify({
        version: 1,
        fingerprint,
        readOnlyToolAllowlist: allowlist,
      } satisfies StoredMcpTrust),
      new Date().toISOString(),
    );
}

export function revokeMcpTrust(config: McpServerConfig, workspaceRoot: string): void {
  getDatabase()
    .prepare("delete from app_settings where key = ?")
    .run(trustKey(config, workspaceRoot));
}
