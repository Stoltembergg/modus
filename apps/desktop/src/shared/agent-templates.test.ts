import { describe, expect, it } from "vitest";
import { AGENT_TEMPLATES, agentAvatarForId, getAgentTemplate } from "./agent-templates";
import { AGENT_AVATAR_COLORS, AGENT_AVATAR_FACES } from "./contracts";

describe("agent templates", () => {
  it("ships the 7 v1 templates, Planner as the suggested Lead", () => {
    expect(AGENT_TEMPLATES.map((template) => template.name)).toEqual([
      "Planner",
      "Builder",
      "Reviewer",
      "Explorer",
      "Librarian",
      "Oracle",
      "Designer",
    ]);
    expect(
      AGENT_TEMPLATES.filter((template) => template.suggestedLead).map((template) => template.id),
    ).toEqual(["planner"]);
    expect(getAgentTemplate("planner")?.role).toBe("Lead");
    expect(getAgentTemplate("nope")).toBeUndefined();
  });

  it("every template has a unique id and name, text, a valid avatar and no model", () => {
    expect(new Set(AGENT_TEMPLATES.map((template) => template.id)).size).toBe(7);
    expect(new Set(AGENT_TEMPLATES.map((template) => template.name.toLowerCase())).size).toBe(7);
    for (const template of AGENT_TEMPLATES) {
      expect(template.id).toMatch(/^[a-z]+$/);
      expect(template.role.trim()).not.toBe("");
      expect(template.description.trim()).not.toBe("");
      expect(template.description).not.toContain("\n");
      expect(template.instructions.length).toBeGreaterThan(100);
      expect(AGENT_AVATAR_FACES).toContain(template.avatarFace);
      expect(AGENT_AVATAR_COLORS).toContain(template.avatarColor);
      expect(Object.keys(template)).not.toContain("modelId");
    }
  });

  it("derives a stable, valid avatar from an id and spreads ids over faces and colors", () => {
    expect(agentAvatarForId("agent-1")).toEqual(agentAvatarForId("agent-1"));
    const faces = new Set<string>();
    const colors = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const avatar = agentAvatarForId(`agent-${index}`);
      expect(AGENT_AVATAR_FACES).toContain(avatar.avatarFace);
      expect(AGENT_AVATAR_COLORS).toContain(avatar.avatarColor);
      faces.add(avatar.avatarFace);
      colors.add(avatar.avatarColor);
    }
    expect(faces.size).toBe(AGENT_AVATAR_FACES.length);
    expect(colors.size).toBe(AGENT_AVATAR_COLORS.length);
  });
});
