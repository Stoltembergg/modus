import {
  decodeGroupErrorMessage,
  GROUP_ERROR_CODES,
  type GroupErrorCode,
} from "../../../../shared/group-errors";
import { groupText, type GroupTextKey } from "../../../../shared/group-room-locale";
import { GROUP_ROOM_TEXT_EN } from "../../../../shared/group-room-text";

/** English text for new task errors that do not have room catalog entries yet. */
const GROUP_ERROR_FALLBACKS: Partial<Record<GroupErrorCode, string>> = {
  "verification-required": "Complete the task's required verification before closing it.",
  "permission-denied": "Allow Git access before applying or aborting this task integration.",
  "stale-task": "The task changed. Refresh it and try again.",
  "dependency-cycle": "The task dependencies contain a cycle.",
  "invalid-dependency": "Choose tasks in this group as dependencies.",
  "stale-evidence": "The task evidence is out of date. Run verification again.",
};

/** Readable English message per group error code (the store's text is for logs). */
export const GROUP_ERROR_MESSAGES = Object.fromEntries(
  GROUP_ERROR_CODES.map((code) => {
    const key = `error.${code}` as GroupTextKey;
    return [code, GROUP_ROOM_TEXT_EN[key] ?? GROUP_ERROR_FALLBACKS[code] ?? code];
  }),
) as Record<GroupErrorCode, string>;

/** The readable message of a group error code in the room locale (C6 catalog). */
export function groupErrorMessage(code: GroupErrorCode, locale?: string | null): string {
  const key = `error.${code}` as GroupTextKey;
  return key in GROUP_ROOM_TEXT_EN ? groupText(key, locale) : GROUP_ERROR_MESSAGES[code];
}

/**
 * User-facing text for an error from `window.modus.group.*`: the mapped
 * message for a known code in the room locale; otherwise the raw message
 * (without Electron's "Error invoking remote method" prefix).
 */
export function describeGroupError(error: unknown, locale?: string | null): string {
  const { code, message } = decodeGroupErrorMessage(error);
  return code ? groupErrorMessage(code, locale) : message;
}
