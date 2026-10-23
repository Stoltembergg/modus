import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "./mcp-config";

const db = vi.hoisted(() => ({ current: undefined as DatabaseSync | undefined }));

vi.mock("../db/database", () => ({
  getDatabase: () => {
    if (!db.current) throw new Error("Test database is not initialized.");
    return db.current;
  },
}));

import { approveMcpTrust, getMcpConfigFingerprint, readMcpTrust } from "./mcp-trust-store";

function projectConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "project-tools",
    source: "/work/sample/.modus/mcp.json",
    enabled: true,
    readOnlyToolAllowlist: ["repo-requested-safe"],
    transport: "stdio",
    command: "node",
    args: ["server.mjs"],
    env: {},
    cwd: "/work/sample",
    ...overrides,
  } as McpServerConfig;
}

beforeEach(() => {
  db.current?.close();
  db.current = new DatabaseSync(":memory:");
  db.current.exec(`create table app_settings (
    key text primary key, value text, updated_at text not null
  )`);
});

describe("MCP project trust store", () => {
  it("keeps repository requested allowlists untrusted and ineffective", () => {
    const config = projectConfig();

    expect(readMcpTrust(config, "/work/sample")).toEqual({
      trusted: false,
      readOnlyToolAllowlist: [],
    });
  });

  it("accepts approval only for the current workspace and exact resolved config", () => {
    const config = projectConfig();
    const fingerprint = getMcpConfigFingerprint(config, "/work/sample");

    approveMcpTrust(config, "/work/sample", fingerprint, []);

    expect(readMcpTrust(config, "/work/sample")).toEqual({
      trusted: true,
      readOnlyToolAllowlist: [],
    });
    expect(readMcpTrust(config, "/work/other")).toEqual({
      trusted: false,
      readOnlyToolAllowlist: [],
    });
  });

  it("rejects stale fingerprints and returns no trust after any effective change", () => {
    const config = projectConfig();

    expect(() => approveMcpTrust(config, "/work/sample", "old-fingerprint", [])).toThrow(
      /changed/i,
    );

    const fingerprint = getMcpConfigFingerprint(config, "/work/sample");
    approveMcpTrust(config, "/work/sample", fingerprint, ["user-approved-search"]);

    expect(readMcpTrust(projectConfig({ args: ["changed.mjs"] }), "/work/sample")).toEqual({
      trusted: false,
      readOnlyToolAllowlist: [],
    });
    expect(readMcpTrust(config, "/work/sample")).toEqual({
      trusted: true,
      readOnlyToolAllowlist: ["user-approved-search"],
    });
  });

  it("does not persist commands, arguments, environment, or headers in trust records", () => {
    const config = projectConfig({
      args: ["server.mjs", "--api-key=secret-value"],
      env: { API_KEY: "secret-value" },
    });
    const fingerprint = getMcpConfigFingerprint(config, "/work/sample");

    approveMcpTrust(config, "/work/sample", fingerprint, []);

    const stored = db.current?.prepare("select key, value from app_settings").all() as Array<{
      key: string;
      value: string;
    }>;
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain("secret-value");
    expect(JSON.stringify(stored)).not.toContain("server.mjs");
  });
});
