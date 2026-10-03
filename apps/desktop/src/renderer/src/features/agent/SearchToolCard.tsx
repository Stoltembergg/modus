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
 *
 * C2.1: file rows are buttons that open the file in the Files panel at the
 * first match; a file with several matches expands (chevron, or →/←) to one
 * mono line per match, each opening at its own line. ↑/↓/Home/End move a
 * roving focus across the visible rows and match lines. Paths are joined with
 * the tool's `path` arg and contained in the session cwd (`searchResultPath`);
 * a result outside the workspace renders as a disabled row.
 */
import { IconChevronRight, IconFileText, IconFolder } from "@tabler/icons-react";
import {
  type KeyboardEvent,
  memo,
  type ReactNode,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { CollapsibleMotion } from "../../components/ui/CollapsibleMotion";
import { ShinyText } from "../../components/ui/ShinyText";
import { cn } from "../../lib/cn";
import { ICON, ICON_STROKE } from "../../lib/uiDensity";
import { type FilesTextFn, useFilesText } from "../files/filesI18n";
import { resolveSearchResultTarget, type SearchResultTarget } from "./searchResultPath";
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
  /** Session cwd (workspace root): rows resolve and are contained in it. */
  cwd?: string | undefined;
  /** Opens a workspace file, optionally at a line. Without it rows are static. */
  onOpenFile?: ((path: string, line?: number) => void) | undefined;
  /** Room / UI locale tag; falls back to the room context, then the renderer locale (C6.1). */
  locale?: string | undefined;
};

/** Focus ring shared by every focusable row / match line (Modus focus token). */
const NAV_FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/35 focus-visible:ring-inset";

const NAV_SELECTOR = "[data-search-nav]:not(:disabled)";

/**
 * Roving focus across the visible rows and expanded match lines: ↑/↓ move,
 * Home/End jump. Exactly one item is in the tab order (the last focused one,
 * else the first). Items are found in DOM order, so collapsed matches (not
 * rendered) are skipped automatically.
 */
function useRovingList() {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [activeKey, setActiveKey] = useState<string | undefined>();

  const items = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>(NAV_SELECTOR) ?? []);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const list = Array.from(listRef.current?.querySelectorAll<HTMLElement>(NAV_SELECTOR) ?? []);
    if (list.length === 0) return;
    const index = list.indexOf(document.activeElement as HTMLElement);
    let next = index;
    if (event.key === "ArrowDown") next = index < 0 ? 0 : Math.min(list.length - 1, index + 1);
    if (event.key === "ArrowUp") next = index < 0 ? 0 : Math.max(0, index - 1);
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = list.length - 1;
    event.preventDefault();
    const target = list[next];
    if (target) {
      setActiveKey(target.dataset.navKey);
      target.focus();
    }
  }, []);

  /** tabIndex for an item: 0 for the active one (or the first when none is). */
  const tabIndexFor = (key: string, firstKey: string | undefined) => {
    const current = items().some((item) => item.dataset.navKey === activeKey)
      ? activeKey
      : firstKey;
    return key === current ? 0 : -1;
  };

  return { listRef, onKeyDown, setActiveKey, tabIndexFor };
}

type Roving = ReturnType<typeof useRovingList>;

/** The search tool's `path` argument (where it ran), if any. */
function searchPathArg(args: unknown): string | undefined {
  const path = args && typeof args === "object" ? (args as { path?: unknown }).path : undefined;
  return typeof path === "string" && path.trim() ? path : undefined;
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

function FileIcon({ isDir }: { isDir: boolean }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center text-fg-faint">
      {isDir ? (
        <IconFolder size={ICON.sm} stroke={ICON_STROKE.sm} />
      ) : (
        <IconFileText size={ICON.sm} stroke={ICON_STROKE.sm} />
      )}
    </span>
  );
}

