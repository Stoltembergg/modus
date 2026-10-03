import { describe, expect, it, vi } from "vitest";
import {
  createDeepLinkRouter,
  findDeepLinkInArgv,
  parseDeepLink,
  registerModusProtocol,
} from "./deep-link";

describe("parseDeepLink", () => {
  it("parses the auth callback with code in the query and state in the fragment", () => {
    const link = parseDeepLink("modus://auth/callback?code=abc#state=xyz");
    expect(link?.kind).toBe("auth-callback");
    if (link?.kind !== "auth-callback") return;
    expect(link.query.get("code")).toBe("abc");
    expect(link.fragment.get("state")).toBe("xyz");
  });

  it("parses billing returns and keeps only known statuses", () => {
    expect(parseDeepLink("modus://billing/return?status=success")).toEqual({
      kind: "billing-return",
      status: "success",
    });
    expect(parseDeepLink("modus://billing/return/")).toEqual({
      kind: "billing-return",
      status: null,
    });
    expect(parseDeepLink("modus://billing/return?status=<script>")).toEqual({
      kind: "billing-return",
      status: null,
    });
  });

  it.each([
    "https://auth/callback?code=a",
    "modus://evil/callback",
    "modus://auth/callback/extra",
    "modus://user:pw@auth/callback",
    "modus://auth:8080/callback",
    "modus://billing/return#x",
    "modus:auth/callback",
    `modus://auth/callback?code=${"a".repeat(5000)}`,
    42,
    undefined,
  ])("rejects %s", (raw) => {
    expect(parseDeepLink(raw)).toBeNull();
  });

  it("finds the link among Windows/Linux argv", () => {
    expect(findDeepLinkInArgv(["/opt/Modus/modus", "--flag", "modus://billing/return"])).toBe(
      "modus://billing/return",
    );
    expect(findDeepLinkInArgv(["/opt/Modus/modus", "--flag"])).toBeUndefined();
  });
});

describe("createDeepLinkRouter", () => {
  it("queues links until ready, then routes and focuses", () => {
    const handlers = { onAuthCallback: vi.fn(), onBillingReturn: vi.fn(), focus: vi.fn() };
    const router = createDeepLinkRouter(handlers);
    expect(router.handle("modus://billing/return?status=cancel")).toBe(true);
    expect(handlers.onBillingReturn).not.toHaveBeenCalled();
    router.markReady();
    expect(handlers.onBillingReturn).toHaveBeenCalledWith({
      kind: "billing-return",
      status: "cancel",
    });
    expect(router.handle("modus://auth/callback?code=c#state=s")).toBe(true);
    expect(handlers.onAuthCallback).toHaveBeenCalledTimes(1);
    expect(handlers.focus).toHaveBeenCalledTimes(2);
    expect(router.handle("modus://nope")).toBe(false);
    expect(handlers.focus).toHaveBeenCalledTimes(2);
  });
});

describe("registerModusProtocol", () => {
  const proc = (env: Record<string, string> = {}) => ({
    defaultApp: true,
    execPath: "/usr/bin/electron",
    argv: ["/usr/bin/electron", "out/main/index.js"],
    env,
  });

  it("registers packaged builds", () => {
    const app = { isPackaged: true, setAsDefaultProtocolClient: vi.fn(() => true) };
    expect(registerModusProtocol(app, proc())).toBe(true);
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith("modus");
  });

  it("leaves dev runs alone unless MODUS_DEV_PROTOCOL=1", () => {
    const app = { isPackaged: false, setAsDefaultProtocolClient: vi.fn(() => true) };
    expect(registerModusProtocol(app, proc())).toBe(false);
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
    registerModusProtocol(app, proc({ MODUS_DEV_PROTOCOL: "1" }));
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith("modus", "/usr/bin/electron", [
      expect.stringMatching(/out\/main\/index\.js$/),
    ]);
  });
});
