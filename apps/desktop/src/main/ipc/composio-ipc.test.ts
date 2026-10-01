import { describe, expect, it, vi } from "vitest";
import type {
  ComposioConnectionOperation,
  ComposioSettingsState,
  ComposioToolSummary,
} from "../../shared/contracts";
import type { ComposioService } from "../composio/composio-service";
import type { TrustedSenderEvent } from "./trusted-sender";

const CHANNELS = [
  "composio:get-state",
  "composio:set-api-key",
  "composio:remove-api-key",
  "composio:refresh-catalog",
  "composio:list-tools",
  "composio:start-connection",
  "composio:get-connection-operation",
  "composio:set-toolkit-policy",
  "composio:rename-account",
  "composio:disconnect-account",
];

type Handler = (event: TrustedSenderEvent, input?: unknown) => unknown;

const SAFE_STATE: ComposioSettingsState = {
  apiKeyConfigured: true,
  status: "ready",
  toolkits: [
    {
      slug: "github",
      name: "GitHub",
      enabled: false,
      selectedToolSlugs: [],
      accounts: [
        {
          id: "account-1",
          toolkitSlug: "github",
          alias: "Work",
          status: "active",
        },
      ],
    },
  ],
};

function mockService() {
  const tool: ComposioToolSummary = {
    toolkitSlug: "github",
    slug: "GITHUB_LIST_REPOSITORIES",
    name: "List repositories",
  };
  const operation: ComposioConnectionOperation = {
    id: "operation-1",
    toolkitSlug: "github",
    alias: "Work",
    status: "pending",
  };
  return {
    initialize: vi.fn(async () => SAFE_STATE),
    getSettingsState: vi.fn(async () => SAFE_STATE),
    setProjectApiKey: vi.fn(async (_apiKey: string) => SAFE_STATE),
    removeProjectApiKey: vi.fn(async () => SAFE_STATE),
    refreshCatalog: vi.fn(async () => SAFE_STATE),
    listToolkitTools: vi.fn(async (_toolkitSlug: string) => [tool]),
    setToolkitPolicy: vi.fn(async () => SAFE_STATE),
    startConnection: vi.fn(async () => operation),
    getConnectionOperation: vi.fn(async (_operationId: string) => operation),
    renameAccount: vi.fn(async () => SAFE_STATE),
    disconnectAccount: vi.fn(async () => SAFE_STATE),
    shutdown: vi.fn(async () => {}),
  } satisfies ComposioService;
}

async function register(service: ComposioService) {
  const { registerComposioIpcHandlers } = await import("./composio-ipc");
  const { assertTrustedSender } = await import("./trusted-sender");
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
  };
  registerComposioIpcHandlers(ipcMain, assertTrustedSender, () => service);
  return handlers;
}

async function trustedEvent() {
  const { registerTrustedSender } = await import("./trusted-sender");
  const sender = { mainFrame: { url: "file:///index.html" } };
  const unregister = registerTrustedSender(sender, "file:///index.html");
  return { trusted: { sender, senderFrame: sender.mainFrame }, unregister };
}

