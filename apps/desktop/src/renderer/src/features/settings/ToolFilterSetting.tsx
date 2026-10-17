import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useState } from "react";
import {
  DEFAULT_TOOL_FILTER_STATE,
  type ToolFilterModel,
  type ToolFilterState,
  type ToolFilterUnavailableReason,
} from "../../../../shared/tool-filter";
import { cn } from "../../lib/cn";
import { useSettingsText } from "../../lib/settingsText";
import { SwitchControl } from "./form-controls";

function formatMb(bytes: number, locale?: string): string {
  const mb = Math.round(bytes / 1e6);
  return new Intl.NumberFormat(locale || undefined, { maximumFractionDigits: 0 }).format(mb);
}

export function ToolFilterSetting() {
  const t = useSettingsText();
  const [state, setState] = useState<ToolFilterState>(DEFAULT_TOOL_FILTER_STATE);
  const [confirmOpen, setConfirmOpen] = useState(false);
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
    if (checked) {
      setConfirmOpen(true);
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

  const downloadBytesFormatted = formatMb(state.downloadBytes, t.locale);
  const partialBytesFormatted = formatMb(state.partialBytes, t.locale);

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
    <section className="mt-6 rounded-lg bg-panel px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-md font-normal text-fg">{title}</h3>
          <p className="mt-1 text-xs text-fg-faint">{t("settings.toolFilter.desc")}</p>
          {!isAvailable ? (
            <p className="mt-1 text-xs text-fg-muted">
              {getUnavailableText(state.availability.reason)}
            </p>
          ) : null}
          {isAvailable && state.enabled && state.download.phase === "ready" ? (
            <p className="mt-1 text-xs text-fg-muted">{getModelStatusText(state.model)}</p>
          ) : null}
        </div>
        <SwitchControl
          ariaLabel={title}
          checked={state.enabled}
          disabled={!isAvailable || !isBridgeAvailable || busy}
          onCheckedChange={handleToggle}
        />
      </div>

      {isAvailable && state.download.phase === "downloading" ? (
        <div className="mt-3 flex flex-col gap-2">
          <div
            aria-label={title}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={downloadPercent}
            className="h-1.5 w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)]"
            role="progressbar"
          >
            <div
              className="h-full rounded-full bg-[var(--color-accent)] transition-all duration-150"
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
        <div className="mt-3 flex flex-col gap-2">
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
        <div className="mt-2 flex items-center justify-between gap-3 text-xs">
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

      <Dialog.Root
        onOpenChange={(open) => {
          if (!open) setConfirmOpen(false);
        }}
        open={confirmOpen}
      >
        <Dialog.Portal>
          <Dialog.Backdrop
            className={cn(
              "fixed inset-0 z-50 bg-black/50 transition-opacity duration-150 ease-out-quint motion-reduce:transition-none",
              "data-ending-style:opacity-0 data-starting-style:opacity-0",
            )}
          />
          <Dialog.Popup
            className={cn(
              "-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-50 w-[min(440px,calc(100vw-2rem))]",
              "origin-center overflow-hidden popup-chrome surface-glass rounded-lg p-5 outline-none",
              "transition-[transform,opacity,scale] duration-150 ease-out-quint motion-reduce:transition-none",
              "data-ending-style:scale-[0.96] data-ending-style:opacity-0",
              "data-starting-style:scale-[0.96] data-starting-style:opacity-0",
            )}
          >
            <Dialog.Title className="font-medium text-fg text-sm">
              {t("settings.toolFilter.confirmTitle")}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-xs leading-relaxed text-fg-muted">
              {t("settings.toolFilter.confirmDesc", { size: downloadBytesFormatted })}
            </Dialog.Description>
            {state.partialBytes > 0 ? (
              <p className="mt-2 text-xs leading-relaxed text-fg-muted">
                {t("settings.toolFilter.resumeLine", { size: partialBytesFormatted })}
              </p>
            ) : null}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                className="h-8 rounded-md px-3 text-xs text-fg-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus-ring/35"
                onClick={() => setConfirmOpen(false)}
                type="button"
              >
                {t("settings.toolFilter.cancelButton")}
              </button>
              <button
                className="h-8 rounded-md bg-[var(--color-accent)] px-3 text-xs font-medium text-white shadow-sm outline-none transition-[background-color,opacity] hover:brightness-110 active:brightness-95 focus-visible:ring-2 focus-visible:ring-focus-ring/35"
                onClick={() => {
                  setConfirmOpen(false);
                  void handleEnable();
                }}
                type="button"
              >
                {t("settings.toolFilter.confirmButton")}
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
