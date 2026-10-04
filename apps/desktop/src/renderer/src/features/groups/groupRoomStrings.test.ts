import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * C6 guard: no hardcoded user-visible strings in `features/groups/` (outside
 * tests). Every string literal, template and JSX text that reads like copy
 * must come from the room catalog (`shared/group-room-text.ts`). C6.1 extends
 * the scan to the Files panel (`features/files/`) and the Search Tool card
 * (`features/agent/SearchToolCard.tsx` + its parsers), whose copy lives in
 * `shared/files-search-text.ts`. A heuristic
 * scan with the TypeScript AST: identifiers, class lists, test ids, ARIA
 * plumbing, imports, comparisons and `cn(...)` arguments are not copy.
 *
 * ALLOWED lists the few literals that stay on purpose, each with its reason.
 * A new hit fails the test; so does an allowlist entry that no longer exists.
 */
const ALLOWED: Record<string, Record<string, string>> = {
  "groupKickoff.ts": {
    "Outcome: {x}": "kickoff protocol line sent to agents (parsed, stays English)",
    "First owner: @{x}": "kickoff protocol line sent to agents",
    "Next: {x}": "kickoff protocol line sent to agents",
    "Approval: {x}": "kickoff protocol line sent to agents",
    "@Builder implements · @Reviewer blocking gaps only":
      "collab pipeline protocol text for agents",
    "merge / publish — wait for me": "collab pipeline protocol text for agents",
  },
  "groupLiveTurn.ts": {
    Done: "internal live phase code, mapped by thinkingStateKeyFromLive (not rendered)",
    Failed: "internal live phase code (not rendered)",
    Stopped: "internal live phase code (not rendered)",
    "Waiting for you": "internal live phase code, mapped to the waitingForYou label",
  },
  "workingShimmer.ts": {
    Queued: "internal phase code fed to formatGroupProgressLabel",
    Thinking: "internal phase code fed to formatGroupProgressLabel",
  },
  "GroupMemberLiveTurn.tsx": {
    Writing: "internal phase code fed to inlineLiveStatusLabel",
  },
  "newGroupModel.ts": {
    Agent: "fallback base for a stored agent name (data, not UI copy)",
  },
  "GroupMessageRow.tsx": {
    "→": "arrow glyph before the addressee's name",
  },
  "NewGroupModal.tsx": {
    "×": "multiplier glyph before a template count",
  },
  "../agent/SearchToolCard.tsx": {
    Home: "keyboard event key name (roving focus), not rendered",
    End: "keyboard event key name (roving focus), not rendered",
  },
  "../agent/searchResults.ts": {
    "No matches found": "PI grep tool output recognised as an empty result (parsed, not rendered)",
    "No files found matching pattern":
      "PI find tool output recognised as an empty result (parsed, not rendered)",
  },
};

/** C6.1: the Files panel and the Search Tool card, scanned with the room. */
const EXTRA_SOURCES = [
  "../files",
  "../agent/SearchToolCard.tsx",
  "../agent/searchResults.ts",
  "../agent/searchResultPath.ts",
];

const here = fileURLToPath(new URL(".", import.meta.url));

const SKIP_ATTR =
  /^(className|style|key|data-[\w-]+|type|role|id|htmlFor|name|href|src|value|mode|variant|side|align|accept|aria-(controls|hidden|live|haspopup|labelledby|current|pressed|expanded|selected|checked))$/;
const SKIP_CALLS =
  /^(cn|startsWith|endsWith|includes|split|replace|test|match|join|get|has|set|add|delete|warn|error|log|setItem|getItem|removeItem|querySelector|querySelectorAll|t|groupText|groupPluralText|filesSearchText|filesSearchPluralText|plural|RegExp|localeCompare)$/;

function looksLikeCopy(text: string): boolean {
  const value = text.trim();
  const bare = value.replace(/\{x\}/g, "");
  if (/[\u4e00-\u9fff]/.test(value)) return true;
  // "{x}…" truncation and other symbol-only literals are not copy
  if (!/\p{L}{2,}/u.test(bare)) return false;
  // identifiers, ids, keys, mime types, paths: no spaces, not a capitalised word
  if (!/\s/.test(bare) && !/^[A-Z][a-z]+$/.test(bare)) return false;
  // class lists
  if (
    /^[a-z!-][\w:/[\].%()=>!-]*(\s+[\w:/[\].%()=>!-]+)+$/.test(value) &&
    !/\b(the|a|an|to|of|for|in|no|is|and|or|you|your|this|that)\b/.test(value)
  ) {
    return false;
  }
  return true;
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
  }
  return files;
}

