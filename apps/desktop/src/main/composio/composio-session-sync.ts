import { SessionPreset } from "@composio/core";
import type {
  ComposioAccountSummary,
  ComposioSettingsState,
  ComposioUserError,
} from "../../shared/contracts";
import type { ComposioMcpBridge } from "../mcp/mcp-service";
import type {
  ComposioAccountRecord,
  ComposioApi,
  ComposioSession,
  ComposioSessionConfig,
  ComposioToolkitRecord,
} from "./composio-api";
import type { ComposioProfileConfig } from "./composio-profile-store";

export type ComposioSessionSyncInput = {
  profile: ComposioProfileConfig;
  api: ComposioApi;
  mcp: ComposioMcpBridge;
  loadProfile?: () => ComposioProfileConfig;
  persistSessionId?: (sessionId: string | undefined) => void;
};

type SyncGeneration = number;

const NO_TOOLS_STATE: ComposioSettingsState = {
  apiKeyConfigured: true,
  status: "loading",
  toolkits: [],
};

let latestGeneration: SyncGeneration = 0;
let reconciliationTail: Promise<void> = Promise.resolve();

function errorFields(error: unknown): { code: string; message: string; status?: number } {
  if (typeof error !== "object" || error === null) {
    return { code: "", message: String(error ?? "") };
  }
  const value = error as Record<string, unknown>;
  const code = [value.code, value.type, value.name]
    .filter((item): item is string => typeof item === "string")
    .join(" ")
    .toLowerCase();
  const message = typeof value.message === "string" ? value.message.toLowerCase() : "";
  const rawStatus = value.statusCode ?? value.status ?? value.httpStatus;
  const status = typeof rawStatus === "number" ? rawStatus : undefined;
  return { code, message, ...(status !== undefined ? { status } : {}) };
}

function isConflict(error: unknown): boolean {
  const fields = errorFields(error);
  return (
    fields.status === 409 || /conflict|version_mismatch/.test(`${fields.code} ${fields.message}`)
  );
}

function isNotFound(error: unknown): boolean {
  const fields = errorFields(error);
  return fields.status === 404 || /not_found|not found/.test(`${fields.code} ${fields.message}`);
}

function mapSyncError(error: unknown, writeOperation: boolean): ComposioUserError {
  const { code, message, status } = errorFields(error);
  const markers = `${code} ${message}`;
  if (status === 401 || /invalid[_ -]?(?:api[_ -]?)?key|unauthorized/.test(markers)) {
    return {
      code: "invalid_project_key",
      message:
        "A Project API Key é inválida ou não pode acessar esta sessão Composio. Confirme o projeto e a chave.",
      retryable: false,
    };
  }
  if (status === 403 || /insufficient_scope|permission_denied|forbidden/.test(code)) {
    return {
      code: writeOperation ? "missing_scope_write" : "missing_scope_read",
      message: writeOperation
        ? "A chave do projeto não pode gerenciar sessões do Composio. Habilite a permissão de escrita de sessões na Project API Key. Se esta chave substituiu outra que funcionava, reinsira a chave anterior."
        : "A Project API Key não permite consultar as integrações necessárias. Habilite as permissões de leitura correspondentes no Composio.",
      retryable: false,
    };
  }
  if (status === 429 || /rate.?limit|too many requests/.test(markers)) {
    return {
      code: "rate_limited",
      message:
        "O Composio limitou temporariamente esta sincronização. Tente novamente em instantes.",
      retryable: true,
    };
  }
  if (
    (status !== undefined && status >= 500) ||
    /network|fetch|econn|socket|offline/.test(markers)
  ) {
    return {
      code: "network_unavailable",
      message:
        "Não foi possível sincronizar a sessão do Composio. Verifique a conexão e tente novamente.",
      retryable: true,
    };
  }
  if (status === 404 && writeOperation) {
    return {
      code: "session_not_found",
      message:
        "A sessão do Composio não existe mais. Atualize as integrações para criar uma sessão segura.",
      retryable: true,
    };
  }
  return {
    code: "session_sync_failed",
    message:
      "Não foi possível sincronizar com segurança as ferramentas selecionadas do Composio. As ferramentas permanecerão ocultas até você tentar novamente.",
    retryable: true,
  };
}

