import { IconAlertTriangle, IconDownload, IconLoader2 } from "@tabler/icons-react";
import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import type { ModusApi } from "../../../../preload/types";
import type { UpdateState } from "../../../../shared/contracts";
import { cn } from "../../lib/cn";
import { SwipeToast, type SwipeToastCloseReason } from "./SwipeToast";
import { type UpdateToastActionId, updateToastContent } from "./updateToastContent";

export type UpdateApi = ModusApi["update"];

/**
 * A new offer's primary button breathes: a soft ring (::after, opacity only, so nothing
 * moves) that stops on hover and focus; opacity only, so it also runs with reduced motion.
 */
export const BREATHE_CLASSES =
  "update-breathe-ring after:animate-update-breathe hover:after:animate-none focus:after:animate-none focus-visible:after:animate-none";
export const UPDATE_TOAST_DURATION_MS = 45_000;

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
  const action = content?.actions[0];
  const description =
    content?.progress !== undefined ? (
      <div className="update-toast-progress">
        <div
          aria-label={content.title}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={content.progress}
          className="update-toast-progress__track"
          role="progressbar"
        >
          <div
            className="update-toast-progress__value motion-reduce:transition-reduced-fade"
            style={{ width: `${content.progress}%` }}
          />
        </div>
        <span className="w-9 text-right text-2xs text-fg-subtle tabular-nums">
          {Math.round(content.progress)}%
        </span>
      </div>
    ) : (
      content?.detail
    );
  return (
    <>
      <p aria-live="polite" className="sr-only" role="status">
        {content?.title ?? ""}
      </p>
      {content ? (
        <SwipeToast
          {...(content.breathe ? { actionClassName: BREATHE_CLASSES } : {})}
          {...(action
            ? {
                actionId: action.id,
                actionLabel: action.label,
                onAction: () => onAction(action.id),
              }
            : {})}
          announce={false}
          background="var(--color-panel)"
          className={cn("popup-chrome update-swipe-toast", className)}
          closeButton={content.dismissible}
          closeLabel="Dismiss update"
          color="var(--color-fg)"
          data-update-status={state.status}
          dismissible={content.dismissible}
          description={description}
          duration={UPDATE_TOAST_DURATION_MS}
          fuse="none"
          icon={
            content.busy ? (
              <IconLoader2 className="animate-spin motion-reduce:animate-pulse" size={13} />
            ) : content.tone === "danger" ? (
              <IconAlertTriangle className="text-danger" size={13} stroke={1.7} />
            ) : (
              <IconDownload size={13} stroke={1.7} />
            )
          }
          inline
          key={`${state.status}:${"version" in state ? state.version : ""}`}
          onClose={(reason: SwipeToastCloseReason) => {
            if (reason === "swipe" || reason === "close" || reason === "escape") {
              onDismiss();
            }
          }}
          pauseOnHover
          reduceMotionOverride={reduceMotion}
          title={content.title}
          width={272}
        />
      ) : null}
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
