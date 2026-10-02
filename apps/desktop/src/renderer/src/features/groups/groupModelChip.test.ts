import { describe, expect, it } from "vitest";
import { groupModelChip, mentionedSessionIds, modelDisplayName } from "./groupModelChip";

const members = [
  { sessionId: "lead", title: "Lead" },
  { sessionId: "dev", title: "Dev" },
  { sessionId: "qa", title: "QA" },
  { sessionId: "old", title: "Old" },
];
const models = [
  { id: "gpt-5", name: "GPT-5" },
  { id: "sonnet", name: "Claude Sonnet" },
];
const memberModels = new Map<string, string | undefined>([
  ["lead", "gpt-5"],
  ["dev", "sonnet"],
  ["qa", "gpt-5"],
  ["old", undefined],
]);
const base = { members, memberModels, models, leadSessionId: "lead", locale: "en" };

describe("groupModelChip", () => {
  it("shows the mentioned agent's model for a single mention", () => {
    const chip = groupModelChip({ ...base, draft: "@Dev please fix it" });
    expect(chip?.kind).toBe("single");
    expect(chip?.label).toBe("Claude Sonnet");
    expect(chip?.tooltip).toBe("Dev: Claude Sonnet");
  });

  it("shows 'N models' and lists every agent in the tooltip for several mentions", () => {
    const chip = groupModelChip({ ...base, draft: "@Dev and @QA, review" });
    expect(chip?.kind).toBe("multiple");
    expect(chip?.label).toBe("2 models");
    expect(chip?.tooltip).toBe("Dev: Claude Sonnet\nQA: GPT-5");
    expect(groupModelChip({ ...base, locale: "pt-BR", draft: "@Dev @QA" })?.label).toBe(
      "2 modelos",
    );
    expect(groupModelChip({ ...base, locale: "zh-CN", draft: "@Dev @QA" })?.label).toBe("2 个模型");
  });

  it("shows the shared model name when every mentioned agent uses the same model", () => {
    const chip = groupModelChip({ ...base, draft: "@Lead @QA" });
    expect(chip?.kind).toBe("multiple");
    expect(chip?.label).toBe("GPT-5");
    expect(chip?.tooltip).toBe("Lead: GPT-5\nQA: GPT-5");
  });

  it("counts a repeated mention once", () => {
    expect(mentionedSessionIds("@Dev @Dev", members)).toEqual(["dev"]);
    expect(groupModelChip({ ...base, draft: "@Dev then @Dev" })?.kind).toBe("single");
  });

  it("falls back to the Lead's model without promising who answers", () => {
    const chip = groupModelChip({ ...base, draft: "hello team" });
    expect(chip?.kind).toBe("lead");
    expect(chip?.label).toBe("GPT-5");
    expect(chip?.tooltip).toBe("Lead answers by default\nLead: GPT-5");
    expect(groupModelChip({ ...base, locale: "pt-BR", draft: "" })?.tooltip).toContain(
      "Lead responde por padrão",
    );
    expect(groupModelChip({ ...base, locale: "zh", draft: "" })?.tooltip.split("\n")[0]).not.toBe(
      "Lead answers by default",
    );
  });

  it("labels an agent without modelId as the default model", () => {
    const chip = groupModelChip({ ...base, draft: "@Old" });
    expect(chip?.label).toBe("Default model");
    expect(groupModelChip({ ...base, locale: "pt-BR", draft: "@Old" })?.label).toBe(
      "Modelo padrão",
    );
    expect(modelDisplayName("  ", models, "en")).toBe("Default model");
  });

  it("shows the raw id for an unknown model", () => {
    const chip = groupModelChip({
      ...base,
      memberModels: new Map([...memberModels, ["dev", "custom/model-x"]]),
      draft: "@Dev",
    });
    expect(chip?.label).toBe("custom/model-x");
  });

  it("describes the active members when the room has no Lead", () => {
    const chip = groupModelChip({
      ...base,
      leadSessionId: undefined,
      archivedSessionIds: new Set(["old"]),
      draft: "",
    });
    expect(chip?.kind).toBe("noLead");
    expect(chip?.label).toBe("2 models");
    expect(chip?.tooltip.split("\n")).toEqual([
      "No Lead: the room picks who answers",
      "Lead: GPT-5",
      "Dev: Claude Sonnet",
      "QA: GPT-5",
    ]);
  });

  it("treats a Lead id that is not a member as no Lead", () => {
    const chip = groupModelChip({ ...base, leadSessionId: "gone", draft: "" });
    expect(chip?.kind).toBe("noLead");
  });

  it("thread reply without @ uses the replied-to author, before the room mode", () => {
    const chip = groupModelChip({
      ...base,
      mode: "coordinator",
      replyAuthorSessionId: "dev",
      draft: "and the tests?",
    });
    expect(chip).toMatchObject({ kind: "reply", rule: "reply", label: "Claude Sonnet" });
    expect(chip?.tooltip).toBe("Reply goes to the message author\nDev: Claude Sonnet");
    expect(chip?.targets).toEqual(["dev"]);
    // A mention still wins over the reply.
    expect(
      groupModelChip({ ...base, replyAuthorSessionId: "dev", draft: "@QA look" })?.targets,
    ).toEqual(["qa"]);
  });

  it("thread reply to an archived author warns that nobody will answer", () => {
    const chip = groupModelChip({
      ...base,
      archivedSessionIds: new Set(["dev"]),
      replyAuthorSessionId: "dev",
      draft: "ok?",
    });
    expect(chip).toMatchObject({ kind: "nobody", warning: true, label: "Archived", targets: [] });
    expect(chip?.tooltip.split("\n")[0]).toBe(
      "Nobody will answer. Mention an active member or unarchive the agent",
    );
  });

  it("thread reply to an author who left the room: nobody (no fallback), like the runtime", () => {
    const chip = groupModelChip({ ...base, replyAuthorSessionId: "gone", draft: "ok?" });
    expect(chip).toMatchObject({ kind: "nobody", label: "No recipient", targets: [] });
  });

  it("coordinator mode: the Lead, or an amber warning when the Lead is archived", () => {
    expect(groupModelChip({ ...base, mode: "coordinator", draft: "plan it" })).toMatchObject({
      kind: "lead",
      rule: "coordinator",
      label: "GPT-5",
      tooltip: "Coordinator mode: the Lead answers\nLead: GPT-5",
    });
    const archived = groupModelChip({
      ...base,
      mode: "coordinator",
      archivedSessionIds: new Set(["lead"]),
      draft: "plan it",
    });
    expect(archived).toMatchObject({ kind: "nobody", warning: true, label: "Lead archived" });
    expect(archived?.tooltip).toBe(
      "Nobody will answer. Mention an active member or unarchive the Lead",
    );
    const pt = groupModelChip({
      ...base,
      locale: "pt-BR",
      mode: "coordinator",
      archivedSessionIds: new Set(["lead"]),
      draft: "",
    });
    expect(pt?.label).toBe("Lead arquivado");
    expect(pt?.tooltip).toBe(
      "Ninguém vai responder. Mencione um membro ativo ou desarquive o Lead",
    );
  });

  it("autonomous mode with an archived Lead: no-Lead case, active members only", () => {
    const chip = groupModelChip({
      ...base,
      archivedSessionIds: new Set(["lead", "old"]),
      draft: "",
    });
    expect(chip?.kind).toBe("noLead");
    expect(chip?.targets).toEqual(["dev", "qa"]);
    expect(chip?.label).toBe("2 models");
  });

  it("counts only ACTIVE mentioned members; all archived → amber 'Archived'", () => {
    const mixed = groupModelChip({
      ...base,
      archivedSessionIds: new Set(["qa"]),
      draft: "@Dev @QA go",
    });
    expect(mixed).toMatchObject({ kind: "single", label: "Claude Sonnet", targets: ["dev"] });
    expect(mixed?.tooltip).toBe("Dev: Claude Sonnet\nArchived, will not be woken: QA");
    const all = groupModelChip({
      ...base,
      archivedSessionIds: new Set(["dev", "qa"]),
      draft: "@Dev @QA go",
    });
    expect(all).toMatchObject({ kind: "nobody", warning: true, label: "Archived", targets: [] });
    expect(
      groupModelChip({ ...base, locale: "zh", archivedSessionIds: new Set(["dev"]), draft: "@Dev" })
        ?.label,
    ).toBe("已归档");
  });

  it("every room is archived: nobody", () => {
    const chip = groupModelChip({
      ...base,
      archivedSessionIds: new Set(["lead", "dev", "qa", "old"]),
      draft: "hi",
    });
    expect(chip).toMatchObject({ kind: "nobody", label: "Archived" });
  });

  it("returns nothing for a room without members", () => {
    expect(
      groupModelChip({ ...base, members: [], memberModels: new Map(), draft: "" }),
    ).toBeUndefined();
  });
});
