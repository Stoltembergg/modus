import { decodeGroupErrorMessage } from "../../../shared/group-errors";
import { type GroupTextKey, groupText } from "../../../shared/group-room-locale";
import { GROUP_ROOM_TEXT_EN } from "../../../shared/group-room-text";

/**
 * User-facing text for an `agents:*` error (profiles still use the store's
 * `[group-error:<code>]` wire format): the mapped message for a known code,
 * otherwise the raw message without Electron's "Error invoking remote method".
 * The catalogs move to a neutral module before PR 8 deletes the group ones.
 */
export function describeAgentError(error: unknown, locale?: string | null): string {
  const { code, message } = decodeGroupErrorMessage(error);
  if (!code) return message;
  const key = `error.${code}` as GroupTextKey;
  return key in GROUP_ROOM_TEXT_EN ? groupText(key, locale) : code;
}
