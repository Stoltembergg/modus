import { describe, expect, it } from "vitest";
import {
  AGENT_FACE_SEEDS,
  avatarEyeIndex,
  faceForAvatarSeed,
} from "../../../../shared/agent-avatar-seeds";
import { AGENT_TEMPLATES, getAgentTemplate } from "../../../../shared/agent-templates";
import {
  applyCollabPipeline,
  copyMember,
  dialogMember,
  editedMember,
  leadAfterRemoval,
  membersFromCard,
  NEW_GROUP_DEFAULT_NAME,
  NEW_GROUP_HINTS,
  type NewGroupMember,
  newGroupBlocker,
  newGroupCounter,
  newGroupCreateInput,
  newGroupMemberInput,
  nextFreeName,
  resolveNewGroupLead,
  templateMember,
} from "./newGroupModel";

const builder = getAgentTemplate("builder");
const template = (id: string) => {
  const found = getAgentTemplate(id);
  if (!found) throw new Error(`no template ${id}`);
  return found;
};
if (!builder) throw new Error("builder template missing");

function members(count: number): NewGroupMember[] {
  const list: NewGroupMember[] = [];
  for (let index = 0; index < count; index += 1) {
    list.push(templateMember(builder as NonNullable<typeof builder>, list, `k${index}`));
  }
  return list;
}

