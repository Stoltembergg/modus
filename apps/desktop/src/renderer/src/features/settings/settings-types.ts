export type SettingsSectionId =
  | "general"
  | "model-provider"
  | "appearance"
  | "personalization"
  | "skills"
  | "subagents"
  | "mcp"
  | "rules"
  | "project-memory"
  | "harness-insights"
  | "limits";

export type ModelConfigPatch = {
  thinkingVariant?: string;
  contextWindow?: number;
  maxTokens?: number;
};
