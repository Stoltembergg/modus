import type { QuestionPrompt, TaskClassificationInput } from "../../../shared/contracts";
import { classifyHarnessTask } from "./task-classifier";

/**
 * Gate input. `hasAttachedContext` (files, elements, images…) and `previousTurn` (the
 * previous user prompt and the agent's last reply) only let the missing-target rule
 * stand down; they never make the gate stricter.
 */
export type IntentGateInput = TaskClassificationInput & {
  hasAttachedContext?: boolean;
  previousTurn?: { userText?: string; assistantText?: string };
  /**
   * User setting "Ask before acting when the target is missing" (default on). When false the
   * missing-target rule is skipped entirely; destructive confirmation is unaffected.
   */
  askMissingTarget?: boolean;
};

export type IntentGateResult =
  | { action: "proceed" }
  | {
      action: "suggest_plan";
      classification: ReturnType<typeof classifyHarnessTask>;
    }
  | { action: "clarify"; question: QuestionPrompt; default: string }
  | { action: "confirm"; question: QuestionPrompt };

const CLARIFY_DEFAULT = "Use a conservative default and proceed.";
const ACTION_CLAUSE_BOUNDARY = String.raw`(?:^|[.!?;:]\s*|,\s*(?:and\s+)?then\s+|\bthen\s+)`;
const DIRECT_REQUEST_PREFIX = String.raw`(?:(?:please|can you|could you|i want you to|i want to|we need to)\s+)*`;
const DESTRUCTIVE_VERB = `(?:delete|remove|drop|wipe|erase|destroy|truncate|overwrite)`;
const CONSEQUENTIAL_DATA_TARGET = String.raw`(?:(?:the|all|my|our|these|those)\s+)*(?:(?:production|prod|live)\s+)?(?:database|db|data|records?|accounts?|customer\s+accounts?|user\s+accounts?|[a-z][a-z0-9_-]*\s+tables?)`;
const DIRECT_DESTRUCTIVE_EFFECT = new RegExp(
  `${ACTION_CLAUSE_BOUNDARY}${DIRECT_REQUEST_PREFIX}${DESTRUCTIVE_VERB}\\s+${CONSEQUENTIAL_DATA_TARGET}\\b`,
  "i",
);

