/** Settings → General (language, approval mode, ask-before-acting). */
export const GENERAL_TEXT_EN = {
  "settings.general.title": "General",
  "settings.general.languageTitle": "Language",
  "settings.general.languageDesc":
    "Applies right away, including the app menu. System follows your computer's language.",
  "settings.general.languageSystem": "System",
  "settings.general.languageSystemResolved": "System ({language})",
  "settings.general.projectFallback": "Project",
  "settings.general.openWorkspaceError": "Open a workspace to set a project override.",
  "settings.general.tabHome": "Home",
  "settings.general.approvalModeGlobalTitle": "Global approval mode",
  "settings.general.approvalModeProjectTitle": "Approval mode · {project}",
  "settings.general.approvalScopeLabel": "Approval mode scope",
  "settings.general.approvalModeGlobalDesc":
    "Default for every workspace that does not set an override.",
  "settings.general.approvalModeFollowingGlobal":
    "Following global default ({mode}). Pick a mode to override.",
  "settings.general.approvalModeOverrideActiveWorkspace":
    "Override active for this workspace. Use global to clear it.",
  "settings.general.followGlobalDefault": "Follow global default",
  "settings.general.usingGlobalMode": "Using {mode}",
  "settings.general.overrideActiveProject": "Override active for this project",
  "settings.general.following": "Following",
  "settings.general.useGlobal": "Use global",
  "settings.general.scopeHint":
    "Home sets the app-wide default. Project tabs optionally override that default for one workspace.",
  "settings.general.modeRequestApproval": "Request approval",
  "settings.general.modeRequestApprovalDesc":
    "Ask before edits, commands, and other risky actions.",
  "settings.general.modeAuto": "Auto",
  "settings.general.modeAutoDesc": "Only ask for high-risk actions like deletes and git pushes.",
  "settings.general.modeFullAccess": "Full access",
  "settings.general.modeFullAccessDesc": "Never ask. Unrestricted access to your files.",
  "settings.general.askMissingTargetTitle": "Ask before acting when the target is missing",
  "settings.general.askMissingTargetDesc":
    'In Build mode, asks one question when a request like "Fix it" doesn\'t say what to change. Off: the agent proceeds directly. Destructive actions are always confirmed.',
} as const;

export const GENERAL_TEXT_PT: Record<keyof typeof GENERAL_TEXT_EN, string> = {
  "settings.general.title": "Geral",
  "settings.general.languageTitle": "Idioma",
  "settings.general.languageDesc":
    "Muda na hora, inclusive o menu do app. Sistema segue o idioma do computador.",
  "settings.general.languageSystem": "Sistema",
  "settings.general.languageSystemResolved": "Sistema ({language})",
  "settings.general.projectFallback": "Projeto",
  "settings.general.openWorkspaceError":
    "Abra um workspace para definir uma configuração própria do projeto.",
  "settings.general.tabHome": "Início",
  "settings.general.approvalModeGlobalTitle": "Modo de aprovação global",
  "settings.general.approvalModeProjectTitle": "Modo de aprovação · {project}",
  "settings.general.approvalScopeLabel": "Escopo do modo de aprovação",
  "settings.general.approvalModeGlobalDesc":
    "Padrão para todo workspace que não tem configuração própria.",
  "settings.general.approvalModeFollowingGlobal":
    "Seguindo o padrão global ({mode}). Escolha um modo para substituir.",
  "settings.general.approvalModeOverrideActiveWorkspace":
    "Este workspace usa um modo próprio. Clique em “Usar global” para voltar ao padrão.",
  "settings.general.followGlobalDefault": "Seguir padrão global",
  "settings.general.usingGlobalMode": "Usando {mode}",
  "settings.general.overrideActiveProject": "Modo próprio ativo neste projeto",
  "settings.general.following": "Seguindo",
  "settings.general.useGlobal": "Usar global",
  "settings.general.scopeHint":
    "Início define o padrão para todo o app. As abas de projeto podem substituir esse padrão para um workspace.",
  "settings.general.modeRequestApproval": "Pedir aprovação",
  "settings.general.modeRequestApprovalDesc":
    "Perguntar antes de edições, comandos e outras ações de risco.",
  "settings.general.modeAuto": "Automático",
  "settings.general.modeAutoDesc":
    "Perguntar apenas para ações de alto risco, como exclusões e git push.",
  "settings.general.modeFullAccess": "Acesso total",
  "settings.general.modeFullAccessDesc": "Nunca perguntar. Acesso irrestrito aos seus arquivos.",
  "settings.general.askMissingTargetTitle":
    "Perguntar antes de agir quando não estiver claro o que alterar",
  "settings.general.askMissingTargetDesc":
    'No modo Build, faz uma pergunta quando um pedido como "corrige isso" não diz o que mudar. Desativado: o agente prossegue diretamente. Ações destrutivas são sempre confirmadas.',
};
