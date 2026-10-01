import { describe, expect, it } from "vitest";
import {
  bindSessionExecution,
  clearSessionExecutions,
  filterMessagesByExecution,
  latestExecutionId,
  messageExecutionId,
  sessionExecutionId,
  shortExecutionLabel,
  unbindSessionExecution,
} from "./group-execution-link";

describe("group-execution-link", () => {
  it("messageExecutionId prefers chainId then falls back to id", () => {
    expect(messageExecutionId({ id: "m1", chainId: "exec-a" })).toBe("exec-a");
    expect(messageExecutionId({ id: "m1" })).toBe("m1");
  });

  it("shortExecutionLabel uses title or a short id", () => {
    expect(shortExecutionLabel("abcdef012345", "Ship login")).toBe("Ship login");
    expect(shortExecutionLabel("abcdef012345")).toBe("abcdef01");
    expect(shortExecutionLabel("x", "a".repeat(50))).toBe(`${"a".repeat(37)}…`);
  });

  it("latestExecutionId picks the newest user message chain", () => {
    const messages = [
      { id: "u1", authorKind: "user", chainId: "u1" },
      { id: "a1", authorKind: "agent", chainId: "u1" },
      { id: "u2", authorKind: "user", chainId: "u2" },
      { id: "a2", authorKind: "agent", chainId: "u2" },
    ];
    expect(latestExecutionId(messages)).toBe("u2");
    expect(latestExecutionId([])).toBeUndefined();
  });

  it("filterMessagesByExecution keeps chronological order within one execution", () => {
    const messages = [
      { id: "u1", chainId: "u1" },
      { id: "a1", chainId: "u1" },
      { id: "u2", chainId: "u2" },
      { id: "a2", chainId: "u2" },
      { id: "u1b", chainId: "u1" },
    ];
    expect(filterMessagesByExecution(messages, "u1").map((m) => m.id)).toEqual(["u1", "a1", "u1b"]);
    expect(filterMessagesByExecution(messages, undefined)).toHaveLength(5);
  });

  it("session bind tracks the active execution for tools", () => {
    clearSessionExecutions();
    bindSessionExecution("s1", "exec-1");
    expect(sessionExecutionId("s1")).toBe("exec-1");
    unbindSessionExecution("s1");
    expect(sessionExecutionId("s1")).toBeUndefined();
    clearSessionExecutions();
  });
});
