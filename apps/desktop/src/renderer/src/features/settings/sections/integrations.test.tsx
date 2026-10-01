// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ComposioSettingsState,
  ComposioToolkitPolicyInput,
  ComposioToolSummary,
} from "../../../../../shared/contracts";
import { IntegrationsSettingsPanel } from "./integrations";

const accountOne = {
  id: "account-one",
  toolkitSlug: "github",
  alias: "Work GitHub",
  status: "active" as const,
};
const accountTwo = {
  id: "account-two",
  toolkitSlug: "github",
  alias: "Personal GitHub",
  status: "active" as const,
};

function githubToolkit(overrides: Partial<ComposioSettingsState["toolkits"][number]> = {}) {
  return {
    slug: "github",
    name: "GitHub",
    description: "Repositories, issues, and pull requests.",
    accounts: [accountOne, accountTwo],
    enabled: false,
    selectedAccountId: accountOne.id,
    selectedToolSlugs: [],
    ...overrides,
  };
}

function readyState(overrides: Partial<ComposioSettingsState> = {}): ComposioSettingsState {
  return {
    apiKeyConfigured: true,
    status: "ready",
    toolkits: [githubToolkit()],
    ...overrides,
  };
}

function tool(slug: string, name = slug): ComposioToolSummary {
  return { toolkitSlug: "github", slug, name };
}

function installComposioApi() {
  type ComposioApi = Window["modus"]["composio"];
  const api: ComposioApi = {
    getState: vi.fn<ComposioApi["getState"]>(),
    setApiKey: vi.fn<ComposioApi["setApiKey"]>(),
    removeApiKey: vi.fn<ComposioApi["removeApiKey"]>(),
    refreshCatalog: vi.fn<ComposioApi["refreshCatalog"]>(),
    listTools: vi.fn<ComposioApi["listTools"]>(),
    startConnection: vi.fn<ComposioApi["startConnection"]>(),
    getConnectionOperation: vi.fn<ComposioApi["getConnectionOperation"]>(),
    setToolkitPolicy: vi.fn<ComposioApi["setToolkitPolicy"]>(),
    renameAccount: vi.fn<ComposioApi["renameAccount"]>(),
    disconnectAccount: vi.fn<ComposioApi["disconnectAccount"]>(),
  };
  Object.defineProperty(window, "modus", {
    configurable: true,
    value: { composio: api },
  });
  return api;
}

