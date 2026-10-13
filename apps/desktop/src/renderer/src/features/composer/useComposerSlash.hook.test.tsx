// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_COMMANDS, useComposerSlash } from "./useComposerSlash";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const skill = {
  name: "release-notes",
  description: "Draft release notes",
  path: "/repo/.modus/skills/release-notes/SKILL.md",
  scope: "workspace",
};

function stubSkills(list: (cwd: string) => Promise<unknown[]>) {
  vi.stubGlobal("modus", { skills: { list: vi.fn(list) } });
}

describe("useComposerSlash", () => {
  it("opens with built-in commands when there is no workspace", () => {
    stubSkills(async () => []);
    const { result } = renderHook(() =>
      useComposerSlash({ value: "/", cwd: undefined, actions: [] }),
    );
    expect(result.current.isOpen).toBe(true);
    expect(result.current.items).toHaveLength(BUILTIN_COMMANDS.length);
  });

  it("still loads skills when typing continues before the list arrives", async () => {
    let resolveFirst: (items: unknown[]) => void = () => {};
    let calls = 0;
    stubSkills(() => {
      calls += 1;
      return calls === 1
        ? new Promise((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve([skill]);
    });
    const { result, rerender } = renderHook(
      ({ value }) => useComposerSlash({ value, cwd: "/repo", actions: [] }),
      { initialProps: { value: "/" } },
    );
    rerender({ value: "/r" });
    rerender({ value: "/re" });
    resolveFirst([skill]);
    await waitFor(() =>
      expect(result.current.items.some((item) => item.kind === "skill")).toBe(true),
    );
  });

  it("retries the skill list after a slash session that closed before it loaded", async () => {
    let calls = 0;
    stubSkills(() => {
      calls += 1;
      return calls === 1 ? new Promise(() => {}) : Promise.resolve([skill]);
    });
    const { result, rerender } = renderHook(
      ({ value }) => useComposerSlash({ value, cwd: "/repo", actions: [] }),
      { initialProps: { value: "/" } },
    );
    rerender({ value: "" });
    rerender({ value: "/" });
    await waitFor(() =>
      expect(result.current.items.some((item) => item.kind === "skill")).toBe(true),
    );
  });
});
