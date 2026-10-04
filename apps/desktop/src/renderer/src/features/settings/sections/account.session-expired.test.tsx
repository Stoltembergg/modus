// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthState } from "../../../../../shared/auth";
import { AccountSettingsPanel } from "./account";

const STATE: AuthState = {
  status: "signed-out",
  user: null,
  persistence: "encrypted",
  oauthProviders: ["github", "google"],
  pendingProvider: null,
  notice: "session-expired",
  error: null,
};

function mountWith(state: AuthState, modusStatus?: "ready" | "loading" | "unavailable") {
  (window as unknown as { modus: unknown }).modus = {
    auth: {
      getState: vi.fn(async () => state),
      onStateChange: vi.fn(() => () => undefined),
    },
    billing: {
      getState: vi.fn(async () => ({ status: "signed-out" })),
      onStateChange: vi.fn(() => () => undefined),
    },
  };
  return render(<AccountSettingsPanel modusStatus={modusStatus} />);
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { modus?: unknown }).modus;
});

describe("Account: Modus session expired (B4b)", () => {
  it("shows the session-expired message after the router session could not be refreshed", async () => {
    mountWith(STATE);
    expect((await screen.findByRole("status")).textContent).toBe(
      "Your session expired. Please sign in again.",
    );
  });

  it("does not show it for an ordinary sign-out", async () => {
    mountWith({ ...STATE, notice: null });
    await screen.findByText("Signed out");
    expect(screen.queryByText("Your session expired. Please sign in again.")).toBeNull();
  });
});

describe("Account: Modus status (L3b0)", () => {
  const SIGNED_IN: AuthState = {
    ...STATE,
    status: "signed-in",
    notice: null,
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      email: "ana@example.com",
      displayName: "Ana",
      avatarUrl: null,
      emailConfirmed: true,
      provider: "email",
    },
  };

  it("shows Modus unavailable as a status row (no modal) when the main process says so", async () => {
    mountWith(SIGNED_IN, "unavailable");
    expect(await screen.findByText("Modus models")).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.getByText(/didn't answer/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows Available when ready, and no row when Modus is off", async () => {
    const { unmount } = mountWith(SIGNED_IN, "ready");
    expect(await screen.findByText("Modus models")).toBeTruthy();
    expect(screen.getByText("Available")).toBeTruthy();
    unmount();
    mountWith(SIGNED_IN);
    await screen.findByText("Remember me");
    expect(screen.queryByText("Modus models")).toBeNull();
  });
});
