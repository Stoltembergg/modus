// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsSidebar } from "./sections/SettingsSidebar";

function renderSidebar(query: string): string {
  return renderToStaticMarkup(
    <SettingsSidebar
      activeSection="general"
      onBack={() => {}}
      onQueryChange={() => {}}
      onSectionChange={() => {}}
      query={query}
    />,
  );
}

function groupHeadings(markup: string): string[] {
  return [...markup.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map((match) => match[1] ?? "");
}

function navLabels(markup: string): string[] {
  return [...markup.matchAll(/<span class="truncate">([^<]*)<\/span>/g)].map(
    (match) => match[1] ?? "",
  );
}

describe("Settings navigation in Portuguese (<html lang=pt-BR>)", () => {
  const PT_NAV = {
    Workspace: ["MCP e integrações", "Skills", "Regras"],
    Modelos: ["Modelo e provedor"],
    Interface: ["Geral", "Conta", "Aparência", "Personalização"],
  } as const;

  function inPortuguese<T>(run: () => T): T {
    const previous = document.documentElement.lang;
    document.documentElement.lang = "pt-BR";
    try {
      return run();
    } finally {
      document.documentElement.lang = previous;
    }
  }

  it("renders the groups, items and chrome from the pt catalog", () => {
    const markup = inPortuguese(() => renderSidebar(""));
    expect(groupHeadings(markup)).toEqual(Object.keys(PT_NAV));
    expect(navLabels(markup)).toEqual(Object.values(PT_NAV).flat());
    expect(markup).toContain("Voltar");
    expect(markup).toContain('placeholder="Buscar configurações..."');
  });

  it("searches the labels people see, accents optional", () => {
    expect(navLabels(inPortuguese(() => renderSidebar("aparência")))).toEqual(["Aparência"]);
    expect(navLabels(inPortuguese(() => renderSidebar("aparencia")))).toEqual(["Aparência"]);
    expect(navLabels(inPortuguese(() => renderSidebar("appear")))).toEqual([]);
    expect(inPortuguese(() => renderSidebar("zzz"))).toContain("Nenhuma configuração encontrada");
  });
});
