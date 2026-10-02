export type SettingsSectionId =
  | "general"
  | "model-provider"
  | "appearance"
  | "personalization"
  | "skills"
  | "subagents"
  | "mcp"
  | "rules";

export type ModelConfigPatch = {
  thinkingVariant?: string;
  contextWindow?: number;
  maxTokens?: number;
};
