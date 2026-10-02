import { randomUUID } from "node:crypto";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  ComposioAccountSummary,
  ComposioConnectionOperation,
  ComposioConnectivityResult,
  ComposioDisconnectAccountInput,
  ComposioRenameAccountInput,
  ComposioSettingsState,
  ComposioStartConnectionInput,
  ComposioToolkitPolicyInput,
  ComposioToolSummary,
  ComposioUserError,
  McpToolInfo,
} from "../../shared/contracts";
import type { ComposioMcpBridge } from "../mcp/mcp-service";
import type {
  ComposioAccountRecord,
  ComposioApi,
  ComposioAuthConfigRecord,
  ComposioConnectionRequest,
} from "./composio-api";
import type { ComposioProfileConfig, ComposioProfileStore } from "./composio-profile-store";
import type { ComposioSecretStore } from "./composio-secret-store";
import { reconcileComposioSession } from "./composio-session-sync";

const MAX_ACCOUNTS_PER_TOOLKIT = 5;
const CONNECTION_TIMEOUT_MS = 60_000;
const FOR_YOU_TOOLKIT = "composio-for-you";
const FOR_YOU_MCP_URL = "https://connect.composio.dev/mcp";
const DEFAULT_SETTINGS: ComposioSettingsState = {
  apiKeyConfigured: false,
  status: "unconfigured",
  toolkits: [],
};

type ErrorContext =
  | "consumer"
  | "project-read"
  | "catalog-read"
  | "account-read"
  | "auth-config-read"
  | "auth-config-write"
  | "connected-account-write"
  | "connected-account-delete"
  | "connection"
  | "storage"
  | "browser"
  | "session-sync";

type ComposioServiceDependencies = {
  secretStore: ComposioSecretStore;
  profileStore: ComposioProfileStore;
  createComposioApi(apiKey: string): ComposioApi;
  openExternal(url: string): Promise<void> | void;
  mcp: ComposioMcpBridge;
};

export interface ComposioService {
  initialize(): Promise<ComposioSettingsState>;
  getSettingsState(): Promise<ComposioSettingsState>;
  diagnose(): Promise<ComposioConnectivityResult>;
  setProjectApiKey(apiKey: string): Promise<ComposioSettingsState>;
  removeProjectApiKey(): Promise<ComposioSettingsState>;
  refreshCatalog(): Promise<ComposioSettingsState>;
  listToolkitTools(toolkitSlug: string): Promise<ComposioToolSummary[]>;
  setToolkitPolicy(input: ComposioToolkitPolicyInput): Promise<ComposioSettingsState>;
  startConnection(input: ComposioStartConnectionInput): Promise<ComposioConnectionOperation>;
  getConnectionOperation(operationId: string): Promise<ComposioConnectionOperation>;
  renameAccount(input: ComposioRenameAccountInput): Promise<ComposioSettingsState>;
  disconnectAccount(input: ComposioDisconnectAccountInput): Promise<ComposioSettingsState>;
  shutdown(): Promise<void>;
}

class ComposioServiceError extends Error {
  constructor(readonly userError: ComposioUserError) {
    super(userError.message);
    this.name = "ComposioServiceError";
  }
}

function errorFields(error: unknown): {
  code: string;
  message: string;
  status: number | undefined;
} {
  if (typeof error !== "object" || error === null) {
    return { code: "", message: String(error ?? ""), status: undefined };
  }
  const value = error as Record<string, unknown>;
  const cause =
    typeof value.cause === "object" && value.cause !== null
      ? (value.cause as Record<string, unknown>)
      : undefined;
  const nestedResponse =
    typeof value.response === "object" && value.response !== null
      ? (value.response as Record<string, unknown>)
      : undefined;
  const nestedError =
    typeof value.error === "object" && value.error !== null
      ? (value.error as Record<string, unknown>)
      : undefined;
  const nestedDetails =
    typeof value.details === "object" && value.details !== null
      ? (value.details as Record<string, unknown>)
      : undefined;
  const rawStatus =
    value.statusCode ??
    value.status ??
    value.httpStatus ??
    nestedResponse?.status ??
    nestedDetails?.status ??
    cause?.statusCode ??
    cause?.status ??
    cause?.httpStatus ??
    (error instanceof StreamableHTTPError ? error.code : undefined) ??
    (error instanceof UnauthorizedError ? 401 : undefined) ??
    (value.cause instanceof StreamableHTTPError ? value.cause.code : undefined) ??
    (value.cause instanceof UnauthorizedError ? 401 : undefined);
  const status = typeof rawStatus === "number" ? rawStatus : undefined;
  const rawCode = [value.code, value.type, value.name, nestedError?.code, nestedDetails?.slug]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();
  const code = [rawCode, cause?.code]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();
  const enrichedMessage = [
    value.message,
    cause?.message,
    nestedError?.message,
    nestedDetails?.message,
    nestedDetails?.suggested_fix,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();
  return { code, message: enrichedMessage, status };
}

function diagnosticText(error: unknown): string {
  const seen = new Set<object>();
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const fields = current as Record<string, unknown>;
    for (const key of ["message", "code", "syscall", "hostname", "address"]) {
      const value = fields[key];
      if ((typeof value === "string" || typeof value === "number") && String(value).length < 240) {
        parts.push(String(value));
      }
    }
    current = fields.cause;
  }
  return (
    [...new Set(parts)]
      .join(" ")
      .replace(/https?:\/\/\S+/gi, "[url]")
      .replace(/(?:cmp|comp|sk|eyJ|ck|ak|uak)[_-][a-z0-9._-]+/gi, "[credential]")
      .slice(0, 600) || "technical details unavailable"
  );
}

