// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptSources } from "./PromptSources";

afterEach(cleanup);

describe("PromptSources", () => {
  it("keeps run references behind a compact disclosure and opens local files", async () => {
    const onOpenFile = vi.fn();
    render(
      <PromptSources
        onOpenFile={onOpenFile}
        sources={[
          { id: "file:src/main.ts", kind: "file", label: "main.ts", path: "src/main.ts" },
          {
            id: "documentation:https://react.dev",
            kind: "documentation",
            label: "react.dev",
            href: "https://react.dev",
          },
          { id: "connection:Composio", kind: "connection", label: "Composio", detail: "Slack" },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "Sources (3)" })).toBeTruthy();
    expect(screen.queryByText("Sources used")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sources (3)" }));
    expect(await screen.findByText("Sources used")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /main\.ts/ }));
    expect(onOpenFile).toHaveBeenCalledWith("src/main.ts");
    expect(screen.getByRole("link", { name: /react\.dev/ }).getAttribute("href")).toBe(
      "https://react.dev",
    );
    expect(screen.getByText("Composio")).toBeTruthy();
  });
});
