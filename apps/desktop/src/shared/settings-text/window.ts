/** Settings window chrome: panel, layout, sidebar, nav, shared form controls. */
export const WINDOW_TEXT_EN = {
  // Navigation sidebar & window chrome
  "settings.window.back": "Back",
  "settings.window.searchPlaceholder": "Search settings...",
  "settings.window.noSettingsMatch": "No settings match",
  "settings.window.appTitle": "Modus Desktop",

  // Navigation groups
  "settings.window.navGroupWorkspace": "Workspace",
  "settings.window.navGroupModels": "Models",
  "settings.window.navGroupInterface": "Interface",

  // Navigation items
  "settings.window.navGeneral": "General",
  "settings.window.navAccount": "Account",
  "settings.window.navModelProvider": "Model & Provider",
  "settings.window.navAppearance": "Appearance",
  "settings.window.navPersonalization": "Personalization",
  "settings.window.navMcp": "MCP & Integrations",
  "settings.window.navSkills": "Skills",
  "settings.window.navRules": "Rules",

  // Settings panel confirmations & messages
  "settings.window.removeProviderConfirm":
    'Remove "{name}"? This deletes its local configuration and models from Modus.',
  "settings.window.disconnectProviderConfirmCustom":
    'Disconnect "{name}"? This removes saved credentials and enabled models from Modus. Its endpoint and model definition will remain for reconnection.',
  "settings.window.disconnectProviderConfirmStandard":
    'Disconnect "{name}"? This removes saved credentials and enabled models from Modus. Any Modus base URL override will also be removed.',
  "settings.window.providerSignInFailed": "Provider sign-in failed.",

  // Shared form controls & KeyValueEditor
  "settings.window.keyValueKeyAriaLabel": "{title} key",
  "settings.window.keyValueValueAriaLabel": "{title} value",
  "settings.window.removeRow": "Remove row",
} as const;

export const WINDOW_TEXT_PT: Record<keyof typeof WINDOW_TEXT_EN, string> = {
  // Navigation sidebar & window chrome
  "settings.window.back": "Voltar",
  "settings.window.searchPlaceholder": "Buscar configurações...",
  "settings.window.noSettingsMatch": "Nenhuma configuração encontrada",
  "settings.window.appTitle": "Modus Desktop",

  // Navigation groups
  "settings.window.navGroupWorkspace": "Workspace",
  "settings.window.navGroupModels": "Modelos",
  "settings.window.navGroupInterface": "Interface",

  // Navigation items
  "settings.window.navGeneral": "Geral",
  "settings.window.navAccount": "Conta",
  "settings.window.navModelProvider": "Modelo e provedor",
  "settings.window.navAppearance": "Aparência",
  "settings.window.navPersonalization": "Personalização",
  "settings.window.navMcp": "MCP e integrações",
  "settings.window.navSkills": "Skills",
  "settings.window.navRules": "Regras",

  // Settings panel confirmations & messages
  "settings.window.removeProviderConfirm":
    'Remover "{name}"? Isso exclui sua configuração local e seus modelos do Modus.',
  "settings.window.disconnectProviderConfirmCustom":
    'Desconectar "{name}"? Isso remove as credenciais salvas e os modelos ativados do Modus. Seu endpoint e definição de modelo permanecerão para reconexão.',
  "settings.window.disconnectProviderConfirmStandard":
    'Desconectar "{name}"? Isso remove as credenciais salvas e os modelos ativados do Modus. Qualquer substituição de URL base do Modus também será removida.',
  "settings.window.providerSignInFailed": "Falha ao entrar no provedor.",

  // Shared form controls & KeyValueEditor
  "settings.window.keyValueKeyAriaLabel": "Chave de {title}",
  "settings.window.keyValueValueAriaLabel": "Valor de {title}",
  "settings.window.removeRow": "Remover linha",
};
