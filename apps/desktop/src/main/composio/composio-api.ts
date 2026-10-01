import { Composio, SessionPreset } from "@composio/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ComposioDisconnectAccountInput,
  ComposioRenameAccountInput,
  ComposioStartConnectionInput,
  ComposioToolkitPolicyInput,
  ComposioUserError,
} from "../../shared/contracts";

export type {
  ComposioDisconnectAccountInput,
  ComposioRenameAccountInput,
  ComposioStartConnectionInput,
  ComposioToolkitPolicyInput,
  ComposioUserError,
};

export type ComposioToolkitRecord = {
  slug: string;
  name: string;
  description?: string;
};

export type ComposioToolRecord = {
  slug: string;
  name: string;
  description?: string;
  riskHint?: string;
};

export type ComposioAccountRecord = {
  id: string;
  toolkitSlug: string;
  alias?: string;
  status: string;
};

export type ComposioAuthConfigRecord = {
  id: string;
  isComposioManaged: boolean;
  authScheme: string;
};

export type ComposioConnectionRequest = {
  id: string;
  redirectUrl: string;
  waitForConnection(timeoutMs: number, signal?: AbortSignal): Promise<ComposioAccountRecord>;
};

export type ComposioSessionConfig = {
  toolkits: { enable: string[] };
  tools: Record<string, { enable: string[] }>;
  connectedAccounts: Record<string, string[]>;
  sessionPreset: typeof SessionPreset.DIRECT_TOOLS;
  mcp: true;
  sandbox: { enable: false };
  manageConnections: { enable: false };
  multiAccount: { enable: false; requireExplicitSelection: false };
};

export type ComposioConnectivityResult = {
  apiReachable: boolean;
  mcpSessionReady: boolean;
  error?: ComposioUserError;
};

export type ComposioSession = {
  id: string;
  configVersion: number;
  mcp: { url: string; headers?: Record<string, string> };
  update(config: ComposioSessionConfig, expectedConfigVersion?: number): Promise<void>;
};

export interface ComposioApi {
  validateProjectReadAccess(profileId: string): Promise<void>;
  validateMcpConnectivity(profileId: string): Promise<ComposioConnectivityResult>;
  listToolkits(): Promise<ComposioToolkitRecord[]>;
  listTools(toolkitSlug: string): Promise<ComposioToolRecord[]>;
  listAuthConfigs(toolkitSlug: string): Promise<ComposioAuthConfigRecord[]>;
  createManagedAuthConfig(toolkitSlug: string): Promise<ComposioAuthConfigRecord>;
  listAccounts(profileId: string, toolkitSlug?: string): Promise<ComposioAccountRecord[]>;
  linkAccount(input: {
    userId: string;
    authConfigId: string;
    alias: string;
    allowMultiple: true;
  }): Promise<ComposioConnectionRequest>;
  deleteAccount(accountId: string): Promise<void>;
  createSession(userId: string, config: ComposioSessionConfig): Promise<ComposioSession>;
  useSession(sessionId: string): Promise<ComposioSession>;
  deleteSession(sessionId: string): Promise<void>;
}

type SdkToolkit = {
  slug: string;
  name: string;
  meta?: { description?: string | null };
};

type SdkTool = {
  slug: string;
  name: string;
  description?: string;
  isDeprecated?: boolean;
};

type SdkAccount = {
  id: string;
  alias?: string | null;
  status: string;
  isDisabled: boolean;
  toolkit: { slug: string };
};

type SdkConnectionRequest = {
  id: string;
  redirectUrl: string;
  waitForConnection(timeoutMs?: number): Promise<SdkAccount>;
};

type SdkSession = {
  sessionId: string;
  configVersion?: number;
  mcp?: { url?: string; headers?: Record<string, string> };
  update(config: Record<string, unknown>): Promise<unknown>;
};

function mapToolkit(toolkit: SdkToolkit): ComposioToolkitRecord {
  return {
    slug: toolkit.slug,
    name: toolkit.name,
    ...(typeof toolkit.meta?.description === "string" && toolkit.meta.description.length > 0
      ? { description: toolkit.meta.description }
      : {}),
  };
}

function mapTool(tool: SdkTool): ComposioToolRecord {
  return {
    slug: tool.slug,
    name: tool.name,
    ...(typeof tool.description === "string" && tool.description.length > 0
      ? { description: tool.description }
      : {}),
    ...(tool.isDeprecated ? { riskHint: "Deprecated by Composio" } : {}),
  };
}

