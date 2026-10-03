import type { AuthCallbackDeepLink } from "../deep-link/deep-link";
import { AUTH_CALLBACK_DEEP_LINK } from "../deep-link/deep-link";
import type { LoopbackListener } from "./loopback-server";

/**
 * Where the browser hands the OAuth result back. Both transports resolve with the same params
 * (code, state, error) and are consumed by the same single-use state check in auth-service.
 */
export type OAuthCallbackChannel = {
  /** The redirect_to sent to Supabase for this flow. */
  redirectTo(state: string): string;
  /** Resolves on the first callback, rejects on timeout or close(). */
  callback: Promise<{ params: URLSearchParams }>;
  close(): Promise<void>;
};

export type OAuthTransport = "loopback" | "deep-link";

/** Loopback (default, B2): state in the query of http://127.0.0.1:<port>/auth/callback. */
export function loopbackChannel(listener: LoopbackListener): OAuthCallbackChannel {
  return {
    redirectTo: (state) => `${listener.callbackUrl}?state=${encodeURIComponent(state)}`,
    callback: listener.callback,
    close: () => listener.close(),
  };
}

export interface DeepLinkCallbackHub {
  start(options: { timeoutMs: number }): Promise<OAuthCallbackChannel>;
  /** Called by the deep-link router; false when no sign-in is waiting (the link is dropped). */
  deliver(link: AuthCallbackDeepLink): boolean;
}

/**
 * Deep-link transport: redirect_to is `modus://auth/callback#state=<state>`, so the allow-list
 * entry is the exact URL `modus://auth/callback`. GoTrue appends `?code=` and keeps the fragment.
 * The state is read ONLY from the fragment; a `state` in the query is ignored, so a link crafted
 * with only query params never matches a pending flow.
 */
export function createDeepLinkCallbackHub(): DeepLinkCallbackHub {
  let waiting:
    | {
        resolve(value: { params: URLSearchParams }): void;
        reject(error: Error): void;
      }
    | undefined;

  return {
    async start({ timeoutMs }) {
      waiting?.reject(new Error("superseded"));
      let current: typeof waiting;
      const callback = new Promise<{ params: URLSearchParams }>((resolve, reject) => {
        current = { resolve, reject };
      });
      waiting = current;
      // Rejections are observed by the caller; avoid an unhandled rejection after close().
      callback.catch(() => undefined);
      const timer = setTimeout(() => {
        if (waiting === current) waiting = undefined;
        current?.reject(new Error("timeout"));
      }, timeoutMs);
      timer.unref?.();
      return {
        redirectTo: (state) => `${AUTH_CALLBACK_DEEP_LINK}#state=${encodeURIComponent(state)}`,
        callback,
        close: async () => {
          clearTimeout(timer);
          if (waiting === current) waiting = undefined;
          current?.reject(new Error("closed"));
        },
      };
    },

    deliver(link) {
      const target = waiting;
      if (!target) return false;
      waiting = undefined;
      const params = new URLSearchParams();
      const code = link.query.get("code");
      if (code) params.set("code", code);
      const error = link.query.get("error") ?? link.fragment.get("error");
      if (error) params.set("error", error);
      const state = link.fragment.get("state");
      if (state) params.set("state", state);
      target.resolve({ params });
      return true;
    },
  };
}
