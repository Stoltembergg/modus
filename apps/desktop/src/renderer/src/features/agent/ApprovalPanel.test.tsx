// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionRequest } from "../../../../shared/contracts";
import { ApprovalPanel } from "./ApprovalPanel";

afterEach(() => cleanup());

const request: PermissionRequest = {
  id: "p1",
  sessionId: "s1",
  action: "shell.execute",
  target: "  rm -rf build  ",
  reason: "Clean build output",
};

describe("ApprovalPanel (adapter)", () => {
  it("renders the permission request with the original copy", () => {
    render(<ApprovalPanel onDecide={vi.fn()} request={request} />);
    expect(screen.getByRole("region", { name: "Tool approval" })).toBeTruthy();
    expect(screen.getByText("Allow running this command?")).toBeTruthy();
    expect(screen.getByText("shell.execute")).toBeTruthy();
    expect(screen.getByText("rm -rf build")).toBeTruthy();
    expect(screen.getByText("Yes, allow this time")).toBeTruthy();
    expect(screen.getByText("Yes, always allow in this project")).toBeTruthy();
    expect(screen.getByText("No, deny this request")).toBeTruthy();
  });

  it("Submit sends allow-once by default with the original request", async () => {
    const onDecide = vi.fn();
    render(<ApprovalPanel onDecide={onDecide} request={request} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Submit/ }));
    });
    expect(onDecide).toHaveBeenCalledWith(request, "allow-once");
  });

  it("key 2 + Enter sends allow-workspace", async () => {
    const onDecide = vi.fn();
    render(<ApprovalPanel onDecide={onDecide} request={request} />);
    const panel = screen.getByRole("region");
    fireEvent.keyDown(panel, { key: "2" });
    await act(async () => {
      fireEvent.keyDown(panel, { key: "Enter" });
    });
    expect(onDecide).toHaveBeenCalledWith(request, "allow-workspace");
  });

  it("Deny, Escape and option 3 send deny", async () => {
    for (const [index, run] of [
      () => fireEvent.click(screen.getByRole("button", { name: /^Deny/ })),
      () => fireEvent.keyDown(screen.getByRole("region"), { key: "Escape" }),
      () => fireEvent.click(screen.getByRole("button", { name: /Submit/ })),
    ].entries()) {
      const onDecide = vi.fn();
      render(<ApprovalPanel onDecide={onDecide} request={request} />);
      if (index === 2) fireEvent.keyDown(screen.getByRole("region"), { key: "3" });
      await act(async () => run());
      expect(onDecide).toHaveBeenCalledWith(request, "deny");
      cleanup();
    }
  });

  it("falls back to the action when the target is blank", () => {
    render(<ApprovalPanel onDecide={vi.fn()} request={{ ...request, target: "  " }} />);
    expect(screen.getAllByText("shell.execute")).toHaveLength(2);
  });
});

describe("ApprovalPanel expiry and app-generated summary", () => {
  const code = "document.querySelector('#go')?.click();\n  return  `ok`; // \u00e9";
  const cdpRequest: PermissionRequest = {
    id: "p2",
    sessionId: "s1",
    action: "browser.control",
    target: "{}",
    reason: "agent text that must not drive the card",
    summary: "Run JavaScript in tab tab-2",
    details: code,
    expiresAt: 10_000,
  };

  it("shows the expired state and disables Submit once expiresAt passes", async () => {
    const onDecide = vi.fn();
    render(<ApprovalPanel now={() => 20_000} onDecide={onDecide} request={cdpRequest} />);
    expect(screen.getByText("Expired")).toBeTruthy();
    const submit = screen.getByRole("button", { name: /Submit/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("flips to expired when the main process reports the request inactive", async () => {
    const onDecide = vi
      .fn()
      .mockRejectedValue(new Error("Permission request is no longer active."));
    render(<ApprovalPanel now={() => 0} onDecide={onDecide} request={cdpRequest} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Submit/ }));
    });
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(screen.queryByText(/no longer active/)).toBeNull();
  });

  it("shows the app summary and the exact code behind Show details", () => {
    render(<ApprovalPanel now={() => 0} onDecide={vi.fn()} request={cdpRequest} />);
    expect(screen.getByText("Run JavaScript in tab tab-2")).toBeTruthy();
    expect(screen.queryByText(/agent text/)).toBeNull();
    expect(screen.queryByTestId("approval-details")).toBeNull();
    fireEvent.click(screen.getByTestId("approval-details-toggle"));
    expect(screen.getByTestId("approval-details").textContent).toBe(code);
  });
});
