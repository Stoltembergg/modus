import type { UpdateAction } from "../../shared/contracts";

/** An install/download failure that knows whether retrying makes sense and what to offer. */
export class UpdateInstallError extends Error {
  readonly retryable: boolean;
  readonly action: UpdateAction;
  readonly code: string | undefined;

  constructor(
    message: string,
    options: { retryable: boolean; action: UpdateAction; code?: string; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "UpdateInstallError";
    this.retryable = options.retryable;
    this.action = options.action;
    this.code = options.code;
  }
}

export function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export function isPermissionError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EACCES" || code === "EPERM";
}

/** How a failed user-initiated download/install is presented. */
export function describeInstallFailure(error: unknown): {
  retryable: boolean;
  action: UpdateAction;
} {
  if (error instanceof UpdateInstallError) {
    return { retryable: error.retryable, action: error.action };
  }
  // No permission to replace the app: retrying may work after fixing permissions, but
  // the useful action is downloading the release manually.
  if (isPermissionError(error)) return { retryable: true, action: "download-page" };
  return { retryable: true, action: "install" };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
