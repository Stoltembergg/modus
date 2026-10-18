import { useEffect, useState } from "react";
import {
  DEFAULT_TOOL_FILTER_STATE,
  type ToolFilterModel,
  type ToolFilterState,
  type ToolFilterUnavailableReason,
} from "../../../../shared/tool-filter";
import { useSettingsText } from "../../lib/settingsText";
import { SwitchControl } from "./form-controls";
import { SettingsRow } from "./settings-layout";

function formatMb(bytes: number, locale?: string): string {
  const mb = Math.round(bytes / 1e6);
  return new Intl.NumberFormat(locale || undefined, { maximumFractionDigits: 0 }).format(mb);
}

export function ToolFilterSetting() {
  const t = useSettingsText();
  const [state, setState] = useState<ToolFilterState>(DEFAULT_TOOL_FILTER_STATE);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const api = window.modus?.app?.toolFilter;
    if (!api) return;
    let active = true;
    api
      .get()
      .then((initialState: ToolFilterState) => {
        if (active) setState(initialState);
      })
      .catch((err: unknown) => {
        console.warn("[modus] Failed to get tool filter state", err);
      });

    const unsubscribe = api.onChange((nextState: ToolFilterState) => {
      if (active) setState(nextState);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function handleEnable(): Promise<void> {
    const api = window.modus?.app?.toolFilter;
    if (!api) return;
    setBusy(true);
    try {
      const next = await api.enable();
      setState(next);
    } catch (err) {
      console.warn("[modus] Failed to enable tool filter", err);
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable(): Promise<void> {
    const api = window.modus?.app?.toolFilter;
    if (!api) return;
    setBusy(true);
    try {
      const next = await api.disable();
      setState(next);
    } catch (err) {
      console.warn("[modus] Failed to disable tool filter", err);
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelDownload(): Promise<void> {
    const api = window.modus?.app?.toolFilter;
    if (!api) return;
    setBusy(true);
    try {
      const next = await api.cancelDownload();
      setState(next);
    } catch (err) {
      console.warn("[modus] Failed to cancel tool filter download", err);
    } finally {
      setBusy(false);
    }
  }

  function handleToggle(checked: boolean): void {
    // No confirmation: turning it on enables and starts the background download/load.
    if (checked) {
      void handleEnable();
    } else {
      void handleDisable();
    }
  }

  function getUnavailableText(reason: ToolFilterUnavailableReason): string {
    switch (reason) {
      case "intel-mac":
        return t("settings.toolFilter.unavailableIntelMac");
      case "vc-runtime-missing":
        return t("settings.toolFilter.unavailableVcRuntimeMissing");
      case "runtime-load-failed":
        return t("settings.toolFilter.unavailableRuntimeLoadFailed");
      default:
        return t("settings.toolFilter.unavailableUnsupportedPlatform");
    }
  }

  function getModelStatusText(model: ToolFilterModel): string {
    switch (model) {
      case "starting":
        return t("settings.toolFilter.modelStarting");
      case "ready":
        return t("settings.toolFilter.modelReady");
      case "failed":
        return t("settings.toolFilter.modelFailed");
      case "stopped":
        return t("settings.toolFilter.modelStopped");
    }
  }

  const title = t("settings.toolFilter.title");
  const isAvailable = state.availability.available;
  const isBridgeAvailable = typeof window !== "undefined" && Boolean(window.modus?.app?.toolFilter);

  let downloadPercent = 0;
  let receivedFormatted = "0";
  let totalFormatted = "0";
  if (state.download.phase === "downloading") {
    receivedFormatted = formatMb(state.download.receivedBytes, t.locale);
    totalFormatted = formatMb(state.download.totalBytes, t.locale);
    downloadPercent =
      state.download.totalBytes > 0
        ? Math.min(
            100,
            Math.max(
              0,
              Math.round((state.download.receivedBytes / state.download.totalBytes) * 100),
            ),
          )
        : 0;
  }

  return (
    <>
      <SettingsRow
        control={
          <SwitchControl
            ariaLabel={title}
            checked={state.enabled}
            disabled={!isAvailable || !isBridgeAvailable || busy}
            onCheckedChange={handleToggle}
          />
        }
        notice={
          !isAvailable
            ? getUnavailableText(state.availability.reason)
            : state.enabled && state.download.phase === "ready" && state.model === "failed"
              ? getModelStatusText(state.model)
              : undefined
        }
        noticeTone={isAvailable ? "danger" : "muted"}
        title={title}
      />
      <div className="px-3 empty:hidden" data-tool-filter-progress="">
        {isAvailable && state.download.phase === "downloading" ? (
          <div className="flex flex-col gap-2 pb-2.5">
            <div
              aria-label={title}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={downloadPercent}
              className="h-1.5 w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)]"
              role="progressbar"
            >
              <div
                className="h-full rounded-full bg-[var(--color-accent)] transition-all duration-(--motion-duration-base)"
                style={{ width: `${downloadPercent}%` }}
              />
            </div>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-fg-muted">
                {t("settings.toolFilter.downloadProgress", {
                  received: receivedFormatted,
                  total: totalFormatted,
                  percent: downloadPercent,
                })}
              </span>
              <button
                className="text-xs text-fg-muted outline-none transition-colors hover:text-fg"
                onClick={() => void handleCancelDownload()}
                type="button"
              >
                {t("settings.toolFilter.cancelDownloadButton")}
              </button>
            </div>
          </div>
        ) : null}

        {isAvailable && state.download.phase === "verifying" ? (
          <div className="flex flex-col gap-2 pb-2.5">
            <div
              aria-label={t("settings.toolFilter.verifying")}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={100}
              className="h-1.5 w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)]"
              role="progressbar"
            >
              <div className="h-full w-full rounded-full bg-[var(--color-accent)] animate-pulse" />
            </div>
            <span className="text-xs text-fg-muted">{t("settings.toolFilter.verifying")}</span>
          </div>
        ) : null}

        {isAvailable && state.download.phase === "failed" ? (
          <div className="flex items-center justify-between gap-3 pb-2.5 text-xs">
            <span className="text-xs text-danger">
              {state.download.error === "hash-mismatch"
                ? t("settings.toolFilter.failedHashMismatch")
                : t("settings.toolFilter.failedDownloadFailed")}
            </span>
            {state.download.error === "download-failed" ? (
              <button
                className="shrink-0 text-xs text-[var(--accent-text)] outline-none transition-colors hover:underline"
                onClick={() => void handleEnable()}
                type="button"
              >
                {t("settings.toolFilter.retryButton")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
