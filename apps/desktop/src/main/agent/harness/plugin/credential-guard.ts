/**
 * @file credential-guard.ts
 * Strict Credential & Secret Protection Guard (Fase 13).
 * Intercepts and denies access to private keys, environment files, tokens, and credentials.
 */

import path from "path";

export class CredentialGuard {
  private static readonly SENSITIVE_PATH_PATTERNS = [
    /^\.env(\..+)?$/i,
    /id_rsa/i,
    /id_ed25519/i,
    /id_ecdsa/i,
    /\.pem$/i,
    /\.key$/i,
    /\.pfx$/i,
    /\.pkcs12$/i,
    /credentials?(\.json|\.ini|\.xml)?$/i,
    /secrets?(\.json|\.ya?ml|\.env)?$/i,
    /tokens?(\.json|\.txt)?$/i,
    /\.aws[/\\]credentials/i,
    /\.ssh[/\\]/i,
    /\.gnupg[/\\]/i,
    /\.netrc$/i,
  ];

  private static readonly SENSITIVE_ENV_KEYWORDS = [
    "KEY",
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "AUTH",
    "PRIVATE",
    "CREDENTIAL",
    "SALT",
    "SIGNATURE",
    "API_KEY",
    "BEARER",
  ];

  private static readonly SENSITIVE_ENV_PREFIXES = [
    "AWS_",
    "GITHUB_",
    "GH_",
    "OPENAI_",
    "ANTHROPIC_",
    "GOOGLE_",
    "AZURE_",
    "SSH_",
    "SSL_",
    "MODUS_SECRET_",
  ];

  /**
   * Determines whether a filesystem path points to sensitive credentials or secrets.
   */
  public static isSensitivePath(targetPath: string): boolean {
    const normalized = targetPath.replace(/\\/g, "/");
    // Windows strips trailing dots/spaces per path segment when opening
    // files, so match on the effective name: ".env " and ".env." open .env.
    const effective = normalized
      .split("/")
      .map((segment) => segment.replace(/[. ]+$/, ""))
      .join("/");
    const baseName = path.basename(effective);

    // Direct filename checks
    if (CredentialGuard.SENSITIVE_PATH_PATTERNS.some((pat) => pat.test(baseName))) {
      return true;
    }

    // Full path segment checks (e.g. .ssh/authorized_keys or .aws/credentials)
    if (CredentialGuard.SENSITIVE_PATH_PATTERNS.some((pat) => pat.test(effective))) {
      return true;
    }

    return false;
  }

  /**
   * Checks whether an environment variable key is considered sensitive.
   */
  public static isSensitiveEnvKey(key: string): boolean {
    const upper = key.toUpperCase();

    if (CredentialGuard.SENSITIVE_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
      return true;
    }

    if (CredentialGuard.SENSITIVE_ENV_KEYWORDS.some((kw) => upper.includes(kw))) {
      return true;
    }

    return false;
  }

  /**
   * Sanitizes an environment dictionary, stripping all sensitive variables
   * unless explicitly whitelisted by exact name.
   */
  public static filterEnv(
    rawEnv: Record<string, string | undefined>,
    allowedKeys: string[] = [],
  ): Record<string, string> {
    const sanitized: Record<string, string> = {};
    const allowedSet = new Set(allowedKeys);

    for (const [key, val] of Object.entries(rawEnv)) {
      if (val === undefined) continue;

      if (allowedSet.has(key)) {
        sanitized[key] = val;
        continue;
      }

      if (!CredentialGuard.isSensitiveEnvKey(key)) {
        sanitized[key] = val;
      }
    }

    return sanitized;
  }

  /**
   * Masks secrets for safe logging.
   */
  public static maskSecret(value: string): string {
    if (!value || value.length <= 6) return "******";
    return `${value.slice(0, 3)}...${value.slice(-3)}`;
  }
}
