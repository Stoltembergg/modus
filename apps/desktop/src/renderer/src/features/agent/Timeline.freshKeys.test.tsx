// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFreshKeys } from "./Timeline";

function keysHook(initial: readonly string[]) {
  return renderHook(({ keys }) => [...useFreshKeys(keys)], { initialProps: { keys: initial } });
}

describe("useFreshKeys (RevealOnMount gating)", () => {
  it("history present at mount never animates; later arrivals do", () => {
    const hook = keysHook(["a", "b"]);
    expect(hook.result.current).toEqual([]);
    hook.rerender({ keys: ["a", "b", "c"] });
    expect(hook.result.current).toEqual(["c"]);
    hook.rerender({ keys: ["a", "b", "c", "d"] });
    expect(hook.result.current).toEqual(["d"]);
  });

  it("switching to another chat (no shared key) is history again", () => {
    const hook = keysHook(["a", "b"]);
    hook.rerender({ keys: ["x", "y", "z"] });
    expect(hook.result.current).toEqual([]);
    hook.rerender({ keys: ["x", "y", "z", "w"] });
    expect(hook.result.current).toEqual(["w"]);
  });

  it("a fresh chat animates its first messages, a history batch on an empty timeline does not", () => {
    const fresh = keysHook([]);
    fresh.rerender({ keys: ["u1"] });
    expect(fresh.result.current).toEqual(["u1"]);

    const loading = keysHook([]);
    loading.rerender({ keys: ["h1", "h2", "h3", "h4"] });
    expect(loading.result.current).toEqual([]);
    loading.rerender({ keys: ["h1", "h2", "h3", "h4", "n1"] });
    expect(loading.result.current).toEqual(["n1"]);
  });
});
