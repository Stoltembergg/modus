// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ModusApi } from "../../../../preload/types";
import { SettingsSidebar } from "./sections/SettingsSidebar";

function renderSidebar() {
  return render(
    <SettingsSidebar
      activeSection="general"
      onBack={() => {}}
      onQueryChange={() => {}}
      onSectionChange={() => {}}
      query=""
    />,
  );
}

function setBridge(app: Partial<ModusApi["app"]> | undefined) {
  Object.defineProperty(window, "modus", {
    configurable: true,
    value: app ? ({ app } as unknown as ModusApi) : undefined,
  });
}

describe("Settings sidebar version label", () => {
  afterEach(() => {
    cleanup();
    setBridge(undefined);
  });

  it("shows the app version reported by the bridge", async () => {
    setBridge({ platform: "linux", version: async () => "1.2.3" });
    renderSidebar();
    expect(await screen.findByText("v1.2.3")).toBeTruthy();
    expect(screen.queryByText("v0.1.0")).toBeNull();
  });

  it("renders no version line when the bridge is missing", () => {
    setBridge(undefined);
    renderSidebar();
    expect(screen.getByText("Modus Desktop")).toBeTruthy();
    expect(screen.queryByText("Modus")).toBeNull();
    expect(screen.queryByText(/^v\d/)).toBeNull();
  });

  it("renders no version line when the bridge cannot report a version", async () => {
    setBridge({ platform: "linux", version: async () => Promise.reject(new Error("no ipc")) });
    renderSidebar();
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByText("Modus Desktop")).toBeTruthy();
    expect(screen.queryByText("Modus")).toBeNull();
    expect(screen.queryByText(/^v\d/)).toBeNull();
  });
});
