/**
 * App shell copy (rail, sidebar, project chip, activity panel) in en / pt / zh.
 * Same pattern as `files-search-text.ts`: the en table defines the key set and
 * pt / zh must have the same keys (type-checked here and by the parity test).
 * The locale is resolved like the other catalogs (`resolveGroupRoomLocale`):
 * no locale means English.
 */
import { type GroupRoomLocale, resolveGroupRoomLocale } from "./group-room-locale";

export const SHELL_TEXT_EN = {
  "shell.projects": "Projects",
  "shell.noProject": "No project",
  "shell.chatsEmpty": "Your chats will appear here.",
  "shell.selectChatForActivity": "Select a chat to view activity.",
  "shell.model": "Model",
  "shell.modelDefault": "Default ({name})",
  "shell.pickModel": "Pick a model",
  "shell.effort": "Effort",
  "shell.modelRunning": "Can't change the model while a run is active.",
  "shell.newProfile": "New profile",
  "shell.editProfile": "Edit profile",
  "shell.profileRestoredAs": 'Restored as "{name}"',
  "shell.readOnlyHistory": "This chat is read-only history.",
} as const;

export type ShellTextKey = keyof typeof SHELL_TEXT_EN;

export const SHELL_TEXT_PT: Record<ShellTextKey, string> = {
  "shell.projects": "Projetos",
  "shell.noProject": "Sem projeto",
  "shell.chatsEmpty": "Suas conversas aparecerão aqui.",
  "shell.selectChatForActivity": "Selecione uma conversa para ver a atividade.",
  "shell.model": "Modelo",
  "shell.modelDefault": "Padrão ({name})",
  "shell.pickModel": "Escolha um modelo",
  "shell.effort": "Esforço",
  "shell.modelRunning": "Não dá para trocar o modelo com uma execução ativa.",
  "shell.newProfile": "Novo perfil",
  "shell.editProfile": "Editar perfil",
  "shell.profileRestoredAs": 'Restaurado como "{name}"',
  "shell.readOnlyHistory": "Esta conversa é um histórico somente leitura.",
};

export const SHELL_TEXT_ZH: Record<ShellTextKey, string> = {
  "shell.projects": "项目",
  "shell.noProject": "无项目",
  "shell.chatsEmpty": "你的对话会显示在这里。",
  "shell.selectChatForActivity": "选择一个对话以查看活动。",
  "shell.model": "模型",
  "shell.modelDefault": "默认（{name}）",
  "shell.pickModel": "选择模型",
  "shell.effort": "推理强度",
  "shell.modelRunning": "运行中无法更换模型。",
  "shell.newProfile": "新建档案",
  "shell.editProfile": "编辑档案",
  "shell.profileRestoredAs": "已恢复为“{name}”",
  "shell.readOnlyHistory": "此对话为只读历史记录。",
};

const SHELL_TEXT: Record<GroupRoomLocale, Record<ShellTextKey, string>> = {
  en: SHELL_TEXT_EN,
  pt: SHELL_TEXT_PT,
  zh: SHELL_TEXT_ZH,
};

export type ShellTextVars = Readonly<Record<string, string | number>>;

function fillShellText(template: string, vars?: ShellTextVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

export function shellText(key: ShellTextKey, locale?: string | null, vars?: ShellTextVars): string {
  return fillShellText(SHELL_TEXT[resolveGroupRoomLocale(locale)][key], vars);
}
