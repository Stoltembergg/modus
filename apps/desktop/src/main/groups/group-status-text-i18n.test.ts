import { describe, expect, it } from "vitest";
import { localizeGroupStatusBody, matchGroupStatusBody } from "../../shared/group-room-locale";
import { GROUP_STATUS_TEXT } from "./group-runtime-lib";

/**
 * C6: status bodies stay English in the DB (agents read them back), and the
 * room localises them at render time. Every body the runtime can post must be
 * recognised, or it would show in English inside a pt / zh room.
 */
describe("GROUP_STATUS_TEXT is recognised by the room catalog", () => {
  const bodies = [
    GROUP_STATUS_TEXT.failed,
    GROUP_STATUS_TEXT.aborted,
    GROUP_STATUS_TEXT.stoppedByYou,
    GROUP_STATUS_TEXT.noNextOwner,
    GROUP_STATUS_TEXT.worktreeReady("feat/c6"),
    GROUP_STATUS_TEXT.archived("Builder"),
    ...Object.values(GROUP_STATUS_TEXT.limit),
  ];

  it.each(bodies)("%s", (body) => {
    expect(matchGroupStatusBody(body)).not.toBeNull();
    expect(localizeGroupStatusBody(body, "en")).toBe(body);
    expect(localizeGroupStatusBody(body, "pt")).not.toBe(body);
    expect(localizeGroupStatusBody(body, "zh")).not.toBe(body);
  });

  it("waitingForYou goes through the legacy text path", () => {
    expect(localizeGroupStatusBody(GROUP_STATUS_TEXT.waitingForYou, "pt")).toBe("Aguardando você");
  });
});