export function safeError(error: unknown, context: ErrorContext): ComposioUserError {
  if (error instanceof ComposioServiceError) return error.userError;
  const { code, message, status } = errorFields(error);
  const markers = `${code} ${message}`;

  if (/cancel(?:ed|led)|user_cancel|authorization_canceled|connection_canceled/.test(markers)) {
    return {
      code: "connection_canceled",
      message: "Authorization was canceled. Start the connection again when you are ready.",
      retryable: true,
    };
  }
  if (/expir|timed? ?out|timeout/.test(markers) || status === 408) {
    return {
      code: "connection_expired",
      message: "Authorization expired or timed out. Start a new connection.",
      retryable: true,
    };
  }
  if (
    status === 401 ||
    /invalid[_ -]?(?:api[_ -]?)?key|wrong[_ -]?project|project[_ -]?not[_ -]?found/.test(markers)
  ) {
    if (context === "consumer") {
      return {
        code: "invalid_consumer_key",
        message:
          "Composio rejected the For You API Key. Check that the key is active in Composio For You → Settings → Sessions & API Key and try again.",
        retryable: false,
      };
    }
    return {
      code: "invalid_project_key",
      message:
        "Composio rejected the Project API Key or its permissions. Check that the key is active and has the required access. Scoped keys can return this error even when they are valid.",
      retryable: false,
    };
  }
  if (/revok/.test(markers)) {
    return {
      code: "account_revoked",
      message: "Authorization for this account was revoked. Reconnect the account before using it.",
      retryable: true,
    };
  }
  if (status === 404 || /not_found|not found/.test(markers)) {
    if (context === "auth-config-read" || context === "auth-config-write") {
      return {
        code: "auth_config_unavailable",
        message:
          "No usable authentication configuration exists for this platform. Configure one in your Composio project and try again.",
        retryable: false,
      };
    }
    if (context === "catalog-read") {
      return {
        code: "toolkit_unavailable",
        message: "This platform is not available in your Composio project's catalog.",
        retryable: false,
      };
    }
  }
  if (
    status === 403 ||
    /forbidden|permission_denied|insufficient_scope/.test(code) ||
    /permission|scope|unauthorized|forbidden/.test(message)
  ) {
    if (context === "consumer") {
      return {
        code: "consumer_access_denied",
        message:
          "This For You API Key does not have access to the personal Composio MCP. Check the key and access in Composio For You.",
        retryable: false,
      };
    }
    if (
      context === "project-read" ||
      context === "catalog-read" ||
      context === "account-read" ||
      context === "auth-config-read"
    ) {
      return {
        code: "missing_scope_read",
        message:
          "The Project API Key lacks required access. Check permissions to read toolkits, the catalog, and connected accounts, and to manage sessions and execute MCP session tools in your Composio project.",
        retryable: false,
      };
    }
    if (context === "auth-config-write") {
      return {
        code: "missing_scope_write",
        message:
          "The key cannot create Auth Configs in this project. Enable Auth Config write permission or configure compatible authentication in Composio and try again. If this key replaced a working key, restore the previous key.",
        retryable: false,
      };
    }
    if (context === "connected-account-delete") {
      return {
        code: "missing_scope_write",
        message:
          "The key cannot revoke Connected Accounts. Enable connected account management permission for the Composio key. If this key replaced a working key, restore the previous key.",
        retryable: false,
      };
    }
    return {
      code: "missing_scope_write",
      message:
        "The key cannot create Connected Accounts in this project. Enable permission to create connected accounts for the Composio key and try again. If this key replaced a working key, restore the previous key.",
      retryable: false,
    };
  }
  if (
    /managed.{0,30}auth|custom.{0,30}auth|auth.{0,30}(?:unsupported|required|unavailable)/.test(
      markers,
    )
  ) {
    return {
      code: "auth_config_unavailable",
      message:
        "This platform requires a custom authentication configuration. Configure it in your Composio project and try connecting again.",
      retryable: false,
    };
  }
  if (status === 429 || /rate.?limit|too many requests/.test(markers)) {
    return {
      code: "rate_limited",
      message: "Composio temporarily limited requests. Wait a moment and try again.",
      retryable: true,
    };
  }
  if (status !== undefined && status >= 500) {
    return {
      code: "composio_unavailable",
      message: "The Composio service is temporarily unavailable. Try again in a moment.",
      retryable: true,
    };
  }
  if (
    /network|fetch|econn|socket|offline|connection reset|failed to fetch|api_connection/.test(
      markers,
    )
  ) {
    const safeDiagnostic = diagnosticText(error);
    return {
      code: "network_unavailable",
      message: `Could not reach Composio. Check DNS, network, proxy, and TLS settings. Diagnostic: ${safeDiagnostic}`,
      retryable: true,
    };
  }
  if (context === "auth-config-write" || context === "auth-config-read") {
    return {
      code: "auth_config_unavailable",
      message:
        "Could not prepare authentication for this platform. Configure an Auth Config in Composio and try again.",
      retryable: false,
    };
  }
  if (context === "session-sync") {
    return {
      code: "session_sync_failed",
      message:
        "The connection was saved, but Composio tool synchronization failed. Refresh integrations before using agents.",
      retryable: true,
    };
  }
  if (context === "consumer") {
    return {
      code: "consumer_mcp_failed",
      message: "Could not synchronize Composio For You tools. Refresh integrations and try again.",
      retryable: true,
    };
  }
  if (context === "storage") {
    return {
      code: "local_storage_failed",
      message:
        "Modus could not access local secure storage. Check access to the system's secure storage and try again.",
      retryable: true,
    };
  }
  return {
    code: "composio_operation_failed",
    message: "Composio could not complete this operation. Check project permissions and try again.",
    retryable: true,
  };
}