describe("newGroupModel (A4)", () => {
  it("suffixes a taken name case-insensitively: Builder, Builder 2, Builder 3", () => {
    expect(nextFreeName("Builder", [])).toBe("Builder");
    expect(nextFreeName("Builder", ["builder"])).toBe("Builder 2");
    expect(nextFreeName("Builder", ["Builder", "BUILDER 2"])).toBe("Builder 3");
    expect(members(3).map((member) => member.name)).toEqual(["Builder", "Builder 2", "Builder 3"]);
  });

  it("a copy is a normal member: no templateId, the source's fields, a suffixed name", () => {
    const copy = copyMember(
      {
        id: "agent-1",
        name: "Builder",
        role: "Fixer",
        instructions: "Fix it.",
        modelId: "m-1",
        avatarFace: "cheeky",
        avatarColor: "red",
        avatarShape: "circle",
      },
      members(1),
      "c1",
    );
    // Its face is the random face seed it starts on (never the source's eyes).
    const face = faceForAvatarSeed(copy.avatarSeed);
    expect(face).toBeDefined();
    expect(copy).toEqual({
      key: "c1",
      source: "copy",
      copiedFromAgentId: "agent-1",
      name: "Builder 2",
      role: "Fixer",
      instructions: "Fix it.",
      modelId: "m-1",
      avatarFace: face,
      avatarColor: "red",
      avatarShape: "circle",
      avatarSeed: copy.avatarSeed,
    });
    // A copied template agent on the app default takes the fallback model (it needs one now).
    expect(
      copyMember(
        {
          id: "agent-2",
          name: "X",
          role: "",
          instructions: "",
          avatarFace: "calm",
          avatarColor: "sky",
          avatarShape: "circle",
        },
        [],
        "c2",
        "m-2",
      ).modelId,
    ).toBe("m-2");
  });

  it("counts N of M and blocks Create with no folder, below 2 or above 10", () => {
    expect(newGroupCounter(0)).toBe("0 of 10");
    expect(newGroupCounter(4)).toBe("4 of 10");
    expect(newGroupCounter(11)).toBe("11 of 10");
    expect(newGroupCounter(4, "pt")).toBe("4 de 10");
    expect(newGroupCounter(4, "zh")).toBe("4 / 10");
    expect(newGroupBlocker({ workspaceId: "", members: members(3) })).toBe(NEW_GROUP_HINTS.folder);
    expect(newGroupBlocker({ workspaceId: "ws", members: members(1) })).toBe(NEW_GROUP_HINTS.min);
    expect(newGroupBlocker({ workspaceId: "ws", members: members(2) })).toBeNull();
    expect(newGroupBlocker({ workspaceId: "ws", members: members(10) })).toBeNull();
    expect(newGroupBlocker({ workspaceId: "ws", members: members(11) })).toBe(NEW_GROUP_HINTS.max);
  });

  describe("leadAfterRemoval", () => {
    const planner = template("planner");
    const reviewer = template("reviewer");

    it("moves lead to Planner when lead is removed and Planner remains", () => {
      const list = [
        templateMember(builder as NonNullable<typeof builder>, [], "k0"),
        templateMember(planner, [], "k1"),
      ];
      // k0 is lead, remove k0 -> Planner k1 becomes lead
      expect(leadAfterRemoval(list, "k0", "k0")).toBe("k1");
    });

    it("falls back to the first remaining member when no Planner remains", () => {
      const list = [
        templateMember(builder as NonNullable<typeof builder>, [], "k0"),
        templateMember(reviewer, [], "k1"),
        templateMember(builder as NonNullable<typeof builder>, [], "k2"),
      ];
      expect(leadAfterRemoval(list, "k0", "k0")).toBe("k1");
    });

    it("clears the lead only when the last member is removed", () => {
      const list = [templateMember(reviewer, [], "k0")];
      expect(leadAfterRemoval(list, "k0", "k0")).toBeNull();
    });

    it("returns leadKey unchanged when a non-lead member is removed", () => {
      const list = [
        templateMember(builder as NonNullable<typeof builder>, [], "k0"),
        templateMember(planner, [], "k1"),
      ];
      // k0 is lead, remove k1 (non-lead) -> k0 stays lead
      expect(leadAfterRemoval(list, "k1", "k0")).toBe("k0");
    });
  });

  it("editedMember keeps identity and updates editable fields", () => {
    const original = templateMember(builder as NonNullable<typeof builder>, [], "k1");
    const updated = editedMember(original, {
      name: "SuperBuilder",
      role: "Architect",
      instructions: "Build architectures.",
      modelId: "m-custom",
      avatarFace: "focused",
      avatarColor: "violet",
      avatarShape: "squircle",
    });
    expect(updated).toEqual({
      key: "k1",
      source: "template",
      templateId: "builder",
      name: "SuperBuilder",
      role: "Architect",
      instructions: "Build architectures.",
      modelId: "m-custom",
      avatarFace: "focused",
      avatarColor: "violet",
      avatarShape: "squircle",
    });
  });

  it("membersFromCard lists members matching templateId, copiedFromAgentId, or source", () => {
    const planner = template("planner");
    const p1 = templateMember(planner, [], "p1");
    const b1 = templateMember(builder as NonNullable<typeof builder>, [], "b1");
    const b2 = templateMember(builder as NonNullable<typeof builder>, [b1], "b2");
    const c1: NewGroupMember = {
      key: "c1",
      source: "copy",
      copiedFromAgentId: "agent-x",
      name: "CopyCat",
      role: "Tester",
      instructions: "",
      modelId: "m-1",
      avatarFace: "calm",
      avatarColor: "sky",
    };
    const cust1: NewGroupMember = {
      key: "cust1",
      source: "custom",
      name: "CustomOne",
      role: "Specialist",
      instructions: "",
      modelId: "m-2",
      avatarFace: "happy",
      avatarColor: "red",
    };
    const all = [p1, b1, b2, c1, cust1];

    expect(membersFromCard(all, { templateId: "builder" })).toEqual([b1, b2]);
    expect(membersFromCard(all, { copiedFromAgentId: "agent-x" })).toEqual([c1]);
    expect(membersFromCard(all, { source: "custom" })).toEqual([cust1]);
  });

  it("blocks duplicate or empty names and a non-template member without a model", () => {
    const two = members(2);
    const [first, second] = two as [NewGroupMember, NewGroupMember];
    expect(
      newGroupBlocker({ workspaceId: "ws", members: [first, { ...second, name: " builder " }] }),
    ).toBe(NEW_GROUP_HINTS.names);
    expect(newGroupBlocker({ workspaceId: "ws", members: [first, { ...second, name: " " }] })).toBe(
      NEW_GROUP_HINTS.emptyName,
    );
    const custom: NewGroupMember = { ...second, key: "x", source: "custom", modelId: "" };
    delete custom.templateId;
    expect(newGroupBlocker({ workspaceId: "ws", members: [first, custom] })).toBe(
      NEW_GROUP_HINTS.model,
    );
  });

  it("builds ONE group:create payload: templates carry templateId, the lead by final name", () => {
    const planner = AGENT_TEMPLATES.find((template) => template.suggestedLead);
    if (!planner) throw new Error("no suggested lead");
    const list = [templateMember(planner, [], "p"), ...members(1)];
    const lead = list[0] as NewGroupMember;
    lead.name = "Boss";
    expect(
      newGroupCreateInput({ name: "  ", workspaceId: "ws", members: list, leadKey: "p" }),
    ).toEqual({
      name: NEW_GROUP_DEFAULT_NAME,
      workspaceId: "ws",
      members: [
        {
          templateId: "planner",
          name: "Boss",
          role: planner.role,
          instructions: planner.instructions,
          avatarFace: planner.avatarFace,
          avatarColor: planner.avatarColor,
        },
        {
          templateId: "builder",
          name: "Builder",
          role: builder?.role,
          instructions: builder?.instructions,
          avatarFace: builder?.avatarFace,
          avatarColor: builder?.avatarColor,
        },
      ],
      leadName: "Boss",
    });
  });

  it("defaults Lead to the first member when leadKey is missing or stale", () => {
    const list = members(2);
    expect(resolveNewGroupLead(list, null)?.key).toBe("k0");
    expect(resolveNewGroupLead(list, "gone")?.key).toBe("k0");
    expect(resolveNewGroupLead(list, "k1")?.key).toBe("k1");
    expect(
      newGroupCreateInput({ name: "Crew", workspaceId: "ws", members: list, leadKey: null }),
    ).toMatchObject({ leadName: "Builder" });
  });

  it("applyCollabPipeline adds Planner → Builder → Reviewer without duplicating", () => {
    let n = 0;
    const nextKey = () => {
      n += 1;
      return `k${n}`;
    };
    const first = applyCollabPipeline(AGENT_TEMPLATES, [], nextKey);
    expect(first.map((member) => member.templateId)).toEqual(["planner", "builder", "reviewer"]);
    expect(first.map((member) => member.name)).toEqual(["Planner", "Builder", "Reviewer"]);
    const again = applyCollabPipeline(AGENT_TEMPLATES, first, nextKey);
    expect(again).toHaveLength(3);
  });
});

