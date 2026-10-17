/** Settings → Skills and Rules. */
export const SKILLS_RULES_TEXT_EN = {
  // Skills section
  "settings.skillsRules.openFolder": "Open folder",
  "settings.skillsRules.new": "New",
  "settings.skillsRules.skillsTitle": "Skills",
  "settings.skillsRules.name": "Name",
  "settings.skillsRules.namePlaceholder": "code-review",
  "settings.skillsRules.description": "Description",
  "settings.skillsRules.descriptionPlaceholder": "Review a diff for correctness and security",
  "settings.skillsRules.instructions": "Instructions",
  "settings.skillsRules.instructionsPlaceholder":
    "# code-review\n\nUse this skill when reviewing code.\n\n## Steps\n\n1. Read the diff.\n2. Find correctness risks.\n3. Return concise findings first.",
  "settings.skillsRules.cancel": "Cancel",
  "settings.skillsRules.creating": "Creating…",
  "settings.skillsRules.createSkill": "Create skill",
  "settings.skillsRules.availableSkills": "Available skills",
  "settings.skillsRules.noWorkspaceSkills": "Open a workspace to discover and create skills.",
  "settings.skillsRules.discoveringSkills": "Discovering skills…",
  "settings.skillsRules.noSkills": "No skills yet. Create one, or drop a {file} into {dir}.",
  "settings.skillsRules.scopeBuiltin": "builtin",
  "settings.skillsRules.scopeUser": "user · {source}",
  "settings.skillsRules.scopeProject": "project · {source}",

  // Rules section
  "settings.skillsRules.refresh": "Refresh",
  "settings.skillsRules.refreshing": "Refreshing…",
  "settings.skillsRules.save": "Save",
  "settings.skillsRules.createAgents": "Create AGENTS.md",
  "settings.skillsRules.saving": "Saving…",
  "settings.skillsRules.rulesTitle": "Rules",
  "settings.skillsRules.agentsSaved": "AGENTS.md saved.",
  "settings.skillsRules.agentsCreated": "AGENTS.md created.",
  "settings.skillsRules.agentsSectionTitle": "AGENTS.md",
  "settings.skillsRules.editExampleDescription":
    "Edit this example, then save it to your workspace.",
  "settings.skillsRules.appliedAutomaticallyDescription":
    "Applied automatically in this workspace.",
  "settings.skillsRules.noWorkspaceEditRules": "Open a workspace to edit project rules.",
  "settings.skillsRules.onDisk": "On disk",
  "settings.skillsRules.exampleNotSaved": "Example (not saved)",
  "settings.skillsRules.resetToExample": "Reset to example",
  "settings.skillsRules.openFile": "Open file",
  "settings.skillsRules.projectRulesPlaceholder": "Project rules…",
  "settings.skillsRules.detectedRuleFiles": "Detected rule files",
  "settings.skillsRules.noWorkspaceDiscoverRules": "Open a workspace to discover project rules.",
  "settings.skillsRules.scanningWorkspace": "Scanning workspace…",
  "settings.skillsRules.noRuleFiles":
    "No rule files on disk yet. Save the example above to create {agents}, or add {cursorRules} with {alwaysApply}.",
  "settings.skillsRules.globs": "globs: {globs}",
  "settings.skillsRules.autoAppliedTitle": "Auto-applied",
  "settings.skillsRules.autoAppliedDescription_one":
    "{count} rule file injected into the system prompt for every new agent session in this workspace.",
  "settings.skillsRules.autoAppliedDescription_other":
    "{count} rule files injected into the system prompt for every new agent session in this workspace.",
  "settings.skillsRules.ruleModeAlways": "Always",
  "settings.skillsRules.ruleModeGlob": "Glob",
  "settings.skillsRules.ruleModeIntelligent": "Intelligent",
  "settings.skillsRules.ruleModeManual": "Manual",
} as const;

