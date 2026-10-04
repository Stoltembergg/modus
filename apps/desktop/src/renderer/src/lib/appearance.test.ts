// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppearanceState } from "../../../shared/appearance";
import { initAppearanceAttributes } from "./appearance";

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.transparency;
});

describe("data-transparency sync", () => {
  it("applies the initial mode and every later change from main", () => {
    let listener: ((state: AppearanceState) => void) | undefined;
    vi.stubGlobal("modus", {
      app: {
        appearance: {
          initial: { glassMode: "full" },
          onChange: (handler: (state: AppearanceState) => void) => {
            listener = handler;
            return () => undefined;
          },
        },
      },
    });
    initAppearanceAttributes();
    expect(document.documentElement.dataset.transparency).toBe("full");
    listener?.({ glassMode: "off" } as AppearanceState);
    expect(document.documentElement.dataset.transparency).toBe("off");
  });
});
