/** Max capped Oracle findings digest size (UTF-8 bytes). Untrusted turn data only. */
export const ORACLE_DIGEST_MAX_BYTES = 2048;

function stripControlChars(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // Keep tab (9) and newline (10) / carriage return (13); drop other C0 + DEL.
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      out += ch;
    }
  }
  return out;
}

/**
 * Cap and lightly sanitize Oracle child output for parent-turn injection.
 * Returns empty string for empty/garbage input; never throws.
 */
export function capOracleDigest(text: unknown, maxBytes = ORACLE_DIGEST_MAX_BYTES): string {
  try {
    if (typeof text !== "string") return "";
    const cleaned = stripControlChars(text).trim();
    if (!cleaned) return "";
    const limit = Math.max(64, Math.min(maxBytes, ORACLE_DIGEST_MAX_BYTES * 2));
    if (Buffer.byteLength(cleaned, "utf8") <= limit) return cleaned;
    let out = cleaned;
    while (Buffer.byteLength(out, "utf8") > limit - 1 && out.length > 0) {
      out = out.slice(0, Math.max(0, out.length - 32));
    }
    return `${out}…`;
  } catch {
    return "";
  }
}

/** Escape for embedding inside an untrusted XML-ish turn envelope. */
export function escapeOracleDigestForEnvelope(digest: string): string {
  return digest.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatOracleFindingsEnvelope(digest: string): string | undefined {
  const capped = capOracleDigest(digest);
  if (!capped) return undefined;
  return `<adaptive_oracle_findings>\n${escapeOracleDigestForEnvelope(capped)}\n</adaptive_oracle_findings>`;
}
