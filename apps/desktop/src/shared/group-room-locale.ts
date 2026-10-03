/**
 * Locale-aware Group Room UI strings (Thinking…, Queued…, Ready…).
 * English unless an explicit locale tag is passed (C6.2); the system locale
 * only drives `Intl` date / time formatting (see `groupRoomIntlLocale`).
 */

import {
  FILES_SEARCH_TEXT_EN,
  FILES_SEARCH_TEXT_PT,
  FILES_SEARCH_TEXT_ZH,
  type FilesSearchTextKey,
} from "./files-search-text";
import {
  GROUP_ROOM_TEXT_EN,
  GROUP_ROOM_TEXT_PT,
  GROUP_ROOM_TEXT_ZH,
  type GroupTextKey,
} from "./group-room-text";

export type { FilesSearchTextKey, GroupTextKey };

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

/**
 * Normalize a BCP-47 locale tag into a Group Room catalog key. No tag means
 * `en` (C6.2): UI text never follows the system locale on its own; pt / zh
 * only come from an explicit locale (e.g. a future language selector).
 */
export function resolveGroupRoomLocale(tag?: string | null): GroupRoomLocale {
  const raw = (tag ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (raw.startsWith("pt")) return "pt";
  if (raw.startsWith("zh")) return "zh";
  return "en";
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

// ---------------------------------------------------------------------------
// C6: the room's full UI copy (group-room-text.ts) and helpers around it.
// ---------------------------------------------------------------------------

const GROUP_ROOM_TEXT: Record<GroupRoomLocale, Record<GroupTextKey, string>> = {
  en: GROUP_ROOM_TEXT_EN,
  pt: GROUP_ROOM_TEXT_PT,
  zh: GROUP_ROOM_TEXT_ZH,
};

export type GroupTextVars = Readonly<Record<string, string | number>>;

function fillGroupText(template: string, vars?: GroupTextVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** Room UI copy for `key` in the room locale, with `{name}` placeholders filled. */
export function groupText(key: GroupTextKey, locale?: string | null, vars?: GroupTextVars): string {
  return fillGroupText(GROUP_ROOM_TEXT[resolveGroupRoomLocale(locale)][key], vars);
}

/** Keys that come as a `_one` / `_other` pair. */
export type GroupPluralTextBase = GroupTextKey extends infer K
  ? K extends `${infer B}_one`
    ? B
    : never
  : never;

/** Plural copy: `{base}_one` when count is 1, else `{base}_other`; `{count}` is filled. */
export function groupPluralText(
  base: GroupPluralTextBase,
  count: number,
  locale?: string | null,
  vars?: GroupTextVars,
): string {
  const key = `${base}_${count === 1 ? "one" : "other"}` as GroupTextKey;
  return groupText(key, locale, { count, ...vars });
}

const FILES_SEARCH_TEXT: Record<GroupRoomLocale, Record<FilesSearchTextKey, string>> = {
  en: FILES_SEARCH_TEXT_EN,
  pt: FILES_SEARCH_TEXT_PT,
  zh: FILES_SEARCH_TEXT_ZH,
};

/**
 * Files panel / Search Tool card copy (C6.1) for `key`, resolved with the same
 * rule as the room catalog (pt* → pt, zh* → zh, else en; no tag → renderer locale).
 */
export function filesSearchText(
  key: FilesSearchTextKey,
  locale?: string | null,
  vars?: GroupTextVars,
): string {
  return fillGroupText(FILES_SEARCH_TEXT[resolveGroupRoomLocale(locale)][key], vars);
}

/** Keys of the Files / Search catalog that come as a `_one` / `_other` pair. */
export type FilesSearchPluralBase = FilesSearchTextKey extends infer K
  ? K extends `${infer B}_one`
    ? B
    : never
  : never;

/** Plural Files / Search copy: `_one` when count is 1, else `_other`; `{count}` is filled. */
export function filesSearchPluralText(
  base: FilesSearchPluralBase,
  count: number,
  locale?: string | null,
  vars?: GroupTextVars,
): string {
  const key = `${base}_${count === 1 ? "one" : "other"}` as FilesSearchTextKey;
  return filesSearchText(key, locale, { count, ...vars });
}

const INTL_FALLBACK: Record<GroupRoomLocale, string> = { en: "en-US", pt: "pt-BR", zh: "zh-CN" };

/**
 * The system's hour cycle ("h23" on a pt-BR system, "h12" on en-US), read
 * from the runtime default locale. Undefined when `Intl` can't tell.
 */
export function systemHourCycle(): Intl.DateTimeFormatOptions["hourCycle"] {
  try {
    return new Intl.DateTimeFormat([], { hour: "numeric" }).resolvedOptions().hourCycle;
  } catch {
    return undefined;
  }
}

/**
 * Date / time formatting for UI text (C6.2). With an explicit `Intl` tag it is
 * fully that locale. Without one, names (weekday, month) are en-US so they
 * match the English text around them, while the hour cycle is the system's:
 * 24h "21:47" on a pt system, "9:47 PM" on an en-US one. A numeric hour is
 * never zero-padded ("9:05", as the pre-C6 system format showed it), and the
 * output matches `Date#toLocale*String` spacing.
 */
export function formatGroupRoomDate(
  date: Date,
  options: Intl.DateTimeFormatOptions,
  intlLocale?: string,
): string {
  const hasTime = options.hour !== undefined || options.timeStyle !== undefined;
  const hourCycle = !intlLocale && hasTime ? systemHourCycle() : undefined;
  const format = new Intl.DateTimeFormat(
    intlLocale ?? "en-US",
    hourCycle ? { ...options, hourCycle } : options,
  );
  const text =
    !intlLocale && options.hour === "numeric"
      ? format
          .formatToParts(date)
          .map((part) => (part.type === "hour" ? String(Number(part.value)) : part.value))
          .join("")
      : format.format(date);
  // `Intl.DateTimeFormat` puts U+202F before AM/PM where `Date#toLocale*String`
  // (used before C6.2) prints a plain space; keep the plain space.
  return text.replace(/\u202f/g, " ");
}

/**
 * BCP-47 tag for `Intl` / `toLocale*String` in the room: the same resolution
 * rule as the catalog (pt* → pt, zh* → zh, else en). The raw tag is kept when
 * it resolves to the same catalog locale and `Intl` accepts it (en-GB, pt-PT,
 * zh-TW keep their region); otherwise en-US / pt-BR / zh-CN.
 *
 * No tag → `undefined` (C6.2): format with `formatGroupRoomDate`, which then
 * uses en-US names with the system hour cycle.
 */
export function groupRoomIntlLocale(tag?: string | null): string | undefined {
  if (tag == null || tag.trim() === "") return undefined;
  const raw = tag.trim().replace(/_/g, "-");
  const locale = resolveGroupRoomLocale(raw);
  try {
    const canonical = Intl.getCanonicalLocales(raw)[0];
    if (canonical?.toLowerCase().startsWith(locale)) return canonical;
  } catch {
    // invalid tag: fall back to the catalog default below
  }
  return INTL_FALLBACK[locale];
}

/**
 * Status bodies persisted by the Group Runtime (`GROUP_STATUS_TEXT` in main)
 * stay English in the DB, because agents read them back in the transcript. The
 * room localises them at render time: each English template becomes a matcher
 * (`{x}` captures), and a match is rendered with the same key in `locale`.
 * Unknown bodies come back unchanged.
 */
const PERSISTED_STATUS_KEYS = [
  "status.turnFailed",
  "status.turnStopped",
  "status.stoppedByYou",
  "status.noNextOwner",
  "status.worktreeReady",
  "status.archived",
  "status.limitAgentMessages",
  "status.limitMemberWakes",
  "status.limitInputTokens",
  "status.limitContext",
] as const satisfies readonly GroupTextKey[];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PERSISTED_STATUS_MATCHERS = PERSISTED_STATUS_KEYS.map((key) => {
  const names: string[] = [];
  const source = GROUP_ROOM_TEXT_EN[key]
    .split(/(\{\w+\})/)
    .map((part) => {
      const name = /^\{(\w+)\}$/.exec(part)?.[1];
      if (!name) return escapeRegExp(part);
      names.push(name);
      return "(.+?)";
    })
    .join("");
  return { key, names, pattern: new RegExp(`^${source}$`, "s") };
});

/** The catalog key of a persisted English status body, or null. */
export function matchGroupStatusBody(
  body: string,
): { key: GroupTextKey; vars: Record<string, string> } | null {
  const text = body.trim();
  if (isLegacyWaitingForYouBody(text)) return null;
  for (const matcher of PERSISTED_STATUS_MATCHERS) {
    const match = matcher.pattern.exec(text);
    if (!match) continue;
    const vars: Record<string, string> = {};
    matcher.names.forEach((name, index) => {
      vars[name] = match[index + 1] ?? "";
    });
    return { key: matcher.key, vars };
  }
  return null;
}

/** Render-time translation of a persisted status body (unknown text unchanged). */
export function localizeGroupStatusBody(body: string, locale?: string | null): string {
  if (isLegacyWaitingForYouBody(body)) {
    return body.trim().replace(/^Waiting for you/, groupStatusLabel("waitingForYou", locale));
  }
  const found = matchGroupStatusBody(body);
  return found ? groupText(found.key, locale, found.vars) : body;
}

/**
 * Legacy text detection of the amber "Waiting for you" status: rows written
 * before 90b751e carry only the English body. New turns mark the card with
 * `status: "awaiting_user"` instead (see `isGroupMessageWaitingForYou`).
 */
export function isLegacyWaitingForYouBody(body: string): boolean {
  return body.trim().startsWith("Waiting for you");
}

/**
 * Every catalog of the room, per locale, for the key-parity test. Adding a
 * catalog here puts it under the en/pt/zh parity check.
 */
export const GROUP_ROOM_CATALOGS = {
  labels: LABELS,
  statusOnly: STATUS_ONLY_LABELS,
  memberCard: MEMBER_CARD_TEXT,
  modelChip: MODEL_CHIP_TEXT,
  text: GROUP_ROOM_TEXT,
  filesSearch: FILES_SEARCH_TEXT,
} as const satisfies Record<string, Record<GroupRoomLocale, Record<string, string>>>;