function mapAccount(account: SdkAccount): ComposioAccountRecord {
  return {
    id: account.id,
    toolkitSlug: account.toolkit.slug,
    ...(typeof account.alias === "string" && account.alias.length > 0
      ? { alias: account.alias }
      : {}),
    status: account.isDisabled ? "DISABLED" : account.status,
  };
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Connection wait aborted."));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function mapAuthConfig(authConfig: {
  id: string;
  isComposioManaged?: boolean | undefined;
  authScheme?: string | undefined;
}): ComposioAuthConfigRecord {
  return {
    id: authConfig.id,
    isComposioManaged: authConfig.isComposioManaged === true,
    authScheme: authConfig.authScheme ?? "UNKNOWN",
  };
}

function mapSession(sessionLike: unknown): ComposioSession {
  const session = sessionLike as SdkSession;
  const headers = session.mcp?.headers;
  if (
    typeof session.sessionId !== "string" ||
    typeof session.configVersion !== "number" ||
    typeof session.mcp?.url !== "string" ||
    !headers ||
    Object.keys(headers).length === 0
  ) {
    throw new Error("Composio session did not provide usable MCP credentials.");
  }

  return {
    id: session.sessionId,
    configVersion: session.configVersion,
    mcp: { url: session.mcp.url, headers: { ...headers } },
    async update(config, expectedConfigVersion): Promise<void> {
      const updateConfig: Record<string, unknown> = {
        toolkits: config.toolkits,
        tools: config.tools,
        connectedAccounts: config.connectedAccounts,
        sandbox: config.sandbox,
        manageConnections: config.manageConnections,
        multiAccount: config.multiAccount,
      };
      if (expectedConfigVersion !== undefined) {
        updateConfig.expectedConfigVersion = expectedConfigVersion;
      }
      await session.update(updateConfig);
    },
  };
}

