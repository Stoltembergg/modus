import { describe, expect, it } from "vitest";
import { createOAuthFlowRegistry } from "./oauth-flow";

function registry(start = 1_000) {
  let clock = start;
  let counter = 0;
  const flows = createOAuthFlowRegistry({
    timeoutMs: 1_000,
    now: () => clock,
    randomState: () => `state-${++counter}`,
  });
  return { flows, advance: (ms: number) => (clock += ms) };
}

describe("OAuth flow registry", () => {
  it("accepts the pending state exactly once", () => {
    const { flows } = registry();
    const flow = flows.begin("github");
    expect(flows.consume(flow.state)).toEqual({ ok: true, provider: "github" });
    expect(flows.consume(flow.state)).toEqual({ ok: false, reason: "already-used" });
    expect(flows.pending()).toBeUndefined();
  });

  it("rejects a mismatched, missing or empty state", () => {
    const { flows } = registry();
    const flow = flows.begin("google");
    expect(flows.consume("state-999")).toEqual({ ok: false, reason: "state-mismatch" });
    expect(flows.consume(`${flow.state}x`)).toEqual({ ok: false, reason: "state-mismatch" });
    expect(flows.consume(null)).toEqual({ ok: false, reason: "state-mismatch" });
    expect(flows.consume("")).toEqual({ ok: false, reason: "state-mismatch" });
  });

  it("rejects an expired state and does not accept it afterwards", () => {
    const { flows, advance } = registry();
    const flow = flows.begin("github");
    advance(1_001);
    expect(flows.consume(flow.state)).toEqual({ ok: false, reason: "expired" });
    expect(flows.consume(flow.state)).toEqual({ ok: false, reason: "already-used" });
  });

  it("rejects callbacks when no sign-in is pending", () => {
    const { flows } = registry();
    expect(flows.consume("state-1")).toEqual({ ok: false, reason: "no-pending" });
  });

  it("retires the previous state when a new flow starts or the flow is cancelled", () => {
    const { flows } = registry();
    const first = flows.begin("github");
    const second = flows.begin("google");
    expect(flows.consume(first.state)).toEqual({ ok: false, reason: "already-used" });
    flows.cancel();
    expect(flows.consume(second.state)).toEqual({ ok: false, reason: "already-used" });
  });

  it("generates long random states by default", () => {
    const flows = createOAuthFlowRegistry();
    const a = flows.begin("github").state;
    const b = flows.begin("github").state;
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
