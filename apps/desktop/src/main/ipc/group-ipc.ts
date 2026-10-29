import { encodeGroupErrorMessage, isGroupErrorCode } from "../../shared/group-errors";

/**
 * Electron drops custom error properties across IPC (only `message` survives),
 * so a GroupStoreError's `code` is serialized into the message
 * (`[group-error:<code>] ...`, see shared/group-errors). Other errors pass
 * through untouched. Duck-typed so this module does not import the store.
 */
export function toGroupIpcError(error: unknown): unknown {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  if (error instanceof Error && error.name === "GroupStoreError" && isGroupErrorCode(code)) {
    return new Error(encodeGroupErrorMessage(code, error.message), { cause: error });
  }
  return error;
}
