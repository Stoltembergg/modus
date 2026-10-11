import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginIsolationHost } from "./plugin-isolation-host";
import { SecurityAuditLogger } from "./security-audit-logger";

describe("security audit logger reflective boundary", () => {
  let database: DatabaseSync;
  let logger: SecurityAuditLogger;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    logger = new SecurityAuditLogger({ database });
  });

  afterEach(() => database.close());

  it("keeps database and audit-chain state out of reflective properties", () => {
    const ownKeys = Reflect.ownKeys(logger);
    const prototype = Object.getPrototypeOf(logger) as object;
    const classKeys = Reflect.ownKeys(SecurityAuditLogger);

    for (const key of [
      "database",
      "maxEntries",
      "entries",
      "anchorHash",
      "latestHash",
      "nextSequence",
      "databaseVersion",
      "auditRevision",
      "integrityFailure",
    ]) {
      expect(ownKeys).not.toContain(key);
    }

    expect(classKeys).not.toContain("instance");
    for (const key of [
      "ensureSchema",
      "hydrate",
      "readDatabaseVersion",
      "readState",
      "readRows",
      "assertBoundedInput",
    ]) {
      expect(Object.hasOwn(prototype, key)).toBe(false);
    }
    expect(Object.hasOwn(SecurityAuditLogger, "verifyRows")).toBe(false);
  });

  it("does not expose the audit logger reference from the fail-closed host facade", () => {
    const host = new PluginIsolationHost({ auditLogger: logger });
    const prototype = Object.getPrototypeOf(host) as object;

    expect(Reflect.ownKeys(host)).not.toContain("audit");
    expect(Object.hasOwn(prototype, "blocked")).toBe(false);
  });
});
