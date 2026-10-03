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

function mountWith(state: AuthState) {
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
  return render(<AccountSettingsPanel />);
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
