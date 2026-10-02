/**
 * Parsers for search tool output (grep / find / web_search) used by the
 * Search Tool card. Each parser returns `undefined` when the payload does not
 * look like the shape it expects, so the caller can fall back to the generic
 * tool row and never drop information.
 */

export const FILE_SEARCH_TOOL_NAMES = ["grep", "find"] as const;
export const WEB_SEARCH_TOOL_NAMES = ["web_search"] as const;

export type FileSearchResult = {
  kind: "file";
  path: string;
  /** Number of matching lines (grep); undefined for path-only results (find). */
  matches?: number;
  /** First matching line number (grep). */
  line?: number;
  /**
   * Every matching line (grep), in output order. `text` is exactly what grep
   * printed after `path:line: ` (the tool may already have truncated it).
   */
  matchLines?: SearchMatchLine[];
};

export type SearchMatchLine = { line: number; text: string };

export type WebSearchResult = {
  kind: "web";
  title: string;
  url: string;
  source: string;
};

export type SearchResultItem = FileSearchResult | WebSearchResult;

export type ParsedSearch = {
  results: SearchResultItem[];
  /** Trailing tool notices, e.g. "[100 matches limit reached …]". */
  notice?: string;
};

export function isSearchToolName(name: string): boolean {
  return (
    (FILE_SEARCH_TOOL_NAMES as readonly string[]).includes(name) ||
    (WEB_SEARCH_TOOL_NAMES as readonly string[]).includes(name)
  );
}

/** Query label shown in mono: the pattern / query plus where it ran. */
export function searchQuery(name: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const text = (value: unknown) => (value == null ? "" : String(value));
  if (name === "web_search") return text(a.query);
  const pattern = text(a.pattern);
  if (a.path) return `${pattern} in ${text(a.path)}`;
  if (name === "grep" && a.glob) return `${pattern} in ${text(a.glob)}`;
  return pattern;
}

const EMPTY_OUTPUTS = new Set(["No matches found", "No files found matching pattern"]);

/** Split a trailing `\n\n[notice]` block (PI grep/find) from the body. */
function splitNotice(output: string): { body: string; notice?: string } {
  const trimmed = output.replace(/\s+$/, "");
  const match = /\n\n\[([^\n]+)\]$/.exec(trimmed);
  if (!match || match.index === undefined) return { body: trimmed };
  const notice = match[1]?.trim();
  return { body: trimmed.slice(0, match.index), ...(notice ? { notice } : {}) };
}

const GREP_MATCH = /^(.+?):(\d+): ?(.*)$/;
const GREP_CONTEXT = /^(.+?)-(\d+)- ?/;

/** PI grep output: `path:line: text` matches, `path-line- text` context lines. */
export function parseGrepOutput(output: string): ParsedSearch | undefined {
  const { body, notice } = splitNotice(output);
  const extra = notice ? { notice } : {};
  if (EMPTY_OUTPUTS.has(body.trim())) return { results: [], ...extra };
  if (!body.trim()) return undefined;
  const byPath = new Map<string, FileSearchResult>();
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim() || line.trim() === "--") continue;
    const match = GREP_MATCH.exec(line);
    if (match?.[1] && match[2]) {
      const path = match[1];
      const lineNumber = Number(match[2]);
      const matchLine = { line: lineNumber, text: match[3] ?? "" };
      const existing = byPath.get(path);
      if (existing) {
        existing.matches = (existing.matches ?? 0) + 1;
        existing.matchLines?.push(matchLine);
      } else {
        byPath.set(path, {
          kind: "file",
          path,
          matches: 1,
          line: lineNumber,
          matchLines: [matchLine],
        });
      }
      continue;
    }
    if (GREP_CONTEXT.test(line)) continue;
    return undefined;
  }
  if (byPath.size === 0) return undefined;
  return { results: [...byPath.values()], ...extra };
}

