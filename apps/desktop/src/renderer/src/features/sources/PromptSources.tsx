import { Popover } from "@base-ui/react/popover";
import { IconInfoCircle } from "@tabler/icons-react";
import { cn } from "../../lib/cn";
import type { RunSource } from "./runSources";

/** Compact per-run source disclosure; raw tool output stays in Activity history. */
export function PromptSources({
  sources,
  onOpenFile,
  className,
}: {
  sources: readonly RunSource[];
  onOpenFile?: ((path: string) => void) | undefined;
  className?: string | undefined;
}) {
  if (sources.length === 0) return null;
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={`Sources (${sources.length})`}
        className={cn(
          "mt-1 inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-2xs text-fg-faint transition-colors hover:bg-hover hover:text-fg-muted",
          className,
        )}
        data-prompt-kit="sources"
        data-testid="prompt-sources-trigger"
        type="button"
      >
        <IconInfoCircle aria-hidden size={13} stroke={1.7} />
        <span>Sources</span>
        <span className="tabular-nums">{sources.length}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="start" side="bottom" sideOffset={5}>
          <Popover.Popup className="popup-chrome popup-motion w-[min(320px,calc(100vw-24px))] p-1 outline-none">
            <div className="px-2 py-1.5 font-medium text-fg-muted text-2xs">Sources used</div>
            <ul aria-label="Sources used in this response" className="max-h-64 overflow-y-auto">
              {sources.map((source) => (
                <li key={source.id}>
                  {source.href ? (
                    <a
                      className="flex min-w-0 items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs text-fg-muted no-underline transition-colors hover:bg-hover hover:text-fg"
                      href={source.href}
                      rel="noopener noreferrer"
                      target="_blank"
                      title={source.href}
                    >
                      <SourceLabel source={source} />
                      <span className="shrink-0 text-fg-faint">Open</span>
                    </a>
                  ) : source.path ? (
                    <button
                      className="flex w-full min-w-0 items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
                      onClick={() => onOpenFile?.(source.path ?? "")}
                      title={source.path}
                      type="button"
                    >
                      <SourceLabel source={source} />
                      <span className="shrink-0 text-fg-faint">File</span>
                    </button>
                  ) : (
                    <div className="flex min-w-0 items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs text-fg-muted">
                      <SourceLabel source={source} />
                      <span className="shrink-0 text-fg-faint">Connection</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SourceLabel({ source }: { source: RunSource }) {
  const kindLabel =
    source.kind === "file"
      ? "File"
      : source.kind === "documentation"
        ? "Documentation"
        : source.kind === "github"
          ? "GitHub"
          : source.kind === "connection"
            ? "Connection"
            : "Web";
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 rounded bg-elevated px-1 py-0.5 text-[9px] text-fg-faint">
        {kindLabel}
      </span>
      <span className="min-w-0 truncate font-medium text-fg">{source.label}</span>
      {source.detail ? (
        <span className="min-w-0 truncate text-fg-faint">{source.detail}</span>
      ) : null}
    </span>
  );
}
