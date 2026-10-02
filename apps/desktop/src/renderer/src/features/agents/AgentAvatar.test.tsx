// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_AVATAR_COLORS,
  AGENT_AVATAR_FACES,
  AGENT_AVATAR_SHAPES,
} from "../../../../shared/contracts";
import { AgentAvatar } from "./AgentAvatar";
import {
  AGENT_AVATAR_ARCHIVED_FILL,
  AGENT_AVATAR_FILL,
  agentAvatarState,
  agentAvatarTiming,
  memberAvatar,
} from "./agentAvatarModel";

afterEach(cleanup);

const avatar = () => screen.getByTestId("agent-avatar");
const bodyFill = () => avatar().querySelector(".agent-avatar-fill")?.getAttribute("fill");

describe("AgentAvatar", () => {
  it("draws every face in every color at 16, 20 and 48 px", () => {
    for (const face of AGENT_AVATAR_FACES) {
      for (const color of AGENT_AVATAR_COLORS) {
        for (const size of [16, 20, 48] as const) {
          const { unmount } = render(<AgentAvatar color={color} face={face} size={size} />);
          const svg = avatar().querySelector("svg");
          expect(svg?.getAttribute("width")).toBe(String(size));
          expect(avatar().dataset.face).toBe(face);
          expect(bodyFill()).toBe(AGENT_AVATAR_FILL[color]);
          expect(avatar().querySelector(".agent-avatar-eyes")?.childElementCount).toBeGreaterThan(
            0,
          );
          unmount();
        }
      }
    }
    expect(new Set(Object.values(AGENT_AVATAR_FILL)).size).toBe(AGENT_AVATAR_COLORS.length);
  });

  it("supports the compact 24 px header size", () => {
    render(<AgentAvatar color="blue" face="happy" size={24} />);
    expect(avatar().dataset.size).toBe("24");
    expect(avatar().querySelector("svg")?.getAttribute("width")).toBe("24");
  });

  it("renders every silhouette shape", () => {
    for (const shape of AGENT_AVATAR_SHAPES) {
      const { unmount } = render(<AgentAvatar color="blue" face="happy" shape={shape} size={20} />);
      expect(avatar().dataset.shape).toBe(shape);
      expect(avatar().querySelector(".agent-avatar-fill")).not.toBeNull();
      unmount();
    }
  });

  it("draws triangle and pentagon as vector silhouettes at compact and header sizes", () => {
    expect(AGENT_AVATAR_SHAPES).toContain("triangle");
    expect(AGENT_AVATAR_SHAPES).toContain("pentagon");

    for (const shape of ["triangle", "pentagon"] as const) {
      for (const size of [20, 24] as const) {
        const { unmount } = render(
          <AgentAvatar
            color="blue"
            face="happy"
            shape={shape as (typeof AGENT_AVATAR_SHAPES)[number]}
            size={size}
          />,
        );
        const fill = avatar().querySelector(".agent-avatar-fill");
        expect(fill?.tagName.toLowerCase()).toBe("polygon");
        expect(avatar().querySelector("svg")?.getAttribute("width")).toBe(String(size));
        unmount();
      }
    }
  });

  it("idle and working animate; waiting adds the amber ring and brow; archived is grey", () => {
    const { rerender } = render(<AgentAvatar color="blue" face="happy" seed="a-1" />);
    expect(avatar().dataset.state).toBe("idle");
    expect(avatar().querySelector(".agent-avatar-ring")).toBeNull();
    expect(avatar().style.getPropertyValue("--agent-avatar-delay")).toBe(
      agentAvatarTiming("a-1").delay,
    );

    rerender(<AgentAvatar color="blue" face="happy" state="working" />);
    expect(avatar().dataset.state).toBe("working");

    rerender(<AgentAvatar color="blue" face="happy" state="waiting" />);
    expect(avatar().querySelector(".agent-avatar-ring")?.getAttribute("stroke")).toBe("#fbbf24");
    expect(avatar().querySelector(".agent-avatar-brow")).not.toBeNull();

    rerender(<AgentAvatar color="blue" face="happy" state="archived" />);
    expect(avatar().dataset.state).toBe("archived");
    expect(bodyFill()).toBe(AGENT_AVATAR_ARCHIVED_FILL);
    expect(avatar().querySelector(".agent-avatar-ring")).toBeNull();
  });

  it("every animated part is static under reduced motion (class + app.css media rule)", () => {
    render(<AgentAvatar color="pink" face="bright" state="waiting" />);
    const animated = avatar().querySelectorAll(
      ".agent-avatar-body, .agent-avatar-eyes, .agent-avatar-ring",
    );
    expect(animated).toHaveLength(3);
    for (const part of animated) {
      expect(part.getAttribute("class")).toContain("motion-reduce:animate-none");
    }
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../styles/app.css"),
      "utf8",
    );
    const block = css.slice(css.indexOf("AgentAvatar (A3)"));
    // The only animations are the keyframes above: no JS timers drive the avatar.
    expect(block).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.agent-avatar \.agent-avatar-body,\s*\.agent-avatar \.agent-avatar-eyes,\s*\.agent-avatar \.agent-avatar-ring \{\s*animation: none;/,
    );
    for (const name of ["float", "blink", "look", "bounce", "pulse"]) {
      expect(block).toContain(`@keyframes agent-avatar-${name}`);
    }
  });

  it("is decorative next to a name, an image with a label", () => {
    const { rerender } = render(<AgentAvatar color="teal" face="calm" />);
    expect(avatar().getAttribute("aria-hidden")).toBe("true");
    rerender(<AgentAvatar color="teal" face="calm" label="Ana" />);
    expect(screen.getByRole("img", { name: "Ana" })).toBe(avatar());
  });
});

describe("agentAvatarModel", () => {
  it("archived wins, then the room activity", () => {
    expect(agentAvatarState(undefined, false)).toBe("idle");
    expect(agentAvatarState("working", false)).toBe("working");
    expect(agentAvatarState("waiting", false)).toBe("waiting");
    expect(agentAvatarState("waiting", true)).toBe("archived");
  });

  it("uses the stored face / color / shape, else the id-derived default", () => {
    expect(
      memberAvatar({
        agentId: "a",
        avatarFace: "wink",
        avatarColor: "lime",
        avatarShape: "hexagon",
      }),
    ).toEqual({
      face: "wink",
      color: "lime",
      shape: "hexagon",
    });
    const derived = memberAvatar({ agentId: "a" });
    expect(AGENT_AVATAR_FACES).toContain(derived.face);
    expect(AGENT_AVATAR_COLORS).toContain(derived.color);
    expect(AGENT_AVATAR_SHAPES).toContain(derived.shape);
  });

  it("varies timing per seed within 0..-3.9 s and 3.6..4.4 s", () => {
    const timings = Array.from({ length: 50 }, (_, index) => agentAvatarTiming(`agent-${index}`));
    expect(new Set(timings.map((timing) => timing.delay)).size).toBeGreaterThan(5);
    for (const { delay, blink } of timings) {
      expect(Number.parseFloat(delay)).toBeLessThanOrEqual(0);
      expect(Number.parseFloat(delay)).toBeGreaterThanOrEqual(-3.9);
      expect(Number.parseFloat(blink)).toBeGreaterThanOrEqual(3.6);
      expect(Number.parseFloat(blink)).toBeLessThanOrEqual(4.4);
    }
  });
});
