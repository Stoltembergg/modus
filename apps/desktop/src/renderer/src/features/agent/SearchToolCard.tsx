/**
 * Search Tool card — ported and adapted from 21st.dev Agent Elements
 * (`lib/agent-ui/components/tools/search-tool.tsx` + `tool-row-base.tsx`),
 * MIT License, Copyright (c) 2026 21st.dev. See THIRD_PARTY_NOTICES.md at the
 * repo root for the full license text.
 *
 * Modus adaptations: Modus theme tokens, ShinyText (respects reduced motion)
 * instead of the injected shimmer keyframes, CollapsibleMotion instead of the
 * base-ui Collapsible, and file-first results: each row is a FILE with its
 * relative path truncated in the middle (filename stays visible) and the match
 * count / line number on the right. Web results keep title + source. Output
 * that cannot be parsed renders the generic tool row instead (`fallback`).
 */
import { IconChevronRight, IconFileText, IconFolder } from "@tabler/icons-react";
import { memo, type ReactNode, useMemo, useState } from "react";
import { CollapsibleMotion } from "../../components/ui/CollapsibleMotion";
import { ShinyText } from "../../components/ui/ShinyText";
import { cn } from "../../lib/cn";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import {
  type FileSearchResult,
  fileResultMeta,
  middleTruncatePath,
  parseSearchOutput,
  type SearchResultItem,
  searchQuery,
} from "./searchResults";
import { Favicon } from "./toolIcons";

export type SearchToolCardProps = {
  name: string;
  args?: unknown;
  output: string;
  isComplete?: boolean;
  isError?: boolean;
  /** Generic row rendered when the call failed or its output can't be parsed. */
  fallback: ReactNode;
  defaultOpen?: boolean;
};

function resultLabel(count: number): string {
  return `Found ${count} ${count === 1 ? "result" : "results"}`;
}

/**
 * Middle-truncated path: the directory part may shrink further (CSS ellipsis)
 * when the row is narrow, the filename never does.
 */
function PathLabel({ path }: { path: string }) {
  const label = middleTruncatePath(path);
  const cut = label.replace(/\/+$/, "").lastIndexOf("/") + 1;
  const dir = label.slice(0, cut);
  const name = label.slice(cut);
  return (
    <span className="flex min-w-0 flex-1 font-mono text-fg-muted text-xs" data-search-path>
      {dir ? <span className="min-w-0 truncate text-fg-subtle">{dir}</span> : null}
      <span className="shrink-0 whitespace-nowrap">{name}</span>
    </span>
  );
}

function FileRow({ result }: { result: FileSearchResult }) {
  const meta = fileResultMeta(result);
  const isDir = result.path.endsWith("/");
  return (
    <div
      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 hover:bg-hover"
      data-search-row="file"
      title={result.path}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-fg-faint">
        {isDir ? (
          <IconFolder size={ICON.sm} stroke={ICON_STROKE.sm} />
        ) : (
          <IconFileText size={ICON.sm} stroke={ICON_STROKE.sm} />
        )}
      </span>
      <PathLabel path={result.path} />
      {meta ? (
        <span className="shrink-0 whitespace-nowrap text-fg-faint text-xs tabular-nums">
          {meta}
        </span>
      ) : null}
    </div>
  );
}

function ResultRow({ result }: { result: SearchResultItem }) {
  if (result.kind === "file") return <FileRow result={result} />;
  return (
    <div
      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 hover:bg-hover"
      data-search-row="web"
      title={result.url}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-fg-faint">
        <Favicon url={result.url} />
      </span>
      <span className="min-w-0 flex-1 truncate text-fg-muted text-sm">{result.title}</span>
      <span className="shrink-0 whitespace-nowrap text-fg-faint text-xs">{result.source}</span>
    </div>
  );
}

export const SearchToolCard = memo(function SearchToolCard({
  name,
  args,
  output,
  isComplete = false,
  isError = false,
  fallback,
  defaultOpen = false,
}: SearchToolCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const query = searchQuery(name, args);
  const searching = !isComplete && !isError;
  const parsed = useMemo(
    () => (isComplete && !isError ? parseSearchOutput(name, output) : undefined),
    [isComplete, isError, name, output],
  );

  if (searching) {
    return (
      <div className="flex min-w-0 items-center gap-2 py-0.5 text-sm" data-search-state="searching">
        <ShinyText className="shrink-0">
          {name === "web_search" ? "Searching the web…" : "Searching…"}
        </ShinyText>
        {query ? (
          <span className="min-w-0 flex-1 truncate font-mono text-fg-faint text-xs" title={query}>
            {query}
          </span>
        ) : null}
      </div>
    );
  }

  if (!parsed) return <>{fallback}</>;

  const count = parsed.results.length;
  const expandable = count > 0 || Boolean(parsed.notice);
  const bodyOpen = open && expandable;
  const label = resultLabel(count);

  const header = (
    <>
      <span className="shrink-0 font-medium">{label}</span>
      {expandable ? (
        <IconChevronRight
          className={cn(
            "shrink-0 text-fg-faint transition-transform duration-150 ease-out",
            bodyOpen && "rotate-90",
          )}
          size={13}
          stroke={1.7}
        />
      ) : null}
    </>
  );

  return (
    <div className="min-w-0 text-sm" data-search-state="done">
      {expandable ? (
        <button
          aria-expanded={bodyOpen}
          className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md py-0.5 text-left text-fg-subtle transition-colors hover:text-fg-muted"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          {header}
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-1.5 py-0.5 text-fg-subtle">{header}</div>
      )}

      <CollapsibleMotion open={bodyOpen} preset="timeline">
        <div className="mt-1.5 overflow-hidden rounded-md border border-hairline bg-card">
          <div className="flex h-7 min-w-0 items-center gap-1.5 border-hairline border-b px-2.5 text-xs">
            <span className="shrink-0 font-medium text-fg-muted">Searched for</span>
            <span className="min-w-0 truncate font-mono text-fg-subtle" title={query}>
              {query}
            </span>
          </div>
          {count > 0 ? (
            <div className="scroll-thin max-h-[200px] overflow-y-auto">
              <div className="flex flex-col gap-px p-1">
                {parsed.results.map((result) => (
                  <ResultRow
                    key={result.kind === "file" ? result.path : result.url}
                    result={result}
                  />
                ))}
              </div>
            </div>
          ) : null}
          {parsed.notice ? (
            <div className="border-hairline border-t px-2.5 py-1.5 text-fg-faint text-xs">
              {parsed.notice}
            </div>
          ) : null}
        </div>
      </CollapsibleMotion>
    </div>
  );
});
