/**
 * Main-process copy: the native application menu, native dialogs and system
 * notifications. Rebuilt / re-read on every language change (no restart).
 * Same rules as the other catalogs: en defines the keys, pt is typed against
 * it, a missing key falls back to English alone.
 */
import { type GroupRoomLocale, resolveGroupRoomLocale } from "./group-room-locale";
import { type CatalogVars, fillCatalogText, lookupCatalogText } from "./i18n-catalog";

export const MAIN_TEXT_EN = {
  "main.menu.about": "About {app}",
  "main.menu.services": "Services",
  "main.menu.hide": "Hide {app}",
  "main.menu.hideOthers": "Hide Others",
  "main.menu.unhide": "Show All",
  "main.menu.quit": "Quit {app}",
  "main.menu.file": "File",
  "main.menu.close": "Close Window",
  "main.menu.edit": "Edit",
  "main.menu.undo": "Undo",
  "main.menu.redo": "Redo",
  "main.menu.cut": "Cut",
  "main.menu.copy": "Copy",
  "main.menu.paste": "Paste",
  "main.menu.pasteAndMatchStyle": "Paste and Match Style",
  "main.menu.delete": "Delete",
  "main.menu.selectAll": "Select All",
  "main.menu.view": "View",
  "main.menu.reload": "Reload",
  "main.menu.forceReload": "Force Reload",
  "main.menu.toggleDevTools": "Toggle Developer Tools",
  "main.menu.resetZoom": "Actual Size",
  "main.menu.zoomIn": "Zoom In",
  "main.menu.zoomOut": "Zoom Out",
  "main.menu.toggleFullScreen": "Toggle Full Screen",
  "main.menu.window": "Window",
  "main.menu.minimize": "Minimize",
  "main.menu.zoom": "Zoom",
  "main.menu.front": "Bring All to Front",
  "main.menu.help": "Help",
  "main.dialog.openWorkspaceTitle": "Open Modus Workspace",
  "main.dialog.pngImage": "PNG Image",
  "main.notification.defaultTitle": "Modus agent",
  "main.notification.finished": "Agent finished its task.",
  "main.notification.failed": "Agent run failed: {message}",
  "main.notification.permission": "Agent needs permission: {reason}",
  "main.notification.question": "The agent is waiting for your answer.",
  "main.about.modelAttribution":
    "Tool search model: RERANK-03 weights, modified from IBM Granite Embedding (ibm-granite/granite-embedding-97m-multilingual-r2, Copyright IBM), Apache License 2.0. Downloaded on demand with its LICENSE and NOTICE.",
} as const;

export type MainTextKey = keyof typeof MAIN_TEXT_EN;

export const MAIN_TEXT_PT: Record<MainTextKey, string> = {
  "main.menu.about": "Sobre o {app}",
  "main.menu.services": "Serviços",
  "main.menu.hide": "Ocultar {app}",
  "main.menu.hideOthers": "Ocultar Outros",
  "main.menu.unhide": "Mostrar Tudo",
  "main.menu.quit": "Encerrar {app}",
  "main.menu.file": "Arquivo",
  "main.menu.close": "Fechar Janela",
  "main.menu.edit": "Editar",
  "main.menu.undo": "Desfazer",
  "main.menu.redo": "Refazer",
  "main.menu.cut": "Recortar",
  "main.menu.copy": "Copiar",
  "main.menu.paste": "Colar",
  "main.menu.pasteAndMatchStyle": "Colar e Manter Estilo",
  "main.menu.delete": "Apagar",
  "main.menu.selectAll": "Selecionar Tudo",
  "main.menu.view": "Visualizar",
  "main.menu.reload": "Recarregar",
  "main.menu.forceReload": "Forçar Recarregamento",
  "main.menu.toggleDevTools": "Ferramentas do Desenvolvedor",
  "main.menu.resetZoom": "Tamanho Real",
  "main.menu.zoomIn": "Aumentar Zoom",
  "main.menu.zoomOut": "Diminuir Zoom",
  "main.menu.toggleFullScreen": "Tela Cheia",
  "main.menu.window": "Janela",
  "main.menu.minimize": "Minimizar",
  "main.menu.zoom": "Zoom",
  "main.menu.front": "Trazer Tudo para a Frente",
  "main.menu.help": "Ajuda",
  "main.dialog.openWorkspaceTitle": "Abrir workspace do Modus",
  "main.dialog.pngImage": "Imagem PNG",
  "main.notification.defaultTitle": "Agente do Modus",
  "main.notification.finished": "O agente terminou a tarefa.",
  "main.notification.failed": "A execução do agente falhou: {message}",
  "main.notification.permission": "O agente precisa de permissão: {reason}",
  "main.notification.question": "O agente está aguardando sua resposta.",
  "main.about.modelAttribution":
    "Modelo de busca de ferramentas: pesos RERANK-03, modificados a partir do IBM Granite Embedding (ibm-granite/granite-embedding-97m-multilingual-r2, Copyright IBM), Licença Apache 2.0. Baixado sob demanda com seus arquivos LICENSE e NOTICE.",
};

const MAIN_TEXT: Record<GroupRoomLocale, Partial<Record<MainTextKey, string>>> = {
  en: MAIN_TEXT_EN,
  pt: MAIN_TEXT_PT,
  zh: MAIN_TEXT_EN,
};

export function mainText(key: MainTextKey, locale?: string | null, vars?: CatalogVars): string {
  return fillCatalogText(
    lookupCatalogText(MAIN_TEXT_EN, MAIN_TEXT[resolveGroupRoomLocale(locale)], key),
    vars,
  );
}
