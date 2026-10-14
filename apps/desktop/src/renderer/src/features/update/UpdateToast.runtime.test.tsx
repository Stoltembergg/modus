// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateState } from "../../../../shared/contracts";
import { UpdateToastView } from "./UpdateToast";

describe("update toast runtime presentation", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("uses a borderless SwipeToast with a 45-second timeout and preserves update actions", () => {
    vi.useFakeTimers();
    const animation = {
      finished: Promise.resolve(),
      onfinish: null as ((event: AnimationPlaybackEvent) => void) | null,
      pause: vi.fn(),
      play: vi.fn(),
      cancel: vi.fn(),
      playState: "running",
    } as unknown as Animation;
    const animate = vi.spyOn(HTMLElement.prototype, "animate").mockReturnValue(animation);
    const state: UpdateState = { status: "available", version: "0.1.8", action: "install" };
    const onAction = vi.fn();
    const onDismiss = vi.fn();

    const { container } = render(
      <UpdateToastView state={state} onAction={onAction} onDismiss={onDismiss} />,
    );

    expect(container.querySelector(".swipe-toast__title")?.textContent).toBe(
      "New version 0.1.8 available",
    );
    expect(screen.getByRole("button", { name: "Install" })).toBeTruthy();
    expect(container.querySelector(".swipe-toast")).toBeTruthy();
    expect(container.querySelector(".swipe-toast")?.getAttribute("data-fuse")).toBe("none");
    expect(container.querySelector(".swipe-toast")?.className).not.toMatch(/border/);
    expect(container.querySelector(".swipe-toast")?.className).toContain("popup-chrome");
    expect(animate).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ duration: 45_000, easing: "linear" }),
    );

    act(() => {
      animation.onfinish?.({} as AnimationPlaybackEvent);
      vi.advanceTimersByTime(540);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(container.querySelector(".swipe-toast")?.getAttribute("data-phase")).toBe("gone");
  });
});
