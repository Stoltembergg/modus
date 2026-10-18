import { IconBrandGithub, IconBrandGoogle, IconLogout, IconMail } from "@tabler/icons-react";
import { type ReactNode, useEffect, useState } from "react";
import {
  AUTH_PASSWORD_MIN_LENGTH,
  AUTH_PROVIDERS,
  type AuthOAuthProviderId,
  type AuthState,
} from "../../../../../shared/auth";
import type { ModusModelsStatus } from "../../../../../shared/contracts";
import { modusText } from "../../../../../shared/modus-text";
import { WorkingText } from "../../../components/ui/WorkingText";
import { type SettingsTextFn, settingsTextFor, useSettingsText } from "../../../lib/settingsText";
import { Field } from "../form-controls";
import {
  ReadOnlyPill,
  SETTINGS_PRIMARY_BUTTON,
  SETTINGS_SECONDARY_BUTTON,
  SettingsList,
  SettingsNotice,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from "../settings-layout";
import { AccountBillingSection } from "./account-billing";

const SECONDARY_BUTTON = `${SETTINGS_SECONDARY_BUTTON} h-8 px-2.5 text-xs`;
const PRIMARY_BUTTON = `${SETTINGS_PRIMARY_BUTTON} h-10 w-full px-3 text-sm font-medium`;
const OAUTH_BUTTON =
  "flex min-h-10 min-w-0 items-center justify-center gap-2 rounded-md bg-chip px-3 text-xs text-fg transition-colors hover:bg-chip-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/50 disabled:opacity-40";

const OAUTH_ICONS: Record<AuthOAuthProviderId, ReactNode> = {
  github: <IconBrandGithub size={14} stroke={1.7} />,
  google: <IconBrandGoogle size={14} stroke={1.7} />,
};

type Mode = "sign-in" | "sign-up";

export function accountStatusLabel(
  state: AuthState,
  t: SettingsTextFn = settingsTextFor(),
): string {
  switch (state.status) {
    case "unconfigured":
      return t("settings.account.statusUnavailable");
    case "restoring":
      return t("settings.account.statusRestoring");
    case "awaiting-oauth":
      return t("settings.account.statusAwaitingOauth");
    case "signed-in":
      return t("settings.account.statusSignedIn");
    default:
      return t("settings.account.statusSignedOut");
  }
}

/** L3b0: the Modus provider state the main process publishes (ModelSettingsState.modus). */
export function modusStatusText(
  status: ModusModelsStatus,
  locale?: string | null,
): { label: string; detail: string } {
  switch (status) {
    case "ready":
      return { label: modusText("modus.status.ready", locale), detail: "" };
    case "loading":
      return { label: modusText("modus.status.loading", locale), detail: "" };
    case "unavailable":
      return {
        label: modusText("modus.status.unavailable", locale),
        detail: modusText("modus.status.unavailableDetail", locale),
      };
    default:
      return { label: "", detail: "" };
  }
}

export function AccountSettingsPanel({
  modusStatus,
  modusPlan,
}: {
  /** Absent = off (signed out / no Modus provider). */
  modusStatus?: ModusModelsStatus | undefined;
  /** The plan the Modus router grants now (/v1/models `plan`); absent until Modus is ready. */
  modusPlan?: string | undefined;
} = {}) {
  const t = useSettingsText();
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
      setError(t("settings.account.authErrorCheckEmailPassword"));
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

  const signedIn = state?.status === "signed-in" && !!state.user;

  const content = (
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
              {t("settings.account.signOut")}
            </button>
          ) : state ? (
            <span
              className={state.status === "signed-out" ? "sr-only" : "text-xs text-fg-muted"}
              aria-live="polite"
            >
              {accountStatusLabel(state, t)}
            </span>
          ) : null
        }
        title={
          signedIn
            ? t("settings.account.title")
            : mode === "sign-in"
              ? t("settings.account.signInToModus")
              : t("settings.account.createAccount")
        }
      />
      {!signedIn && unavailable ? (
        <SettingsNotice>{t("settings.account.unconfiguredDescription")}</SettingsNotice>
      ) : null}
      {!signedIn && !unavailable && mode === "sign-up" ? (
        <SettingsNotice>
          {t("settings.account.passwordMinLength", { min: AUTH_PASSWORD_MIN_LENGTH })}
        </SettingsNotice>
      ) : null}

      {shownError ? <SettingsNotice tone="danger">{shownError}</SettingsNotice> : null}
      {state?.notice === "session-expired" ? (
        <SettingsNotice role="status" tone="danger">
          {modusText("modus.sessionExpired", t.locale)}
        </SettingsNotice>
      ) : null}
      {state?.notice === "confirm-email" ? (
        <p className="text-success text-xs">{t("settings.account.confirmEmailNotice")}</p>
      ) : null}

      {state?.status === "signed-in" && state.user ? (
        <>
          <SettingsSection title={t("settings.account.profileSectionTitle")}>
            <SettingsList>
              <SettingsRow
                control={<ReadOnlyPill>{state.user.provider}</ReadOnlyPill>}
                notice={state.user.email ?? t("settings.account.noEmail")}
                title={state.user.displayName ?? t("settings.account.profileSignedIn")}
              />
              <SettingsRow
                control={
                  <ReadOnlyPill>
                    {state.user.emailConfirmed
                      ? t("settings.account.emailConfirmed")
                      : t("settings.account.emailPending")}
                  </ReadOnlyPill>
                }
                title={t("settings.account.emailConfirmationTitle")}
              />
              <SettingsRow
                control={
                  <ReadOnlyPill>
                    {state.persistence === "encrypted"
                      ? t("settings.account.persistenceEncrypted")
                      : t("settings.account.persistenceSessionOnly")}
                  </ReadOnlyPill>
                }
                notice={
                  state.persistence === "encrypted"
                    ? undefined
                    : t("settings.account.persistenceSessionOnlyDescription")
                }
                noticeTone="warning"
                title={t("settings.account.rememberMeTitle")}
              />
              {modusStatus && modusStatus !== "off" ? (
                <SettingsRow
                  control={
                    <ReadOnlyPill>{modusStatusText(modusStatus, t.locale).label}</ReadOnlyPill>
                  }
                  notice={modusStatusText(modusStatus, t.locale).detail || undefined}
                  noticeTone="warning"
                  title={modusText("modus.status.title", t.locale)}
                />
              ) : null}
            </SettingsList>
          </SettingsSection>
          <AccountBillingSection accessPlan={modusPlan} />
        </>
      ) : (
        <>
          <form
            className="grid w-full gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Field
              autoComplete="email"
              label={t("settings.account.emailLabel")}
              onChange={setEmail}
              placeholder={t("settings.account.emailPlaceholder")}
              type="email"
              value={email}
            />
            <Field
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              label={t("settings.account.passwordLabel")}
              onChange={setPassword}
              placeholder={t("settings.account.passwordPlaceholder")}
              type="password"
              value={password}
            />
            <div className="grid gap-3">
              <button
                className={PRIMARY_BUTTON}
                disabled={unavailable || busy || waiting || !email || !password}
                type="submit"
              >
                <IconMail size={13} stroke={2} />
                {busy ? (
                  <WorkingText className="text-on-accent">
                    {t("settings.account.working")}
                  </WorkingText>
                ) : mode === "sign-in" ? (
                  t("settings.account.signIn")
                ) : (
                  t("settings.account.createAccount")
                )}
              </button>
              <button
                className="justify-self-center rounded px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
                disabled={busy}
                onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}
                type="button"
              >
                {mode === "sign-in"
                  ? t("settings.account.createAccount")
                  : t("settings.account.backToSignIn")}
              </button>
            </div>
          </form>
          <div className="space-y-4">
            <fieldset className="grid min-w-0 grid-cols-1 gap-2">
              <legend className="sr-only">{t("settings.account.otherSignInMethods")}</legend>
              {AUTH_PROVIDERS.flatMap((provider) =>
                provider.kind === "oauth" ? [provider] : [],
              ).map((provider) => {
                const enabled = state?.oauthProviders.includes(provider.id) ?? false;
                return (
                  <button
                    className={OAUTH_BUTTON}
                    disabled={unavailable || busy || waiting || !enabled}
                    key={provider.id}
                    onClick={() =>
                      void run(() => window.modus.auth.signInWithOAuth({ provider: provider.id }))
                    }
                    title={enabled ? undefined : t("settings.account.oauthNotAvailableYet")}
                    type="button"
                  >
                    {OAUTH_ICONS[provider.id]}
                    {t("settings.account.continueWith", { provider: provider.label })}
                  </button>
                );
              })}
              {state?.status === "awaiting-oauth" ? (
                <button
                  className={`${OAUTH_BUTTON} col-span-full`}
                  onClick={() => void window.modus.auth.cancelOAuth().then(setState)}
                  type="button"
                >
                  {t("settings.account.cancel")}
                </button>
              ) : null}
            </fieldset>
          </div>
        </>
      )}
    </>
  );

  return signedIn ? (
    content
  ) : (
    <div className="mx-auto w-full max-w-[400px] space-y-6 rounded-2xl bg-panel/20 p-5 sm:p-8">
      {content}
    </div>
  );
}
