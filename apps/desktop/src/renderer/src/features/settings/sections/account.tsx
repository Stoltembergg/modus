import { IconBrandGithub, IconBrandGoogle, IconLogout, IconMail } from "@tabler/icons-react";
import { type ReactNode, useEffect, useState } from "react";
import {
  AUTH_PASSWORD_MIN_LENGTH,
  AUTH_PROVIDERS,
  type AuthOAuthProviderId,
  type AuthState,
} from "../../../../../shared/auth";
import { ShinyText } from "../../../components/ui/ShinyText";
import { Field } from "../form-controls";
import {
  ReadOnlyPill,
  SettingsList,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from "../settings-layout";

const SECONDARY_BUTTON =
  "flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-xs text-fg transition-colors hover:bg-hover disabled:opacity-40";
const PRIMARY_BUTTON =
  "flex h-8 items-center gap-1.5 rounded-md bg-fg px-2.5 text-canvas text-xs transition-colors hover:bg-fg-muted disabled:opacity-40";

const OAUTH_ICONS: Record<AuthOAuthProviderId, ReactNode> = {
  github: <IconBrandGithub size={14} stroke={1.7} />,
  google: <IconBrandGoogle size={14} stroke={1.7} />,
};

type Mode = "sign-in" | "sign-up";

export function accountStatusLabel(state: AuthState): string {
  switch (state.status) {
    case "unconfigured":
      return "Unavailable";
    case "restoring":
      return "Restoring…";
    case "awaiting-oauth":
      return "Waiting for browser";
    case "signed-in":
      return "Signed in";
    default:
      return "Signed out";
  }
}

export function AccountSettingsPanel() {
  const [state, setState] = useState<AuthState | undefined>();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let active = true;
    void window.modus.auth
      .getState()
      .then((next: AuthState) => {
        if (active) setState(next);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    const unsubscribe = window.modus.auth.onStateChange((next: AuthState) => setState(next));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function run(action: () => Promise<AuthState>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const next = await action();
      setState(next);
      if (next.status === "signed-in" || next.notice === "confirm-email") setPassword("");
    } catch {
      setError("Check the email and use a password with at least 8 characters.");
    } finally {
      setBusy(false);
    }
  }

  const submit = () =>
    run(() =>
      mode === "sign-in"
        ? window.modus.auth.signInWithPassword({ email, password })
        : window.modus.auth.signUp({ email, password }),
    );

  const shownError = error ?? state?.error ?? undefined;
  const unavailable = !state || state.status === "unconfigured";
  const waiting = state?.status === "awaiting-oauth" || state?.status === "restoring";

  return (
    <>
      <SettingsPageHeader
        actions={
          state?.status === "signed-in" ? (
            <button
              className={SECONDARY_BUTTON}
              disabled={busy}
              onClick={() => void run(() => window.modus.auth.signOut())}
              type="button"
            >
              <IconLogout size={14} stroke={1.7} />
              Sign out
            </button>
          ) : state ? (
            <ReadOnlyPill>{accountStatusLabel(state)}</ReadOnlyPill>
          ) : null
        }
        description="Your Modus account. Sign-in happens in the app's main process; passwords and tokens never reach this window."
        title="Account"
      />

      {shownError ? <p className="-mt-4 text-danger text-xs">{shownError}</p> : null}
      {state?.notice === "confirm-email" ? (
        <p className="-mt-4 text-success text-xs">
          Check your inbox to confirm your email, then sign in.
        </p>
      ) : null}

      {state?.status === "signed-in" && state.user ? (
        <SettingsSection title="Profile">
          <SettingsList>
            <SettingsRow
              control={<ReadOnlyPill>{state.user.provider}</ReadOnlyPill>}
              description={state.user.email ?? "No email"}
              title={state.user.displayName ?? "Signed in"}
            />
            <SettingsRow
              control={
                <ReadOnlyPill>{state.user.emailConfirmed ? "Confirmed" : "Pending"}</ReadOnlyPill>
              }
              description="Free credits are granted once the email is confirmed."
              title="Email confirmation"
            />
            <SettingsRow
              control={
                <ReadOnlyPill>
                  {state.persistence === "encrypted" ? "Encrypted" : "This session only"}
                </ReadOnlyPill>
              }
              description={
                state.persistence === "encrypted"
                  ? "The session is stored encrypted by your operating system."
                  : "No secure OS storage was found, so you will sign in again after restarting."
              }
              title="Remember me"
            />
          </SettingsList>
        </SettingsSection>
      ) : (
        <>
          <SettingsSection
            description={
              unavailable
                ? "Account sign-in is not configured in this build."
                : mode === "sign-in"
                  ? "Sign in with your email and password."
                  : `Create an account. Use at least ${AUTH_PASSWORD_MIN_LENGTH} characters.`
            }
            title={mode === "sign-in" ? "Sign in" : "Create account"}
          >
            <form
              className="grid max-w-md gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <Field
                autoComplete="email"
                label="Email"
                onChange={setEmail}
                placeholder="you@example.com"
                type="email"
                value={email}
              />
              <Field
                autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                label="Password"
                onChange={setPassword}
                placeholder="Password"
                type="password"
                value={password}
              />
              <div className="flex items-center gap-2">
                <button
                  className={PRIMARY_BUTTON}
                  disabled={unavailable || busy || waiting || !email || !password}
                  type="submit"
                >
                  <IconMail size={13} stroke={2} />
                  {busy ? (
                    <ShinyText className="text-canvas">Working…</ShinyText>
                  ) : mode === "sign-in" ? (
                    "Sign in"
                  ) : (
                    "Create account"
                  )}
                </button>
                <button
                  className={SECONDARY_BUTTON}
                  disabled={busy}
                  onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}
                  type="button"
                >
                  {mode === "sign-in" ? "Create an account instead" : "I already have an account"}
                </button>
              </div>
            </form>
          </SettingsSection>

          <SettingsSection
            description="Opens your default browser and returns to Modus."
            title="Other ways to sign in"
          >
            <div className="flex flex-wrap items-center gap-2">
              {AUTH_PROVIDERS.flatMap((provider) =>
                provider.kind === "oauth" ? [provider] : [],
              ).map((provider) => {
                const enabled = state?.oauthProviders.includes(provider.id) ?? false;
                return (
                  <button
                    className={SECONDARY_BUTTON}
                    disabled={unavailable || busy || waiting || !enabled}
                    key={provider.id}
                    onClick={() =>
                      void run(() => window.modus.auth.signInWithOAuth({ provider: provider.id }))
                    }
                    title={enabled ? undefined : "Not available yet"}
                    type="button"
                  >
                    {OAUTH_ICONS[provider.id]}
                    Continue with {provider.label}
                  </button>
                );
              })}
              {state?.status === "awaiting-oauth" ? (
                <button
                  className={SECONDARY_BUTTON}
                  onClick={() => void window.modus.auth.cancelOAuth().then(setState)}
                  type="button"
                >
                  Cancel
                </button>
              ) : null}
            </div>
          </SettingsSection>
        </>
      )}
    </>
  );
}
