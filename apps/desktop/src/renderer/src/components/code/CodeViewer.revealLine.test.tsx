// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LINE_FLASH_MS } from "./lineFlash";

/** Minimal Monaco fake: records reveal / cursor / decoration calls. */
const calls = vi.hoisted(() => ({
  setPosition: [] as Array<{ lineNumber: number; column: number }>,
  revealLineInCenter: [] as number[],
  decorations: [] as Array<{ line: number; className: string } | "clear">,
  lineCount: 40,
}));

vi.mock("../../lib/monaco", () => {
  const disposable = () => ({ dispose() {} });
  const monaco = {
    Uri: { from: (value: unknown) => value },
    Range: class {
      constructor(public startLineNumber: number) {}
    },
    KeyMod: { CtrlCmd: 0 },
    KeyCode: { KeyS: 0, KeyL: 0 },
    editor: {
      ContentWidgetPositionPreference: { ABOVE: 0 },
      createModel: (content: string) => ({
        getValue: () => content,
        getLineCount: () => calls.lineCount,
        onDidChangeContent: disposable,
        dispose() {},
      }),
      create: () => ({
        createDecorationsCollection: () => ({
          set: (
            items: Array<{ range: { startLineNumber: number }; options: { className: string } }>,
          ) => {
            for (const item of items) {
              calls.decorations.push({
                line: item.range.startLineNumber,
                className: item.options.className,
              });
            }
          },
          clear: () => calls.decorations.push("clear"),
        }),
        setPosition: (position: { lineNumber: number; column: number }) =>
          calls.setPosition.push(position),
        revealLineInCenter: (line: number) => calls.revealLineInCenter.push(line),
        onMouseDown: disposable,
        onMouseUp: disposable,
        onDidChangeCursorSelection: disposable,
        addAction: disposable,
        updateOptions() {},
        getSelection: () => null,
        dispose() {},
      }),
    },
  };
  return {
    MONACO_THEME: "modus",
    loadMonaco: () => Promise.resolve(monaco),
    watchModusTheme: () => () => {},
  };
});

const { CodeViewer } = await import("./CodeViewer");

async function flushMonaco() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  calls.setPosition.length = 0;
  calls.revealLineInCenter.length = 0;
  calls.decorations.length = 0;
  calls.lineCount = 40;
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CodeViewer revealLine", () => {
  it("centres the line, puts the cursor on it and flashes it, then fades", async () => {
    render(<CodeViewer content="x" path="a.ts" revealLine={{ line: 12, key: 1 }} />);
    await flushMonaco();
    expect(calls.setPosition).toEqual([{ lineNumber: 12, column: 1 }]);
    expect(calls.revealLineInCenter).toEqual([12]);
    expect(calls.decorations).toHaveLength(1);
    expect(calls.decorations[0]).toMatchObject({ line: 12 });
    expect((calls.decorations[0] as { className: string }).className).toContain("modus-line-flash");
    act(() => vi.advanceTimersByTime(LINE_FLASH_MS));
    expect(calls.decorations.at(-1)).toBe("clear");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-opening the same line before the fade re-triggers the flash (not stuck)", async () => {
    const view = render(<CodeViewer content="x" path="a.ts" revealLine={{ line: 12, key: 1 }} />);
    await flushMonaco();
    act(() => vi.advanceTimersByTime(LINE_FLASH_MS / 2));
    view.rerender(<CodeViewer content="x" path="a.ts" revealLine={{ line: 12, key: 2 }} />);
    expect(calls.revealLineInCenter).toEqual([12, 12]);
    // Old flash cleared, new one applied with the other class so CSS restarts.
    expect(calls.decorations).toHaveLength(3);
    expect(calls.decorations[1]).toBe("clear");
    const first = calls.decorations[0] as { className: string };
    const second = calls.decorations[2] as { className: string };
    expect(second.className).not.toBe(first.className);
    expect(vi.getTimerCount()).toBe(1);
    // The first timer does not cut the second flash short.
    act(() => vi.advanceTimersByTime(LINE_FLASH_MS / 2));
    expect(calls.decorations).toHaveLength(3);
    act(() => vi.advanceTimersByTime(LINE_FLASH_MS / 2));
    expect(calls.decorations.at(-1)).toBe("clear");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clamps a line beyond the end of the file to the last line (no error)", async () => {
    calls.lineCount = 7;
    render(<CodeViewer content="x" path="a.ts" revealLine={{ line: 99, key: 1 }} />);
    await flushMonaco();
    expect(calls.setPosition).toEqual([{ lineNumber: 7, column: 1 }]);
    expect(calls.revealLineInCenter).toEqual([7]);
  });

  it("does nothing without revealLine, and unmount cancels a pending fade", async () => {
    const view = render(<CodeViewer content="x" path="a.ts" />);
    await flushMonaco();
    expect(calls.revealLineInCenter).toEqual([]);
    view.rerender(<CodeViewer content="x" path="a.ts" revealLine={{ line: 3, key: 1 }} />);
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(calls.decorations.at(-1)).toBe("clear");
  });
});
