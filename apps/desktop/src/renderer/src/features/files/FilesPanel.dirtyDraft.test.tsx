// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** CodeViewer stand-in: shows content, records revealLine, lets a test type. */
const seen = vi.hoisted(() => ({ revealLines: [] as unknown[] }));
vi.mock("../../components/code/CodeViewer", () => ({
  CodeViewer: (props: {
    content: string;
    path: string;
    revealLine?: unknown;
    onChange?: (value: string) => void;
  }) => {
    seen.revealLines.push(props.revealLine);
    return (
      <div data-content={props.content} data-path={props.path} data-testid="code">
        <button onClick={() => props.onChange?.(`${props.content} EDITED`)} type="button">
          type
        </button>
      </div>
    );
  },
}));

const { FilesPanel } = await import("./FilesPanel");

const disk = new Map<string, string>();
const abs = (path: string) => (path.startsWith("/") ? path : `/repo/${path}`);
const rel = (path: string) => path.replace(/^\/repo\//, "");

const read = vi.fn(async ({ path }: { path: string }) => {
  const content = disk.get(rel(path));
  if (content === undefined) throw new Error(`ENOENT ${path}`);
  return {
    path: abs(path),
    relativePath: rel(path),
    size: content.length,
    binary: false,
    truncated: false,
    content,
  };
});
const write = vi.fn(async ({ path, content }: { path: string; content: string }) => {
  disk.set(rel(path), content);
  return { size: content.length };
});
const list = vi.fn(async ({ dir }: { dir?: string }) =>
  dir
    ? []
    : ["a.ts", "b.ts"].map((name) => ({
        name,
        path: `/repo/${name}`,
        relativePath: name,
        kind: "file" as const,
      })),
);

/** Mimics App: reveal(path, line?) sets revealPath; consumed clears it. */
let reveal: (path: string, line?: number) => void = () => {};
let consumedCount = 0;
function Host() {
  const [revealPath, setRevealPath] = useState<string | undefined>();
  const [revealLine, setRevealLine] = useState<{ line: number; key: number } | undefined>();
  const [key, setKey] = useState(0);
  reveal = (path, line) => {
    setKey((k) => k + 1);
    setRevealLine(line ? { line, key: key + 1 } : undefined);
    setRevealPath(path);
  };
  return (
    <FilesPanel
      cwd="/repo"
      onRevealConsumed={() => {
        consumedCount += 1;
        setRevealPath(undefined);
      }}
      revealLine={revealLine}
      revealPath={revealPath}
    />
  );
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

const code = () => screen.getByTestId("code");
const notice = () => document.querySelector("[data-kept-draft-notice]");
const dialog = () => screen.queryByRole("alertdialog");

async function openFromTree(name: string) {
  const row = screen.getAllByTitle(name).find((el) => el.tagName === "BUTTON");
  fireEvent.click(row as HTMLElement);
  await flush();
}

async function doReveal(path: string, line?: number) {
  act(() => reveal(path, line));
  await flush();
}

/** a.ts open from the tree, then edited (dirty). */
async function dirtyA() {
  render(<Host />);
  await flush();
  await openFromTree("a.ts");
  fireEvent.click(screen.getByRole("button", { name: "type" }));
  expect(screen.getByRole("img", { name: "Unsaved changes" })).toBeTruthy();
}

beforeEach(() => {
  disk.clear();
  disk.set("a.ts", "A1");
  disk.set("b.ts", "B1");
  read.mockClear();
  write.mockClear();
  list.mockClear();
  seen.revealLines.length = 0;
  consumedCount = 0;
  (window as unknown as { modus: unknown }).modus = {
    files: { list, read, write },
    file: { open: vi.fn() },
  };
});
afterEach(() => cleanup());

describe("FilesPanel: same file, dirty draft, reveal (C2.2)", () => {
  it("search result reveal keeps the draft, jumps to the line and shows the notice", async () => {
    await dirtyA();
    disk.set("a.ts", "A2 on disk");
    await doReveal("/repo/a.ts", 12);
    expect(code().getAttribute("data-path")).toBe("a.ts");
    // Draft kept: still dirty, nothing overwritten, no dialog.
    expect(screen.getByRole("img", { name: "Unsaved changes" })).toBeTruthy();
    expect(dialog()).toBeNull();
    expect(seen.revealLines.at(-1)).toEqual({ line: 12, key: 1 });
    expect(notice()?.textContent).toBe("Unsaved changes — the line may have moved");
    expect(notice()?.getAttribute("role")).toBe("status");
    expect(consumedCount).toBe(1);
    // Nothing was written behind the user's back.
    expect(write).not.toHaveBeenCalled();
  });

  it("chat file chip (no line) on the same dirty file keeps the draft without the notice", async () => {
    await dirtyA();
    disk.set("a.ts", "A2 on disk");
    await doReveal("a.ts");
    // Draft kept (still dirty, disk content not loaded), no dialog, no write.
    expect(screen.getByRole("img", { name: "Unsaved changes" })).toBeTruthy();
    expect(code().getAttribute("data-path")).toBe("a.ts");
    expect(code().getAttribute("data-content")).toBe("A1");
    expect(dialog()).toBeNull();
    expect(write).not.toHaveBeenCalled();
    // No line to jump to, so no "line may have moved" notice.
    expect(notice()).toBeNull();
    expect(seen.revealLines.at(-1)).toBeUndefined();
    expect(consumedCount).toBe(1);
  });

  it("a no-line reveal after a line reveal clears the notice and still keeps the draft", async () => {
    await dirtyA();
    await doReveal("/repo/a.ts", 12);
    expect(notice()).toBeTruthy();
    await doReveal("/repo/a.ts");
    expect(notice()).toBeNull();
    expect(screen.getByRole("img", { name: "Unsaved changes" })).toBeTruthy();
    expect(write).not.toHaveBeenCalled();
  });

  it("re-clicking the open dirty file in the tree keeps the draft", async () => {
    await dirtyA();
    const reads = read.mock.calls.length;
    await openFromTree("a.ts");
    expect(read.mock.calls.length).toBe(reads);
    expect(screen.getByRole("img", { name: "Unsaved changes" })).toBeTruthy();
  });
});

describe("FilesPanel: clean file reveals exactly as today", () => {
  it("same clean file reloads from disk and jumps, no notice, no dialog", async () => {
    render(<Host />);
    await flush();
    await openFromTree("a.ts");
    disk.set("a.ts", "A2 on disk");
    await doReveal("/repo/a.ts", 3);
    expect(code().getAttribute("data-content")).toBe("A2 on disk");
    expect(seen.revealLines.at(-1)).toEqual({ line: 3, key: 1 });
    expect(notice()).toBeNull();
    expect(dialog()).toBeNull();
    expect(consumedCount).toBe(1);
  });

  it("a different file while clean opens directly (search and chip)", async () => {
    render(<Host />);
    await flush();
    await openFromTree("a.ts");
    await doReveal("/repo/b.ts", 2);
    expect(code().getAttribute("data-path")).toBe("b.ts");
    expect(dialog()).toBeNull();
    await doReveal("a.ts");
    expect(code().getAttribute("data-path")).toBe("a.ts");
    expect(dialog()).toBeNull();
  });
});

describe("FilesPanel: switching away from a dirty file asks first", () => {
  it.each([
    ["tree", async () => openFromTree("b.ts")],
    ["search reveal", async () => doReveal("/repo/b.ts", 7)],
    ["chat file chip", async () => doReveal("b.ts")],
  ])("%s → dialog with Save / Discard / Cancel; nothing switches yet", async (_label, go) => {
    await dirtyA();
    await go();
    const d = dialog();
    expect(d).toBeTruthy();
    expect(d?.textContent).toContain("Save changes to a.ts?");
    for (const name of ["Save", "Discard", "Cancel"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    // Save has initial focus inside the (trapped) dialog.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
    expect(code().getAttribute("data-path")).toBe("a.ts");
    expect(write).not.toHaveBeenCalled();
  });

  it("Save (tree) writes the draft, then switches", async () => {
    await dirtyA();
    await openFromTree("b.ts");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await flush();
    expect(write).toHaveBeenCalledWith({ cwd: "/repo", path: "/repo/a.ts", content: "A1 EDITED" });
    expect(disk.get("a.ts")).toBe("A1 EDITED");
    expect(code().getAttribute("data-path")).toBe("b.ts");
    expect(dialog()).toBeNull();
  });

  it("Save (reveal) writes, then opens the revealed file at its line", async () => {
    await dirtyA();
    await doReveal("/repo/b.ts", 7);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await flush();
    expect(disk.get("a.ts")).toBe("A1 EDITED");
    expect(code().getAttribute("data-path")).toBe("b.ts");
    expect(seen.revealLines.at(-1)).toEqual({ line: 7, key: 1 });
  });

  it("Discard (tree) drops the draft and switches without writing", async () => {
    await dirtyA();
    await openFromTree("b.ts");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await flush();
    expect(write).not.toHaveBeenCalled();
    expect(disk.get("a.ts")).toBe("A1");
    expect(code().getAttribute("data-path")).toBe("b.ts");
    // Back to a.ts: the old draft is gone (disk content, clean).
    await openFromTree("a.ts");
    expect(code().getAttribute("data-content")).toBe("A1");
    expect(screen.queryByRole("img", { name: "Unsaved changes" })).toBeNull();
  });

  it("Discard (reveal / chip) drops the draft and opens the revealed file", async () => {
    await dirtyA();
    await doReveal("b.ts");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await flush();
    expect(write).not.toHaveBeenCalled();
    expect(code().getAttribute("data-path")).toBe("b.ts");
  });

  it("Cancel (tree) stays on the dirty file with the draft", async () => {
    await dirtyA();
    await openFromTree("b.ts");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();
    expect(dialog()).toBeNull();
    expect(code().getAttribute("data-path")).toBe("a.ts");
    expect(screen.getByRole("img", { name: "Unsaved changes" })).toBeTruthy();
    expect(write).not.toHaveBeenCalled();
  });

  it("Esc acts as Cancel", async () => {
    await dirtyA();
    await openFromTree("b.ts");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await flush();
    expect(dialog()).toBeNull();
    expect(code().getAttribute("data-path")).toBe("a.ts");
    expect(screen.getByRole("img", { name: "Unsaved changes" })).toBeTruthy();
  });

  it("Cancel (reveal) does not reveal, consumes revealPath, and the same click fires again", async () => {
    await dirtyA();
    await doReveal("/repo/b.ts", 7);
    expect(consumedCount).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();
    expect(code().getAttribute("data-path")).toBe("a.ts");
    expect(seen.revealLines.at(-1)).toBeUndefined();
    // Second click on the same search result: the flow runs again.
    await doReveal("/repo/b.ts", 7);
    expect(consumedCount).toBe(2);
    expect(dialog()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await flush();
    expect(code().getAttribute("data-path")).toBe("b.ts");
    expect(seen.revealLines.at(-1)).toEqual({ line: 7, key: 2 });
  });

  it("Cancel (chat chip) consumes too, and a second chip click re-prompts", async () => {
    await dirtyA();
    await doReveal("b.ts");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();
    await doReveal("b.ts");
    expect(consumedCount).toBe(2);
    expect(dialog()).toBeTruthy();
  });

  it("Save that fails keeps the current file and draft, shows the error, no switch", async () => {
    await dirtyA();
    write.mockRejectedValueOnce(new Error("EACCES: permission denied"));
    await doReveal("/repo/b.ts", 7);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Couldn't save: EACCES: permission denied");
    expect(dialog()).toBeTruthy();
    expect(code().getAttribute("data-path")).toBe("a.ts");
    expect(disk.get("a.ts")).toBe("A1");
    // (The modal hides the rest of the panel from the a11y tree meanwhile.)
    expect(screen.getByRole("img", { name: "Unsaved changes", hidden: true })).toBeTruthy();
    // Cancel after the failure: still the dirty a.ts, draft intact.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();
    expect(code().getAttribute("data-path")).toBe("a.ts");
    expect(screen.getByRole("img", { name: "Unsaved changes" })).toBeTruthy();
    // The draft survived: a later successful Save writes exactly it.
    await openFromTree("b.ts");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await flush();
    expect(write).toHaveBeenLastCalledWith({
      cwd: "/repo",
      path: "/repo/a.ts",
      content: "A1 EDITED",
    });
    expect(code().getAttribute("data-path")).toBe("b.ts");
  });

  it("saving the kept draft clears the notice", async () => {
    await dirtyA();
    await doReveal("/repo/a.ts", 4);
    expect(notice()).toBeTruthy();
    // Switch away with Save: notice is gone with the draft saved.
    await openFromTree("b.ts");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await flush();
    expect(notice()).toBeNull();
  });
});