function accountStatus(status: string): ComposioAccountSummary["status"] {
  switch (status.trim().toLowerCase()) {
    case "active":
    case "connected":
      return "active";
    case "pending":
    case "initiated":
      return "pending";
    case "failed":
      return "failed";
    case "expired":
    case "needs_reauth":
    case "needs reauth":
      return "expired";
    case "revoked":
    case "inactive":
      return "revoked";
    case "disabled":
      return "disabled";
    default:
      return "unknown";
  }
}

export function buildComposioSessionConfig(
  profileId: string,
  profileConfig: ComposioProfileConfig,
): ComposioSessionConfig {
  const activePolicies = Object.entries(profileConfig.toolkits)
    .filter(
      ([, policy]) =>
        policy.enabled &&
        typeof policy.selectedAccountId === "string" &&
        policy.selectedAccountId.length > 0 &&
        policy.selectedToolSlugs.length > 0,
    )
    .sort(([left], [right]) => left.localeCompare(right));
  const toolkits = activePolicies.map(([toolkitSlug]) => toolkitSlug);
  const tools = Object.fromEntries(
    activePolicies.map(([toolkitSlug, policy]) => [
      toolkitSlug,
      { enable: [...new Set(policy.selectedToolSlugs)] },
    ]),
  );
  const connectedAccounts = Object.fromEntries(
    activePolicies.map(([toolkitSlug, policy]) => {
      const accountId = policy.selectedAccountId;
      return [toolkitSlug, accountId ? [accountId] : []];
    }),
  );
  void profileId;
  return {
    toolkits: { enable: toolkits },
    tools,
    connectedAccounts,
    sessionPreset: SessionPreset.DIRECT_TOOLS,
    mcp: true,
    sandbox: { enable: false },
    manageConnections: { enable: false },
    multiAccount: { enable: false, requireExplicitSelection: false },
  };
}

function hasOperations(config: ComposioSessionConfig): boolean {
  return (
    config.toolkits.enable.length > 0 &&
    Object.values(config.tools).some((toolPolicy) => toolPolicy.enable.length > 0)
  );
}

