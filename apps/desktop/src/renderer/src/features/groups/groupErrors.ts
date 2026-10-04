import {
  decodeGroupErrorMessage,
  GROUP_ERROR_CODES,
  type GroupErrorCode,
} from "../../../../shared/group-errors";
import { groupText } from "../../../../shared/group-room-locale";
import { GROUP_ROOM_TEXT_EN } from "../../../../shared/group-room-text";

/** The readable message of a group error code, in the room locale (C6 catalog `error.*`). */
export function groupErrorMessage(code: GroupErrorCode, locale?: string | null): string {
  return groupText(`error.${code}`, locale);
}

/**
 * English message per group error code (the store's text is for logs). Kept
 * as the en catalog values for callers and tests that compare English text.
 */
export const GROUP_ERROR_MESSAGES = Object.fromEntries(
  GROUP_ERROR_CODES.map((code) => [code, GROUP_ROOM_TEXT_EN[`error.${code}`]]),
) as Record<GroupErrorCode, string>;

/**
 * User-facing text for an error from `window.modus.group.*`: the mapped
 * message for a known code in the room locale; otherwise the raw message
 * (without Electron's "Error invoking remote method" prefix).
 */
export function describeGroupError(error: unknown, locale?: string | null): string {
  const { code, message } = decodeGroupErrorMessage(error);
  return code ? groupErrorMessage(code, locale) : message;
}
