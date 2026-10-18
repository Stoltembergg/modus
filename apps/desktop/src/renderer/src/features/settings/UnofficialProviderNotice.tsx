import { IconAlertTriangle } from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import { cn } from "../../lib/cn";
import { useSettingsText } from "../../lib/settingsText";

/**
 * Compact, in-detail reminder that stays visible while Antigravity is
 * configured. The text is deliberately grounded in the upstream warning and
 * does not promise safety, legality, or support.
 */
export function UnofficialProviderNotice({ className }: { className?: string }) {
  const t = useSettingsText();
  return (
    <section
      aria-label={t("settings.providers.unofficialProviderWarningAria")}
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-warning/35 bg-warning/8 px-3 py-3",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-warning">
        <IconAlertTriangle aria-hidden size={14} stroke={1.8} />
        <span className="font-medium text-xs uppercase tracking-wide">
          {t("settings.providers.unofficialProvider")}
        </span>
      </div>
      <p className="text-xs leading-5 text-warning/95">
        {t("settings.providers.unofficialEndpointsNotice")}
      </p>
      <p className="text-xs leading-5 text-fg-muted">
        {t("settings.providers.upstreamWarningNotice")}
      </p>
    </section>
  );
}

/**
 * Interstitial that gates the start of Antigravity OAuth. The user must
 * explicitly tick the risk acknowledgement before the primary action enables;
 * cancellation closes without starting OAuth or persisting credentials. The
 * confirmed path forwards `riskAcknowledged: true` to the preload layer, which
 * the main process enforces independently.
 */
export function UnofficialProviderRiskInterstitial({
  busy,
  checked,
  onChange,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  checked: boolean;
  onChange(checked: boolean): void;
  onConfirm(): void;
  onCancel(): void;
}) {
  const t = useSettingsText();
  // Defensive local state ensures checkbox behaviour even when the parent
  // does not bounce state back through this render path.
  const [localChecked, setLocalChecked] = useState(checked);
  const value = localChecked;
  const setValue = (next: boolean) => {
    setLocalChecked(next);
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="grid gap-1.5">
        <h3 className="text-md font-normal text-fg">
          {t("settings.providers.antigravityRiskAcknowledgement")}
        </h3>
        <p className="text-xs text-fg-faint">{t("settings.providers.antigravityRiskReview")}</p>
      </header>

      <section className="grid gap-3 rounded-lg border border-hairline bg-surface/45 p-3">
        <p className="text-sm text-fg">
          {t("settings.providers.antigravityEndpointsReverseEngineer")}
        </p>
        <p className="text-xs leading-5 text-fg-muted">
          {t("settings.providers.upstreamWarningTerms")}
        </p>
        <p className="text-xs leading-5 text-fg-muted">
          {t("settings.providers.modusGuaranteeDisclaimer")}
        </p>
      </section>

      <label className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-md border border-hairline bg-canvas/70 px-3 py-2.5 text-sm text-fg transition-colors hover:border-hairline-strong">
        <input
          aria-label={t("settings.providers.acknowledgeAntigravityRiskAria")}
          checked={value}
          className="mt-0.5 size-4 cursor-pointer accent-fg"
          data-testid="unofficial-provider-acknowledge"
          disabled={busy}
          onChange={(event) => setValue(event.target.checked)}
          type="checkbox"
        />
        <span className="grid gap-1">
          <span>{t("settings.providers.acknowledgeTermsLabel")}</span>
          <span className="text-2xs text-fg-muted">
            {t("settings.providers.modusGuaranteeAccountWarning")}
          </span>
        </span>
      </label>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          aria-label={t("settings.providers.cancelAntigravitySignIn")}
          className="h-9 rounded-md px-3 text-sm text-fg-faint transition-colors hover:bg-hover hover:text-fg"
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          {t("settings.providers.cancel")}
        </button>
        <button
          aria-label={t("settings.providers.startAntigravityOAuthAria")}
          className="flex h-9 items-center justify-center rounded-md bg-fg px-3 text-sm text-canvas transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || !value}
          onClick={onConfirm}
          type="button"
        >
          {t("settings.providers.continueToSignIn")}
        </button>
      </div>
    </div>
  );
}

/**
 * Compact badge + tooltip used in the Antigravity row before sign-in, so users
 * see the warning before they pick "Connect". The same tooltip stays attached
 * to the row while configured.
 */
export function UnofficialProviderMark({ children }: { children: ReactNode }) {
  const t = useSettingsText();
  return (
    <span
      aria-label={t("settings.providers.unofficialProvider")}
      className="ml-1 inline-flex items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-2xs font-medium text-warning"
      role="img"
      title={t("settings.providers.unofficialEndpointsTooltip")}
    >
      <IconAlertTriangle aria-hidden size={11} stroke={1.8} />
      {children ?? t("settings.providers.unofficial")}
    </span>
  );
}
