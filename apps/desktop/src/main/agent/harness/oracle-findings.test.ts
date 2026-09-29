import { describe, expect, it } from "vitest";
import {
  capOracleDigest,
  formatOracleFindingsEnvelope,
  ORACLE_DIGEST_MAX_BYTES,
} from "./oracle-findings";

describe("oracle-findings", () => {
  it("returns empty string for empty or non-string input without throwing", () => {
    expect(capOracleDigest("")).toBe("");
    expect(capOracleDigest("   ")).toBe("");
    expect(capOracleDigest(undefined)).toBe("");
    expect(capOracleDigest(null)).toBe("");
    expect(capOracleDigest(42)).toBe("");
    expect(capOracleDigest({ text: "nope" })).toBe("");
  });

  it("caps long digests to the byte budget", () => {
    const long = "a".repeat(ORACLE_DIGEST_MAX_BYTES + 500);
    const capped = capOracleDigest(long);
    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(ORACLE_DIGEST_MAX_BYTES);
    expect(capped.endsWith("…")).toBe(true);
  });

  it("strips control characters and wraps an untrusted envelope", () => {
    const digest = capOracleDigest("findings\u0000 with <tags> & more");
    expect(digest).not.toContain("\u0000");
    const envelope = formatOracleFindingsEnvelope(digest);
    expect(envelope).toMatch(/^<adaptive_oracle_findings>/);
    expect(envelope).toContain("&lt;tags&gt;");
    expect(envelope).toContain("&amp;");
  });
});
