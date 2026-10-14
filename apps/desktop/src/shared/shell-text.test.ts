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
    expect(shellText("shell.newProfile")).toBe("New Agent");
    expect(shellText("shell.newProfile", "pt-BR")).toBe("Novo agente");
    expect(shellText("shell.newProfile", "zh-CN")).toBe("新建智能体");
    expect(shellText("shell.editProfile")).toBe("Edit profile");
    expect(shellText("shell.editProfile", "pt-BR")).toBe("Editar perfil");
    expect(shellText("shell.editProfile", "zh-CN")).toBe("编辑档案");
  });

  it("fills placeholders like {name} in every locale", () => {
    expect(shellText("shell.modelDefault", undefined, { name: "Claude" })).toBe("Default (Claude)");
    expect(shellText("shell.modelDefault", "pt-BR", { name: "Claude" })).toBe("Padrão (Claude)");
    expect(shellText("shell.modelDefault", "zh-CN", { name: "Claude" })).toBe("默认（Claude）");
    expect(shellText("shell.profileRestoredAs", undefined, { name: "Ana 2" })).toBe(
      'Restored as "Ana 2"',
    );
    expect(shellText("shell.profileRestoredAs", "pt-BR", { name: "Ana 2" })).toBe(
      'Restaurado como "Ana 2"',
    );
    expect(shellText("shell.profileRestoredAs", "zh-CN", { name: "Ana 2" })).toBe(
      "已恢复为“Ana 2”",
    );
  });
});
