import { describe, expect, it } from "vitest";
import { encodeGroupErrorMessage, GROUP_ERROR_CODES } from "../../../../shared/group-errors";
import { describeGroupError, GROUP_ERROR_MESSAGES } from "./groupErrors";

const wire = (text: string) =>
  new Error(`Error invoking remote method 'group:create': Error: ${text}`);

describe("describeGroupError", () => {
  it("maps every known code to a readable English message", () => {
    for (const code of GROUP_ERROR_CODES) {
      const message = describeGroupError(wire(encodeGroupErrorMessage(code, "internal detail")));
      expect(message).toBe(GROUP_ERROR_MESSAGES[code]);
      expect(message).not.toContain("internal detail");
    }
    expect(describeGroupError(wire(encodeGroupErrorMessage("already-in-group", "x")))).toBe(
      "One of the selected chats is already in another group.",
    );
  });

  it("falls back to the raw message for unknown codes or plain errors", () => {
    // Unknown code: the store's raw text (wire prefix stripped), not a mapped message.
    expect(describeGroupError(wire("[group-error:brand-new] Something odd"))).toBe("Something odd");
    expect(describeGroupError(wire("disk full"))).toBe("disk full");
    expect(describeGroupError("plain string")).toBe("plain string");
  });
});
