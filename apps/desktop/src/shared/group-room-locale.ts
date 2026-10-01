/**
 * Locale-aware Group Room UI strings (Thinking…, Queued…, Ready…).
 * Uses the app/renderer locale when available; falls back to English.
 */

export type GroupRoomLocale = "en" | "pt" | "zh";

export type GroupThinkingStateKey =
  | "thinking"
  | "waitingOnModel"
  | "exploring"
  | "reading"
  | "runningTests"
  | "reviewing"
  | "writing"
  | "implementing"
  | "working"
  | "queued"
  | "waiting"
  | "waitingForYou"
  | "stillWorking"
  | "ready"
  | "done"
  | "failed"
  | "stopped";

const LABELS: Record<GroupRoomLocale, Record<GroupThinkingStateKey, string>> = {
  en: {
    thinking: "Thinking…",
    waitingOnModel: "Waiting on model…",
    exploring: "Exploring…",
    reading: "Reading files…",
    runningTests: "Running tests…",
    reviewing: "Reviewing…",
    writing: "Writing…",
    implementing: "Implementing…",
    working: "Working…",
    queued: "Queued…",
    waiting: "Waiting…",
    waitingForYou: "Waiting for you…",
    stillWorking: "Still working…",
    ready: "Ready for you",
    done: "Done",
    failed: "Failed",
    stopped: "Stopped",
  },
  pt: {
    thinking: "Pensando…",
    waitingOnModel: "Aguardando o modelo…",
    exploring: "Explorando…",
    reading: "Lendo arquivos…",
    runningTests: "Executando testes…",
    reviewing: "Revisando…",
    writing: "Escrevendo…",
    implementing: "Implementando…",
    working: "Trabalhando…",
    queued: "Na fila…",
    waiting: "Aguardando…",
    waitingForYou: "Aguardando você…",
    stillWorking: "Ainda trabalhando…",
    ready: "Pronto para você",
    done: "Concluído",
    failed: "Falhou",
    stopped: "Parado",
  },
  zh: {
    thinking: "思考中…",
    waitingOnModel: "等待模型…",
    exploring: "探索中…",
    reading: "读取文件…",
    runningTests: "运行测试…",
    reviewing: "审查中…",
    writing: "撰写中…",
    implementing: "实现中…",
    working: "工作中…",
    queued: "排队中…",
    waiting: "等待中…",
    waitingForYou: "等待你…",
    stillWorking: "仍在工作…",
    ready: "等待你确认",
    done: "完成",
    failed: "失败",
    stopped: "已停止",
  },
};

/** Normalize a BCP-47 / OS locale tag into a Group Room catalog key. */
export function resolveGroupRoomLocale(tag?: string | null): GroupRoomLocale {
  const raw = (tag ?? detectRendererLocale()).trim().toLowerCase().replace(/_/g, "-");
  if (raw.startsWith("pt")) return "pt";
  if (raw.startsWith("zh")) return "zh";
  return "en";
}

function detectRendererLocale(): string {
  try {
    if (typeof navigator !== "undefined" && navigator.language) return navigator.language;
  } catch {
    // non-browser
  }
  return "en-US";
}

/** Localized label for a Thinking State / ephemeral room indicator. */
export function groupRoomLabel(key: GroupThinkingStateKey, locale?: string | null): string {
  const catalog = LABELS[resolveGroupRoomLocale(locale)];
  return catalog[key];
}

/** Waiting for a named peer: "Waiting for @Name…" / "Aguardando @Name…". */
export function groupWaitingForAgentLabel(name: string, locale?: string | null): string {
  const clean = name.replace(/^@/, "").trim() || "…";
  switch (resolveGroupRoomLocale(locale)) {
    case "pt":
      return `Aguardando @${clean}…`;
    case "zh":
      return `等待 @${clean}…`;
    default:
      return `Waiting for @${clean}…`;
  }
}

/**
 * Compact working shimmer above the composer: "Planner is working…" /
 * "Planner está a trabalhar…" / "Planner 工作中…".
 * Names the active agent(s); empty names → generic Working….
 */
export function groupAgentWorkingLabel(names: readonly string[], locale?: string | null): string {
  const cleaned = names.map((name) => name.replace(/^@/, "").trim()).filter(Boolean);
  const catalog = resolveGroupRoomLocale(locale);
  if (cleaned.length === 0) return groupRoomLabel("working", locale);
  if (cleaned.length === 1) {
    const name = cleaned[0] ?? "";
    switch (catalog) {
      case "pt":
        return `${name} está a trabalhar…`;
      case "zh":
        return `${name} 工作中…`;
      default:
        return `${name} is working…`;
    }
  }
  const list =
    catalog === "zh"
      ? cleaned.join("、")
      : catalog === "pt"
        ? `${cleaned.slice(0, -1).join(", ")} e ${cleaned.at(-1)}`
        : `${cleaned.slice(0, -1).join(", ")} and ${cleaned.at(-1)}`;
  switch (catalog) {
    case "pt":
      return `${list} estão a trabalhar…`;
    case "zh":
      return `${list} 工作中…`;
    default:
      return `${list} are working…`;
  }
}

/** Map live phase / presence into a Thinking State key. */
export function thinkingStateKeyFromLive(input: {
  phase: string;
  presenceState?: string;
  activity?: string | undefined;
  stillWorking?: boolean;
}): GroupThinkingStateKey {
  if (input.stillWorking) return "stillWorking";

  const phase = input.phase.trim();
  const activity = (input.activity ?? "").toLocaleLowerCase();
  const presence = (input.presenceState ?? "").toLocaleLowerCase();

  if (presence === "waiting_for_agent" || /^waiting$/i.test(phase)) return "waiting";
  if (presence === "blocked" || /waiting for you/i.test(phase)) return "waitingForYou";
  if (presence === "queued" || /^queued$/i.test(phase)) return "queued";
  if (
    /test|vitest|jest|pytest|spec/.test(activity) ||
    /test/i.test(phase) ||
    /running tests/i.test(phase)
  ) {
    return "runningTests";
  }
  if (presence === "exploring" || /^explor/i.test(phase)) return "exploring";
  if (presence === "reviewing" || /^review/i.test(phase)) return "reviewing";
  if (presence === "running_tool" || /^implement/i.test(phase) || /^working$/i.test(phase)) {
    if (/read|search|list|find|grep|glob/.test(activity)) return "exploring";
    if (/read/.test(activity)) return "reading";
    if (/edit|writ|patch|bash|run|implement/.test(activity)) return "implementing";
    return "working";
  }
  if (presence === "writing" || /^writ/i.test(phase)) return "writing";
  if (/^read/i.test(phase) || /read|file/.test(activity)) return "reading";
  if (/^done$/i.test(phase)) return "done";
  if (/^failed$/i.test(phase)) return "failed";
  if (/^stopped$/i.test(phase)) return "stopped";
  // Idle on the model (no tool spam yet) — concrete, not opaque "Working"/"Thinking".
  if (
    presence === "thinking" ||
    /waiting on model/i.test(phase) ||
    /thinking/i.test(phase) ||
    !phase
  ) {
    return "waitingOnModel";
  }
  return "waitingOnModel";
}
