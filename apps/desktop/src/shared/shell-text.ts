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
  "shell.newMessage": "New message",
  "shell.groups": "Groups",
  "shell.settings": "Settings",
  "shell.pinSidebar": "Pin sidebar open",
  "shell.unpinSidebar": "Unpin sidebar",
  "shell.menu": "Menu",
  "shell.editProfile": "Edit profile",
  "shell.profileRestoredAs": 'Restored as "{name}"',
  "shell.readOnlyHistory": "This chat is read-only history.",
  "shell.taskChecklist": "Task checklist",
  "shell.showTaskChecklist": "Show task checklist",
  "shell.hideTaskChecklist": "Hide task checklist",
  "shell.taskChecklistHidden": "The task checklist is hidden.",
  "shell.run.working": "Working on your request",
  "shell.run.retrying": "Retrying the current turn",
  "shell.run.thinking": "Thinking…",
  "shell.run.writing": "Writing the response…",
  "shell.run.runningCommand": "Running {command}",
  "shell.run.runningTool": "Running {tool}",
  "shell.run.editing": "Editing {file}",
  "shell.run.reading": "Reading {file}",
  "shell.run.searching": "Searching the codebase…",
  "shell.run.spawningSubagent": "Spawning subagent",
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
  "shell.newMessage": "Nova mensagem",
  "shell.groups": "Grupos",
  "shell.settings": "Configurações",
  "shell.pinSidebar": "Fixar sidebar aberta",
  "shell.unpinSidebar": "Desafixar sidebar",
  "shell.menu": "Menu",
  "shell.editProfile": "Editar perfil",
  "shell.profileRestoredAs": 'Restaurado como "{name}"',
  "shell.readOnlyHistory": "Esta conversa é um histórico somente leitura.",
  "shell.taskChecklist": "Lista de tarefas",
  "shell.showTaskChecklist": "Mostrar lista de tarefas",
  "shell.hideTaskChecklist": "Ocultar lista de tarefas",
  "shell.taskChecklistHidden": "A lista de tarefas está oculta.",
  "shell.run.working": "Trabalhando no seu pedido",
  "shell.run.retrying": "Tentando o turno de novo",
  "shell.run.thinking": "Pensando…",
  "shell.run.writing": "Escrevendo a resposta…",
  "shell.run.runningCommand": "Executando {command}",
  "shell.run.runningTool": "Executando {tool}",
  "shell.run.editing": "Editando {file}",
  "shell.run.reading": "Lendo {file}",
  "shell.run.searching": "Buscando no código…",
  "shell.run.spawningSubagent": "Iniciando subagente",
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
  "shell.newMessage": "新消息",
  "shell.groups": "群组",
  "shell.settings": "设置",
  "shell.pinSidebar": "固定侧边栏",
  "shell.unpinSidebar": "取消固定侧边栏",
  "shell.menu": "菜单",
  "shell.editProfile": "编辑档案",
  "shell.profileRestoredAs": "已恢复为“{name}”",
  "shell.readOnlyHistory": "此对话为只读历史记录。",
  "shell.taskChecklist": "任务清单",
  "shell.showTaskChecklist": "显示任务清单",
  "shell.hideTaskChecklist": "隐藏任务清单",
  "shell.taskChecklistHidden": "任务清单已隐藏。",
  "shell.run.working": "正在处理你的请求",
  "shell.run.retrying": "正在重试当前轮次",
  "shell.run.thinking": "思考中…",
  "shell.run.writing": "正在撰写回复…",
  "shell.run.runningCommand": "正在运行 {command}",
  "shell.run.runningTool": "正在运行 {tool}",
  "shell.run.editing": "正在编辑 {file}",
  "shell.run.reading": "正在读取 {file}",
  "shell.run.searching": "正在搜索代码库…",
  "shell.run.spawningSubagent": "正在启动子代理",
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
