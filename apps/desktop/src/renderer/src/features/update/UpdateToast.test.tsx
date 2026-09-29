import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { UpdateState } from "../../../../shared/contracts";
import {
  runUpdateAction,
  subscribeToUpdateState,
  type UpdateApi,
  UpdateToast,
  UpdateToastView,
} from "./UpdateToast";
import { type UpdateToastActionId, updateToastContent } from "./updateToastContent";

type ButtonProps = { children?: ReactNode; onClick?: () => void; "aria-label"?: string };

function fakeApi(initial: UpdateState = { status: "idle" }) {
  const listeners = new Set<(state: UpdateState) => void>();
  const unsubscribe = vi.fn();
  const api = {
    getState: vi.fn(async () => initial),
    install: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    restartNow: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => undefined),
    openReleasePage: vi.fn(async () => undefined),
    onStateChange: vi.fn((listener: (state: UpdateState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    }),
  } satisfies UpdateApi;
  const push = (state: UpdateState) => {
    for (const listener of listeners) listener(state);
  };
  return { api, push, unsubscribe, listeners };
}

/** The view has no hooks: call it and walk the element tree to reach the buttons. */
function buttons(node: ReactNode): ReactElement<ButtonProps>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<ButtonProps>(node)) return [];
  const own = node.type === "button" ? [node] : [];
  return [...own, ...buttons(node.props.children)];
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function renderView(state: UpdateState) {
  const { api } = fakeApi();
  const tree = UpdateToastView({
    state,
    onAction: (id) => runUpdateAction(api, id),
    onDismiss: () => runUpdateAction(api, "dismiss"),
  });
  const found = buttons(tree);
  return {
    api,
    markup: renderToStaticMarkup(tree),
    labels: found.map((button) => button.props["aria-label"] ?? textOf(button.props.children)),
    click: (label: string) => {
      const button = found.find(
        (b) => (b.props["aria-label"] ?? textOf(b.props.children)) === label,
      );
      if (!button?.props.onClick) throw new Error(`no button ${label}`);
      button.props.onClick();
    },
  };
}

const API_METHODS = ["install", "retry", "restartNow", "dismiss", "openReleasePage"] as const;

function expectOnlyCalled(api: UpdateApi, method: (typeof API_METHODS)[number]) {
  for (const name of API_METHODS) {
    expect(api[name], name).toHaveBeenCalledTimes(name === method ? 1 : 0);
  }
}

