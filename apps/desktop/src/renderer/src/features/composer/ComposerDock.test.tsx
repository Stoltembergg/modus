// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ComposerDock } from "./ComposerDock";

afterEach(cleanup);

describe("ComposerDock", () => {
  it("keeps status rails and input inside one elevated composer surface", () => {
    render(
      <ComposerDock rails={<div data-testid="composer-status-rail">Changes</div>}>
        <div data-testid="composer-input">Prompt</div>
      </ComposerDock>,
    );

    const dock = screen.getByTestId("composer-dock");
    expect(dock.getAttribute("data-ui-surface")).toBe("raised");
    expect(dock.contains(screen.getByTestId("composer-status-rail"))).toBe(true);
    expect(dock.contains(screen.getByTestId("composer-input"))).toBe(true);
    expect(document.querySelectorAll("[data-composer-surface]")).toHaveLength(1);
  });
});
