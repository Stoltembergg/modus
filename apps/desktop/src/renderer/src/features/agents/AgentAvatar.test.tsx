// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_AVATAR_COLORS, AGENT_AVATAR_SHAPES } from "../../../../shared/contracts";
import { AgentAvatar } from "./AgentAvatar";
import {
  AGENT_AVATAR_ARCHIVED_FILL,
  AGENT_AVATAR_FILL,
  AGENT_AVATAR_SHAPE_MAP,
  agentAvatarPresentation,
  agentAvatarState,
  memberAvatar,
} from "./agentAvatarModel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const wrapper = () => screen.getByTestId("agent-avatar");
const packageAvatar = () => wrapper().querySelector("[data-avatar-key]");

describe("AgentAvatar adapter", () => {
  it("passes each Modus palette fill to the package renderer", () => {
    for (const color of AGENT_AVATAR_COLORS) {
      const { unmount } = render(<AgentAvatar color={color} face="happy" />);
      expect(wrapper().querySelector(".agent-avatar-body")?.getAttribute("fill")).toBe(
        AGENT_AVATAR_FILL[color],
      );
      unmount();
    }
  });

  it("explicitly maps all persisted shapes to supported package silhouettes", () => {
    expect(Object.keys(AGENT_AVATAR_SHAPE_MAP).sort()).toEqual([...AGENT_AVATAR_SHAPES].sort());
    expect(AGENT_AVATAR_SHAPE_MAP).toEqual({
      circle: "pebble",
      squircle: "squircle",
      roundedSquare: "pebble",
      hexagon: "hex",
      triangle: "wedge",
      pentagon: "cloud",
      capsule: "tablet",
      blob: "blob",
      diamond: "teardrop",
      shield: "wedge",
    });
    const supported = new Set([
      "blob",
      "pebble",
      "squircle",
      "tablet",
      "wedge",
      "hex",
      "cloud",
      "teardrop",
    ]);
    for (const shape of AGENT_AVATAR_SHAPES) {
      const mapped = AGENT_AVATAR_SHAPE_MAP[shape];
      expect(supported.has(mapped)).toBe(true);
      const { unmount } = render(<AgentAvatar color="blue" face="happy" shape={shape} />);
      expect(packageAvatar()?.getAttribute("data-avatar-shape")).toBe(mapped);
      unmount();
    }
  });

  it("maps activity and archived state to package state, fill, and pause", () => {
    expect(agentAvatarPresentation("blue", "circle", "idle", true)).toEqual({
      fill: AGENT_AVATAR_FILL.blue,
      shape: AGENT_AVATAR_SHAPE_MAP.circle,
      state: "idle",
      paused: false,
    });
    expect(agentAvatarPresentation("blue", "circle", "working", true).state).toBe("working");
    expect(agentAvatarPresentation("blue", "circle", "waiting", true).state).toBe("waiting");
    expect(agentAvatarPresentation("blue", "circle", "archived", true)).toEqual({
      fill: AGENT_AVATAR_ARCHIVED_FILL,
      shape: AGENT_AVATAR_SHAPE_MAP.circle,
      state: "idle",
      paused: true,
    });
    expect(agentAvatarPresentation("blue", "circle", "idle", false).paused).toBe(true);
  });

  it("keeps requested dimensions, class names, and final fill on the wrapper", () => {
    for (const size of [16, 20, 24, 48] as const) {
      const { unmount } = render(
        <AgentAvatar className="custom-avatar" color="coral" face="bright" size={size} />,
      );
      expect(wrapper().style.width).toBe(`${size}px`);
      expect(wrapper().style.height).toBe(`${size}px`);
      expect(wrapper().className).toContain("custom-avatar");
      expect(packageAvatar()?.getAttribute("class")).toContain("!size-full");
      expect(wrapper().querySelector(".agent-avatar-body")?.getAttribute("fill")).toBe(
        AGENT_AVATAR_FILL.coral,
      );
      unmount();
    }
  });

  it("pauses package motion when animation is disabled or archived", () => {
    const { rerender } = render(
      <AgentAvatar animated={false} color="teal" face="calm" state="working" />,
    );
    expect(wrapper().dataset.animated).toBe("false");
    expect(wrapper().dataset.paused).toBe("true");
    expect(packageAvatar()?.getAttribute("data-avatar-state")).toBe("working");

    rerender(<AgentAvatar color="teal" face="calm" state="archived" />);
    expect(wrapper().dataset.paused).toBe("true");
    expect(wrapper().querySelector(".agent-avatar-body")?.getAttribute("fill")).toBe(
      AGENT_AVATAR_ARCHIVED_FILL,
    );
  });

  it("lets the package respect the user's reduced-motion preference", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const requestFrame = vi.spyOn(window, "requestAnimationFrame");
    render(<AgentAvatar color="teal" face="calm" animated />);
    expect(window.matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it("preserves decorative and named-image semantics on the wrapper", () => {
    const { rerender } = render(<AgentAvatar color="teal" face="calm" />);
    expect(wrapper().getAttribute("aria-hidden")).toBe("true");
    rerender(<AgentAvatar color="teal" face="calm" label="Ana" />);
    expect(screen.getByRole("img", { name: "Ana" })).toBe(wrapper());
    expect(packageAvatar()?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("agentAvatarModel", () => {
  it("keeps the face and profile values stored while the renderer does not draw a face", () => {
    expect(
      memberAvatar({
        agentId: "a",
        avatarFace: "wink",
        avatarColor: "lime",
        avatarShape: "hexagon",
      }),
    ).toEqual({ face: "wink", color: "lime", shape: "hexagon" });
    render(<AgentAvatar color="lime" face="wink" />);
    expect(wrapper().dataset.face).toBe("wink");
    expect(wrapper().querySelector(".agent-avatar-eyes")).toBeNull();
    expect(wrapper().querySelector(".agent-avatar-brow")).toBeNull();
  });

  it("prefers archived status and otherwise preserves activity states", () => {
    expect(agentAvatarState(undefined, false)).toBe("idle");
    expect(agentAvatarState("working", false)).toBe("working");
    expect(agentAvatarState("waiting", false)).toBe("waiting");
    expect(agentAvatarState("waiting", true)).toBe("archived");
  });
});
