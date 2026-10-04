import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AuthState } from "../../../../../shared/auth";
import { AccountSettingsPanel, accountStatusLabel } from "./account";

const BASE: AuthState = {
  status: "signed-out",
  user: null,
  persistence: "encrypted",
  oauthProviders: [],
  pendingProvider: null,
  notice: null,
  error: null,
};

describe("Account settings", () => {
  it("labels every auth status", () => {
    expect(accountStatusLabel({ ...BASE, status: "unconfigured" })).toBe("Unavailable");
    expect(accountStatusLabel({ ...BASE, status: "awaiting-oauth" })).toBe("Waiting for browser");
    expect(accountStatusLabel({ ...BASE, status: "signed-in" })).toBe("Signed in");
    expect(accountStatusLabel(BASE)).toBe("Signed out");
  });

  it("renders the sign-in form with disabled actions until main reports its state", () => {
    const markup = renderToStaticMarkup(<AccountSettingsPanel />);
    expect(markup).toContain("Account");
    expect(markup).toContain('type="password"');
    expect(markup).toContain("Continue with GitHub");
    expect(markup).toContain("Continue with Google");
    expect(markup.match(/disabled=""/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
