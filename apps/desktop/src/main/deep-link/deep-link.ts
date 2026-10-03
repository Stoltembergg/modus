import { resolve } from "node:path";
import { type BillingReturnStatus, isBillingReturnStatus } from "../../shared/billing";

/**
 * `modus://` deep links. Only two routes exist and both are parsed strictly:
 *
 * - `modus://auth/callback?code=…#state=…` — OAuth (PKCE) return when the deep-link transport is
 *   enabled. The state travels in the fragment so the Supabase redirect allow-list can hold the
 *   exact entry `modus://auth/callback` (GoTrue matches the full URL including the query, but
 *   strips the fragment before matching and keeps it on the final redirect).
 * - `modus://billing/return?status=success|cancel|portal` — back from Stripe (via the https
 *   fallback page). It only triggers a refresh; nothing in it is trusted as billing data.
 */
export const MODUS_PROTOCOL = "modus";
export const AUTH_CALLBACK_DEEP_LINK = "modus://auth/callback";
export const BILLING_RETURN_DEEP_LINK = "modus://billing/return";
const MAX_DEEP_LINK_LENGTH = 4096;

export type AuthCallbackDeepLink = {
  kind: "auth-callback";
  query: URLSearchParams;
  fragment: URLSearchParams;
};

export type BillingReturnDeepLink = {
  kind: "billing-return";
  status: BillingReturnStatus | null;
};

export type DeepLink = AuthCallbackDeepLink | BillingReturnDeepLink;

export function isModusDeepLink(value: unknown): value is string {
  return typeof value === "string" && value.toLowerCase().startsWith(`${MODUS_PROTOCOL}://`);
}

export function parseDeepLink(raw: unknown): DeepLink | null {
  if (!isModusDeepLink(raw) || raw.length > MAX_DEEP_LINK_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${MODUS_PROTOCOL}:` || url.username || url.password || url.port) {
    return null;
  }
  const route = `${url.hostname}${url.pathname.replace(/\/$/, "")}`;
  if (route === "auth/callback") {
    return {
      kind: "auth-callback",
      query: new URLSearchParams(url.search),
      fragment: new URLSearchParams(url.hash.replace(/^#/, "")),
    };
  }
  if (route === "billing/return") {
    if (url.hash) return null;
    const status = url.searchParams.get("status");
    return { kind: "billing-return", status: isBillingReturnStatus(status) ? status : null };
  }
  return null;
}

/** Windows / Linux deliver the link as a command-line argument (first launch and second-instance). */
export function findDeepLinkInArgv(argv: readonly string[]): string | undefined {
  return argv.find((arg) => isModusDeepLink(arg));
}

type ProtocolApp = {
  isPackaged: boolean;
  setAsDefaultProtocolClient(protocol: string, path?: string, args?: string[]): boolean;
};

/**
 * Packaged builds register `modus://` (electron-builder also declares it for macOS / Linux
 * installers). Dev runs only register with MODUS_DEV_PROTOCOL=1 so a checkout never steals the
 * installed app's handler.
 */
export function registerModusProtocol(
  app: ProtocolApp,
  proc: { defaultApp?: boolean; execPath: string; argv: string[]; env: NodeJS.ProcessEnv },
): boolean {
  if (app.isPackaged) return app.setAsDefaultProtocolClient(MODUS_PROTOCOL);
  if (proc.env.MODUS_DEV_PROTOCOL !== "1") return false;
  const entry = proc.argv[1];
  if (proc.defaultApp && entry) {
    return app.setAsDefaultProtocolClient(MODUS_PROTOCOL, proc.execPath, [resolve(entry)]);
  }
  return app.setAsDefaultProtocolClient(MODUS_PROTOCOL);
}

export type DeepLinkHandlers = {
  onAuthCallback(link: AuthCallbackDeepLink): void;
  onBillingReturn(link: BillingReturnDeepLink): void;
  /** Bring the main window forward (every accepted link). */
  focus(): void;
};

export interface DeepLinkRouter {
  /** Returns false when the link was rejected (unknown route, malformed). */
  handle(raw: unknown): boolean;
  /** Links received before the app was ready are replayed once handlers can run. */
  markReady(): void;
}

const MAX_PENDING = 4;

export function createDeepLinkRouter(handlers: DeepLinkHandlers): DeepLinkRouter {
  let ready = false;
  const pending: DeepLink[] = [];

  function dispatch(link: DeepLink): void {
    handlers.focus();
    if (link.kind === "auth-callback") handlers.onAuthCallback(link);
    else handlers.onBillingReturn(link);
  }

  return {
    handle(raw) {
      const link = parseDeepLink(raw);
      if (!link) return false;
      if (!ready) {
        if (pending.length < MAX_PENDING) pending.push(link);
        return true;
      }
      dispatch(link);
      return true;
    },
    markReady() {
      if (ready) return;
      ready = true;
      for (const link of pending.splice(0)) dispatch(link);
    },
  };
}
