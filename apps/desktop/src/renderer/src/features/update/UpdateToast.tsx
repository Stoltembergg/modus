import { IconAlertTriangle, IconDownload, IconLoader2, IconX } from "@tabler/icons-react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import type { ModusApi } from "../../../../preload/types";
import type { UpdateState } from "../../../../shared/contracts";
import { cn } from "../../lib/cn";
import { type UpdateToastActionId, updateToastContent } from "./updateToastContent";

export type UpdateApi = ModusApi["update"];

const IDLE: UpdateState = { status: "idle" };

/**
 * Follows the update service: pushes win over the initial `getState()` reply (a push is
 * always newer), and nothing is delivered after the returned cleanup runs.
 */
export function subscribeToUpdateState(
  api: Pick<UpdateApi, "getState" | "onStateChange">,
  onState: (state: UpdateState) => void,
): () => void {
  let active = true;
  let pushed = false;
  const unsubscribe = api.onStateChange((state) => {
    pushed = true;
    if (active) onState(state);
  });
  api
    .getState()
    .then((state) => {
      if (active && !pushed) onState(state);
    })
    .catch(() => undefined);
  return () => {
    active = false;
    unsubscribe();
  };
}

export function useUpdateState(api: UpdateApi | undefined): UpdateState {
  const [state, setState] = useState<UpdateState>(IDLE);
  useEffect(() => (api ? subscribeToUpdateState(api, setState) : undefined), [api]);
  return state;
}

/** Runs the service method behind a toast button; failures are the service's to report. */
export function runUpdateAction(api: UpdateApi, id: UpdateToastActionId | "dismiss"): void {
  void api[id]().catch(() => undefined);
}

/**
 * Presentational update notice (no hooks, so tests can render it directly). A
 * visually hidden live region is always mounted so every new title is announced once,
 * without the download percent.
 */
export function UpdateToastView({
  state,
  onAction,
  onDismiss,
  className,
  reduceMotion = false,
}: {
  state: UpdateState;
  onAction: (id: UpdateToastActionId) => void;
  onDismiss: () => void;
  className?: string;
  reduceMotion?: boolean;
}) {
  const content = updateToastContent(state);
  return (
    <>
      <p aria-live="polite" className="sr-only" role="status">
        {content?.title ?? ""}
      </p>
      <AnimatePresence>
        {content ? (
          <m.section
            animate={{ opacity: 1, y: 0 }}
            aria-label="App update"
            className={cn(
              "w-[272px] max-w-[calc(100%-24px)] rounded-lg border border-popup-border bg-elevated px-2.5 py-2 text-fg shadow-popup",
              className,
            )}
            data-update-status={state.status}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            initial={reduceMotion ? false : { opacity: 0, y: -4 }}
            key="update-toast"
            transition={{ duration: reduceMotion ? 0 : 0.14, ease: "easeOut" }}
          >
            <div className="flex items-start gap-2">
              <span
                aria-hidden
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center",
                  content.tone === "danger" ? "text-danger" : "text-fg-subtle",
                )}
              >
                {content.busy ? (
                  <IconLoader2 className="animate-spin motion-reduce:animate-none" size={13} />
                ) : content.tone === "danger" ? (
                  <IconAlertTriangle size={13} stroke={1.7} />
                ) : (
                  <IconDownload size={13} stroke={1.7} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-fg text-xs leading-4">{content.title}</p>
                {content.detail ? (
                  <p className="mt-0.5 text-2xs text-fg-subtle leading-4">{content.detail}</p>
                ) : null}
              </div>
              {content.dismissible ? (
                <button
                  aria-label="Dismiss update"
                  className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded-md text-fg-faint outline-none transition-colors hover:bg-hover hover:text-fg-subtle focus-visible:ring-2 focus-visible:ring-focus-ring/35"
                  onClick={onDismiss}
                  title="Dismiss"
                  type="button"
                >
                  <IconX size={12} stroke={1.7} />
                </button>
              ) : null}
            </div>
            {content.progress !== undefined ? (
              <div className="mt-2 flex items-center gap-2 pl-6">
                <div
                  aria-label={content.title}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={content.progress}
                  className="h-1 flex-1 overflow-hidden rounded-full bg-chip-strong"
                  role="progressbar"
                >
                  <div
                    className="h-full rounded-full bg-build transition-[width] duration-200 motion-reduce:transition-none"
                    style={{ width: `${content.progress}%` }}
                  />
                </div>
                <span className="w-9 text-right text-2xs text-fg-subtle tabular-nums">
                  {Math.round(content.progress)}%
                </span>
              </div>
            ) : null}
            {content.actions.length > 0 ? (
              <div className="mt-2 flex justify-end gap-1.5">
                {content.actions.map((action, index) => (
                  <button
                    className={cn(
                      "h-6 rounded-md px-2 font-medium text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring/35",
                      // Quiet by design: a neutral chip, not a bright primary button.
                      index === 0
                        ? "border border-hairline-strong bg-chip text-fg hover:bg-chip-strong"
                        : "text-fg-muted hover:bg-hover hover:text-fg",
                    )}
                    data-update-action={action.id}
                    key={action.id}
                    onClick={() => onAction(action.id)}
                    type="button"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </m.section>
        ) : null}
      </AnimatePresence>
    </>
  );
}

/** Update notice driven by `window.modus.update`; renders nothing while idle/checking. */
export function UpdateToast({
  api,
  className,
}: {
  /** `window.modus.update`; without it (no preload) nothing renders. */
  api: UpdateApi | undefined;
  className?: string;
}) {
  const state = useUpdateState(api);
  const reduceMotion = useReducedMotion() ?? false;
  if (!api) return null;
  return (
    <UpdateToastView
      onAction={(id) => runUpdateAction(api, id)}
      onDismiss={() => runUpdateAction(api, "dismiss")}
      reduceMotion={reduceMotion}
      state={state}
      {...(className ? { className } : {})}
    />
  );
}
