// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** CodeViewer stand-in: records the revealLine it receives. */
const seen = vi.hoisted(() => ({ revealLines: [] as unknown[] }));
vi.mock("../../components/code/CodeViewer", () => ({
  CodeViewer: (props: { revealLine?: unknown; path: string }) => {
    seen.revealLines.push(props.revealLine);
    return <div data-path={props.path} data-testid="code" />;
  },
}));

const { FilesPanel } = await import("./FilesPanel");

const read = vi.fn(async ({ path }: { path: string }) => ({
  path: path.startsWith("/") ? path : `/repo/${path}`,
  relativePath: path.replace(/^\/repo\//, ""),
  size: 10,
  binary: false,
  truncated: false,
  content: "a\nb\nc",
}));

beforeEach(() => {
  seen.revealLines.length = 0;
  read.mockClear();
  (window as unknown as { modus: unknown }).modus = {
    files: { list: vi.fn(async () => []), read, write: vi.fn() },
    file: { open: vi.fn() },
  };
});
afterEach(() => cleanup());

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

describe("FilesPanel reveal with an optional line (C2.1)", () => {
  it("passes the requested line to the editor", async () => {
    render(
      <FilesPanel cwd="/repo" revealLine={{ line: 12, key: 1 }} revealPath="/repo/src/a.ts" />,
    );
    await flush();
    expect(read).toHaveBeenCalledWith({ cwd: "/repo", path: "/repo/src/a.ts" });
    expect(seen.revealLines.at(-1)).toEqual({ line: 12, key: 1 });
  });

  it("a reveal without a line (every existing onOpenFile(path) caller) still opens the file", async () => {
    const consumed = vi.fn();
    render(<FilesPanel cwd="/repo" onRevealConsumed={consumed} revealPath="src/a.ts" />);
    await flush();
    expect(read).toHaveBeenCalledWith({ cwd: "/repo", path: "src/a.ts" });
    expect(document.querySelector('[data-testid="code"]')).toBeTruthy();
    expect(seen.revealLines.at(-1)).toBeUndefined();
    expect(consumed).toHaveBeenCalledTimes(1);
  });
});