function buildSettingsState(
  profile: ComposioProfileConfig,
  toolkitRecords: ComposioToolkitRecord[],
  accounts: ComposioAccountRecord[],
  error?: ComposioUserError,
): ComposioSettingsState {
  const toolkitBySlug = new Map<string, ComposioSettingsState["toolkits"][number]>();
  for (const toolkit of toolkitRecords) {
    const policy = profile.toolkits[toolkit.slug];
    toolkitBySlug.set(toolkit.slug, {
      slug: toolkit.slug,
      name: toolkit.name,
      ...(toolkit.description ? { description: toolkit.description } : {}),
      accounts: [],
      enabled: policy?.enabled === true,
      ...(policy?.selectedAccountId ? { selectedAccountId: policy.selectedAccountId } : {}),
      selectedToolSlugs: [...(policy?.selectedToolSlugs ?? [])],
    });
  }
  for (const account of accounts) {
    let toolkit = toolkitBySlug.get(account.toolkitSlug);
    if (!toolkit) {
      const policy = profile.toolkits[account.toolkitSlug];
      toolkit = {
        slug: account.toolkitSlug,
        name: account.toolkitSlug,
        accounts: [],
        enabled: policy?.enabled === true,
        ...(policy?.selectedAccountId ? { selectedAccountId: policy.selectedAccountId } : {}),
        selectedToolSlugs: [...(policy?.selectedToolSlugs ?? [])],
      };
      toolkitBySlug.set(account.toolkitSlug, toolkit);
    }
    toolkit.accounts.push({
      id: account.id,
      toolkitSlug: account.toolkitSlug,
      alias:
        profile.toolkits[account.toolkitSlug]?.aliases[account.id]?.trim() ||
        account.alias?.trim() ||
        "Conta conectada",
      status: accountStatus(account.status),
    });
  }
  for (const toolkit of toolkitBySlug.values()) {
    toolkit.accounts.sort((left, right) => left.alias.localeCompare(right.alias));
  }
  return {
    apiKeyConfigured: true,
    status: error ? "error" : "ready",
    toolkits: [...toolkitBySlug.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    ...(error ? { error } : {}),
  };
}

async function resolveActivePolicy(
  profile: ComposioProfileConfig,
  api: ComposioApi,
  toolkitRecords: ComposioToolkitRecord[],
  accounts: ComposioAccountRecord[],
): Promise<ComposioProfileConfig> {
  const knownToolkitSlugs = new Set(toolkitRecords.map((toolkit) => toolkit.slug));
  const activeAccountIds = new Map<string, Set<string>>();
  for (const account of accounts) {
    if (accountStatus(account.status) !== "active") continue;
    const toolkitAccounts = activeAccountIds.get(account.toolkitSlug) ?? new Set<string>();
    toolkitAccounts.add(account.id);
    activeAccountIds.set(account.toolkitSlug, toolkitAccounts);
  }

  const toolkits: ComposioProfileConfig["toolkits"] = {};
  const activeCandidates = Object.entries(profile.toolkits).filter(
    ([toolkitSlug, policy]) =>
      policy.enabled &&
      policy.selectedAccountId &&
      policy.selectedToolSlugs.length > 0 &&
      knownToolkitSlugs.has(toolkitSlug) &&
      activeAccountIds.get(toolkitSlug)?.has(policy.selectedAccountId),
  );
  const toolRecords = await Promise.all(
    activeCandidates.map(
      async ([toolkitSlug]) => [toolkitSlug, await api.listTools(toolkitSlug)] as const,
    ),
  );
  const toolsByToolkit = new Map<string, Set<string>>(
    toolRecords.map(([toolkitSlug, tools]) => [
      toolkitSlug,
      new Set(tools.map((tool) => tool.slug)),
    ]),
  );
  for (const [toolkitSlug, policy] of activeCandidates) {
    const knownTools = toolsByToolkit.get(toolkitSlug) ?? new Set<string>();
    const selectedToolSlugs = [...new Set(policy.selectedToolSlugs)].filter((slug) =>
      knownTools.has(slug),
    );
    if (selectedToolSlugs.length === 0) continue;
    toolkits[toolkitSlug] = { ...policy, selectedToolSlugs };
  }
  return { ...profile, toolkits };
}

function flattenToolSlugs(config: ComposioSessionConfig): string[] {
  return Object.values(config.tools).flatMap((policy) => policy.enable);
}

async function validateSessionUpdate(
  input: ComposioSessionSyncInput,
  session: ComposioSession,
  currentProfile: ComposioProfileConfig,
  generation: SyncGeneration,
  operation: { writeOperation: boolean },
): Promise<
  | { session: ComposioSession; profile: ComposioProfileConfig; config: ComposioSessionConfig }
  | undefined
> {
  const toolkitRecords = await input.api.listToolkits();
  const accounts = await input.api.listAccounts(currentProfile.profileId);
  const resolvedProfile = await resolveActivePolicy(
    currentProfile,
    input.api,
    toolkitRecords,
    accounts,
  );
  const config = buildComposioSessionConfig(resolvedProfile.profileId, resolvedProfile);
  if (generation !== latestGeneration) return undefined;
  if (!hasOperations(config)) {
    operation.writeOperation = true;
    await input.api.deleteSession(session.id).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
    operation.writeOperation = false;
    input.persistSessionId?.(undefined);
    return undefined;
  }
  if (generation !== latestGeneration) return undefined;
  // biome-ignore lint/correctness/useHookAtTopLevel: ComposioApi.useSession wraps the Composio SDK; it is not a React hook.
  const freshSession = await input.api.useSession(session.id);
  if (generation !== latestGeneration) return undefined;
  operation.writeOperation = true;
  await freshSession.update(config, freshSession.configVersion);
  operation.writeOperation = false;
  return { session: freshSession, profile: resolvedProfile, config };
}

async function reconcileSerial(
  input: ComposioSessionSyncInput,
  initialProfile: ComposioProfileConfig,
  generation: SyncGeneration,
): Promise<ComposioSettingsState> {
  let profile = initialProfile;
  let toolkitRecords: ComposioToolkitRecord[] = [];
  let accounts: ComposioAccountRecord[] = [];
  let createdSession: ComposioSession | undefined;
  let persisted = false;
  const operation = { writeOperation: false };
  try {
    toolkitRecords = await input.api.listToolkits();
    accounts = await input.api.listAccounts(profile.profileId);
    const resolvedProfile = await resolveActivePolicy(profile, input.api, toolkitRecords, accounts);
    let config = buildComposioSessionConfig(resolvedProfile.profileId, resolvedProfile);
    if (!hasOperations(config)) {
      if (profile.sessionId) {
        operation.writeOperation = true;
        await input.api.deleteSession(profile.sessionId).catch((error: unknown) => {
          if (!isNotFound(error)) throw error;
        });
        operation.writeOperation = false;
      }
      input.persistSessionId?.(undefined);
      return buildSettingsState(profile, toolkitRecords, accounts);
    }
    if (generation !== latestGeneration) return { ...NO_TOOLS_STATE };

    let session: ComposioSession | undefined;
    if (profile.sessionId) {
      try {
        // biome-ignore lint/correctness/useHookAtTopLevel: ComposioApi.useSession wraps the Composio SDK; it is not a React hook.
        session = await input.api.useSession(profile.sessionId);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    if (!session) {
      operation.writeOperation = true;
      session = await input.api.createSession(profile.profileId, config);
      operation.writeOperation = false;
      createdSession = session;
    } else {
      try {
        operation.writeOperation = true;
        await session.update(config, session.configVersion);
        operation.writeOperation = false;
      } catch (error) {
        if (!isConflict(error)) throw error;
        operation.writeOperation = false;
        const latestProfile = input.loadProfile?.() ?? profile;
        if (generation !== latestGeneration) return { ...NO_TOOLS_STATE };
        const retry = await validateSessionUpdate(
          input,
          session,
          latestProfile,
          generation,
          operation,
        );
        if (!retry) {
          const latestToolkits = await input.api.listToolkits();
          const latestAccounts = await input.api.listAccounts(latestProfile.profileId);
          return buildSettingsState(latestProfile, latestToolkits, latestAccounts);
        }
        session = retry.session;
        profile = retry.profile;
        config = retry.config;
        toolkitRecords = await input.api.listToolkits();
        accounts = await input.api.listAccounts(profile.profileId);
        operation.writeOperation = false;
      }
    }

    if (generation !== latestGeneration) {
      if (createdSession) await input.api.deleteSession(createdSession.id).catch(() => undefined);
      return { ...NO_TOOLS_STATE };
    }
    if (!session.mcp.url || !session.mcp.headers || Object.keys(session.mcp.headers).length === 0) {
      throw new Error("Composio did not return usable MCP credentials.");
    }
    const allowedToolSlugs = flattenToolSlugs(config);
    const registeredTools = await input.mcp.registerComposioMcpSession({
      url: session.mcp.url,
      headers: session.mcp.headers,
      allowedToolSlugs,
    });
    const registeredSlugs = new Set(registeredTools.map((tool) => tool.name));
    if (
      registeredSlugs.size !== allowedToolSlugs.length ||
      allowedToolSlugs.some((slug) => !registeredSlugs.has(slug))
    ) {
      throw new Error("Composio MCP bridge registered an incomplete operation set.");
    }
    if (generation !== latestGeneration) {
      await input.mcp.unregisterComposioMcpSession();
      if (createdSession) await input.api.deleteSession(createdSession.id).catch(() => undefined);
      return { ...NO_TOOLS_STATE };
    }
    input.persistSessionId?.(session.id);
    persisted = true;
    return buildSettingsState(profile, toolkitRecords, accounts);
  } catch (error) {
    await input.mcp.unregisterComposioMcpSession().catch(() => undefined);
    if (createdSession && !persisted)
      await input.api.deleteSession(createdSession.id).catch(() => undefined);
    return buildSettingsState(
      profile,
      toolkitRecords,
      accounts,
      mapSyncError(error, operation.writeOperation),
    );
  }
}

/** Serialize and fail closed while reconciling the local allowlist with Composio. */
export function reconcileComposioSession(
  input: ComposioSessionSyncInput,
): Promise<ComposioSettingsState> {
  const generation = ++latestGeneration;
  const unregistering = Promise.resolve().then(() => input.mcp.unregisterComposioMcpSession());
  const previous = reconciliationTail;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  reconciliationTail = previous.then(() => gate);

  return (async () => {
    let profile = input.profile;
    try {
      await unregistering;
      await previous;
      profile = input.loadProfile?.() ?? input.profile;
      if (generation !== latestGeneration) return { ...NO_TOOLS_STATE };
      return await reconcileSerial(input, profile, generation);
    } catch (error) {
      await input.mcp.unregisterComposioMcpSession().catch(() => undefined);
      return buildSettingsState(profile, [], [], mapSyncError(error, false));
    } finally {
      release();
    }
  })();
}
