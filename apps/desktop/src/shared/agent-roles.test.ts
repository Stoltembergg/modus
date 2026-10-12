import { describe, expect, it } from "vitest";
import {
  AGENT_ROLES,
  CUSTOM_ROLE_CAPABILITIES,
  capabilitiesForRole,
  derivedRoleId,
  describeCapabilities,
  effectiveCapabilities,
  hasCustomWorkTypes,
  roleIdForLabel,
} from "./agent-roles";
import { getAgentTemplate } from "./agent-templates";

describe("agent roles", () => {
  it("maps every role to exactly the approved work lists", () => {
    expect(
      Object.fromEntries(AGENT_ROLES.map((role) => [role.label, capabilitiesForRole(role.id)])),
    ).toEqual({
      Lead: {
        capabilityIds: ["plan"],
        supportedTaskKinds: ["code", "docs", "design", "review", "research", "question"],
      },
      Builder: { capabilityIds: ["implement", "verify"], supportedTaskKinds: ["code"] },
      Reviewer: { capabilityIds: ["review"], supportedTaskKinds: ["code", "review"] },
      Explorer: {
        capabilityIds: ["research"],
        supportedTaskKinds: ["code", "research", "question"],
      },
      Librarian: {
        capabilityIds: ["research", "docs"],
        supportedTaskKinds: ["docs", "research", "question"],
      },
      Advisor: {
        capabilityIds: ["plan", "review", "research"],
        supportedTaskKinds: ["code", "design", "review", "research", "question"],
      },
      Designer: { capabilityIds: ["implement", "review"], supportedTaskKinds: ["design"] },
      Custom: {
        capabilityIds: ["research", "docs"],
        supportedTaskKinds: ["docs", "research", "question"],
      },
    });
    // Known roles read their template, so the two never drift.
    for (const role of AGENT_ROLES.filter((r) => r.templateId)) {
      const template = getAgentTemplate(role.templateId ?? "");
      expect(capabilitiesForRole(role.id)).toEqual({
        capabilityIds: template?.capabilityIds,
        supportedTaskKinds: template?.supportedTaskKinds,
      });
    }
  });

  it("Custom never implements, reviews or takes code tasks", () => {
    expect(CUSTOM_ROLE_CAPABILITIES.capabilityIds).not.toContain("implement");
    expect(CUSTOM_ROLE_CAPABILITIES.capabilityIds).not.toContain("review");
    expect(CUSTOM_ROLE_CAPABILITIES.supportedTaskKinds).not.toContain("code");
    expect(capabilitiesForRole("custom")).toEqual(CUSTOM_ROLE_CAPABILITIES);
    // A copy: changing it never changes the shared value.
    capabilitiesForRole("custom").capabilityIds.push("implement");
    expect(CUSTOM_ROLE_CAPABILITIES.capabilityIds).toEqual(["research", "docs"]);
  });

  it("matches labels and template names, ignoring case and spaces; anything else is Custom", () => {
    expect(roleIdForLabel("Lead")).toBe("lead");
    expect(roleIdForLabel("  planner ")).toBe("lead");
    expect(roleIdForLabel("ORACLE")).toBe("advisor");
    expect(roleIdForLabel("Advisor")).toBe("advisor");
    expect(roleIdForLabel("Builder")).toBe("builder");
    expect(roleIdForLabel("Generalist")).toBe("custom");
    expect(roleIdForLabel("Security reviewer")).toBe("custom");
    expect(roleIdForLabel("")).toBe("custom");
    expect(roleIdForLabel(undefined)).toBe("custom");
  });

  it("derives empty lists from the template, then the label, else Custom; saved lists win", () => {
    expect(derivedRoleId({ role: "Reviewer", templateId: "builder" })).toBe("builder");
    expect(derivedRoleId({ role: "Reviewer" })).toBe("reviewer");
    expect(derivedRoleId({ role: "Release notes" })).toBe("custom");
    expect(
      effectiveCapabilities({ role: "Builder", capabilityIds: [], supportedTaskKinds: [] }),
    ).toEqual(capabilitiesForRole("builder"));
    // One empty list routes nothing typed either, so it is derived too.
    expect(
      effectiveCapabilities({ role: "Builder", capabilityIds: ["docs"], supportedTaskKinds: [] }),
    ).toEqual(capabilitiesForRole("builder"));
    expect(
      effectiveCapabilities({
        role: "Builder",
        capabilityIds: ["docs"],
        supportedTaskKinds: ["docs"],
      }),
    ).toEqual({ capabilityIds: ["docs"], supportedTaskKinds: ["docs"] });
  });

  it("flags hand-picked lists only when they match neither the label's role nor the template", () => {
    const builder = capabilitiesForRole("builder");
    expect(hasCustomWorkTypes({ role: "Builder", ...builder })).toBe(false);
    expect(hasCustomWorkTypes({ role: "Implementer", templateId: "builder", ...builder })).toBe(
      false,
    );
    expect(hasCustomWorkTypes({ role: "Builder", capabilityIds: [], supportedTaskKinds: [] })).toBe(
      false,
    );
    expect(
      hasCustomWorkTypes({
        role: "Builder",
        capabilityIds: ["verify"],
        supportedTaskKinds: ["code"],
      }),
    ).toBe(true);
    expect(hasCustomWorkTypes({ role: "Notes", ...CUSTOM_ROLE_CAPABILITIES })).toBe(false);
  });

  it("describes the work in plain sentences, without middle dots", () => {
    expect(describeCapabilities(capabilitiesForRole("builder"))).toBe(
      "Handles code tasks. Implements and verifies.",
    );
    expect(describeCapabilities(capabilitiesForRole("reviewer"))).toBe(
      "Handles code and review tasks. Reviews.",
    );
    expect(describeCapabilities(capabilitiesForRole("advisor"))).toBe(
      "Handles code, design, review, research and question tasks. Plans, reviews and researches.",
    );
    expect(describeCapabilities(CUSTOM_ROLE_CAPABILITIES)).toBe(
      "Handles docs, research and question tasks. Researches and writes docs.",
    );
    expect(describeCapabilities({ capabilityIds: [], supportedTaskKinds: [] })).toBe(
      "Handles untyped tasks only.",
    );
    for (const role of AGENT_ROLES) {
      expect(describeCapabilities(capabilitiesForRole(role.id))).not.toMatch(/[·•]/);
    }
  });
});
