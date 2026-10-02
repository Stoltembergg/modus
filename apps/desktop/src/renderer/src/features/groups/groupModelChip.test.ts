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

  it("returns nothing for a room without members", () => {
    expect(
      groupModelChip({ ...base, members: [], memberModels: new Map(), draft: "" }),
    ).toBeUndefined();
  });
});
