import { describe, expect, it } from "vitest";
import { SHELL_TEXT_EN, SHELL_TEXT_PT, SHELL_TEXT_ZH, shellText } from "./shell-text";

describe("shell text", () => {
  it("has the same keys in every locale", () => {
    const keys = Object.keys(SHELL_TEXT_EN).sort();
    expect(Object.keys(SHELL_TEXT_PT).sort()).toEqual(keys);
    expect(Object.keys(SHELL_TEXT_ZH).sort()).toEqual(keys);
  });

  it("resolves the locale and falls back to English", () => {
    expect(shellText("shell.projects")).toBe("Projects");
    expect(shellText("shell.noProject", "pt-BR")).toBe("Sem projeto");
    expect(shellText("shell.projects", "zh-CN")).toBe("项目");
  });
});
