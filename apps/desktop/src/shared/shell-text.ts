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
} as const;

export type ShellTextKey = keyof typeof SHELL_TEXT_EN;

export const SHELL_TEXT_PT: Record<ShellTextKey, string> = {
  "shell.projects": "Projetos",
  "shell.noProject": "Sem projeto",
  "shell.chatsEmpty": "Suas conversas aparecerão aqui.",
  "shell.selectChatForActivity": "Selecione uma conversa para ver a atividade.",
};

export const SHELL_TEXT_ZH: Record<ShellTextKey, string> = {
  "shell.projects": "项目",
  "shell.noProject": "无项目",
  "shell.chatsEmpty": "你的对话会显示在这里。",
  "shell.selectChatForActivity": "选择一个对话以查看活动。",
};

const SHELL_TEXT: Record<GroupRoomLocale, Record<ShellTextKey, string>> = {
  en: SHELL_TEXT_EN,
  pt: SHELL_TEXT_PT,
  zh: SHELL_TEXT_ZH,
};

export function shellText(key: ShellTextKey, locale?: string | null): string {
  return SHELL_TEXT[resolveGroupRoomLocale(locale)][key];
}
