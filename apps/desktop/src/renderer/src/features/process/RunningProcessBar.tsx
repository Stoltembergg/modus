import { IconAppWindow, IconTerminal2, IconTrash } from "@tabler/icons-react";
import { useRef, useState } from "react";
import type { ManagedProcessInfo } from "../../../../shared/contracts";
import { formatElapsed } from "../../../../shared/managed-process";
import { cn } from "../../lib/cn";
import { ComposerRail } from "../composer/ComposerRail";
import { requestManagedProcessStop } from "./processStopRequest";

/**
 * Background-terminal rail in the independent status card above the composer
 * (Cursor: "N background terminal(s)"). Pure view over a running-process list —
 * scope/filtering stays with the caller.
 */
export function RunningProcessBar({
  processes,
  nowMs,
  onStop,
  onStopError,
  onStopSuccess,
  onOpenTerminal,
}: {
  processes: ManagedProcessInfo[];
  nowMs: number;
  onStop(id: string): Promise<boolean>;
  onStopError?(id: string, message: string): void;
  onStopSuccess?(id: string): void;
  /** Open the inspector Terminal tab and select this process (terminal ids only). */
  onOpenTerminal?(terminalId: string): void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!processes || processes.length === 0) {
    return null;
  }

  const label = `${processes.length} background ${
    processes.length === 1 ? "terminal" : "terminals"
  }`;

  return (
    <ComposerRail expanded={expanded} label={label} onExpandedChange={setExpanded}>
      <ul className="flex flex-col">
        {processes.map((process) => (
          <ProcessRow
            key={process.id}
            nowMs={nowMs}
            onOpenTerminal={onOpenTerminal}
            onStop={onStop}
            onStopError={onStopError}
            onStopSuccess={onStopSuccess}
            process={process}
          />
        ))}
      </ul>
    </ComposerRail>
  );
}

function ProcessRow({
  process,
  nowMs,
  onStop,
  onStopError,
  onStopSuccess,
  onOpenTerminal,
}: {
  process: ManagedProcessInfo;
  nowMs: number;
  onStop: (id: string) => Promise<boolean>;
  onStopError?: ((id: string, message: string) => void) | undefined;
  onStopSuccess?: ((id: string) => void) | undefined;
  onOpenTerminal?: ((terminalId: string) => void) | undefined;
}) {
  const [stopError, setStopError] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const stopInFlight = useRef(false);
  const elapsed = formatElapsed(nowMs - Date.parse(process.startedAt));
  const isTerminal = process.kind === "terminal";
  const canOpen = isTerminal && Boolean(onOpenTerminal);
  const Icon = isTerminal ? IconTerminal2 : IconAppWindow;

  return (
    <li
      className={cn(
        "group/row flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5",
        canOpen && "cursor-pointer hover:bg-hover",
      )}
      onClick={canOpen ? () => onOpenTerminal?.(process.id) : undefined}
      onKeyDown={
        canOpen
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpenTerminal?.(process.id);
              }
            }
          : undefined
      }
      role={canOpen ? "button" : undefined}
      tabIndex={canOpen ? 0 : undefined}
    >
      <Icon className="shrink-0 text-fg-faint" size={15} stroke={1.7} />
      <span
        className="min-w-0 flex-1 truncate text-sm text-fg-subtle transition-colors group-hover/row:text-fg"
        title={process.label}
      >
        {process.label}
      </span>
      <span className="shrink-0 font-mono text-xs text-fg-faint tabular-nums transition-colors group-hover/row:text-fg-muted">
        {elapsed}
      </span>
      <button
        aria-label={`Stop ${process.label}`}
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-md text-fg-faint opacity-0 transition-[opacity,color]",
          "hover:text-danger group-hover/row:opacity-100",
        )}
        onClick={(event) => {
          event.stopPropagation();
          if (stopInFlight.current) return;
          stopInFlight.current = true;
          setStopping(true);
          void requestManagedProcessStop(
            onStop,
            process.id,
            (id, message) => {
              const labeledMessage = `${process.label}: ${message}`;
              if (onStopError) {
                onStopError(id, labeledMessage);
              } else {
                setStopError(labeledMessage);
              }
            },
            (id) => {
              setStopError(undefined);
              onStopSuccess?.(id);
            },
          ).finally(() => {
            stopInFlight.current = false;
            setStopping(false);
          });
        }}
        onMouseDown={(event) => event.preventDefault()}
        disabled={stopping}
        tabIndex={-1}
        type="button"
      >
        <IconTrash size={13} stroke={1.8} />
      </button>
      {stopError ? (
        <span className="basis-full text-xs text-danger" role="alert">
          {stopError}
        </span>
      ) : null}
    </li>
  );
}