describe("Composio IPC", () => {
  it("registers exactly the Composio integration channels", async () => {
    const handlers = await register(mockService());
    expect([...handlers.keys()].sort()).toEqual([...CHANNELS].sort());
  });

  it("rejects untrusted senders before creating or calling the service", async () => {
    const service = mockService();
    const handlers = await register(service);
    const event = { senderFrame: { url: "https://attacker.invalid/" } };
    for (const channel of CHANNELS) {
      expect(() => handlers.get(channel)?.(event, undefined)).toThrow(
        "Blocked IPC call from untrusted renderer frame.",
      );
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it("rejects malformed and extra fields without invoking any service method", async () => {
    const service = mockService();
    const handlers = await register(service);
    const { trusted, unregister } = await trustedEvent();
    try {
      expect(() => handlers.get("composio:get-state")?.(trusted, {})).toThrow(
        /Invalid IPC payload/,
      );
      expect(() =>
        handlers.get("composio:set-api-key")?.(trusted, { apiKey: "x", debug: true }),
      ).toThrow(/Invalid IPC payload/);
      expect(() => handlers.get("composio:set-api-key")?.(trusted, { apiKey: "" })).toThrow(
        /Invalid IPC payload/,
      );
      expect(() =>
        handlers.get("composio:list-tools")?.(trusted, { toolkitSlug: "github", all: true }),
      ).toThrow(/Invalid IPC payload/);
      expect(() =>
        handlers.get("composio:set-toolkit-policy")?.(trusted, {
          toolkitSlug: "github",
          enabled: true,
          selectedToolSlugs: Array.from({ length: 501 }, (_, index) => `TOOL_${index}`),
        }),
      ).toThrow(/Invalid IPC payload/);
      expect(() =>
        handlers.get("composio:rename-account")?.(trusted, {
          toolkitSlug: "github",
          accountId: "account-1",
          alias: "x".repeat(81),
        }),
      ).toThrow(/Invalid IPC payload/);
      expect(service.getSettingsState).not.toHaveBeenCalled();
      expect(service.setProjectApiKey).not.toHaveBeenCalled();
      expect(service.listToolkitTools).not.toHaveBeenCalled();
      expect(service.setToolkitPolicy).not.toHaveBeenCalled();
      expect(service.renameAccount).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("forwards valid calls and returns only renderer-safe DTOs", async () => {
    const service = mockService();
    const handlers = await register(service);
    const { trusted, unregister } = await trustedEvent();
    const apiKey = "composio_project_key_private";
    try {
      expect(await handlers.get("composio:get-state")?.(trusted, undefined)).toEqual(SAFE_STATE);
      expect(await handlers.get("composio:set-api-key")?.(trusted, { apiKey })).toEqual(SAFE_STATE);
      expect(await handlers.get("composio:remove-api-key")?.(trusted, undefined)).toEqual(
        SAFE_STATE,
      );
      expect(await handlers.get("composio:refresh-catalog")?.(trusted, undefined)).toEqual(
        SAFE_STATE,
      );
      expect(
        await handlers.get("composio:list-tools")?.(trusted, { toolkitSlug: " github " }),
      ).toEqual([
        { toolkitSlug: "github", slug: "GITHUB_LIST_REPOSITORIES", name: "List repositories" },
      ]);
      expect(
        await handlers.get("composio:start-connection")?.(trusted, {
          toolkitSlug: "github",
          alias: " Work ",
        }),
      ).toMatchObject({ status: "pending" });
      expect(
        await handlers.get("composio:get-connection-operation")?.(trusted, {
          operationId: "operation-1",
        }),
      ).toMatchObject({ id: "operation-1" });
      expect(
        await handlers.get("composio:set-toolkit-policy")?.(trusted, {
          toolkitSlug: "github",
          enabled: true,
          selectedToolSlugs: ["GITHUB_LIST_REPOSITORIES"],
          selectedAccountId: "account-1",
        }),
      ).toEqual(SAFE_STATE);
      expect(
        await handlers.get("composio:rename-account")?.(trusted, {
          toolkitSlug: "github",
          accountId: "account-1",
          alias: "Personal",
        }),
      ).toEqual(SAFE_STATE);
      expect(
        await handlers.get("composio:disconnect-account")?.(trusted, {
          toolkitSlug: "github",
          accountId: "account-1",
        }),
      ).toEqual(SAFE_STATE);

      expect(service.setProjectApiKey).toHaveBeenCalledWith(apiKey);
      expect(service.listToolkitTools).toHaveBeenCalledWith("github");
      expect(service.startConnection).toHaveBeenCalledWith({
        toolkitSlug: "github",
        alias: "Work",
      });
      expect(service.setToolkitPolicy).toHaveBeenCalledWith({
        toolkitSlug: "github",
        enabled: true,
        selectedToolSlugs: ["GITHUB_LIST_REPOSITORIES"],
        selectedAccountId: "account-1",
      });
      const serialized = JSON.stringify(SAFE_STATE);
      expect(serialized).not.toMatch(
        /x-api-key|mcp\.composio\.dev|session-key|access[_-]?token|connect\.composio\.dev/,
      );
      expect(serialized).not.toContain(apiKey);
    } finally {
      unregister();
    }
  });
});
