import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthOAuthProviderId } from "../../shared/auth";

/** A browser sign-in must come back within this window. */
export const OAUTH_FLOW_TIMEOUT_MS = 5 * 60 * 1000;

export type OAuthFlowRejection = "no-pending" | "state-mismatch" | "expired" | "already-used";

export type OAuthFlowConsumeResult =
  | { ok: true; provider: AuthOAuthProviderId }
  | { ok: false; reason: OAuthFlowRejection };

export type PendingOAuthFlow = {
  state: string;
  provider: AuthOAuthProviderId;
  expiresAt: number;
};

/**
 * At most one pending browser sign-in. Its `state` is random (32 bytes, base64url), compared in
 * constant time, accepted once and only before it expires. Starting a new flow cancels the old one.
 */
export interface OAuthFlowRegistry {
  begin(provider: AuthOAuthProviderId): PendingOAuthFlow;
  consume(state: string | null | undefined): OAuthFlowConsumeResult;
  cancel(): void;
  pending(): PendingOAuthFlow | undefined;
}

type Options = {
  timeoutMs?: number;
  now?: () => number;
  randomState?: () => string;
};

function sameState(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createOAuthFlowRegistry({
  timeoutMs = OAUTH_FLOW_TIMEOUT_MS,
  now = Date.now,
  randomState = () => randomBytes(32).toString("base64url"),
}: Options = {}): OAuthFlowRegistry {
  let current: PendingOAuthFlow | undefined;
  // States already consumed (or superseded) are remembered so a replay reports "already-used".
  const used = new Set<string>();

  function retire(flow: PendingOAuthFlow | undefined): void {
    if (flow) used.add(flow.state);
    current = undefined;
  }

  return {
    begin(provider) {
      retire(current);
      current = { state: randomState(), provider, expiresAt: now() + timeoutMs };
      return { ...current };
    },

    consume(state) {
      if (typeof state === "string" && state && used.has(state)) {
        return { ok: false, reason: "already-used" };
      }
      const flow = current;
      if (!flow) return { ok: false, reason: "no-pending" };
      if (typeof state !== "string" || !state || !sameState(flow.state, state)) {
        return { ok: false, reason: "state-mismatch" };
      }
      retire(flow);
      if (now() > flow.expiresAt) return { ok: false, reason: "expired" };
      return { ok: true, provider: flow.provider };
    },

    cancel() {
      retire(current);
    },

    pending() {
      if (current && now() > current.expiresAt) retire(current);
      return current ? { ...current } : undefined;
    },
  };
}