/** PI find output: one relative path per line. */
export function parseFindOutput(output: string): ParsedSearch | undefined {
  const { body, notice } = splitNotice(output);
  const extra = notice ? { notice } : {};
  if (EMPTY_OUTPUTS.has(body.trim())) return { results: [], ...extra };
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  // A path list never contains free prose like "Error: …" with spaces after a colon.
  if (lines.some((line) => /^[A-Za-z]+: /.test(line))) return undefined;
  return { results: lines.map((path) => ({ kind: "file", path })), ...extra };
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

/** Drop repeated URLs so each row (keyed by URL) is unique. */
function uniqueByUrl(results: WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => !seen.has(result.url) && Boolean(seen.add(result.url)));
}

function webResult(title: string, url: string): WebSearchResult | undefined {
  const source = hostOf(url);
  if (!source) return undefined;
  return { kind: "web", title: title.trim() || url, url, source };
}

/**
 * web_search output is provider text. Recognised shapes: `Title: …` / `URL: …`
 * blocks (Exa), a JSON array or `{ results: [...] }` with title + url, or
 * markdown link lines.
 */
export function parseWebSearchOutput(output: string): ParsedSearch | undefined {
  const text = output.trim();
  if (!text) return undefined;

  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      const list = Array.isArray(parsed)
        ? parsed
        : (parsed as { results?: unknown } | null)?.results;
      if (Array.isArray(list)) {
        const results = list
          .map((item) => {
            if (!item || typeof item !== "object") return undefined;
            const { title, url } = item as { title?: unknown; url?: unknown };
            return typeof url === "string"
              ? webResult(typeof title === "string" ? title : "", url)
              : undefined;
          })
          .filter((item): item is WebSearchResult => Boolean(item));
        if (results.length > 0) return { results: uniqueByUrl(results) };
      }
    } catch {
      // not JSON; try the text shapes below
    }
  }

  const results: WebSearchResult[] = [];
  let pendingTitle: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const title = /^Title:\s*(.*)$/i.exec(line);
    if (title) {
      pendingTitle = title[1] ?? "";
      continue;
    }
    const url = /^URL:\s*(\S+)/i.exec(line);
    if (url?.[1] && pendingTitle !== undefined) {
      const result = webResult(pendingTitle, url[1]);
      if (result) results.push(result);
      pendingTitle = undefined;
    }
  }
  if (results.length > 0) return { results: uniqueByUrl(results) };

  for (const match of text.matchAll(
    /^\s*(?:[-*]|\d+\.)?\s*\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gm,
  )) {
    const result = match[1] && match[2] ? webResult(match[1], match[2]) : undefined;
    if (result) results.push(result);
  }
  return results.length > 0 ? { results: uniqueByUrl(results) } : undefined;
}

export function parseSearchOutput(name: string, output: string): ParsedSearch | undefined {
  if (name === "grep") return parseGrepOutput(output);
  if (name === "find") return parseFindOutput(output);
  if (name === "web_search") return parseWebSearchOutput(output);
  return undefined;
}

/**
 * Truncate a path in the MIDDLE so the filename stays visible:
 * `apps/desktop/src/…/QuestionCard.tsx`. A filename longer than `max` keeps
 * its tail.
 */
export function middleTruncatePath(path: string, max = 64): string {
  if (path.length <= max) return path;
  const slash = path.replace(/\/+$/, "").lastIndexOf("/");
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const budget = max - name.length - 1;
  if (budget < 2 || !dir) return `…${path.slice(-(max - 1))}`;
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  return `${dir.slice(0, head)}…${tail > 0 ? dir.slice(-tail) : ""}${name}`;
}

/** Right-hand column for a file row: "L42" for one match, "3 matches" for more. */
export function fileResultMeta(result: FileSearchResult): string {
  if (result.matches === undefined) return result.path.endsWith("/") ? "dir" : "";
  if (result.matches === 1 && result.line !== undefined) return `L${result.line}`;
  return `${result.matches} ${result.matches === 1 ? "match" : "matches"}`;
}
