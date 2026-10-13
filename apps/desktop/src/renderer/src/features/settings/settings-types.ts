export type SettingsSectionId =
  | "general"
  | "account"
  | "model-provider"
  | "appearance"
  | "personalization"
  | "skills"
  | "mcp"
  | "rules";

export type ModelConfigPatch = {
  thinkingVariant?: string;
  contextWindow?: number;
  maxTokens?: number;
};