describe("IntegrationsSettingsPanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the unconfigured profile state with a password-masked Project API Key field", async () => {
    const api = installComposioApi();
    api.getState.mockResolvedValue({
      apiKeyConfigured: false,
      status: "unconfigured",
      toolkits: [],
    });

    render(<IntegrationsSettingsPanel />);

    const keyInput = await screen.findByLabelText("Composio Project API Key");
    expect((keyInput as HTMLInputElement).type).toBe("password");
    expect(screen.getByText(/armazenada com segurança neste dispositivo/i)).toBeTruthy();
  });

  it("submits and clears the key without reading it back into the interface", async () => {
    const api = installComposioApi();
    api.getState.mockResolvedValue({
      apiKeyConfigured: false,
      status: "unconfigured",
      toolkits: [],
    });
    api.setApiKey.mockResolvedValue(readyState({ toolkits: [] }));
    const user = userEvent.setup();

    render(<IntegrationsSettingsPanel />);
    const keyInput = await screen.findByLabelText("Composio Project API Key");
    await user.type(keyInput, "cmp_test_secret_value");
    await user.click(screen.getByRole("button", { name: "Salvar chave" }));

    await waitFor(() =>
      expect(api.setApiKey).toHaveBeenCalledWith({ apiKey: "cmp_test_secret_value" }),
    );
    await waitFor(() => expect((keyInput as HTMLInputElement).value).toBe(""));
    expect(document.body.textContent).not.toContain("cmp_test_secret_value");
    expect(screen.queryByDisplayValue("cmp_test_secret_value")).toBeNull();
  });

  it("lets agents use exactly one selected account when a toolkit has multiple accounts", async () => {
    const api = installComposioApi();
    api.getState.mockResolvedValue(readyState());
    api.setToolkitPolicy.mockResolvedValue(
      readyState({
        toolkits: [githubToolkit({ selectedAccountId: accountTwo.id })],
      }),
    );
    const user = userEvent.setup();

    render(<IntegrationsSettingsPanel />);
    const toolkit = await screen.findByRole("region", { name: "GitHub" });
    await user.click(within(toolkit).getByRole("button", { name: /configure/i }));
    const workAccount = await screen.findByRole("radio", { name: /work github/i });
    const personalAccount = screen.getByRole("radio", { name: /personal github/i });
    expect((workAccount as HTMLInputElement).checked).toBe(true);
    expect((personalAccount as HTMLInputElement).checked).toBe(false);

    await user.click(personalAccount);

    await waitFor(() =>
      expect(api.setToolkitPolicy).toHaveBeenCalledWith({
        toolkitSlug: "github",
        enabled: false,
        selectedToolSlugs: [],
        selectedAccountId: "account-two",
      }),
    );
    expect((personalAccount as HTMLInputElement).checked).toBe(true);
    expect((workAccount as HTMLInputElement).checked).toBe(false);
  });

  it("requires explicit operation checkboxes and provides a Select all action", async () => {
    const api = installComposioApi();
    api.getState.mockResolvedValue(readyState());
    api.listTools.mockResolvedValue([
      tool("GITHUB_LIST_REPOSITORIES", "List repositories"),
      tool("GITHUB_CREATE_ISSUE", "Create issue"),
    ]);
    api.setToolkitPolicy.mockImplementation(async (input: ComposioToolkitPolicyInput) =>
      readyState({
        toolkits: [
          githubToolkit({
            enabled: input.enabled,
            selectedToolSlugs: input.selectedToolSlugs,
            selectedAccountId: input.selectedAccountId ?? accountOne.id,
          }),
        ],
      }),
    );
    const user = userEvent.setup();

    render(<IntegrationsSettingsPanel />);
    const toolkit = await screen.findByRole("region", { name: "GitHub" });
    await user.click(within(toolkit).getByRole("button", { name: /configure/i }));

    const listRepositories = await screen.findByRole("checkbox", { name: /list repositories/i });
    const createIssue = screen.getByRole("checkbox", { name: /create issue/i });
    expect((listRepositories as HTMLInputElement).checked).toBe(false);
    expect((createIssue as HTMLInputElement).checked).toBe(false);
    await user.click(listRepositories);

    await waitFor(() =>
      expect(api.setToolkitPolicy).toHaveBeenCalledWith({
        toolkitSlug: "github",
        enabled: false,
        selectedToolSlugs: ["GITHUB_LIST_REPOSITORIES"],
        selectedAccountId: "account-one",
      }),
    );
    await user.click(within(toolkit).getByRole("button", { name: "Select all" }));

    await waitFor(() =>
      expect(api.setToolkitPolicy).toHaveBeenLastCalledWith({
        toolkitSlug: "github",
        enabled: false,
        selectedToolSlugs: ["GITHUB_LIST_REPOSITORIES", "GITHUB_CREATE_ISSUE"],
        selectedAccountId: "account-one",
      }),
    );
    await waitFor(() => {
      expect((listRepositories as HTMLInputElement).checked).toBe(true);
      expect((createIssue as HTMLInputElement).checked).toBe(true);
    });
  });

  it("blocks selecting more than 500 operations and explains how to recover", async () => {
    const api = installComposioApi();
    api.getState.mockResolvedValue(readyState());
    api.listTools.mockResolvedValue(
      Array.from({ length: 501 }, (_, index) => tool(`TOOL_${index}`)),
    );
    const user = userEvent.setup();

    render(<IntegrationsSettingsPanel />);
    const toolkit = await screen.findByRole("region", { name: "GitHub" });
    await user.click(within(toolkit).getByRole("button", { name: /configure/i }));
    await screen.findByRole("button", { name: "Select all" });
    await user.click(within(toolkit).getByRole("button", { name: "Select all" }));

    expect((await screen.findByRole("status")).textContent).toMatch(/500 operations or fewer/i);
    expect(api.setToolkitPolicy).not.toHaveBeenCalled();
  });

  it("shows actionable guidance when the Project API Key lacks session write scope", async () => {
    const api = installComposioApi();
    api.getState.mockResolvedValue(readyState());
    api.listTools.mockResolvedValue([tool("GITHUB_LIST_REPOSITORIES", "List repositories")]);
    api.setToolkitPolicy.mockResolvedValue(
      readyState({
        status: "error",
        error: {
          code: "missing_scope_write",
          message: "Enable session write permission for this Project API Key.",
          retryable: false,
        },
      }),
    );
    const user = userEvent.setup();

    render(<IntegrationsSettingsPanel />);
    const toolkit = await screen.findByRole("region", { name: "GitHub" });
    await user.click(within(toolkit).getByRole("button", { name: /configure/i }));
    await user.click(await screen.findByRole("checkbox", { name: /list repositories/i }));

    expect((await screen.findByRole("status")).textContent).toMatch(/session write permission/i);
  });

  it.each([
    ["canceled", "connection_canceled", "Authorization was canceled"],
    ["expired", "connection_expired", "Authorization expired"],
  ] as const)("explains when a platform connection is %s", async (status, code, message) => {
    const api = installComposioApi();
    api.getState.mockResolvedValue(readyState());
    api.startConnection.mockResolvedValue({
      id: `operation-${status}`,
      toolkitSlug: "github",
      alias: "Second account",
      status,
      error: { code, message, retryable: status === "expired" },
    });
    const user = userEvent.setup();

    render(<IntegrationsSettingsPanel />);
    const toolkit = await screen.findByRole("region", { name: "GitHub" });
    await user.click(within(toolkit).getByRole("button", { name: /configure/i }));
    await user.click(within(toolkit).getByRole("button", { name: /connect another account/i }));
    await user.type(screen.getByLabelText("Account name"), "Second account");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect((await screen.findByRole("alert")).textContent).toContain(message);
  });

  it("polls only the sanitized operation ID and refreshes after authorization completes", async () => {
    const api = installComposioApi();
    api.getState.mockResolvedValue(readyState());
    api.startConnection.mockResolvedValue({
      id: "safe-operation-id",
      toolkitSlug: "github",
      alias: "Second account",
      status: "pending",
    });
    api.getConnectionOperation.mockResolvedValue({
      id: "safe-operation-id",
      toolkitSlug: "github",
      alias: "Second account",
      status: "active",
    });
    const user = userEvent.setup();

    render(<IntegrationsSettingsPanel />);
    const toolkit = await screen.findByRole("region", { name: "GitHub" });
    await user.click(within(toolkit).getByRole("button", { name: /configure/i }));
    await user.click(within(toolkit).getByRole("button", { name: /connect another account/i }));
    await user.type(screen.getByLabelText("Account name"), "Second account");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(
      (await screen.findByText(/connected second account/i, {}, { timeout: 1500 })).textContent,
    ).toMatch(/select this account and choose allowed operations/i);
    expect(api.getConnectionOperation).toHaveBeenCalledWith({ operationId: "safe-operation-id" });
    expect(document.body.textContent).not.toContain("connectUrl");
  });

  it("shows the actionable synchronization error supplied by the main process", async () => {
    const api = installComposioApi();
    api.getState.mockResolvedValue(
      readyState({
        status: "error",
        error: {
          code: "network_unavailable",
          message: "Could not sync selected tools. Check the connection and retry.",
          retryable: true,
        },
      }),
    );

    render(<IntegrationsSettingsPanel />);

    expect((await screen.findByRole("status")).textContent).toMatch(
      /check the connection and retry/i,
    );
  });
});