export const SKILLS_RULES_TEXT_PT: Record<keyof typeof SKILLS_RULES_TEXT_EN, string> = {
  // Skills section
  "settings.skillsRules.openFolder": "Abrir pasta",
  "settings.skillsRules.new": "Nova",
  "settings.skillsRules.skillsTitle": "Skills",
  "settings.skillsRules.name": "Nome",
  "settings.skillsRules.namePlaceholder": "code-review",
  "settings.skillsRules.description": "Descrição",
  "settings.skillsRules.descriptionPlaceholder": "Revise um diff quanto a correção e segurança",
  "settings.skillsRules.instructions": "Instruções",
  "settings.skillsRules.instructionsPlaceholder":
    "# code-review\n\nUse esta skill ao revisar código.\n\n## Passos\n\n1. Leia o diff.\n2. Encontre riscos de correção.\n3. Retorne conclusões concisas primeiro.",
  "settings.skillsRules.cancel": "Cancelar",
  "settings.skillsRules.creating": "Criando…",
  "settings.skillsRules.createSkill": "Criar skill",
  "settings.skillsRules.availableSkills": "Skills disponíveis",
  "settings.skillsRules.noWorkspaceSkills": "Abra um workspace para descobrir e criar skills.",
  "settings.skillsRules.discoveringSkills": "Descobrindo skills…",
  "settings.skillsRules.noSkills": "Nenhuma skill ainda. Crie uma ou coloque um {file} em {dir}.",
  "settings.skillsRules.scopeBuiltin": "integrada",
  "settings.skillsRules.scopeUser": "usuário · {source}",
  "settings.skillsRules.scopeProject": "projeto · {source}",

  // Rules section
  "settings.skillsRules.refresh": "Atualizar",
  "settings.skillsRules.refreshing": "Atualizando…",
  "settings.skillsRules.save": "Salvar",
  "settings.skillsRules.createAgents": "Criar AGENTS.md",
  "settings.skillsRules.saving": "Salvando…",
  "settings.skillsRules.rulesTitle": "Regras",
  "settings.skillsRules.agentsSaved": "AGENTS.md salvo.",
  "settings.skillsRules.agentsCreated": "AGENTS.md criado.",
  "settings.skillsRules.agentsSectionTitle": "AGENTS.md",
  "settings.skillsRules.editExampleDescription": "Edite este exemplo e salve-o no seu workspace.",
  "settings.skillsRules.appliedAutomaticallyDescription":
    "Aplicado automaticamente neste workspace.",
  "settings.skillsRules.noWorkspaceEditRules":
    "Abra um workspace para editar as regras do projeto.",
  "settings.skillsRules.onDisk": "No disco",
  "settings.skillsRules.exampleNotSaved": "Exemplo (não salvo)",
  "settings.skillsRules.resetToExample": "Restaurar exemplo",
  "settings.skillsRules.openFile": "Abrir arquivo",
  "settings.skillsRules.projectRulesPlaceholder": "Regras do projeto…",
  "settings.skillsRules.detectedRuleFiles": "Arquivos de regras detectados",
  "settings.skillsRules.noWorkspaceDiscoverRules":
    "Abra um workspace para descobrir as regras do projeto.",
  "settings.skillsRules.scanningWorkspace": "Examinando workspace…",
  "settings.skillsRules.noRuleFiles":
    "Nenhum arquivo de regras no disco ainda. Salve o exemplo acima para criar o {agents} ou adicione {cursorRules} com {alwaysApply}.",
  "settings.skillsRules.globs": "globs: {globs}",
  "settings.skillsRules.autoAppliedTitle": "Autoaplicado",
  "settings.skillsRules.autoAppliedDescription_one":
    "{count} arquivo de regras injetado no prompt do sistema a cada nova sessão de agente neste workspace.",
  "settings.skillsRules.autoAppliedDescription_other":
    "{count} arquivos de regras injetados no prompt do sistema a cada nova sessão de agente neste workspace.",
  "settings.skillsRules.ruleModeAlways": "Sempre",
  "settings.skillsRules.ruleModeGlob": "Glob",
  "settings.skillsRules.ruleModeIntelligent": "Inteligente",
  "settings.skillsRules.ruleModeManual": "Manual",
};