describe("update toast", () => {
  it.each([
    { status: "idle" },
    { status: "checking" },
  ] as const)("renders nothing while $status (checks and their errors are silent)", (state) => {
    expect(updateToastContent(state)).toBeNull();
    const { markup, labels } = renderView(state);
    expect(labels).toEqual([]);
    expect(markup).not.toContain("<section");
    // Only the empty, always-mounted live region.
    expect(markup).toBe('<p aria-live="polite" class="sr-only" role="status"></p>');
  });

  it("offers Install for an in-place update, and dismiss", () => {
    const view = renderView({ status: "available", version: "1.2.0", action: "install" });
    expect(view.markup).toContain("New version 1.2.0 available");
    expect(view.labels).toEqual(["Dismiss update", "Install"]);
    view.click("Install");
    expectOnlyCalled(view.api, "install");
  });

  it("offers Download (release page) when the update cannot install in place", () => {
    const view = renderView({ status: "available", version: "1.2.0", action: "download-page" });
    expect(view.markup).toContain("New version 1.2.0 available");
    expect(view.labels).toEqual(["Dismiss update", "Download"]);
    view.click("Download");
    expectOnlyCalled(view.api, "openReleasePage");
  });

  it("dismiss calls the service's dismiss (it hides that version)", () => {
    const view = renderView({ status: "available", version: "1.2.0", action: "install" });
    view.click("Dismiss update");
    expectOnlyCalled(view.api, "dismiss");
  });

  it("shows download progress without any button", () => {
    const view = renderView({ status: "downloading", version: "1.2.0", percent: 42.4 });
    expect(view.markup).toContain("Downloading 1.2.0");
    expect(view.markup).toContain('role="progressbar"');
    expect(view.markup).toContain('aria-valuenow="42.4"');
    expect(view.markup).toContain("width:42.4%");
    expect(view.markup).toContain("42%");
    expect(view.labels).toEqual([]);
    // The live region announces the title, not every percent.
    expect(view.markup).toContain('role="status">Downloading 1.2.0</p>');
  });

  it.each([
    { status: "ready", version: "1.2.0" },
    { status: "installing", version: "1.2.0" },
  ] as const)("shows the restart while $status, without buttons", (state) => {
    const view = renderView(state);
    expect(view.markup).toContain("Restarting to update…");
    expect(view.labels).toEqual([]);
  });

  it("waits for agents and offers Restart now (never stops a turn by itself)", () => {
    const view = renderView({ status: "waiting-for-agents", version: "1.2.0" });
    expect(view.markup).toContain("Restarts when the agent finishes");
    expect(view.markup).toContain("Version 1.2.0 is ready.");
    expect(view.labels).toEqual(["Restart now"]);
    view.click("Restart now");
    expectOnlyCalled(view.api, "restartNow");
  });

  it("offers Try again for a retryable failure", () => {
    const view = renderView({
      status: "failed",
      version: "1.2.0",
      retryable: true,
      action: "install",
    });
    expect(view.markup).toContain("Couldn&#x27;t update to 1.2.0");
    expect(view.labels).toEqual(["Dismiss update", "Try again"]);
    view.click("Try again");
    expectOnlyCalled(view.api, "retry");
  });

  it.each([
    { retryable: true, action: "download-page" },
    { retryable: false, action: "install" },
  ] as const)("offers Download instead when the failure carries the release page (%o)", (failure) => {
    const view = renderView({ status: "failed", version: "1.2.0", ...failure });
    expect(view.markup).toContain("Couldn&#x27;t update to 1.2.0");
    expect(view.markup).toContain("Download it from the release page.");
    expect(view.labels).toEqual(["Dismiss update", "Download"]);
    view.click("Download");
    expectOnlyCalled(view.api, "openReleasePage");
  });

  it("says the update is applied when Modus closes after the app did not quit", () => {
    const view = renderView({
      status: "failed",
      version: "1.2.0",
      retryable: true,
      action: "install",
      appliesOnQuit: true,
    });
    expect(view.markup).toContain("The update will be applied when Modus closes");
    expect(view.markup).toContain("Version 1.2.0 is ready.");
    expect(view.markup).not.toContain("Couldn");
    expect(view.labels).toEqual(["Dismiss update", "Try again"]);
    view.click("Try again");
    expectOnlyCalled(view.api, "retry");
  });

  it("uses the danger tone only for real failures", () => {
    expect(
      updateToastContent({ status: "failed", version: "1", retryable: true, action: "install" })
        ?.tone,
    ).toBe("danger");
    expect(
      updateToastContent({
        status: "failed",
        version: "1",
        retryable: true,
        action: "install",
        appliesOnQuit: true,
      })?.tone,
    ).toBe("info");
  });

  it("renders nothing without the preload API", () => {
    expect(renderToStaticMarkup(<UpdateToast api={undefined} />)).toBe("");
  });
});

describe("update state subscription", () => {
  it("shows the initial state, then pushed states", async () => {
    const { api, push } = fakeApi({ status: "available", version: "1.2.0", action: "install" });
    const seen: UpdateState[] = [];
    subscribeToUpdateState(api, (state) => seen.push(state));
    await Promise.resolve();
    push({ status: "downloading", version: "1.2.0", percent: 5 });
    expect(seen).toEqual([
      { status: "available", version: "1.2.0", action: "install" },
      { status: "downloading", version: "1.2.0", percent: 5 },
    ]);
  });

  it("ignores a late initial reply once a newer push arrived", async () => {
    const { api, push } = fakeApi({ status: "available", version: "1.2.0", action: "install" });
    const seen: UpdateState[] = [];
    subscribeToUpdateState(api, (state) => seen.push(state));
    push({ status: "installing", version: "1.2.0" });
    await Promise.resolve();
    expect(seen).toEqual([{ status: "installing", version: "1.2.0" }]);
  });

  it("unsubscribes on cleanup (unmount) and delivers nothing afterwards", async () => {
    const { api, push, unsubscribe, listeners } = fakeApi({
      status: "available",
      version: "1.2.0",
      action: "install",
    });
    const onState = vi.fn();
    const cleanup = subscribeToUpdateState(api, onState);
    expect(listeners.size).toBe(1);
    cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
    push({ status: "installing", version: "1.2.0" });
    await Promise.resolve();
    expect(onState).not.toHaveBeenCalled();
  });

  it("swallows a rejected action so the renderer never throws", async () => {
    const { api } = fakeApi();
    api.install.mockRejectedValueOnce(new Error("ipc gone"));
    expect(() => runUpdateAction(api, "install" satisfies UpdateToastActionId)).not.toThrow();
    await Promise.resolve();
    expect(api.install).toHaveBeenCalledTimes(1);
  });
});
