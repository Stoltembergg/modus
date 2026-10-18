// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsSegmented, SwitchControl } from "./form-controls";

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

afterEach(cleanup);

describe("Settings accent (#863ff5 logo purple)", () => {
  it("the switch fills with the accent token when on and rings with the focus token", () => {
    render(<SwitchControl ariaLabel="Remember" checked onCheckedChange={() => {}} />);
    const root = screen.getByRole("switch", { name: "Remember" });
    expect(root.className).toMatch(/data-\[checked\]:bg-accent\b/);
    expect(root.className).toMatch(/focus-visible:ring-focus-ring/);
    expect(root.className).not.toMatch(/data-\[checked\]:bg-fg\b|bg-success|ring-white/);
  });

  it("selection uses the accent tint and accent text", () => {
    render(
      <SettingsSegmented
        label="Theme"
        onChange={() => {}}
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
        value="dark"
      />,
    );
    const active = screen.getByRole("button", { name: "Dark" });
    expect(active.getAttribute("aria-pressed")).toBe("true");
    expect(active.className).toContain("--accent-text");
    expect(active.querySelector("[data-settings-selected]")?.className).toContain("bg-selected");
  });

  it("no settings switch is green or monochrome anymore", () => {
    for (const file of ["./form-controls.tsx", "./sections/mcp.tsx"]) {
      const text = source(file);
      expect(text).not.toMatch(/data-checked:bg-success|data-\[checked\]:bg-fg\b/);
    }
  });

  it("the accent token is the logo purple in both new-look themes", () => {
    const css = source("../../styles/tokens-new.css");
    const matches = css.match(/--color-accent: #863ff5;/g) ?? [];
    expect(matches.length).toBe(2);
  });
});