it("never sends work lists: dialog members carry only their role", () => {
  const member = dialogMember({ name: "Custom", role: "Builder", modelId: "m-1" }, [], "cap", {
    avatarFace: "happy",
    avatarColor: "blue",
  });
  const input = newGroupMemberInput(member);
  expect(input).toMatchObject({ name: "Custom", role: "Builder" });
  expect(input).not.toHaveProperty("capabilityIds");
  expect(input).not.toHaveProperty("supportedTaskKinds");
});

it("a copy sends its source agent id so main keeps the saved lists", () => {
  const copy = copyMember(
    {
      id: "reviewer-agent",
      name: "Reviewer",
      role: "Reviewer",
      instructions: "Review diffs.",
      modelId: "m-1",
      avatarFace: "curious",
      avatarColor: "amber",
      avatarShape: "circle",
    },
    members(1),
    "copy",
  );
  const payload = newGroupCreateInput({
    name: "Crew",
    workspaceId: "ws",
    members: [...members(1), copy],
    leadKey: "copy",
  });
  expect(payload.members[1]).toMatchObject({
    name: "Reviewer",
    copiedFromAgentId: "reviewer-agent",
  });
  expect(payload.members[1]).not.toHaveProperty("capabilityIds");
  expect(payload.members[1]?.templateId).toBeUndefined();
  expect(payload.members[0]).not.toHaveProperty("copiedFromAgentId");
});

describe("newGroupCreateInput blank-name default follows the room locale (C6)", () => {
  const list = members(2);
  const blank = { name: "   ", workspaceId: "ws", members: list, leadKey: null };
  it("pt → Novo grupo", () => {
    expect(newGroupCreateInput(blank, "pt-BR").name).toBe("Novo grupo");
  });
  it("zh → 新群组", () => {
    expect(newGroupCreateInput(blank, "zh-CN").name).toBe("新群组");
  });
  it("en and no locale → New group (unchanged)", () => {
    expect(newGroupCreateInput(blank, "en").name).toBe("New group");
    expect(newGroupCreateInput(blank).name).toBe(NEW_GROUP_DEFAULT_NAME);
    expect(NEW_GROUP_DEFAULT_NAME).toBe("New group");
  });
  it("a typed name always wins", () => {
    expect(newGroupCreateInput({ ...blank, name: " Crew " }, "pt").name).toBe("Crew");
  });
});

