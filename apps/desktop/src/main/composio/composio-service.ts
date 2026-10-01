import { randomUUID } from "node:crypto";
import type {
  ComposioAccountSummary,
  ComposioConnectionOperation,
  ComposioDisconnectAccountInput,
  ComposioRenameAccountInput,
  ComposioSettingsState,
  ComposioStartConnectionInput,
  ComposioToolkitPolicyInput,
  ComposioToolSummary,
  ComposioUserError,
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
const DEFAULT_SETTINGS: ComposioSettingsState = {
  apiKeyConfigured: false,
  status: "unconfigured",
  toolkits: [],
};

type ErrorContext =
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
  const code = [value.code, value.type, value.name]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();
  const message = typeof value.message === "string" ? value.message.toLowerCase() : "";
  const rawStatus = value.statusCode ?? value.status ?? value.httpStatus;
  const status = typeof rawStatus === "number" ? rawStatus : undefined;
  return { code, message, status };
}

function safeError(error: unknown, context: ErrorContext): ComposioUserError {
  if (error instanceof ComposioServiceError) return error.userError;
  const { code, message, status } = errorFields(error);
  const markers = `${code} ${message}`;

  if (/cancel(?:ed|led)|user_cancel|authorization_canceled|connection_canceled/.test(markers)) {
    return {
      code: "connection_canceled",
      message: "A autorização foi cancelada. Inicie a conexão novamente quando quiser.",
      retryable: true,
    };
  }
  if (/expir|timed? ?out|timeout/.test(markers) || status === 408) {
    return {
      code: "connection_expired",
      message: "A autorização expirou ou demorou demais. Inicie uma nova conexão.",
      retryable: true,
    };
  }
  if (
    status === 401 ||
    /invalid[_ -]?(?:api[_ -]?)?key|unauthorized|wrong[_ -]?project|project[_ -]?not[_ -]?found/.test(
      markers,
    )
  ) {
    return {
      code: "invalid_project_key",
      message:
        "A Project API Key é inválida, foi revogada ou pertence a outro projeto Composio. Confirme a chave e o projeto e tente novamente.",
      retryable: false,
    };
  }
  if (/revok/.test(markers)) {
    return {
      code: "account_revoked",
      message: "A autorização desta conta foi revogada. Conecte a conta novamente antes de usá-la.",
      retryable: true,
    };
  }
  if (status === 404 || /not_found|not found/.test(markers)) {
    if (context === "auth-config-read" || context === "auth-config-write") {
      return {
        code: "auth_config_unavailable",
        message:
          "Não existe uma configuração de autenticação utilizável para esta plataforma. Configure uma no projeto Composio e tente novamente.",
        retryable: false,
      };
    }
    if (context === "catalog-read") {
      return {
        code: "toolkit_unavailable",
        message: "Esta plataforma não está disponível no catálogo do projeto Composio.",
        retryable: false,
      };
    }
  }
  if (status === 403 || /forbidden|permission_denied|insufficient_scope/.test(code)) {
    if (
      context === "project-read" ||
      context === "catalog-read" ||
      context === "account-read" ||
      context === "auth-config-read"
    ) {
      return {
        code: "missing_scope_read",
        message:
          "A Project API Key não permite consultar o catálogo ou as contas deste projeto. Habilite o acesso de leitura correspondente na chave do Composio.",
        retryable: false,
      };
    }
    if (context === "auth-config-write") {
      return {
        code: "missing_scope_write",
        message:
          "A chave não pode criar Auth Configs neste projeto. Habilite a permissão de escrita de Auth Configs ou configure uma autenticação compatível no Composio e tente novamente. Se esta chave substituiu outra que funcionava, reinsira a chave anterior.",
        retryable: false,
      };
    }
    if (context === "connected-account-delete") {
      return {
        code: "missing_scope_write",
        message:
          "A chave não pode revogar Connected Accounts. Habilite a permissão para gerenciar contas conectadas na chave do Composio. Se esta chave substituiu outra que funcionava, reinsira a chave anterior.",
        retryable: false,
      };
    }
    return {
      code: "missing_scope_write",
      message:
        "A chave não pode criar Connected Accounts neste projeto. Habilite a permissão para criar contas conectadas na chave do Composio e tente novamente. Se esta chave substituiu outra que funcionava, reinsira a chave anterior.",
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
        "Esta plataforma exige uma configuração de autenticação personalizada. Configure-a no projeto Composio e tente conectar novamente.",
      retryable: false,
    };
  }
  if (status === 429 || /rate.?limit|too many requests/.test(markers)) {
    return {
      code: "rate_limited",
      message:
        "O Composio limitou temporariamente as solicitações. Aguarde um pouco e tente novamente.",
      retryable: true,
    };
  }
  if (status !== undefined && status >= 500) {
    return {
      code: "composio_unavailable",
      message:
        "O serviço Composio está temporariamente indisponível. Tente novamente em instantes.",
      retryable: true,
    };
  }
  if (/network|fetch|econn|socket|offline|connection reset/.test(markers)) {
    return {
      code: "network_unavailable",
      message: "Não foi possível alcançar o Composio. Verifique a conexão e tente novamente.",
      retryable: true,
    };
  }
  if (context === "auth-config-write" || context === "auth-config-read") {
    return {
      code: "auth_config_unavailable",
      message:
        "Não foi possível preparar a autenticação desta plataforma. Configure uma Auth Config no Composio e tente novamente.",
      retryable: false,
    };
  }
  if (context === "session-sync") {
    return {
      code: "session_sync_failed",
      message:
        "A conexão foi salva, mas a sincronização das ferramentas do Composio falhou. Atualize as integrações antes de usar os agentes.",
      retryable: true,
    };
  }
  if (context === "storage") {
    return {
      code: "local_storage_failed",
      message:
        "O Modus não conseguiu acessar o armazenamento seguro local. Verifique o acesso ao armazenamento do sistema e tente novamente.",
      retryable: true,
    };
  }
  return {
    code: "composio_operation_failed",
    message:
      "O Composio não conseguiu concluir esta operação. Verifique as permissões do projeto e tente novamente.",
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
      message: "O nome da conta deve ter entre 1 e 80 caracteres.",
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
      message: "O Composio não retornou um link de conexão válido. Tente novamente.",
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
      message: "O link de conexão não pertence ao domínio seguro do Composio e não foi aberto.",
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
        code: "api_key_required",
        message: "Adicione e valide sua Project API Key do Composio antes de continuar.",
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
      settings = { ...state, apiKeyConfigured: hasKey };
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
            "O Composio retornou uma conta de outra plataforma. Ela não foi ativada no Modus.",
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
            message: "A autorização expirou. Inicie uma nova conexão.",
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
              ? "A autorização foi cancelada ou revogada. Inicie uma nova conexão."
              : "O Composio não confirmou uma conta ativa. Tente conectar novamente.",
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

  return {
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
      return initialized ? cloneSettings(settings) : await this.initialize();
    },

    async setProjectApiKey(apiKey: string): Promise<ComposioSettingsState> {
      return await withPolicyLock(async () => {
        if (shutDown) return setSettingsError(new Error("service closed"), "storage");
        if (!initialized) await this.initialize();
        const candidateKey = apiKey.trim();
        if (!candidateKey) {
          return setSettingsError(
            new ComposioServiceError({
              code: "invalid_project_key",
              message: "Informe uma Project API Key do Composio.",
              retryable: false,
            }),
            "project-read",
          );
        }
        try {
          await dependencies.mcp.unregisterComposioMcpSession();
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
          context = "storage";
          await dependencies.secretStore.save(candidateKey);
          api = candidateApi;
          hasKey = true;
          return await refreshCatalogWith(candidateApi);
        } catch (error) {
          return setSettingsError(error, context);
        }
      });
    },

    async removeProjectApiKey(): Promise<ComposioSettingsState> {
      return await withPolicyLock(async () => {
        if (!initialized && !shutDown) await this.initialize();
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
        for (const operation of operations.values()) {
          if (operation.status === "pending") {
            setOperation({
              ...operation,
              status: "canceled",
              error: {
                code: "connection_canceled",
                message: "A conexão foi interrompida porque a Project API Key foi removida.",
                retryable: true,
              },
            });
          }
        }
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
        hasKey = false;
        settings = cloneSettings(DEFAULT_SETTINGS);
        if (sessionDeleteError) {
          settings = {
            ...settings,
            status: "error",
            error: {
              code: "session_sync_failed",
              message:
                "A chave foi removida, mas a sessão remota não pôde ser encerrada. As contas conectadas foram mantidas no Composio.",
              retryable: true,
            },
          };
        }
        return cloneSettings(settings);
      });
    },

    async refreshCatalog(): Promise<ComposioSettingsState> {
      return await withPolicyLock(async () => {
        if (!initialized) await this.initialize();
        if (!api) {
          if (hasKey) return cloneSettings(settings);
          settings = cloneSettings(DEFAULT_SETTINGS);
          return cloneSettings(settings);
        }
        return await refreshCatalogWith(api);
      });
    },

    async listToolkitTools(toolkitSlug: string): Promise<ComposioToolSummary[]> {
      try {
        if (!toolkitSlug.trim())
          throw new ComposioServiceError({
            code: "toolkit_unavailable",
            message: "Selecione uma plataforma válida do catálogo Composio.",
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
          if (!initialized) await this.initialize();
          if (shutDown) throw new Error("service closed");
          const toolkitSlug = input.toolkitSlug.trim();
          if (!toolkitSlug || toolkitSlug.length > 120) {
            throw new ComposioServiceError({
              code: "toolkit_unavailable",
              message: "Selecione uma plataforma válida do catálogo Composio.",
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
              message: "A seleção contém ferramentas inválidas ou excede o limite permitido.",
              retryable: false,
            });
          }
          const currentApi = requireApi();
          const profile = dependencies.profileStore.load();
          const selectedAccountId = input.selectedAccountId?.trim();
          if (input.enabled && (!selectedAccountId || selectedToolSlugs.length === 0)) {
            throw new ComposioServiceError({
              code: "toolkit_unavailable",
              message:
                "Selecione uma conta ativa e pelo menos uma operação antes de habilitar a plataforma.",
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
                message: "Esta plataforma não está disponível no catálogo do projeto Composio.",
                retryable: false,
              });
            }
            const knownTools = new Set(tools.map((tool) => tool.slug));
            if (selectedToolSlugs.some((slug) => !knownTools.has(slug))) {
              throw new ComposioServiceError({
                code: "toolkit_unavailable",
                message:
                  "A seleção contém ferramentas que não pertencem a esta plataforma. Atualize o catálogo e tente novamente.",
                retryable: false,
              });
            }
            const selectedAccount = accounts.find((account) => account.id === selectedAccountId);
            if (!selectedAccount) {
              throw new ComposioServiceError({
                code: "account_not_found",
                message:
                  "A conta selecionada não pertence a este perfil local ou não está mais conectada.",
                retryable: false,
              });
            }
            if (accountStatus(selectedAccount.status) !== "active") {
              throw new ComposioServiceError({
                code: "account_revoked",
                message: "Conecte novamente esta conta antes de habilitá-la para os agentes.",
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
          return setSettingsError(
            error,
            errorFields(error).status === 403 ? "account-read" : "session-sync",
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
          "Selecione uma plataforma válida e tente novamente.",
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
                "O Modus está encerrando. Inicie a conexão novamente ao reabrir o aplicativo.",
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
                "Esta plataforma não está disponível no catálogo do projeto Composio.",
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
                "Cada plataforma pode ter até cinco contas. Remova uma conta existente ou aguarde uma conexão pendente terminar.",
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
                  "Esta plataforma exige uma configuração de autenticação no projeto Composio antes de conectar.",
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
                  message: "A conexão foi interrompida ao encerrar o Modus.",
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
                message: "Não foi possível abrir o link seguro de conexão. Tente novamente.",
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
          message: "Esta operação de conexão não está mais disponível. Inicie uma nova conexão.",
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
              message: "A conta não pertence a este perfil local ou não está mais conectada.",
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
              message: "A conta não pertence a este perfil local ou não está mais conectada.",
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
            message: "A conexão foi interrompida ao encerrar o Modus.",
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
        });
      })();
      await shutdownPromise;
    },
  };
}
