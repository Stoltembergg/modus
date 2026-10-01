/** Composio integration DTOs safe to cross the main/renderer boundary. */

export type ComposioUserError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type ComposioAccountSummary = {
  id: string;
  toolkitSlug: string;
  alias: string;
  status: "active" | "pending" | "failed" | "expired" | "revoked" | "disabled" | "unknown";
};

export type ComposioToolkitSummary = {
  slug: string;
  name: string;
  description?: string;
  accounts: ComposioAccountSummary[];
  enabled: boolean;
  selectedAccountId?: string;
  selectedToolSlugs: string[];
};

export type ComposioToolSummary = {
  toolkitSlug: string;
  slug: string;
  name: string;
  description?: string;
  riskHint?: string;
};

export type ComposioConnectionOperation = {
  id: string;
  toolkitSlug: string;
  alias: string;
  status: "pending" | "active" | "failed" | "expired" | "canceled";
  error?: ComposioUserError;
};

export type ComposioSettingsState = {
  apiKeyConfigured: boolean;
  status: "unconfigured" | "loading" | "ready" | "error";
  toolkits: ComposioToolkitSummary[];
  error?: ComposioUserError;
};

export type ComposioToolkitPolicyInput = {
  toolkitSlug: string;
  enabled: boolean;
  selectedToolSlugs: string[];
  selectedAccountId?: string;
};

export type ComposioStartConnectionInput = {
  toolkitSlug: string;
  alias: string;
};

export type ComposioRenameAccountInput = {
  toolkitSlug: string;
  accountId: string;
  alias: string;
};

export type ComposioDisconnectAccountInput = {
  toolkitSlug: string;
  accountId: string;
};
