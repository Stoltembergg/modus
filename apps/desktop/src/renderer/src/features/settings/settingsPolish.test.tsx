// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ModusApi } from "../../../../preload/types";
import { MOTION_EASE, reducedFade, tween } from "../../lib/motion";
import { ProviderLogo, providerLogoMotion } from "./ProviderLogo";
import { SettingsSidebar } from "./sections/SettingsSidebar";

const MOVEMENT = ["x", "y", "scale", "scaleX", "scaleY", "rotate", "width", "height"];
const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "modus", { configurable: true, value: undefined });
});

describe("Settings footer keeps the version", () => {
  it("shows the app name and the bridge version", async () => {
    Object.defineProperty(window, "modus", {
      configurable: true,
      value: { app: { platform: "linux", version: async () => "0.1.12" } } as unknown as ModusApi,
    });
    render(
      <SettingsSidebar
        activeSection="general"
        onBack={() => {}}
        onQueryChange={() => {}}
        onSectionChange={() => {}}
        query=""
      />,
    );
    expect(await screen.findByText("v0.1.12")).toBeTruthy();
    expect(screen.getByText("Modus Desktop")).toBeTruthy();
  });
});

describe("provider logos still render", () => {
  it("resolves a bundled logo into the masked glyph", async () => {
    const { container } = render(<ProviderLogo name="Anthropic" provider="anthropic" />);
    expect(screen.getByRole("img", { name: "Anthropic provider logo" })).toBeTruthy();
    // mode="wait": the loading placeholder fades out before the glyph mounts.
    await waitFor(
      () => {
        const glyph = container.querySelector<HTMLElement>('[data-logo-state="ready"] > span');
        expect(glyph?.getAttribute("style") ?? "").toMatch(/mask-image:\s*url\(/);
      },
      { timeout: 5000 },
    );
  });

  it("still renders a logo box (fallback) for an unknown provider", async () => {
    render(<ProviderLogo name="Zed Labs" provider="zz-unknown" />);
    const box = screen.getByRole("img", { name: "Zed Labs provider logo" });
    await waitFor(() => expect(box.getAttribute("data-logo-state")).not.toBe("loading"));
  });
});

describe("ProviderLogo reduced motion", () => {
  it("only fades under reduced motion (no scale), 120ms linear reducedFade", () => {
    const reduced = providerLogoMotion(true);
    for (const target of [reduced.initial, reduced.animate, reduced.exit]) {
      expect(Object.keys(target).filter((key) => MOVEMENT.includes(key))).toEqual([]);
      expect(Object.keys(target)).toContain("opacity");
    }
    expect(reduced.transition).toBe(reducedFade);
    expect(reduced.transition).toMatchObject({ duration: 0.12, ease: MOTION_EASE.linear });
  });

  it("keeps the full-motion scale-in unchanged", () => {
    expect(providerLogoMotion(false)).toEqual({
      initial: { opacity: 0, scale: 0.94 },
      animate: { opacity: 1, scale: 1 },
      exit: { opacity: 0, scale: 0.94 },
      transition: tween("base"),
    });
  });

  it("ProviderLogo takes every logo/fallback enter/exit from providerLogoMotion", () => {
    const logo = source("./ProviderLogo.tsx");
    expect(logo).toContain("providerLogoMotion(reduced)");
    expect(logo).not.toMatch(/(?:animate|initial|exit)=\{\{[^}]*scale/);
  });
});
