import { beforeEach, describe, expect, it, vi } from "vitest";

const setAboutPanelOptions = vi.fn();
vi.mock("electron", () => ({
  app: { name: "Modus", getVersion: () => "9.9.9", setAboutPanelOptions },
  Menu: { buildFromTemplate: vi.fn(() => ({})), setApplicationMenu: vi.fn() },
}));

const { installApplicationMenu } = await import("./application-menu");

describe("About panel model attribution", () => {
  beforeEach(() => setAboutPanelOptions.mockClear());

  it("credits the RERANK-03 weights (IBM, Apache-2.0), in the UI language", () => {
    installApplicationMenu("en");
    expect(setAboutPanelOptions.mock.calls[0]?.[0].credits).toMatch(
      /IBM Granite Embedding.*Apache License 2\.0/,
    );
    installApplicationMenu("pt-BR");
    expect(setAboutPanelOptions.mock.calls[1]?.[0].credits).toMatch(
      /^Modelo de busca de ferramentas/,
    );
  });
});
