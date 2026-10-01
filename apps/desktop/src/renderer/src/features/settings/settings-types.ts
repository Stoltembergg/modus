export type SettingsSectionId =
  | "general"
  | "model-provider"
  | "appearance"
  | "personalization"
  | "skills"
  | "subagents"
  | "mcp"
  | "integrations"
  | "rules"
  | "project-memory"
  | "harness-insights"
  | "failure-blacklist"
  | "limits";

export type ModelConfigPatch = {
  thinkingVariant?: string;
  contextWindow?: number;
  maxTokens?: number;
};
