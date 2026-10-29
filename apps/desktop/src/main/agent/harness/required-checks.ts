import type { HarnessTaskCheckKind } from "../../../shared/contracts";

const CHECK_TARGETS: Array<[HarnessTaskCheckKind, RegExp]> = [
  ["tests", /\b(?:tests?|testes?|vitest|jest)\b/i],
  ["typecheck", /\btype[ -]?check\b/i],
  ["lint", /\b(?:lint|eslint|biome)\b/i],
  ["build", /\bbuild\b/i],
];

const ACTIONS =
  /\b(?:run|execute|rerun|verify|check|executar|rode|roda|rodar|faça|faca|fazer|verifique|verificar|reexecute|skip|avoid|evite)\b/gi;
const CLAUSE_BOUNDARIES =
  /[.!?;\n]|\b(?:but|however|instead|mas|porém|porem)\b|\b(?:run|execute|rerun|verify|check|executar|rode|roda|rodar|faça|faca|fazer|verifique|verificar|reexecute|skip|avoid|evite)\b/gi;
const NEGATION = /\b(?:do\s+not|don't|dont|never|avoid|skip|not|não|nao|nunca|evite)\s*$/i;
const QUOTED_OR_CODE = /```[\s\S]*?```|`[^`\n]*`|"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g;

type Directive = { kind: HarnessTaskCheckKind; prohibited: boolean; position: number };

function clauseStartBefore(text: string, position: number): number {
  const boundaries = /[.!?;,\n]|\b(?:but|however|instead|mas|porém|porem)\b/gi;
  let clauseStart = 0;
  for (const match of text.slice(0, position).matchAll(boundaries)) {
    clauseStart = (match.index ?? 0) + match[0].length;
  }
  return clauseStart;
}

function isNegated(text: string, actionStart: number, targetStart: number): boolean {
  const actionClauseStart = clauseStartBefore(text, actionStart);
  const targetClauseStart = clauseStartBefore(text, targetStart);
  const actionPrefix = text.slice(actionClauseStart, actionStart);
  const targetPrefix = text.slice(targetClauseStart, targetStart);
  return (
    NEGATION.test(actionPrefix) ||
    /\b(?:do\s+not|don't|dont|never|avoid|skip|não|nao|nunca|evite)\s+(?:(?:run|execute|rerun|verify|check|executar|rode|rodar|verifique|verificar|reexecute)\s+)?$/i.test(
      targetPrefix,
    )
  );
}

function isAmbiguous(text: string, actionStart: number): boolean {
  const prefix = text.slice(clauseStartBefore(text, actionStart), actionStart);
  return /\b(?:maybe|perhaps|possibly|maybe we should|do we need to|should we)\s*$/i.test(prefix);
}

function lastDirectives(message: string): Map<HarnessTaskCheckKind, Directive> {
  // Quoted or fenced examples describe text; they are not fresh instructions to the Harness.
  const text = message.replace(QUOTED_OR_CODE, " ").replace(/^\s{0,3}>.*$/gm, " ");
  const final = new Map<HarnessTaskCheckKind, Directive>();
  const actions = new RegExp(ACTIONS.source, ACTIONS.flags);

  for (const action of text.matchAll(actions)) {
    const position = action.index ?? 0;
    const actionEnd = position + action[0].length;
    const boundaries = new RegExp(CLAUSE_BOUNDARIES.source, CLAUSE_BOUNDARIES.flags);
    boundaries.lastIndex = actionEnd;
    const nextBoundary = boundaries.exec(text);
    const targetWindow = text.slice(position, nextBoundary?.index ?? text.length);
    if (isAmbiguous(text, position)) continue;

    for (const [kind, target] of CHECK_TARGETS) {
      const targetMatches = new RegExp(target.source, `${target.flags.replace(/[gy]/g, "")}g`);
      for (const match of targetWindow.matchAll(targetMatches)) {
        const targetStart = position + (match.index ?? 0);
        const prohibited =
          isNegated(text, position, targetStart) || /^(?:skip|avoid|evite)$/i.test(action[0]);
        const previous = final.get(kind);
        if (!previous || position >= previous.position) {
          final.set(kind, { kind, prohibited, position });
        }
      }
    }
  }
  return final;
}

/** Extracts check obligations only; it never grants permission to run a tool. */
export function requestedCheckKinds(message: string, prohibited = false): HarnessTaskCheckKind[] {
  const final = lastDirectives(message);
  return CHECK_TARGETS.filter(([kind]) => final.get(kind)?.prohibited === prohibited).map(
    ([kind]) => kind,
  );
}