export function createComposioApi(apiKey: string): ComposioApi {
  // Ignore COMPOSIO_BASE_URL and CLI user-config overrides. Modus sends the
  // user's project key to Composio's documented production API origin only.
  const composio = new Composio({ apiKey, baseURL: "https://backend.composio.dev" });

  return {
    async validateProjectReadAccess(profileId: string): Promise<void> {
      await Promise.all([
        composio.toolkits.get({ managedBy: "all", limit: 1 }),
        composio.connectedAccounts.list({ userIds: [profileId], limit: 1 }),
      ]);
    },

    async validateMcpConnectivity(profileId) {
      await this.validateProjectReadAccess(profileId);
      let session: ComposioSession | undefined;
      try {
        session = await this.createSession(profileId, {
          toolkits: { enable: [] }, tools: {}, connectedAccounts: {},
          sessionPreset: SessionPreset.DIRECT_TOOLS, mcp: true,
          sandbox: { enable: false }, manageConnections: { enable: false },
          multiAccount: { enable: false, requireExplicitSelection: false },
        });
        const client = new Client({ name: "modus-composio-connectivity-check", version: "0.1.0" });
        const transport = new StreamableHTTPClientTransport(new URL(session.mcp.url), {
          requestInit: { headers: session.mcp.headers ?? {}, redirect: "error" },
        });
        try {
          await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
          return { apiReachable: true, mcpSessionReady: true };
        } catch (error) {
          return { apiReachable: true, mcpSessionReady: false, error: { code: "mcp_transport_failed", message: error instanceof Error ? error.message.slice(0, 240) : "MCP transport failed", retryable: true } };
        } finally {
          await client.close().catch(() => undefined);
          await transport.close().catch(() => undefined);
        }
      } finally {
        if (session) await this.deleteSession(session.id).catch(() => undefined);
      }
    },

    async listToolkits(): Promise<ComposioToolkitRecord[]> {
      const toolkits = await composio.toolkits.get({ managedBy: "all", limit: 500 });
      return (toolkits as SdkToolkit[]).map(mapToolkit);
    },

    async listTools(toolkitSlug: string): Promise<ComposioToolRecord[]> {
      const tools = await composio.tools.getRawComposioTools({
        toolkits: [toolkitSlug],
        limit: 500,
        important: false,
      });
      return (tools as SdkTool[]).map(mapTool);
    },

    async listAuthConfigs(toolkitSlug: string): Promise<ComposioAuthConfigRecord[]> {
      const authConfigs: ComposioAuthConfigRecord[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await composio.authConfigs.list({
          toolkit: toolkitSlug,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        authConfigs.push(...page.items.map(mapAuthConfig));
        const nextCursor = page.nextCursor ?? undefined;
        if (nextCursor && seenCursors.has(nextCursor)) {
          throw new Error("Composio auth-config pagination did not advance.");
        }
        if (nextCursor) seenCursors.add(nextCursor);
        cursor = nextCursor;
      } while (cursor);
      return authConfigs;
    },

    async createManagedAuthConfig(toolkitSlug: string): Promise<ComposioAuthConfigRecord> {
      const authConfig = await composio.authConfigs.create(toolkitSlug, {
        type: "use_composio_managed_auth",
        isEnabledForToolRouter: true,
      });
      return mapAuthConfig(authConfig);
    },

    async listAccounts(profileId: string, toolkitSlug?: string): Promise<ComposioAccountRecord[]> {
      const accounts: ComposioAccountRecord[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await composio.connectedAccounts.list({
          userIds: [profileId],
          ...(toolkitSlug ? { toolkitSlugs: [toolkitSlug] } : {}),
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        accounts.push(...page.items.map((account) => mapAccount(account as SdkAccount)));
        const nextCursor = page.nextCursor ?? undefined;
        if (nextCursor && seenCursors.has(nextCursor)) {
          throw new Error("Composio account pagination did not advance.");
        }
        if (nextCursor) seenCursors.add(nextCursor);
        cursor = nextCursor;
      } while (cursor);
      return accounts;
    },

    async linkAccount(input): Promise<ComposioConnectionRequest> {
      const request = (await composio.connectedAccounts.link(input.userId, input.authConfigId, {
        alias: input.alias,
        allowMultiple: true,
      })) as SdkConnectionRequest;
      if (typeof request.id !== "string" || typeof request.redirectUrl !== "string") {
        throw new Error("Composio did not return a valid connection request.");
      }
      return {
        id: request.id,
        redirectUrl: request.redirectUrl,
        async waitForConnection(
          timeoutMs: number,
          signal?: AbortSignal,
        ): Promise<ComposioAccountRecord> {
          if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            throw new Error("A positive Composio connection timeout is required.");
          }
          const deadline = Date.now() + timeoutMs;
          const timeoutController = new AbortController();
          const timeoutError = Object.assign(new Error("Composio connection timed out"), {
            code: "TIMEOUT",
          });
          const timeout = setTimeout(() => timeoutController.abort(timeoutError), timeoutMs);
          timeout.unref?.();
          const requestSignal = signal
            ? AbortSignal.any([signal, timeoutController.signal])
            : timeoutController.signal;
          try {
            while (true) {
              if (signal?.aborted) throw signal.reason ?? new Error("Connection wait aborted.");
              if (timeoutController.signal.aborted || Date.now() >= deadline) {
                throw timeoutController.signal.reason ?? timeoutError;
              }
              let account: SdkAccount;
              try {
                account = (await composio.connectedAccounts.get(request.id, {
                  signal: requestSignal,
                })) as SdkAccount;
              } catch (error) {
                if (signal?.aborted) throw signal.reason ?? error;
                if (timeoutController.signal.aborted) {
                  throw timeoutController.signal.reason ?? error;
                }
                throw error;
              }
              const status = account.isDisabled ? "DISABLED" : account.status.toUpperCase();
              if (status === "ACTIVE") return mapAccount(account);
              if (["FAILED", "EXPIRED", "REVOKED"].includes(status)) {
                throw Object.assign(new Error(`Connection request failed with status: ${status}`), {
                  code: status,
                });
              }
              await abortableDelay(Math.min(1_000, deadline - Date.now()), requestSignal);
            }
          } finally {
            clearTimeout(timeout);
          }
        },
      };
    },

    async deleteAccount(accountId: string): Promise<void> {
      await composio.connectedAccounts.delete(accountId);
    },

    async createSession(userId: string, config: ComposioSessionConfig): Promise<ComposioSession> {
      return mapSession(await composio.sessions.create(userId, config));
    },

    async useSession(sessionId: string): Promise<ComposioSession> {
      return mapSession(await composio.sessions.use(sessionId, { mcp: true }));
    },

    async deleteSession(sessionId: string): Promise<void> {
      await composio.sessions.delete(sessionId);
    },
  };
}
