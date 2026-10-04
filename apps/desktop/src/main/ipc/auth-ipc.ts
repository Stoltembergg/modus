import { z } from "zod";
import {
  AUTH_OAUTH_PROVIDER_IDS,
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
  type AuthCredentialsInput,
  type AuthOAuthInput,
  type AuthState,
} from "../../shared/auth";
import { IPC_CHANNELS } from "./channels";
import { parseIpcInput } from "./schemas";
import type { TrustedSenderEvent } from "./trusted-sender";

export type AuthIpcService = {
  getState(): AuthState;
  signUp(input: AuthCredentialsInput): Promise<AuthState>;
  signInWithPassword(input: AuthCredentialsInput): Promise<AuthState>;
  signInWithOAuth(provider: AuthOAuthInput["provider"]): Promise<AuthState>;
  cancelOAuth(): AuthState;
  signOut(): Promise<AuthState>;
};

type HandlerRegistration = {
  handle(channel: string, listener: (event: TrustedSenderEvent, input?: unknown) => unknown): void;
};

const authNoInputSchema = z.undefined();

export const authCredentialsSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    password: z.string().min(AUTH_PASSWORD_MIN_LENGTH).max(AUTH_PASSWORD_MAX_LENGTH),
  })
  .strict();

export const authOAuthSchema = z
  .object({ provider: z.enum(AUTH_OAUTH_PROVIDER_IDS as [string, ...string[]]) })
  .strict() as z.ZodType<AuthOAuthInput>;

/**
 * Account IPC: every reply is an AuthState (display data only). Tokens, the PKCE verifier and
 * the OAuth code never leave main; auth-ipc.test.ts asserts that on every payload.
 */
export function registerAuthIpcHandlers(
  ipcMain: HandlerRegistration,
  assertTrustedSender: (event: TrustedSenderEvent) => void,
  service: AuthIpcService,
): void {
  const handle = <T>(channel: string, schema: z.ZodType<T>, run: (input: T) => unknown) => {
    ipcMain.handle(channel, (event, input) => {
      assertTrustedSender(event);
      return run(parseIpcInput(schema, input, channel));
    });
  };
  handle(IPC_CHANNELS.authGetState, authNoInputSchema, () => service.getState());
  handle(IPC_CHANNELS.authSignUp, authCredentialsSchema, (input) => service.signUp(input));
  handle(IPC_CHANNELS.authSignInPassword, authCredentialsSchema, (input) =>
    service.signInWithPassword(input),
  );
  handle(IPC_CHANNELS.authSignInOAuth, authOAuthSchema, (input) =>
    service.signInWithOAuth(input.provider),
  );
  handle(IPC_CHANNELS.authCancelOAuth, authNoInputSchema, () => service.cancelOAuth());
  handle(IPC_CHANNELS.authSignOut, authNoInputSchema, () => service.signOut());
}
