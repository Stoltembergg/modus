// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionsPage } from "./ConnectionsPage";

vi.mock("./sections/integrations", () => ({
  IntegrationsSettingsPanel: ({ standalone }: { standalone?: boolean }) => (
    <div data-testid="composio-integrations" data-standalone={String(Boolean(standalone))} />
  ),
}));

afterEach(cleanup);

describe("ConnectionsPage", () => {
  it("exposes the existing Composio integration flow as a first-level surface", () => {
    render(<ConnectionsPage />);

    expect(screen.getByTestId("connections-page").getAttribute("data-shell-layer")).toBe(
      "connections-page",
    );
    expect(screen.getByTestId("composio-integrations").getAttribute("data-standalone")).toBe(
      "true",
    );
  });
});