function cloneSettings(state: ComposioSettingsState): ComposioSettingsState {
  return structuredClone(state);
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

function operationStatusForError(error: ComposioUserError): ComposioConnectionOperation["status"] {
  if (error.code === "connection_canceled" || error.code === "account_revoked") return "canceled";
  if (error.code === "connection_expired") return "expired";
  return "failed";
}

function validateAlias(alias: string): string {
  const normalized = alias.trim();
  if (normalized.length === 0 || normalized.length > 80) {
    throw new ComposioServiceError({
      code: "invalid_alias",
      message: "The account name must contain between 1 and 80 characters.",
      retryable: false,
    });
  }
  return normalized;
}

function validateConnectLink(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ComposioServiceError({
      code: "invalid_connect_link",
      message: "Composio did not return a valid connection link. Try again.",
      retryable: true,
    });
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== "https://connect.composio.dev" ||
    !url.pathname.startsWith("/link/") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new ComposioServiceError({
      code: "invalid_connect_link",
      message:
        "The connection link does not belong to Composio's trusted domain and was not opened.",
      retryable: false,
    });
  }
  return url.toString();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error("Composio connection timed out"), { code: "TIMEOUT" }));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason ?? new Error("Composio operation aborted."));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Composio operation aborted."));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      void promise.catch(() => undefined);
      return;
    }
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function isUsableAuthConfig(config: ComposioAuthConfigRecord): boolean {
  return (
    config.id.trim().length > 0 &&
    config.authScheme.trim().length > 0 &&
    config.authScheme !== "UNKNOWN"
  );
}

