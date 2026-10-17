import ts from "typescript";

/**
 * Static scan behind settingsI18nLiterals.test.ts: finds English written
 * straight into what a component renders (JSX text, text props, literal JSX
 * children, `fooLabel = "..."` defaults). Test-only helper; nothing in the app
 * imports it.
 */
/** Props whose string value is shown to people or read by screen readers. */
const TEXT_PROPS = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "placeholder",
  "title",
  "label",
  "description",
  "hint",
  "helper",
  "helperText",
  "tooltip",
  "emptyText",
  "emptyLabel",
  "confirmLabel",
  "cancelLabel",
  "submitLabel",
  "actionLabel",
  "message",
  "heading",
  "subtitle",
]);

/** Destructured props whose default value is rendered (`submitLabel = "Submit"`). */
const TEXT_DEFAULT_NAME = /(?:Label|Placeholder|Text|Title|Message|Hint|Description)$/;

/**
 * Text that is the same in every language: product, brand and protocol names,
 * symbols and units. Matched against the whole trimmed literal.
 */
const LANGUAGE_NEUTRAL = new Set<string>([]);

/**
 * Code, keys and paths are not prose: `<code>AGENTS.md</code>`, `<kbd>ESC</kbd>`
 * and monospace spans (`<span className="font-mono">SKILL.md</span>`).
 */
const VERBATIM_TAGS = new Set(["code", "kbd", "pre", "samp"]);

function isVerbatimElement(element: ts.JsxElement): boolean {
  const opening = element.openingElement;
  if (VERBATIM_TAGS.has(opening.tagName.getText())) return true;
  return opening.attributes.properties.some(
    (prop) =>
      ts.isJsxAttribute(prop) &&
      prop.name.getText() === "className" &&
      prop.initializer !== undefined &&
      ts.isStringLiteral(prop.initializer) &&
      /\bfont-mono\b/.test(prop.initializer.text),
  );
}

function insideVerbatim(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isJsxElement(at) && isVerbatimElement(at)) return true;
  }
  return false;
}

/** Has a word (two letters in a row); "—", "·", "⏎", "1" and "%" do not count. */
function hasWords(text: string): boolean {
  return /\p{L}{2,}/u.test(text);
}

type Finding = { file: string; line: number; text: string };

function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
  }
  return undefined;
}

/** String literals that end up as the value of an expression (through ?:, ??, ||, parens). */
function renderedLiterals(node: ts.Expression): ts.Node[] {
  if (ts.isParenthesizedExpression(node)) return renderedLiterals(node.expression);
  if (ts.isConditionalExpression(node)) {
    return [...renderedLiterals(node.whenTrue), ...renderedLiterals(node.whenFalse)];
  }
  if (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.PlusToken,
    ].includes(node.operatorToken.kind)
  ) {
    return [...renderedLiterals(node.left), ...renderedLiterals(node.right)];
  }
  return literalText(node) === undefined ? [] : [node];
}

export function scanUntranslated(file: string, source: string): Finding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];
  const report = (node: ts.Node, text: string) => {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!hasWords(trimmed) || LANGUAGE_NEUTRAL.has(trimmed) || insideVerbatim(node)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    findings.push({ file, line: line + 1, text: trimmed });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      report(node, node.text);
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      const init = node.initializer;
      if (TEXT_PROPS.has(name) && init) {
        if (ts.isStringLiteral(init)) report(init, init.text);
        else if (ts.isJsxExpression(init) && init.expression) {
          for (const lit of renderedLiterals(init.expression)) report(lit, literalText(lit) ?? "");
        }
      }
    } else if (
      ts.isBindingElement(node) &&
      node.initializer &&
      TEXT_DEFAULT_NAME.test(node.name.getText(sf))
    ) {
      // `{ submitLabel = "Submit" }` defaults are rendered text too.
      for (const lit of renderedLiterals(node.initializer)) report(lit, literalText(lit) ?? "");
    } else if (
      ts.isJsxExpression(node) &&
      node.expression &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      for (const lit of renderedLiterals(node.expression)) report(lit, literalText(lit) ?? "");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}
