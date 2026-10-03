// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** CodeViewer stand-in: shows content and lets a test type (dirty draft). */
vi.mock("../../components/code/CodeViewer", () => ({
  CodeViewer: (props: { content: string; path: string; onChange?: (value: string) => void }) => (
    <div data-path={props.path} data-testid="code">
      <button onClick={() => props.onChange?.(`${props.content} EDITED`)} type="button">
        type
      </button>
    </div>
  ),
}));

const { FilesPanel } = await import("./FilesPanel");
const { UnsavedChangesDialog } = await import("./UnsavedChangesDialog");

const disk = new Map<string, string>();
const rel = (path: string) => path.replace(/^\/repo\//, "");
const read = vi.fn(async ({ path }: { path: string }) => {
  const content = disk.get(rel(path)) ?? "";
  return {
    path: `/repo/${rel(path)}`,
    relativePath: rel(path),
    size: content.length,
    binary: false,
    truncated: false,
    content,
  };
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

let reveal: (path: string, line?: number) => void = () => {};
function Host({ locale }: { locale?: string }) {
  const [revealPath, setRevealPath] = useState<string | undefined>();
  const [revealLine, setRevealLine] = useState<{ line: number; key: number } | undefined>();
  reveal = (path, line) => {
    setRevealLine(line ? { line, key: Date.now() } : undefined);
    setRevealPath(path);
  };
  return (
    <FilesPanel
      cwd="/repo"
      onRevealConsumed={() => setRevealPath(undefined)}
      revealLine={revealLine}
      revealPath={revealPath}
      {...(locale ? { locale } : {})}
    />
  );
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

async function openFromTree(name: string) {
  const row = screen.getAllByTitle(name).find((el) => el.tagName === "BUTTON");
  fireEvent.click(row as HTMLElement);
  await flush();
}

const notice = () => document.querySelector("[data-kept-draft-notice]");

beforeEach(() => {
  disk.clear();
  disk.set("a.ts", "A1");
  disk.set("b.ts", "B1");
  (window as unknown as { modus: unknown }).modus = {
    files: { list, read, write: vi.fn(async () => ({ size: 0 })) },
    file: { open: vi.fn() },
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FilesPanel copy in pt / zh (C6.1)", () => {
  it.each([
    [
      "pt-BR",
      "Nenhum arquivo aberto",
      "Selecione um arquivo na árvore do workspace",
      "Filtrar arquivos...",
    ],
    ["zh-CN", "未打开文件", "从工作区文件树中选择一个文件", "筛选文件..."],
  ])("%s: empty state, filter and toolbar labels", async (locale, hint, description, filter) => {
    render(<Host locale={locale} />);
    await flush();
    expect(screen.getByText(hint)).toBeTruthy();
    expect(screen.getByText(description)).toBeTruthy();
    expect(screen.getByPlaceholderText(filter)).toBeTruthy();
    expect(screen.queryByText("No file open")).toBeNull();
    expect(screen.queryByPlaceholderText("Filter files...")).toBeNull();
  });

  it.each([
    [
      "pt-BR",
      "Alterações não salvas",
      "Alterações não salvas — a linha pode ter mudado",
      "Salvar as alterações em a.ts?",
      ["Salvar", "Descartar", "Cancelar"],
    ],
    [
      "zh-CN",
      "未保存的更改",
      "有未保存的更改——该行可能已移动",
      "保存对 a.ts 的更改？",
      ["保存", "放弃", "取消"],
    ],
  ])("%s: kept-draft notice and the Save / Discard / Cancel dialog", async (locale, dot, kept, title, buttons) => {
    render(<Host locale={locale} />);
    await flush();
    await openFromTree("a.ts");
    fireEvent.click(screen.getByRole("button", { name: "type" }));
    expect(screen.getByRole("img", { name: dot })).toBeTruthy();
    // Same dirty file revealed at a line: the draft stays, with the notice.
    act(() => reveal("/repo/a.ts", 4));
    await flush();
    expect(notice()?.textContent).toBe(kept);
    // Another file: the guard dialog, fully translated.
    act(() => reveal("/repo/b.ts", 2));
    await flush();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain(title);
    for (const name of buttons) expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: buttons[0] ?? "" }));
  });

  it("without a locale prop it follows navigator.language (same fallback as the room)", async () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("pt-BR");
    render(<Host />);
    await flush();
    expect(screen.getByText("Nenhum arquivo aberto")).toBeTruthy();
  });

  it("en is unchanged", async () => {
    render(<Host locale="en-US" />);
    await flush();
    expect(screen.getByText("No file open")).toBeTruthy();
    expect(screen.getByPlaceholderText("Filter files...")).toBeTruthy();
  });
});

describe("UnsavedChangesDialog copy in pt / zh (C6.1)", () => {
  it.each([
    [
      "pt",
      "Salvar as alterações em x.md?",
      "Você tem alterações não salvas. Se descartá-las, elas serão perdidas.",
      "Não foi possível salvar: EACCES",
    ],
    [
      "zh",
      "保存对 x.md 的更改？",
      "你有未保存的更改。如果放弃，这些更改将会丢失。",
      "无法保存：EACCES",
    ],
  ])("%s: title, body and save error", (locale, title, body, error) => {
    render(
      <UnsavedChangesDialog
        error="EACCES"
        fileName="x.md"
        locale={locale}
        onCancel={() => {}}
        onDiscard={() => {}}
        onSave={() => {}}
        open
      />,
    );
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText(body)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(error);
  });
});