function FileRow({
  result,
  target,
  navKey,
  firstKey,
  roving,
  onOpen,
  t,
}: {
  t: FilesTextFn;
  result: FileSearchResult;
  target: SearchResultTarget;
  navKey: string;
  firstKey: string | undefined;
  roving: Roving;
  onOpen?: ((path: string, line?: number) => void) | undefined;
}) {
  const meta = fileResultMeta(result, t.locale);
  const isDir = result.path.endsWith("/");
  const matchLines = result.matchLines ?? [];
  const expandable = matchLines.length > 1;
  const [expanded, setExpanded] = useState(false);
  const matchesId = useId();
  // Directories (find) never open; without an opener the row stays static.
  const interactive = Boolean(onOpen) && !isDir && target.kind !== "unavailable";
  const outside = interactive && target.kind === "outside";
  const open = (line?: number) => {
    if (!onOpen || target.kind !== "open") return;
    // No line (find results): call with the path only, like every other caller.
    if (line === undefined) onOpen(target.path);
    else onOpen(target.path, line);
  };

  const content = (
    <>
      <FileIcon isDir={isDir} />
      <PathLabel path={result.path} />
      {outside ? (
        <span className="shrink-0 whitespace-nowrap text-fg-faint text-xs">
          {t("search.outsideWorkspace")}
        </span>
      ) : meta ? (
        <span className="shrink-0 whitespace-nowrap text-fg-faint text-xs tabular-nums">
          {meta}
        </span>
      ) : null}
    </>
  );

  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!expandable) return;
    if (event.key === "ArrowRight" && !expanded) {
      event.preventDefault();
      setExpanded(true);
    } else if (event.key === "ArrowLeft" && expanded) {
      event.preventDefault();
      setExpanded(false);
    }
  };

  return (
    <div className="min-w-0">
      <div
        className="flex min-w-0 items-center gap-0.5 rounded-md hover:bg-hover"
        data-search-row="file"
        title={
          outside
            ? t("search.outsideTitle", {
                path: target.kind === "outside" ? target.path : result.path,
              })
            : result.path
        }
      >
        {interactive ? (
          <button
            aria-label={
              outside
                ? t("search.outsideLabel", { path: result.path })
                : result.line !== undefined
                  ? t("search.openAtLine", { path: result.path, line: result.line })
                  : t("search.open", { path: result.path })
            }
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left",
              NAV_FOCUS,
              outside && "cursor-not-allowed opacity-60",
            )}
            data-nav-key={navKey}
            data-search-nav=""
            data-search-open="file"
            disabled={outside}
            onClick={() => open(result.line)}
            onFocus={() => roving.setActiveKey(navKey)}
            onKeyDown={onRowKeyDown}
            tabIndex={roving.tabIndexFor(navKey, firstKey)}
            type="button"
          >
            {content}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1">{content}</div>
        )}
        {expandable ? (
          <button
            aria-controls={matchesId}
            aria-expanded={expanded}
            aria-label={t.plural(
              expanded ? "search.hideMatches" : "search.showMatches",
              matchLines.length,
              { path: result.path },
            )}
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-md text-fg-faint transition-colors hover:text-fg-muted",
              NAV_FOCUS,
            )}
            data-search-expand=""
            onClick={() => setExpanded((value) => !value)}
            // Keyboard users expand from the row (→/←); the chevron stays a mouse
            // target out of the tab order so the list keeps one tab stop.
            tabIndex={interactive && !outside ? -1 : 0}
            type="button"
          >
            <IconChevronRight
              className={cn("transition-transform duration-150 ease-out", expanded && "rotate-90")}
              size={13}
              stroke={1.7}
            />
          </button>
        ) : null}
      </div>
      {expandable && expanded ? (
        <div
          className="flex flex-col gap-px pt-px pb-0.5 pl-6"
          data-search-matches=""
          id={matchesId}
        >
          {matchLines.map((match, index) => {
            const key = `${navKey}:${match.line}:${index}`;
            const lineContent = (
              <>
                <span className="w-9 shrink-0 text-right text-fg-faint tabular-nums">
                  {match.line}
                </span>
                <span className="min-w-0 flex-1 truncate whitespace-pre font-mono text-fg-muted">
                  {match.text}
                </span>
              </>
            );
            return interactive && !outside ? (
              <button
                aria-label={t("search.openMatch", {
                  path: result.path,
                  line: match.line,
                  text: match.text,
                })}
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-md px-2 py-0.5 text-left font-mono text-xs hover:bg-hover",
                  NAV_FOCUS,
                )}
                data-nav-key={key}
                data-search-nav=""
                data-search-open="match"
                key={key}
                onClick={() => open(match.line)}
                onFocus={() => roving.setActiveKey(key)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft") return;
                  event.preventDefault();
                  setExpanded(false);
                  roving.setActiveKey(navKey);
                  requestAnimationFrame(() =>
                    roving.listRef.current
                      ?.querySelector<HTMLElement>(`[data-nav-key="${CSS.escape(navKey)}"]`)
                      ?.focus(),
                  );
                }}
                tabIndex={roving.tabIndexFor(key, firstKey)}
                title={match.text}
                type="button"
              >
                {lineContent}
              </button>
            ) : (
              <div
                className="flex min-w-0 items-center gap-2 px-2 py-0.5 font-mono text-xs"
                data-search-match=""
                key={key}
                title={match.text}
              >
                {lineContent}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function WebRow({ result }: { result: Extract<SearchResultItem, { kind: "web" }> }) {
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
  cwd,
  onOpenFile,
  locale,
}: SearchToolCardProps) {
  const t = useFilesText(locale);
  const [open, setOpen] = useState(defaultOpen);
  const roving = useRovingList();
  const query = searchQuery(name, args, t.locale);
  const searching = !isComplete && !isError;
  const parsed = useMemo(
    () => (isComplete && !isError ? parseSearchOutput(name, output) : undefined),
    [isComplete, isError, name, output],
  );

  if (searching) {
    return (
      <div className="flex min-w-0 items-center gap-2 py-0.5 text-sm" data-search-state="searching">
        <ShinyText className="shrink-0">
          {name === "web_search" ? t("search.searchingWeb") : t("search.searching")}
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
  const searchPath = searchPathArg(args);
  // First openable row: the default tab stop of the roving list.
  const firstNavKey = onOpenFile
    ? parsed.results.find(
        (result) =>
          result.kind === "file" &&
          !result.path.endsWith("/") &&
          resolveSearchResultTarget({ cwd, searchPath, resultPath: result.path }).kind === "open",
      )
    : undefined;
  const firstKey =
    firstNavKey && firstNavKey.kind === "file" ? `file:${firstNavKey.path}` : undefined;
  const expandable = count > 0 || Boolean(parsed.notice);
  const bodyOpen = open && expandable;
  const label = t.plural("search.found", count);

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
            <span className="shrink-0 font-medium text-fg-muted">{t("search.searchedFor")}</span>
            <span className="min-w-0 truncate font-mono text-fg-subtle" title={query}>
              {query}
            </span>
          </div>
          {count > 0 ? (
            <div className="scroll-thin max-h-[200px] overflow-y-auto">
              {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow-key roving for the row buttons inside. */}
              <div
                className="flex flex-col gap-px p-1"
                data-search-list=""
                onKeyDown={roving.onKeyDown}
                ref={roving.listRef}
              >
                {parsed.results.map((result) =>
                  result.kind === "file" ? (
                    <FileRow
                      firstKey={firstKey}
                      key={result.path}
                      navKey={`file:${result.path}`}
                      onOpen={onOpenFile}
                      result={result}
                      roving={roving}
                      t={t}
                      target={resolveSearchResultTarget({
                        cwd,
                        searchPath,
                        resultPath: result.path,
                      })}
                    />
                  ) : (
                    <WebRow key={result.url} result={result} />
                  ),
                )}
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