describe("avatar seed in the New group modal (avatar_seed)", () => {
  const SEED = "face-wink-29";
  const custom: NewGroupMember = {
    key: "k-1",
    source: "custom",
    name: "Ana",
    role: "",
    instructions: "Do.",
    modelId: "m-1",
    avatarFace: "wink",
    avatarColor: "teal",
    avatarSeed: SEED,
  };

  it("a dialog member keeps the picked seed and sends it with group:create", () => {
    const member = dialogMember(
      { name: "Ana", avatarFace: "wink", avatarSeed: SEED, modelId: "m-1" },
      [],
      "k-1",
      { avatarFace: "happy", avatarColor: "teal" },
    );
    expect(member.avatarSeed).toBe(SEED);
    expect(newGroupMemberInput(member).avatarSeed).toBe(SEED);
    // A template card added without the dialog gets no seed (drawn with its new id).
    const card = templateMember(template("planner"), [], "k-2");
    expect(card.avatarSeed).toBeUndefined();
    expect("avatarSeed" in newGroupMemberInput(card)).toBe(false);
  });

  it("an edit without touching the face keeps the seed; a new face seed replaces it; blank clears", () => {
    expect(editedMember(custom, { name: "Ana B", avatarColor: "pink" }).avatarSeed).toBe(SEED);
    expect(editedMember(custom, { name: "Ana", avatarSeed: "face-calm-40" }).avatarSeed).toBe(
      "face-calm-40",
    );
    expect(editedMember(custom, { name: "Ana", avatarSeed: null }).avatarSeed).toBeUndefined();
    expect(editedMember(custom, { name: "Ana", avatarSeed: "" }).avatarSeed).toBeUndefined();
  });

  const source = {
    id: "a-src",
    name: "Src",
    role: "Fixer",
    instructions: "Fix.",
    modelId: "m-1",
    avatarFace: "wink",
    avatarColor: "pink",
    avatarShape: "hexagon",
    avatarSeed: SEED,
  } as const;
  const FACE_SEEDS = Object.values(AGENT_FACE_SEEDS);

  it("a copy starts on a random face seed other than its source's, sent with group:create", () => {
    // random 0 → first of the pool; the source's own seed (wink) is never in it.
    const first = copyMember(source, [], "k-3", "", () => 0);
    expect(first.avatarSeed).toBe(AGENT_FACE_SEEDS.happy);
    expect(first.avatarFace).toBe("happy");
    expect(first.avatarColor).toBe("pink");
    expect(newGroupMemberInput(first).avatarSeed).toBe(AGENT_FACE_SEEDS.happy);
    // 3/8 would pick the source's seed (wink, 4th of the 8); it is not in the pool.
    expect(FACE_SEEDS[Math.floor((3 / 8) * FACE_SEEDS.length)]).toBe(SEED);
    const wouldHitSource = copyMember(source, [], "k-4", "", () => 3 / 8);
    expect(wouldHitSource.avatarSeed).not.toBe(SEED);
    expect(wouldHitSource.avatarSeed).toBe(AGENT_FACE_SEEDS.sleepy);
    // Every random value: one of the 8, never the source's.
    for (let step = 0; step < 50; step += 1) {
      const seed = copyMember(source, [], "k", "", () => step / 50).avatarSeed;
      expect(FACE_SEEDS).toContain(seed);
      expect(seed).not.toBe(SEED);
    }
  });

  it("a copy of a legacy source (no seed) avoids the face seed with its id's eyes", () => {
    // Find a legacy id whose id-derived eyes are one of the 8 sets.
    let id = "legacy-0";
    for (let n = 0; avatarEyeIndex(id) >= 8; n += 1) id = `legacy-${n}`;
    const sameEyes = FACE_SEEDS[avatarEyeIndex(id)];
    for (let step = 0; step < 40; step += 1) {
      const seed = copyMember(
        { ...source, id, avatarSeed: null },
        [],
        "k",
        "",
        () => step / 40,
      ).avatarSeed;
      expect(FACE_SEEDS).toContain(seed);
      expect(seed).not.toBe(sameEyes);
    }
  });

  it("the copy's seed is kept by an untouched edit, replaced by a picked face", () => {
    const copy = copyMember(source, [], "k-5", "", () => 0);
    expect(editedMember(copy, { name: "Src 2" }).avatarSeed).toBe(copy.avatarSeed);
    const picked = editedMember(copy, { name: "Src 2", avatarSeed: AGENT_FACE_SEEDS.calm });
    expect(picked.avatarSeed).toBe(AGENT_FACE_SEEDS.calm);
    expect(newGroupMemberInput(picked).avatarSeed).toBe(AGENT_FACE_SEEDS.calm);
  });
});