export function createComposioService(dependencies: ComposioServiceDependencies): ComposioService {
  let api: ComposioApi | undefined;
  let consumerKey: string | undefined;
  let initialized = false;
  let shutDown = false;
  let initializationPromise: Promise<ComposioSettingsState> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let hasKey = false;
  let settings: ComposioSettingsState = cloneSettings(DEFAULT_SETTINGS);
  const operations = new Map<string, ComposioConnectionOperation>();
  const connectionAbortControllers = new Map<string, AbortController>();
  const connectionTasks = new Map<string, Promise<void>>();
  const toolkitTails = new Map<string, Promise<void>>();
  let policyTail: Promise<void> = Promise.resolve();

  function requireApi(): ComposioApi {
    if (!api) {
      throw new ComposioServiceError({
        code: consumerKey ? "project_operation_unavailable" : "api_key_required",
        message: consumerKey
          ? "Manage personal connections through Composio For You tools. Project account management requires a Platform Project API Key."
          : "Add and validate your Composio API Key before continuing.",
        retryable: false,
      });
    }
    return api;
  }

  function withToolkitLock<T>(toolkitSlug: string, action: () => Promise<T>): Promise<T> {
    const previous = toolkitTails.get(toolkitSlug) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    toolkitTails.set(toolkitSlug, tail);
    return (async () => {
      await previous;
      try {
        return await action();
      } finally {
        release();
        if (toolkitTails.get(toolkitSlug) === tail) toolkitTails.delete(toolkitSlug);
      }
    })();
  }

  function withPolicyLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = policyTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    policyTail = previous.then(() => gate);
    return (async () => {
      await previous;
      try {
        return await action();
      } finally {
        release();
      }
    })();
  }

  function setSettingsError(error: unknown, context: ErrorContext): ComposioSettingsState {
    settings = {
      ...settings,
      apiKeyConfigured: hasKey,
      status: "error",
      error: safeError(error, context),
    };
    return cloneSettings(settings);
  }

  function reconcileWith(currentApi: ComposioApi): Promise<ComposioSettingsState> {
    const profile = dependencies.profileStore.load();
    return reconcileComposioSession({
      profile,
      api: currentApi,
      mcp: dependencies.mcp,
      loadProfile: () => dependencies.profileStore.load(),
      persistSessionId: (sessionId) => {
        dependencies.profileStore.update((current) => {
          const { sessionId: _oldSessionId, ...withoutSessionId } = current;
          return sessionId ? { ...withoutSessionId, sessionId } : withoutSessionId;
        });
      },
    }).then((state) => {
      settings = { ...state, apiKeyConfigured: hasKey, keyType: "project" };
      return cloneSettings(settings);
    });
  }

  async function refreshCatalogWith(currentApi: ComposioApi): Promise<ComposioSettingsState> {
    try {
      return await reconcileWith(currentApi);
    } catch (error) {
      return setSettingsError(error, "session-sync");
    }
  }

  function consumerCredentials(key: string) {
    return { url: FOR_YOU_MCP_URL, headers: { "x-consumer-api-key": key } };
  }

  function consumerToolSummaries(tools: McpToolInfo[]): ComposioToolSummary[] {
    return tools.map((tool) => ({
      toolkitSlug: FOR_YOU_TOOLKIT,
      slug: tool.name,
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
    }));
  }

  async function reconcileConsumer(
    key: string,
    discovered?: McpToolInfo[],
  ): Promise<ComposioSettingsState> {
    try {
      const tools = consumerToolSummaries(
        discovered ?? (await dependencies.mcp.inspectComposioMcpSession(consumerCredentials(key))),
      );
      if (shutDown) return cloneSettings(DEFAULT_SETTINGS);
      const policy = dependencies.profileStore.load().forYou ?? {
        enabled: false,
        selectedToolSlugs: [],
      };
      const knownTools = new Set(tools.map((tool) => tool.slug));
      const selectedToolSlugs = [...new Set(policy.selectedToolSlugs)].filter((slug) =>
        knownTools.has(slug),
      );
      // A changed catalog must never silently widen a saved selection.
      const enabled =
        policy.enabled &&
        selectedToolSlugs.length > 0 &&
        selectedToolSlugs.length === policy.selectedToolSlugs.length;
      if (enabled) {
        await dependencies.mcp.registerComposioMcpSession({
          ...consumerCredentials(key),
          allowedToolSlugs: selectedToolSlugs,
        });
      } else {
        await dependencies.mcp.unregisterComposioMcpSession();
      }
      if (shutDown) {
        await dependencies.mcp.unregisterComposioMcpSession().catch(() => undefined);
        return cloneSettings(DEFAULT_SETTINGS);
      }
      settings = {
        apiKeyConfigured: hasKey,
        keyType: "consumer",
        status: "ready",
        toolkits: [],
        consumer: { enabled, selectedToolSlugs, tools },
      };
      return cloneSettings(settings);
    } catch (error) {
      await dependencies.mcp.unregisterComposioMcpSession().catch(() => undefined);
      if (settings.consumer) settings.consumer.enabled = false;
      return setSettingsError(error, "consumer");
    }
  }

  function cancelPendingConnections(message: string): void {
    for (const operation of operations.values()) {
      if (operation.status !== "pending") continue;
      setOperation({
        ...operation,
        status: "canceled",
        error: { code: "connection_canceled", message, retryable: true },
      });
    }
    for (const controller of connectionAbortControllers.values())
      controller.abort(new Error(message));
  }

  function setOperation(operation: ComposioConnectionOperation): ComposioConnectionOperation {
    operations.set(operation.id, structuredClone(operation));
    return structuredClone(operation);
  }

  function pendingOperationsFor(toolkitSlug: string): number {
    return [...operations.values()].filter(
      (operation) => operation.toolkitSlug === toolkitSlug && operation.status === "pending",
    ).length;
  }

  async function saveAccountAlias(
    toolkitSlug: string,
    accountId: string,
    alias: string,
  ): Promise<void> {
    dependencies.profileStore.update((current) => {
      const existing = current.toolkits[toolkitSlug] ?? {
        enabled: false,
        selectedToolSlugs: [],
        aliases: {},
      };
      return {
        ...current,
        toolkits: {
          ...current.toolkits,
          [toolkitSlug]: {
            ...existing,
            aliases: { ...existing.aliases, [accountId]: alias },
          },
        },
      };
    });
  }

  async function completeConnection(
    currentApi: ComposioApi,
    operationId: string,
    toolkitSlug: string,
    alias: string,
    request: ComposioConnectionRequest,
    signal: AbortSignal,
    timeout: ReturnType<typeof setTimeout>,
  ): Promise<void> {
    try {
      const account = await withTimeout(
        withAbort(request.waitForConnection(CONNECTION_TIMEOUT_MS, signal), signal),
        CONNECTION_TIMEOUT_MS,
      );
      const currentOperation = operations.get(operationId);
      if (currentOperation?.status !== "pending" || shutDown || api !== currentApi || !hasKey)
        return;
      if (account.toolkitSlug !== toolkitSlug) {
        throw new ComposioServiceError({
          code: "foreign_toolkit_account",
          message:
            "Composio returned an account for another platform. It was not activated in Modus.",
          retryable: false,
        });
      }
      const status = accountStatus(account.status);
      if (status === "expired") {
        setOperation({
          ...currentOperation,
          status: "expired",
          error: {
            code: "connection_expired",
            message: "Authorization expired. Start a new connection.",
            retryable: true,
          },
        });
        return;
      }
      if (status !== "active") {
        const error: ComposioUserError = {
          code: status === "revoked" ? "connection_canceled" : "connection_failed",
          message:
            status === "revoked"
              ? "Authorization was canceled or revoked. Start a new connection."
              : "Composio did not confirm an active account. Try connecting again.",
          retryable: status !== "disabled",
        };
        setOperation({ ...currentOperation, status: operationStatusForError(error), error });
        return;
      }

      await withPolicyLock(async () => {
        const latestOperation = operations.get(operationId);
        if (latestOperation?.status !== "pending" || shutDown || api !== currentApi || !hasKey)
          return;
        await saveAccountAlias(toolkitSlug, account.id, alias);
        const confirmedOperation = operations.get(operationId);
        if (confirmedOperation?.status !== "pending" || shutDown || api !== currentApi || !hasKey)
          return;
        setOperation({ ...confirmedOperation, status: "active" });
        await reconcileWith(currentApi);
      });
    } catch (error) {
      const currentOperation = operations.get(operationId);
      if (currentOperation?.status !== "pending" || shutDown) return;
      const userError = safeError(error, "connection");
      setOperation({
        ...currentOperation,
        status: operationStatusForError(userError),
        error: userError,
      });
    } finally {
      clearTimeout(timeout);
      connectionAbortControllers.delete(operationId);
      connectionTasks.delete(operationId);
    }
  }

  function failOperation(
    operation: ComposioConnectionOperation,
    error: unknown,
    context: ErrorContext,
  ): ComposioConnectionOperation {
    const userError = safeError(error, context);
    return setOperation({
      ...operation,
      status: operationStatusForError(userError),
      error: userError,
    });
  }

  function createFailedOperation(
    toolkitSlug: string,
    alias: string,
    code: string,
    message: string,
    retryable = false,
  ): ComposioConnectionOperation {
    return setOperation({
      id: randomUUID(),
      toolkitSlug,
      alias,
      status: "failed",
      error: { code, message, retryable },
    });
  }

  async function listOwnedAccounts(
    currentApi: ComposioApi,
    profileId: string,
    toolkitSlug: string,
  ): Promise<ComposioAccountRecord[]> {
    return (await currentApi.listAccounts(profileId, toolkitSlug)).filter(
      (account) => account.toolkitSlug === toolkitSlug,
    );
  }

  function diagnose(): Promise<ComposioConnectivityResult> {
    let context: ErrorContext = "project-read";
    return (async () => {
      const savedKey = await dependencies.secretStore.load();
      if (!savedKey) {
        return {
          apiReachable: false,
          mcpSessionReady: false,
          error: {
            code: "api_key_required",
            message: "Add a Composio API Key to test the connection.",
            retryable: false,
          },
        };
      }

      if (savedKey.startsWith("ck_")) {
        context = "consumer";
        await dependencies.mcp.inspectComposioMcpSession(consumerCredentials(savedKey));
        return { apiReachable: true, mcpSessionReady: true };
      }

      const currentApi = dependencies.createComposioApi(savedKey);
      const profile = dependencies.profileStore.load();
      await currentApi.validateProjectReadAccess(profile.profileId);
      const result = await currentApi.validateMcpConnectivity(profile.profileId);
      return {
        apiReachable: true,
        mcpSessionReady: result.mcpSessionReady,
        ...(result.error ? { error: safeError(result.error, "project-read") } : {}),
      };
    })().catch((error: unknown) => ({
      apiReachable: false,
      mcpSessionReady: false,
      error: safeError(error, context),
    }));
  }

  return {
    diagnose,
    async initialize(): Promise<ComposioSettingsState> {
      if (shutDown) return cloneSettings(settings);
      if (initializationPromise) return cloneSettings(await initializationPromise);
      if (initialized) return cloneSettings(settings);
      initialized = true;
      initializationPromise = (async () => {
        try {
          const savedKey = await dependencies.secretStore.load();
          hasKey = Boolean(savedKey);
          if (shutDown) return cloneSettings(DEFAULT_SETTINGS);
          if (!savedKey) {
            settings = cloneSettings(DEFAULT_SETTINGS);
            return cloneSettings(settings);
          }
          if (savedKey.startsWith("ck_")) {
            consumerKey = savedKey;
            api = undefined;
            settings = {
              apiKeyConfigured: true,
              keyType: "consumer",
              status: "loading",
              toolkits: [],
              consumer: { enabled: false, selectedToolSlugs: [], tools: [] },
            };
            return await reconcileConsumer(savedKey);
          }
          const profile = dependencies.profileStore.load();
          const savedApi = dependencies.createComposioApi(savedKey);
          await savedApi.validateProjectReadAccess(profile.profileId);
          if (shutDown) return cloneSettings(DEFAULT_SETTINGS);
          api = savedApi;
          await reconcileWith(savedApi);
          if (shutDown) {
            await dependencies.mcp.unregisterComposioMcpSession().catch(() => undefined);
            api = undefined;
            hasKey = false;
            settings = cloneSettings(DEFAULT_SETTINGS);
          }
          return cloneSettings(settings);
        } catch (error) {
          await dependencies.mcp.unregisterComposioMcpSession().catch(() => undefined);
          api = undefined;
          if (shutDown) {
            hasKey = false;
            settings = cloneSettings(DEFAULT_SETTINGS);
            return cloneSettings(settings);
          }
          return setSettingsError(error, hasKey ? "project-read" : "storage");
        }
      })();
      return cloneSettings(await initializationPromise);
    },

    async getSettingsState(): Promise<ComposioSettingsState> {
      if (initializationPromise) await initializationPromise;
      return initialized ? cloneSettings(settings) : await this.initialize();
    },

    async setProjectApiKey(apiKey: string): Promise<ComposioSettingsState> {
      return await withPolicyLock(async () => {
        if (shutDown) return setSettingsError(new Error("service closed"), "storage");
        await this.initialize();
        if (shutDown) return cloneSettings(DEFAULT_SETTINGS);
        const candidateKey = apiKey.trim();
        if (!candidateKey) {
          return setSettingsError(
            new ComposioServiceError({
              code: "invalid_project_key",
              message: "Enter a Composio API Key.",
              retryable: false,
            }),
            "project-read",
          );
        }
        if (candidateKey.startsWith("uak_")) {
          return setSettingsError(
            new ComposioServiceError({
              code: "unsupported_key_type",
              message:
                "This is a Composio user API key. Use a For You API Key from Settings → Sessions & API Key or a Platform Project API Key from your project's Settings → API Keys.",
              retryable: false,
            }),
            "project-read",
          );
        }
        if (candidateKey.startsWith("ck_")) {
          let context: ErrorContext = "consumer";
          try {
            const tools = await dependencies.mcp.inspectComposioMcpSession(
              consumerCredentials(candidateKey),
            );
            if (shutDown) return cloneSettings(DEFAULT_SETTINGS);
            context = "storage";
            await dependencies.mcp.unregisterComposioMcpSession();
            if (settings.consumer) settings.consumer.enabled = false;
            await dependencies.secretStore.save(candidateKey);
            if (shutDown) return cloneSettings(DEFAULT_SETTINGS);
            cancelPendingConnections(
              "The connection was interrupted because the Composio API Key changed.",
            );
            api = undefined;
            consumerKey = candidateKey;
            hasKey = true;
            settings = {
              apiKeyConfigured: true,
              keyType: "consumer",
              status: "loading",
              toolkits: [],
              consumer: { enabled: false, selectedToolSlugs: [], tools: [] },
            };
            return await reconcileConsumer(candidateKey, tools);
          } catch (error) {
            return setSettingsError(error, context);
          }
        }
        try {
          await dependencies.mcp.unregisterComposioMcpSession();
          if (settings.consumer) settings.consumer.enabled = false;
        } catch (error) {
          return setSettingsError(error, "session-sync");
        }
        settings = { ...settings, status: "loading" };
        delete settings.error;
        let context: ErrorContext = "project-read";
        try {
          const profile = dependencies.profileStore.load();
          const candidateApi = dependencies.createComposioApi(candidateKey);
          await candidateApi.validateProjectReadAccess(profile.profileId);
          if (shutDown) return cloneSettings(DEFAULT_SETTINGS);
          context = "storage";
          const previousKey = await dependencies.secretStore.load();
          if (shutDown) return cloneSettings(DEFAULT_SETTINGS);
          if (previousKey !== candidateKey) {
            // A hosted session belongs to the credential's project, not to the local policy.
            dependencies.profileStore.update((current) => {
              const { sessionId: _sessionId, ...withoutSessionId } = current;
              return withoutSessionId;
            });
          }
          await dependencies.secretStore.save(candidateKey);
          if (shutDown) return cloneSettings(DEFAULT_SETTINGS);
          cancelPendingConnections(
            "The connection was interrupted because the Composio API Key changed.",
          );
          api = candidateApi;
          consumerKey = undefined;
          hasKey = true;
          settings = {
            apiKeyConfigured: true,
            keyType: "project",
            status: "loading",
            toolkits: [],
          };
          return await refreshCatalogWith(candidateApi);
        } catch (error) {
          return setSettingsError(error, context);
        }
      });
    },

    async removeProjectApiKey(): Promise<ComposioSettingsState> {
      return await withPolicyLock(async () => {
        if (!shutDown) await this.initialize();
        try {
          await dependencies.mcp.unregisterComposioMcpSession();
        } catch (error) {
          return setSettingsError(error, "session-sync");
        }
        const currentApi = api;
        const sessionId = dependencies.profileStore.load().sessionId;
        let sessionDeleteError: unknown;
        if (currentApi && sessionId) {
          try {
            await currentApi.deleteSession(sessionId);
          } catch (error) {
            sessionDeleteError = error;
          }
        }
        cancelPendingConnections(
          "The connection was interrupted because the Composio API Key was removed.",
        );
        try {
          dependencies.profileStore.update((current) => {
            const { sessionId: _sessionId, ...withoutSessionId } = current;
            return withoutSessionId;
          });
          await dependencies.secretStore.clear();
        } catch (error) {
          return setSettingsError(error, "storage");
        }
        api = undefined;
        consumerKey = undefined;
        hasKey = false;
        settings = cloneSettings(DEFAULT_SETTINGS);
        if (sessionDeleteError) {
          settings = {
            ...settings,
            status: "error",
            error: {
              code: "session_sync_failed",
              message:
                "The key was removed, but the remote session could not be closed. Connected accounts were kept in Composio.",
              retryable: true,
            },
          };
        }
        return cloneSettings(settings);
      });
    },

    async refreshCatalog(): Promise<ComposioSettingsState> {
      return await withPolicyLock(async () => {
        await this.initialize();
        if (shutDown) return cloneSettings(DEFAULT_SETTINGS);
        if (consumerKey) return await reconcileConsumer(consumerKey);
        if (!api) {
          if (hasKey) {
            try {
              const savedKey = await dependencies.secretStore.load();
              if (!savedKey) throw new Error("Saved Composio key unavailable.");
              const savedApi = dependencies.createComposioApi(savedKey);
              await savedApi.validateProjectReadAccess(dependencies.profileStore.load().profileId);
              if (shutDown) return cloneSettings(DEFAULT_SETTINGS);
              api = savedApi;
              return await refreshCatalogWith(savedApi);
            } catch (error) {
              return setSettingsError(error, "project-read");
            }
          }
          settings = cloneSettings(DEFAULT_SETTINGS);
          return cloneSettings(settings);
        }
        return await refreshCatalogWith(api);
      });
    },

    async listToolkitTools(toolkitSlug: string): Promise<ComposioToolSummary[]> {
      try {
        await this.initialize();
        if (consumerKey && toolkitSlug === FOR_YOU_TOOLKIT) {
          return consumerToolSummaries(
            await dependencies.mcp.inspectComposioMcpSession(consumerCredentials(consumerKey)),
          );
        }
        if (!toolkitSlug.trim())
          throw new ComposioServiceError({
            code: "toolkit_unavailable",
            message: "Select a valid platform from the Composio catalog.",
            retryable: false,
          });
        const currentApi = requireApi();
        const records = await currentApi.listTools(toolkitSlug);
        return records.map((tool) => ({
          toolkitSlug,
          slug: tool.slug,
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          ...(tool.riskHint ? { riskHint: tool.riskHint } : {}),
        }));
      } catch (error) {
        throw new ComposioServiceError(safeError(error, "catalog-read"));
      }
    },

    async setToolkitPolicy(input: ComposioToolkitPolicyInput): Promise<ComposioSettingsState> {
      return await withPolicyLock(async () => {
        try {
          await this.initialize();
          if (shutDown) throw new Error("service closed");
          const toolkitSlug = input.toolkitSlug.trim();
          if (!toolkitSlug || toolkitSlug.length > 120) {
            throw new ComposioServiceError({
              code: "toolkit_unavailable",
              message: "Select a valid platform from the Composio catalog.",
              retryable: false,
            });
          }
          const selectedToolSlugs = [
            ...new Set(input.selectedToolSlugs.map((slug) => slug.trim())),
          ];
          if (
            selectedToolSlugs.length > 500 ||
            selectedToolSlugs.some((slug) => !slug || slug.length > 160)
          ) {
            throw new ComposioServiceError({
              code: "toolkit_unavailable",
              message: "The selection contains invalid tools or exceeds the allowed limit.",
              retryable: false,
            });
          }
          if (consumerKey && toolkitSlug === FOR_YOU_TOOLKIT) {
            if (input.selectedAccountId || (input.enabled && selectedToolSlugs.length === 0)) {
              throw new ComposioServiceError({
                code: "invalid_consumer_policy",
                message:
                  "Select at least one For You MCP tool before enabling it. Personal MCP tools do not use a project account selection.",
                retryable: false,
              });
            }
            const tools = input.enabled
              ? await dependencies.mcp.inspectComposioMcpSession(consumerCredentials(consumerKey))
              : (settings.consumer?.tools ?? []).map((tool) => ({
                  name: tool.slug,
                  registeredName: tool.slug,
                  description: tool.description,
                }));
            const knownTools = new Set(tools.map((tool) => tool.name));
            if (input.enabled && selectedToolSlugs.some((slug) => !knownTools.has(slug))) {
              throw new ComposioServiceError({
                code: "invalid_consumer_policy",
                message:
                  "The selection contains unavailable For You MCP tools. Refresh integrations and try again.",
                retryable: false,
              });
            }
            if (shutDown) return cloneSettings(DEFAULT_SETTINGS);
            dependencies.profileStore.update((current) => ({
              ...current,
              forYou: { enabled: input.enabled, selectedToolSlugs },
            }));
            return await reconcileConsumer(consumerKey, tools);
          }
          const currentApi = requireApi();
          const profile = dependencies.profileStore.load();
          const selectedAccountId = input.selectedAccountId?.trim();
          if (input.enabled && (!selectedAccountId || selectedToolSlugs.length === 0)) {
            throw new ComposioServiceError({
              code: "toolkit_unavailable",
              message:
                "Select an active account and at least one operation before enabling the platform.",
              retryable: false,
            });
          }
          if (input.enabled) {
            const [toolkits, tools, accounts] = await Promise.all([
              currentApi.listToolkits(),
              currentApi.listTools(toolkitSlug),
              listOwnedAccounts(currentApi, profile.profileId, toolkitSlug),
            ]);
            if (!toolkits.some((toolkit) => toolkit.slug === toolkitSlug)) {
              throw new ComposioServiceError({
                code: "toolkit_unavailable",
                message: "This platform is not available in your Composio project's catalog.",
                retryable: false,
              });
            }
            const knownTools = new Set(tools.map((tool) => tool.slug));
            if (selectedToolSlugs.some((slug) => !knownTools.has(slug))) {
              throw new ComposioServiceError({
                code: "toolkit_unavailable",
                message:
                  "The selection contains tools that do not belong to this platform. Refresh the catalog and try again.",
                retryable: false,
              });
            }
            const selectedAccount = accounts.find((account) => account.id === selectedAccountId);
            if (!selectedAccount) {
              throw new ComposioServiceError({
                code: "account_not_found",
                message:
                  "The selected account does not belong to this local profile or is no longer connected.",
                retryable: false,
              });
            }
            if (accountStatus(selectedAccount.status) !== "active") {
              throw new ComposioServiceError({
                code: "account_revoked",
                message: "Reconnect this account before enabling it for agents.",
                retryable: false,
              });
            }
          }
          const existing = profile.toolkits[toolkitSlug] ?? {
            enabled: false,
            selectedToolSlugs: [],
            aliases: {},
          };
          const { selectedAccountId: _existingSelection, ...existingWithoutSelection } = existing;
          dependencies.profileStore.update((current) => ({
            ...current,
            toolkits: {
              ...current.toolkits,
              [toolkitSlug]: {
                ...existingWithoutSelection,
                enabled: input.enabled,
                ...(selectedAccountId ? { selectedAccountId } : {}),
                selectedToolSlugs,
              },
            },
          }));
          return await reconcileWith(currentApi);
        } catch (error) {
          if (consumerKey) {
            await dependencies.mcp.unregisterComposioMcpSession().catch(() => undefined);
            if (settings.consumer) settings.consumer.enabled = false;
          }
          return setSettingsError(
            error,
            consumerKey
              ? "consumer"
              : errorFields(error).status === 403
                ? "account-read"
                : "session-sync",
          );
        }
      });
    },

    async startConnection(
      input: ComposioStartConnectionInput,
    ): Promise<ComposioConnectionOperation> {
      const toolkitSlug = input.toolkitSlug.trim();
      let alias: string;
      try {
        alias = validateAlias(input.alias);
      } catch (error) {
        return createFailedOperation(
          toolkitSlug,
          input.alias,
          safeError(error, "connection").code,
          safeError(error, "connection").message,
        );
      }
      if (!toolkitSlug || toolkitSlug.length > 120 || shutDown) {
        return createFailedOperation(
          toolkitSlug,
          alias,
          "toolkit_unavailable",
          "Select a valid platform and try again.",
        );
      }

      return await withPolicyLock(() =>
        withToolkitLock(toolkitSlug, async () => {
          let currentApi: ComposioApi;
          let profile: ComposioProfileConfig;
          let context: ErrorContext = "catalog-read";
          let operation: ComposioConnectionOperation = {
            id: randomUUID(),
            toolkitSlug,
            alias,
            status: "pending",
          };
          try {
            if (shutDown) {
              return createFailedOperation(
                toolkitSlug,
                alias,
                "service_closed",
                "Modus is shutting down. Start the connection again after reopening the app.",
              );
            }
            currentApi = requireApi();
            profile = dependencies.profileStore.load();
            context = "catalog-read";
            const toolkits = await currentApi.listToolkits();
            context = "account-read";
            const scopedAccounts = await listOwnedAccounts(
              currentApi,
              profile.profileId,
              toolkitSlug,
            );
            if (!toolkits.some((toolkit) => toolkit.slug === toolkitSlug)) {
              return createFailedOperation(
                toolkitSlug,
                alias,
                "toolkit_unavailable",
                "This platform is not available in your Composio project's catalog.",
              );
            }
            if (
              scopedAccounts.length + pendingOperationsFor(toolkitSlug) >=
              MAX_ACCOUNTS_PER_TOOLKIT
            ) {
              return createFailedOperation(
                toolkitSlug,
                alias,
                "account_limit",
                "Each platform supports up to five accounts. Remove an existing account or wait for a pending connection to finish.",
              );
            }
            operation = setOperation(operation);

            context = "auth-config-read";
            const authConfigs = await currentApi.listAuthConfigs(toolkitSlug);
            const authConfig =
              authConfigs.find((item) => item.isComposioManaged && isUsableAuthConfig(item)) ??
              authConfigs.find(isUsableAuthConfig) ??
              (await (async () => {
                context = "auth-config-write";
                return await currentApi.createManagedAuthConfig(toolkitSlug);
              })());
            if (!isUsableAuthConfig(authConfig)) {
              throw new ComposioServiceError({
                code: "auth_config_unavailable",
                message:
                  "This platform requires an authentication configuration in your Composio project before connecting.",
                retryable: false,
              });
            }

            context = "connected-account-write";
            const request = await currentApi.linkAccount({
              userId: profile.profileId,
              authConfigId: authConfig.id,
              alias,
              allowMultiple: true,
            });
            if (shutDown) {
              return setOperation({
                ...operation,
                status: "canceled",
                error: {
                  code: "connection_canceled",
                  message: "The connection was interrupted when Modus shut down.",
                  retryable: true,
                },
              });
            }
            context = "connection";
            const validatedLink = validateConnectLink(request.redirectUrl);
            context = "browser";
            try {
              await dependencies.openExternal(validatedLink);
            } catch (_error) {
              throw new ComposioServiceError({
                code: "connect_link_open_failed",
                message: "Could not open the secure connection link. Try again.",
                retryable: true,
              });
            }
            const controller = new AbortController();
            const timeout = setTimeout(
              () =>
                controller.abort(
                  Object.assign(new Error("Composio connection timed out"), { code: "TIMEOUT" }),
                ),
              CONNECTION_TIMEOUT_MS,
            );
            timeout.unref?.();
            connectionAbortControllers.set(operation.id, controller);
            const connectionTask = completeConnection(
              currentApi,
              operation.id,
              toolkitSlug,
              alias,
              request,
              controller.signal,
              timeout,
            );
            connectionTasks.set(operation.id, connectionTask);
            return structuredClone(operation);
          } catch (error) {
            if (!operations.has(operation.id)) operations.set(operation.id, operation);
            return failOperation(operation, error, context);
          }
        }),
      );
    },

    async getConnectionOperation(operationId: string): Promise<ComposioConnectionOperation> {
      const operation = operations.get(operationId);
      if (operation) return structuredClone(operation);
      return {
        id: operationId,
        toolkitSlug: "",
        alias: "",
        status: "failed",
        error: {
          code: "connection_operation_not_found",
          message: "This connection operation is no longer available. Start a new connection.",
          retryable: true,
        },
      };
    },

    async renameAccount(input: ComposioRenameAccountInput): Promise<ComposioSettingsState> {
      return await withPolicyLock(async () => {
        try {
          const alias = validateAlias(input.alias);
          const currentApi = requireApi();
          const profile = dependencies.profileStore.load();
          const accounts = await listOwnedAccounts(
            currentApi,
            profile.profileId,
            input.toolkitSlug,
          );
          if (!accounts.some((account) => account.id === input.accountId)) {
            throw new ComposioServiceError({
              code: "account_not_found",
              message:
                "The account does not belong to this local profile or is no longer connected.",
              retryable: false,
            });
          }
          await saveAccountAlias(input.toolkitSlug, input.accountId, alias);
          return await refreshCatalogWith(currentApi);
        } catch (error) {
          return setSettingsError(
            error,
            errorFields(error).status === 403 ? "account-read" : "catalog-read",
          );
        }
      });
    },

    async disconnectAccount(input: ComposioDisconnectAccountInput): Promise<ComposioSettingsState> {
      return await withPolicyLock(async () => {
        try {
          const currentProfile = dependencies.profileStore.load();
          const currentApi = requireApi();
          const accounts = await listOwnedAccounts(
            currentApi,
            currentProfile.profileId,
            input.toolkitSlug,
          );
          if (!accounts.some((account) => account.id === input.accountId)) {
            throw new ComposioServiceError({
              code: "account_not_found",
              message:
                "The account does not belong to this local profile or is no longer connected.",
              retryable: false,
            });
          }
          const selected =
            currentProfile.toolkits[input.toolkitSlug]?.selectedAccountId === input.accountId;
          if (selected) {
            dependencies.profileStore.update((current) => {
              const toolkit = current.toolkits[input.toolkitSlug];
              if (!toolkit) return current;
              const { selectedAccountId: _selectedAccountId, ...policy } = toolkit;
              return {
                ...current,
                toolkits: {
                  ...current.toolkits,
                  [input.toolkitSlug]: policy,
                },
              };
            });
            const narrowed = await reconcileWith(currentApi);
            if (narrowed.status === "error") return narrowed;
          }
          try {
            await currentApi.deleteAccount(input.accountId);
          } catch (error) {
            throw Object.assign(new Error("Connected account revoke failed"), {
              cause: error,
              context: "connected-account-delete",
            });
          }
          dependencies.profileStore.update((current) => {
            const toolkit = current.toolkits[input.toolkitSlug];
            if (!toolkit) return current;
            const aliases = { ...toolkit.aliases };
            delete aliases[input.accountId];
            return {
              ...current,
              toolkits: {
                ...current.toolkits,
                [input.toolkitSlug]: { ...toolkit, aliases },
              },
            };
          });
          return await reconcileWith(currentApi);
        } catch (error) {
          return setSettingsError(error, "connected-account-delete");
        }
      });
    },

    async shutdown(): Promise<void> {
      if (shutdownPromise) return await shutdownPromise;
      shutDown = true;
      for (const operation of operations.values()) {
        if (operation.status !== "pending") continue;
        setOperation({
          ...operation,
          status: "canceled",
          error: {
            code: "connection_canceled",
            message: "The connection was interrupted when Modus shut down.",
            retryable: true,
          },
        });
      }
      for (const controller of connectionAbortControllers.values()) {
        controller.abort(new Error("Modus is shutting down."));
      }
      shutdownPromise = (async () => {
        await Promise.allSettled([...connectionTasks.values()]);
        await initializationPromise?.catch(() => undefined);
        api = undefined;
        hasKey = false;
        settings = cloneSettings(DEFAULT_SETTINGS);
        await withPolicyLock(async () => {
          await dependencies.mcp.unregisterComposioMcpSession().catch(() => undefined);
          api = undefined;
          consumerKey = undefined;
          hasKey = false;
          settings = cloneSettings(DEFAULT_SETTINGS);
        });
      })();
      await shutdownPromise;
    },
  };
}
