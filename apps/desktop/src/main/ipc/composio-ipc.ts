import type { IpcMain } from "electron";
import { z } from "zod";
import type {
  ComposioDisconnectAccountInput,
  ComposioRenameAccountInput,
  ComposioStartConnectionInput,
  ComposioToolkitPolicyInput,
} from "../../shared/contracts";
import type { ComposioService } from "../composio/composio-service";
import { IPC_CHANNELS } from "./channels";
import { parseIpcInput } from "./schemas";
import type { TrustedSenderEvent } from "./trusted-sender";

type IpcMainLike = Pick<IpcMain, "handle">;
type IpcHandler = (event: TrustedSenderEvent, input?: unknown) => unknown;

const toolkitSlugSchema = z.string().trim().min(1).max(120);
const accountIdSchema = z.string().trim().min(1).max(256);
const toolSlugSchema = z.string().trim().min(1).max(160);
const aliasSchema = z.string().trim().min(1).max(80);

const noInputSchema = z.undefined();
const setApiKeySchema = z
  .object({
    apiKey: z.string().trim().min(1).max(4096),
  })
  .strict();
const toolkitSchema = z.object({ toolkitSlug: toolkitSlugSchema }).strict();
const operationSchema = z.object({ operationId: z.string().trim().min(1).max(128) }).strict();
const startConnectionSchema = z
  .object({
    toolkitSlug: toolkitSlugSchema,
    alias: aliasSchema,
  })
  .strict();
const toolkitPolicySchema = z
  .object({
    toolkitSlug: toolkitSlugSchema,
    enabled: z.boolean(),
    selectedToolSlugs: z
      .array(toolSlugSchema)
      .max(500)
      .refine(
        (slugs) => new Set(slugs).size === slugs.length,
        "Selected tool names must be unique.",
      ),
    selectedAccountId: accountIdSchema.optional(),
  })
  .strict();
const renameAccountSchema = z
  .object({
    toolkitSlug: toolkitSlugSchema,
    accountId: accountIdSchema,
    alias: aliasSchema,
  })
  .strict();
const disconnectAccountSchema = z
  .object({
    toolkitSlug: toolkitSlugSchema,
    accountId: accountIdSchema,
  })
  .strict();

export function registerComposioIpcHandlers(
  ipcMain: IpcMainLike,
  assertTrustedSender: (event: TrustedSenderEvent) => void,
  getService: () => ComposioService,
): void {
  ipcMain.handle(IPC_CHANNELS.composioGetState, ((event, input) => {
    assertTrustedSender(event);
    parseIpcInput(noInputSchema, input, IPC_CHANNELS.composioGetState);
    return getService().getSettingsState();
  }) as IpcHandler);

  ipcMain.handle(IPC_CHANNELS.composioSetApiKey, ((event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(setApiKeySchema, input, IPC_CHANNELS.composioSetApiKey);
    return getService().setProjectApiKey(parsed.apiKey);
  }) as IpcHandler);

  ipcMain.handle(IPC_CHANNELS.composioRemoveApiKey, ((event, input) => {
    assertTrustedSender(event);
    parseIpcInput(noInputSchema, input, IPC_CHANNELS.composioRemoveApiKey);
    return getService().removeProjectApiKey();
  }) as IpcHandler);

  ipcMain.handle(IPC_CHANNELS.composioRefreshCatalog, ((event, input) => {
    assertTrustedSender(event);
    parseIpcInput(noInputSchema, input, IPC_CHANNELS.composioRefreshCatalog);
    return getService().refreshCatalog();
  }) as IpcHandler);

  ipcMain.handle(IPC_CHANNELS.composioListTools, ((event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(toolkitSchema, input, IPC_CHANNELS.composioListTools);
    return getService().listToolkitTools(parsed.toolkitSlug);
  }) as IpcHandler);

  ipcMain.handle(IPC_CHANNELS.composioStartConnection, ((event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(
      startConnectionSchema,
      input,
      IPC_CHANNELS.composioStartConnection,
    ) satisfies ComposioStartConnectionInput;
    return getService().startConnection(parsed);
  }) as IpcHandler);

  ipcMain.handle(IPC_CHANNELS.composioGetConnectionOperation, ((event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(
      operationSchema,
      input,
      IPC_CHANNELS.composioGetConnectionOperation,
    );
    return getService().getConnectionOperation(parsed.operationId);
  }) as IpcHandler);

  ipcMain.handle(IPC_CHANNELS.composioSetToolkitPolicy, ((event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(toolkitPolicySchema, input, IPC_CHANNELS.composioSetToolkitPolicy);
    const policy: ComposioToolkitPolicyInput = {
      toolkitSlug: parsed.toolkitSlug,
      enabled: parsed.enabled,
      selectedToolSlugs: parsed.selectedToolSlugs,
      ...(parsed.selectedAccountId !== undefined
        ? { selectedAccountId: parsed.selectedAccountId }
        : {}),
    };
    return getService().setToolkitPolicy(policy);
  }) as IpcHandler);

  ipcMain.handle(IPC_CHANNELS.composioRenameAccount, ((event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(
      renameAccountSchema,
      input,
      IPC_CHANNELS.composioRenameAccount,
    ) satisfies ComposioRenameAccountInput;
    return getService().renameAccount(parsed);
  }) as IpcHandler);

  ipcMain.handle(IPC_CHANNELS.composioDisconnectAccount, ((event, input) => {
    assertTrustedSender(event);
    const parsed = parseIpcInput(
      disconnectAccountSchema,
      input,
      IPC_CHANNELS.composioDisconnectAccount,
    ) satisfies ComposioDisconnectAccountInput;
    return getService().disconnectAccount(parsed);
  }) as IpcHandler);
}