function skipContext(node: ts.Node): boolean {
  let parent: ts.Node | undefined = node.parent;
  for (let depth = 0; depth < 6 && parent; depth += 1, parent = parent.parent) {
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
    if (ts.isTypeNode(parent)) return true;
    if (ts.isJsxAttribute(parent)) return SKIP_ATTR.test(parent.name.getText());
    if (ts.isCallExpression(parent)) {
      const callee = parent.expression.getText().split(".").pop() ?? "";
      if (SKIP_CALLS.test(callee) || /^console\./.test(parent.expression.getText())) return true;
    }
    if (ts.isNewExpression(parent) && /RegExp/.test(parent.expression.getText())) return true;
    if (ts.isElementAccessExpression(parent) && depth === 0) return true;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
    if (ts.isCaseClause(parent) && depth === 0) return true;
    if (
      ts.isBinaryExpression(parent) &&
      depth === 0 &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
      ].includes(parent.operatorToken.kind)
    ) {
      return true;
    }
    if (ts.isPropertyAccessExpression(parent) || ts.isStatement(parent)) break;
  }
  return false;
}

function scan(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const value = node.getText().trim().replace(/\s+/g, " ");
      if (/\p{L}/u.test(value) || /[…×→]/.test(value)) hits.push(value);
    } else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      const raw = ts.isTemplateExpression(node)
        ? node
            .getText()
            .slice(1, -1)
            .replace(/\$\{[^}]*\}/g, "{x}")
        : node.text;
      if (!skipContext(node) && looksLikeCopy(raw)) hits.push(raw.replace(/\s+/g, " "));
      if (ts.isTemplateExpression(node)) {
        for (const span of node.templateSpans) visit(span.expression);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe("features/groups, Files panel and Search card have no hardcoded user-visible strings (C6/C6.1)", () => {
  const found = new Map<string, string[]>();
  const files = [
    ...sourceFiles(here),
    ...EXTRA_SOURCES.flatMap((entry) => {
      const path = join(here, entry);
      return statSync(path).isDirectory() ? sourceFiles(path) : [path];
    }),
  ];
  for (const file of files) {
    const hits = scan(file);
    if (hits.length > 0) found.set(relative(here, file), hits);
  }

  it("every copy-like literal is in the catalog or justified in ALLOWED", () => {
    const unexpected: string[] = [];
    for (const [file, hits] of found) {
      for (const hit of hits) {
        if (!ALLOWED[file]?.[hit]) unexpected.push(`${file}: ${hit}`);
      }
    }
    expect(unexpected).toEqual([]);
  });

  it("ALLOWED has no stale entries", () => {
    const stale: string[] = [];
    for (const [file, entries] of Object.entries(ALLOWED)) {
      for (const text of Object.keys(entries)) {
        if (!found.get(file)?.includes(text)) stale.push(`${file}: ${text}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("catches a hardcoded string (self-check of the scanner)", () => {
    expect(looksLikeCopy("Show all")).toBe(true);
    expect(looksLikeCopy("Replying to {x}")).toBe(true);
    expect(looksLikeCopy("等待你")).toBe(true);
    expect(looksLikeCopy("group-message-list")).toBe(false);
    expect(looksLikeCopy("flex min-w-0 items-center gap-2")).toBe(false);
    expect(looksLikeCopy("error.{x}")).toBe(false);
    expect(looksLikeCopy("{x}…")).toBe(false);
  });

  it("covers the Files panel and the Search Tool card (C6.1)", () => {
    const scanned = files.map((file) => relative(here, file));
    for (const file of [
      "../files/FilesPanel.tsx",
      "../files/UnsavedChangesDialog.tsx",
      "../agent/SearchToolCard.tsx",
      "../agent/searchResults.ts",
    ]) {
      expect(scanned).toContain(file);
    }
  });
});
