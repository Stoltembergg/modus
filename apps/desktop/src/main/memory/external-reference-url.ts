const SENSITIVE_QUERY_KEYS = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "authtoken",
  "bearertoken",
  "clientkey",
  "clientsecret",
  "clienttoken",
  "code",
  "credential",
  "credentials",
  "idtoken",
  "jwt",
  "key",
  "password",
  "passwd",
  "privatekey",
  "refreshtoken",
  "secret",
  "secretkey",
  "session",
  "sessionid",
  "sessiontoken",
  "signature",
  "sig",
  "sid",
  "ticket",
  "token",
]);

function hasSensitiveQueryKey(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (SENSITIVE_QUERY_KEYS.has(normalized)) return true;
    const parts = key
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    if (parts.some((part) => SENSITIVE_QUERY_KEYS.has(part))) return true;
  }
  return false;
}

/** Canonicalize a metadata URL or return undefined when it is unsafe or oversized. */
export function canonicalizeExternalReferenceUrl(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      hasSensitiveQueryKey(url)
    ) {
      return undefined;
    }
    url.hash = "";
    const canonical = url.href;
    return canonical.length <= maxLength ? canonical : undefined;
  } catch {
    return undefined;
  }
}
