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

/**
 * Static state labels (message card badges, delivery footer). These reuse the
 * live-indicator keys where one exists (`queued`, `waitingForYou`, `failed`) so
 * the card and the footer say exactly the same words, but drop the trailing
 * "…": a badge names a state, it does not animate an ongoing one.
 */
export type GroupStatusLabelKey =
  | "queued"
  | "waitingForYou"
  | "failed"
  | "completed"
  | "cancelled"
  | "interrupted";

const STATUS_ONLY_LABELS: Record<
  GroupRoomLocale,
  Record<"completed" | "cancelled" | "interrupted", string>
> = {
  en: { completed: "Completed", cancelled: "Cancelled", interrupted: "Interrupted" },
  pt: { completed: "Concluído", cancelled: "Cancelado", interrupted: "Interrompido" },
  zh: { completed: "已完成", cancelled: "已取消", interrupted: "已中断" },
};

export function groupStatusLabel(key: GroupStatusLabelKey, locale?: string | null): string {
  if (key === "queued" || key === "waitingForYou" || key === "failed") {
    return groupRoomLabel(key, locale).replace(/…$/u, "");
  }
  return STATUS_ONLY_LABELS[resolveGroupRoomLocale(locale)][key];
}

/** Member turn card copy: fallback progress line and the retry button. */
export type GroupMemberCardTextKey =
  | "waitingForTurn"
  | "workingOnTask"
  | "writingReply"
  | "retryTask"
  | "resumeTask"
  | "sending";

const MEMBER_CARD_TEXT: Record<GroupRoomLocale, Record<GroupMemberCardTextKey, string>> = {
  en: {
    waitingForTurn: "Waiting for its turn",
    workingOnTask: "Working on the task",
    writingReply: "Writing a reply",
    retryTask: "Retry task",
    resumeTask: "Resume task",
    sending: "Sending…",
  },
  pt: {
    waitingForTurn: "Aguardando a vez",
    workingOnTask: "Trabalhando na tarefa",
    writingReply: "Escrevendo uma resposta",
    retryTask: "Tentar de novo",
    resumeTask: "Retomar tarefa",
    sending: "Enviando…",
  },
  zh: {
    waitingForTurn: "等待轮到它",
    workingOnTask: "正在处理任务",
    writingReply: "正在撰写回复",
    retryTask: "重试任务",
    resumeTask: "继续任务",
    sending: "发送中…",
  },
};

export function groupMemberCardText(key: GroupMemberCardTextKey, locale?: string | null): string {
  return MEMBER_CARD_TEXT[resolveGroupRoomLocale(locale)][key];
}

/** Group composer read-only model chip copy (C5). */
export type GroupModelChipTextKey =
  | "model"
  | "leadDefault"
  | "noLead"
  | "defaultModel"
  | "coordinatorLead"
  | "replyAuthor"
  | "archived"
  | "leadArchived"
  | "noTarget"
  | "nobody"
  | "archivedHint"
  | "leadArchivedHint"
  | "noTargetHint"
  | "archivedSkipped";

const MODEL_CHIP_TEXT: Record<GroupRoomLocale, Record<GroupModelChipTextKey, string>> = {
  en: {
    model: "Model",
    leadDefault: "Lead answers by default",
    noLead: "No Lead: the room picks who answers",
    defaultModel: "Default model",
    coordinatorLead: "Coordinator mode: the Lead answers",
    replyAuthor: "Reply goes to the message author",
    archived: "Archived",
    leadArchived: "Lead archived",
    noTarget: "No recipient",
    nobody: "Nobody will answer",
    archivedHint: "Mention an active member or unarchive the agent",
    leadArchivedHint: "Mention an active member or unarchive the Lead",
    noTargetHint: "The author is no longer in the room. Mention an active member",
    archivedSkipped: "Archived, will not be woken",
  },
  pt: {
    model: "Modelo",
    leadDefault: "Lead responde por padrão",
    noLead: "Sem Lead: a sala escolhe quem responde",
    defaultModel: "Modelo padrão",
    coordinatorLead: "Modo coordenador: o Lead responde",
    replyAuthor: "A resposta vai para o autor da mensagem",
    archived: "Arquivado",
    leadArchived: "Lead arquivado",
    noTarget: "Sem destinatário",
    nobody: "Ninguém vai responder",
    archivedHint: "Mencione um membro ativo ou desarquive o agente",
    leadArchivedHint: "Mencione um membro ativo ou desarquive o Lead",
    noTargetHint: "O autor não está mais na sala. Mencione um membro ativo",
    archivedSkipped: "Arquivado, não será acordado",
  },
  zh: {
    model: "模型",
    leadDefault: "默认由 Lead 回答",
    noLead: "没有 Lead：由群组决定谁回答",
    defaultModel: "默认模型",
    coordinatorLead: "协调模式：由 Lead 回答",
    replyAuthor: "回复将发给该消息的作者",
    archived: "已归档",
    leadArchived: "Lead 已归档",
    noTarget: "没有接收者",
    nobody: "没有人会回答",
    archivedHint: "请提及一位活跃成员，或取消归档该智能体",
    leadArchivedHint: "请提及一位活跃成员，或取消归档 Lead",
    noTargetHint: "作者已不在群组中。请提及一位活跃成员",
    archivedSkipped: "已归档，不会被唤醒",
  },
};

export function groupModelChipText(key: GroupModelChipTextKey, locale?: string | null): string {
  return MODEL_CHIP_TEXT[resolveGroupRoomLocale(locale)][key];
}

/** "3 models" / "3 modelos" / "3 个模型". */
export function groupModelCountLabel(count: number, locale?: string | null): string {
  switch (resolveGroupRoomLocale(locale)) {
    case "pt":
      return `${count} modelos`;
    case "zh":
      return `${count} 个模型`;
    default:
      return `${count} models`;
  }
}
