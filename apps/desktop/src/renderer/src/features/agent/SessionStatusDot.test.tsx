// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStatusDot } from "./SessionStatusDot";

/** Sidebar "Needs your input": neutral dot + hand-stop, CSS ping only when motion is allowed. */
const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../styles/app.css"),
  "utf8",
).replace(/\s+/g, " ");
const activity = { running: false, needsInput: true, unread: false, failed: false };

afterEach(cleanup);

describe("SessionStatusDot needs-input", () => {
  it("is neutral with a hand-stop icon, never red", () => {
    const { container } = render(<SessionStatusDot activity={activity} />);
    const root = container.querySelector('[data-status="needs-input"]');
    expect(root).not.toBeNull();
    expect(root?.getAttribute("title")).toBe("Needs your input");
    expect(root?.querySelector("svg.tabler-icon-hand-stop")).not.toBeNull();
    expect(container.innerHTML).not.toContain("danger");
    expect(container.querySelector(".bg-fg-muted")).not.toBeNull();
  });

  it("pings through .status-ping (motion-safe), not animate-ping", () => {
    const { container } = render(<SessionStatusDot activity={activity} />);
    expect(container.innerHTML).not.toContain("animate-ping");
    expect(container.querySelectorAll(".status-ping")).toHaveLength(1);
    expect(
      css.indexOf("@media (prefers-reduced-motion: no-preference) { .status-ping { animation: status-ping"),
    ).toBeGreaterThan(-1);
    expect(css.match(/\.status-ping \{[^}]*animation/g)).toHaveLength(1);
  });

  it("keeps the purple accent out", () => {
    const { container } = render(<SessionStatusDot activity={activity} />);
    expect(container.innerHTML).not.toMatch(/accent|purple|violet/);
  });
});