// Missing-target rule: an imperative edit verb (pt-BR or English) at the start of a clause,
// optionally after a polite prefix, with nothing that says what to change.
const POLITE_PREFIX = String.raw`(?:(?:ok|okay|sim|please|pls|can you|could you|would you|i want you to|i need you to|go ahead and|now|por favor|pode|você pode|vc pode|voce pode|poderia|consegue|agora|então|entao)[\s,]+)*`;
const EDIT_VERB = String.raw`(?:fix|repair|add|change|modify|update|upgrade|refactor|rewrite|delete|remove|convert|improve|optimi[sz]e|clean\s+up|rename|move|split|replace|tweak|adjust|edit|redo|make|do(?!\s+(?:you|we|i|they|not)\b)|handle|deal\s+with|get\s+rid\s+of|sort\s+out|corrij[ae]|corrigir|corrige|consert[ae]|consertar|arrum[ae]|arrumar|ajust[ae]|ajustar|adicion[ae]|adicionar|acrescent[ae]|coloc[ae]|coloque|mud[ae]|mudar|alter[ae]|alterar|troc[ae]|troque|trocar|refator[ae]|refatorar|remov[ae]|remover|apag[ae]|apague|apagar|delet[ae]|deletar|exclu[ia]|excluir|tir[ae](?!\s+(?:uma|minha|essa)\s+d[uú]vida)|tirar|convert[ae]|converter|atualiz[ae]|atualizar|melhor[ae]|melhorar|otimiz[ae]|otimizar|renomei[ae]|renomear|mov[ae]|mover|limp[ae]|limpar|resolv[ae]|resolver|deix[ae](?!\s+eu\b)|faz(?!\s+(?:sentido|quanto|tempo|diferen[cç]a)\b)|faça|faca|fazer|substitu[ia]|substituir|separ[ae]|divid[ae]|implement|create|insert|include|hide|disable|enable|revert|undo|translate|cent(?:er|re)|align|resize|implement[ae]|implementar|cri[ae]|criar|inclu[ia]|incluir|insir[ae]|inserir|escond[ae]|esconder|desativ[ae]|desativar|ativ[ae]|ativar|revert[ae]|reverter|desfaz|desfaça|desfaca|desfazer|traduz|traduza|traduzir|centraliz[ae]|centralizar|alinh[ae]|alinhar|redimension[ae]|redimensionar)`;
const CLAUSE_START = String.raw`(?:^|[.!?;:,\n]\s*|\b(?:and|then|e|depois|aí|ai)\s+)`;
const EDIT_REQUEST = new RegExp(
  `${CLAUSE_START}${POLITE_PREFIX}${EDIT_VERB}(?![\\p{L}\\p{N}_])`,
  "iu",
);
const NAMED_TARGET = [
  /`[^`\n]+`/, // backticked identifier or snippet
  /["“”][^"“”\n]{2,}["“”]|'[^'\n]{2,}'/, // quoted label or text
  /\b[\w@-]{1,128}\.[a-z][a-z0-9]{0,5}\b(?![\w-])/i, // file name with an extension
  /[\w@.-]{1,128}\/[\w@.-]{1,128}/, // path segment
  /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/, // camelCase
  /\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/, // PascalCase
  /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/, // snake_case / SCREAMING_CASE
  /\b[A-Za-z_$][\w$]*\(\)/, // call()
  /https?:\/\//i, // URL
  /\b(?:line|linha)\s+\d+/i,
  /(?:^|\s)\.[a-z][\w.-]*/i, // dotfile (.nvmrc, .env)
  /\bv?\d+\.\d+(?:\.\d+)?\b/, // version number
  /\b(?:README|CHANGELOG|LICENSE|CONTRIBUTING|Dockerfile|Makefile)\b/,
  /[\p{Ll}\d,]\s+\p{Lu}\p{Ll}{2,}/u, // capitalized name mid-sentence (Sidebar, Windows)
  // App surfaces that exist once, so naming them is enough in any case ("sidebar" == "Sidebar").
  // Generic nouns (button, label, modal, component, page) are not here: they still need a name.
  // Translation into a named language: the language is the target.
  /\b(?:translate|translat(?:ion|ing)|tradu\p{L}*)[^\n]*?(?<![\p{L}])(?:english|portuguese|spanish|french|german|italian|japanese|chinese|korean|russian|dutch|ingl[eê]s|portugu[eê]s|espanhol|franc[eê]s|alem[aã]o|italiano|japon[eê]s|chin[eê]s|coreano|russo|holand[eê]s|pt-br|en-us|zh)(?![\p{L}])/iu,
  /\b(?:side\s?bar|barra\s+lateral|nav\s?bar|tool\s?bar|title\s?bar|status\s?bar|header|footer|cabe[cç]alho|rodap[eé]|composer)(?![\p{L}\p{N}_])/iu,
];
/**
 * Targets that exist once per project, so naming them is enough: lint, warnings, tests, build,
 * CI, typecheck/type errors, merge conflicts, version, dependencies, unused imports. Only when
 * the noun phrase ends the request ("Update the version", not "Atualiza a versão da biblioteca").
 */
const PROJECT_TARGET =
  /(?:^|\s)(?:lint(?:\s+(?:errors?|warnings?|issues?))?|warnings?|avisos|(?:unit\s+|e2e\s+)?tests?|testes|build|ci|typecheck|type[\s-]?check(?:ing)?|type\s+errors?|erros?\s+de\s+(?:lint|tipo|tipagem|build)|merge\s+conflicts?|conflitos?(?:\s+de\s+merge)?|version|vers[aã]o|dependencies|depend[eê]ncias|deps|package\.json|unused\s+imports?|imports?\s+n[aã]o\s+usados?)\s*[.!]*\s*$/iu;
// Brand names that look like PascalCase/camelCase but name no code target.
const NON_TARGET_WORDS =
  /\b(?:JavaScript|TypeScript|GitHub|GitLab|macOS|iOS|iPhone|iPad|PowerShell|WebSocket|PostgreSQL|MySQL|MongoDB|YouTube|WhatsApp|LinkedIn|OpenAI|ChatGPT)\b/g;
const ERROR_TEXT = [
  /\b\w*(?:Error|Exception)\b:?/, // TypeError, AssertionError, NullPointerException
  /\b\w+(?:error|exception)\b/i, // typeerror, nullpointerexception (any case)
  /\b(?:error|erro|exception):\s*\S/i, // "error: cannot read config"
  /\berror\[?\s*(?:TS)?E?\d{3,}/i, // error TS2554, error[E0277]
  /\bTS\d{4}\b/,
  /\bE[A-Z]{3,}\b/, // ENOENT, EADDRINUSE
  /npm ERR!|##\[error\]|Traceback \(most recent call last\)|panicked at|command not found|\bfatal:|\bFAIL\s/,
  /:\d+:\d+\b|\(\d+,\d+\)/, // file:line:col, file(line,col)
  /^\s*at\s+\S+.*\d/m, // stack frame
];
const AFFIRMATIVE_REPLY =
  /^\s*(?:sim|s|yes|y|yep|yeah|yup|ok|okay|okey|sure|pode|claro|beleza|blz|isso|bora|vai|manda|go|go ahead|do it|please do|proceed|continue|segue|prossiga|confirmo|confirm|perfeito|faz|faça)\b/i;
/** Longer or multi-line requests usually carry their own description; leave them alone. */
const DESCRIBED_REQUEST_MIN_CHARS = 200;
/** Only the end of the agent's last reply is scanned: it is where targets and questions sit. */
const PREVIOUS_REPLY_TAIL_CHARS = 2_000;

function namesTarget(text: string, longTextNamesTarget = true): boolean {
  if (
    longTextNamesTarget &&
    (text.length >= DESCRIBED_REQUEST_MIN_CHARS || text.trim().split("\n").length >= 3)
  ) {
    return true;
  }
  const withoutBrands = text.replace(NON_TARGET_WORDS, " ");
  return (
    NAMED_TARGET.some((pattern) => pattern.test(withoutBrands)) ||
    ERROR_TEXT.some((pattern) => pattern.test(text))
  );
}

// "Improve the tests" names the target but not what to change, so it still asks.
const OPEN_ENDED_VERB = /\b(?:improve|optimi[sz]e|melhor[ae]r?|otimiz(?:e|a|ar))\b/i;

/**
 * A trailing polite word ("fix the tests please", "arruma os testes por favor") is stripped
 * before the end-anchored checks, so it reads the same as the request without it.
 */
const TRAILING_POLITENESS =
  /[\s,]+(?:please|pls|plz|thanks|thank\s+you|por\s+favor|pfv|pf|obrigad[oa])\s*[.!?]*\s*$/iu;

function withoutTrailingPoliteness(text: string): string {
  return text.replace(TRAILING_POLITENESS, "");
}

function isProjectTargetRequest(text: string): boolean {
  return PROJECT_TARGET.test(withoutTrailingPoliteness(text)) && !OPEN_ENDED_VERB.test(text);
}

function agentAskedQuestion(assistantText: string | undefined): boolean {
  const lastLine = assistantText?.trim().split("\n").at(-1) ?? "";
  return lastLine.includes("?");
}

// Verbs added after #250 (build-something verbs). They stand down when the agent's last reply
// proposed a plan, because the request then points at that plan.
const PLAN_FOLLOW_UP_VERB = String.raw`(?:implement|create|insert|include|implement[ae]|implementar|cri[ae]|criar|inclu[ia]|incluir|insir[ae]|inserir)`;
const PLAN_FOLLOW_UP_REQUEST = new RegExp(
  `${CLAUSE_START}${POLITE_PREFIX}${PLAN_FOLLOW_UP_VERB}(?![\\p{L}\\p{N}_])`,
  "iu",
);
/** A plan: a "plan"/"plano"/"steps" heading or at least two numbered or bulleted lines. */
function agentProposedPlan(assistantText: string | undefined): boolean {
  if (!assistantText) return false;
  if (/\b(?:plan|plano|proposed\s+steps|passos|etapas)\b\s*[:\n]/i.test(assistantText)) return true;
  return (assistantText.match(/^\s*(?:\d+[.)]|[-*•])\s+\S/gm) ?? []).length >= 2;
}

function lacksTarget(input: IntentGateInput): boolean {
  if (input.askMissingTarget === false || input.mode !== "build") return false;
  // Long requests describe themselves; skip the regex scan entirely (bounded cost).
  if (input.text.length >= DESCRIBED_REQUEST_MIN_CHARS) return false;
  if (!EDIT_REQUEST.test(input.text)) return false;
  if (input.hasAttachedContext || input.contextPaths.length > 0 || input.changedPaths.length > 0) {
    return false;
  }
  if (namesTarget(input.text) || isProjectTargetRequest(input.text)) return false;
  const { userText } = input.previousTurn ?? {};
  const assistantText = input.previousTurn?.assistantText?.slice(-PREVIOUS_REPLY_TAIL_CHARS);
  // Agent replies are long by nature, so only a concrete target in them counts.
  if ((userText && namesTarget(userText)) || (assistantText && namesTarget(assistantText, false))) {
    return false;
  }
  if (agentAskedQuestion(assistantText) && AFFIRMATIVE_REPLY.test(input.text)) return false;
  // "Implement the feature" right after the agent laid out a plan refers to that plan.
  if (agentProposedPlan(assistantText) && PLAN_FOLLOW_UP_REQUEST.test(input.text)) return false;
  return true;
}

function hasMaterialAmbiguity(text: string): boolean {
  if (/^\s*(?:explain|discuss|review|analyze|describe)\s+(?:whether|if)\b/i.test(text)) {
    return false;
  }
  return /\b(which|whether|should i|do you mean|not sure|unclear|ambiguous|help me choose)\b/i.test(
    text,
  );
}

function clarificationQuestion(): QuestionPrompt {
  return {
    id: "intent-clarification",
    header: "What requirement or target should guide this task?",
    detail: "Type a brief answer, choose the conservative default, or cancel this turn.",
    multiSelect: false,
    options: [
      { label: "Use a conservative default", recommended: true },
      { label: "Cancel this turn" },
    ],
  };
}

function confirmationQuestion(): QuestionPrompt {
  return {
    id: "intent-confirmation",
    header: "Confirm consequential action",
    detail: "This request may have consequential effects. Confirm before the agent proceeds.",
    multiSelect: false,
    options: [{ label: "Proceed" }, { label: "Cancel", recommended: true }],
  };
}

export function evaluateIntentGate(input: IntentGateInput): IntentGateResult {
  const classification = classifyHarnessTask(input);
  const directDestructiveEffect =
    input.mode === "build" &&
    (input.hasDestructiveAction === true || DIRECT_DESTRUCTIVE_EFFECT.test(input.text));
  if (directDestructiveEffect) {
    return { action: "confirm", question: confirmationQuestion() };
  }
  if (hasMaterialAmbiguity(input.text) || lacksTarget(input)) {
    return { action: "clarify", question: clarificationQuestion(), default: CLARIFY_DEFAULT };
  }
  if (classification.complexity === "complex") {
    return { action: "suggest_plan", classification };
  }
  return { action: "proceed" };
}
