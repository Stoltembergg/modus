// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupRoomLocaleProvider } from "../groups/groupRoomI18n";
import { SearchToolCard } from "./SearchToolCard";
import { fileResultMeta, searchQuery } from "./searchResults";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const fallback = <div data-testid="generic">generic</div>;
const grepOut = "src/a.ts:3: alpha\nsrc/b.ts:10: beta\nsrc/b.ts:20: gamma";

function renderDone(locale?: string, extra: { cwd?: string; output?: string } = {}) {
  render(
    <SearchToolCard
      args={{ pattern: "needle", path: "src" }}
      cwd={extra.cwd ?? "/repo"}
      fallback={fallback}
      isComplete
      name="grep"
      onOpenFile={vi.fn()}
      output={extra.output ?? grepOut}
      {...(locale ? { locale } : {})}
    />,
  );
}

describe("SearchToolCard copy in pt / zh (C6.1)", () => {
  it.each([
    ["pt-BR", "Buscando…", "Buscando na web…"],
    ["zh-CN", "正在搜索…", "正在搜索网络…"],
  ])("%s: searching states", (locale, searching, web) => {
    render(
      <SearchToolCard
        args={{ pattern: "x" }}
        fallback={fallback}
        locale={locale}
        name="grep"
        output=""
      />,
    );
    expect(screen.getByText(searching)).toBeTruthy();
    cleanup();
    render(
      <SearchToolCard
        args={{ query: "x" }}
        fallback={fallback}
        locale={locale}
        name="web_search"
        output=""
      />,
    );
    expect(screen.getByText(web)).toBeTruthy();
  });

  it("pt: header, query, counts, row and match aria-labels", () => {
    renderDone("pt-BR");
    const toggle = screen.getByRole("button", { name: /2 resultados encontrados/ });
    fireEvent.click(toggle);
    expect(screen.getByText("Busca por")).toBeTruthy();
    expect(screen.getByText("needle em src")).toBeTruthy();
    const rows = document.querySelectorAll("[data-search-row='file']");
    expect(rows[0]?.textContent).toContain("L3");
    expect(rows[1]?.textContent).toContain("2 ocorrências");
    expect(screen.getByRole("button", { name: "Abrir src/a.ts na linha 3" })).toBeTruthy();
    const expand = screen.getByRole("button", { name: "Mostrar 2 ocorrências em src/b.ts" });
    fireEvent.click(expand);
    expect(expand.getAttribute("aria-label")).toBe("Ocultar 2 ocorrências em src/b.ts");
    expect(screen.getByRole("button", { name: "Abrir src/b.ts na linha 20: gamma" })).toBeTruthy();
  });

  it("zh: header, query, counts, row and match aria-labels", () => {
    renderDone("zh-CN");
    fireEvent.click(screen.getByRole("button", { name: /找到 2 个结果/ }));
    expect(screen.getByText("搜索内容")).toBeTruthy();
    expect(screen.getByText("src 中的 needle")).toBeTruthy();
    const rows = document.querySelectorAll("[data-search-row='file']");
    expect(rows[0]?.textContent).toContain("第 3 行");
    expect(rows[1]?.textContent).toContain("2 处匹配");
    expect(screen.getByRole("button", { name: "在第 3 行打开 src/a.ts" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "显示 src/b.ts 中的 2 处匹配" })).toBeTruthy();
  });

  it("singular result count and outside-workspace row", () => {
    renderDone("pt", { output: "../../etc/x.ts:1: y", cwd: "/repo" });
    const toggle = screen.getByRole("button", { name: /1 resultado encontrado/ });
    fireEvent.click(toggle);
    expect(screen.getByText("fora do workspace")).toBeTruthy();
    const row = document.querySelector("[data-search-row='file']");
    expect(row?.getAttribute("title")).toMatch(/^Fora do workspace: /);
    expect(screen.getByRole("button", { name: /\(fora do workspace\)$/ })).toBeTruthy();
    cleanup();
    renderDone("zh", { output: "src/a.ts:1: y" });
    expect(screen.getByRole("button", { name: /找到 1 个结果/ })).toBeTruthy();
  });

  it("inside a group room it takes the room locale; a prop wins over it", () => {
    render(
      <GroupRoomLocaleProvider locale="zh-CN">
        <SearchToolCard args={{ pattern: "x" }} fallback={fallback} name="grep" output="" />
      </GroupRoomLocaleProvider>,
    );
    expect(screen.getByText("正在搜索…")).toBeTruthy();
    cleanup();
    render(
      <GroupRoomLocaleProvider locale="zh-CN">
        <SearchToolCard
          args={{ pattern: "x" }}
          fallback={fallback}
          locale="pt"
          name="grep"
          output=""
        />
      </GroupRoomLocaleProvider>,
    );
    expect(screen.getByText("Buscando…")).toBeTruthy();
  });

  it("falls back to navigator.language, and en stays as before", () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("zh-TW");
    render(<SearchToolCard args={{ pattern: "x" }} fallback={fallback} name="grep" output="" />);
    expect(screen.getByText("正在搜索…")).toBeTruthy();
    cleanup();
    renderDone("en-US");
    expect(screen.getByRole("button", { name: /Found 2 results/ })).toBeTruthy();
  });
});

describe("searchResults helpers take a locale (C6.1)", () => {
  it("query label and meta column", () => {
    expect(searchQuery("find", { pattern: "*.md", path: "docs" }, "pt")).toBe("*.md em docs");
    expect(searchQuery("grep", { pattern: "foo", glob: "*.ts" }, "zh")).toBe("*.ts 中的 foo");
    expect(searchQuery("find", { pattern: "*.md", path: "docs" }, "en")).toBe("*.md in docs");
    expect(fileResultMeta({ kind: "file", path: "a/" }, "pt")).toBe("pasta");
    expect(fileResultMeta({ kind: "file", path: "a", matches: 1 }, "pt")).toBe("1 ocorrência");
    expect(fileResultMeta({ kind: "file", path: "a", matches: 3 }, "zh")).toBe("3 处匹配");
    expect(fileResultMeta({ kind: "file", path: "a", matches: 1, line: 7 }, "zh")).toBe("第 7 行");
    expect(fileResultMeta({ kind: "file", path: "a", matches: 3, line: 7 }, "en")).toBe(
      "3 matches",
    );
  });
});
