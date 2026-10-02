/**
 * To-dos card — presentation ported and adapted from 21st.dev Agent Elements
 * (`lib/agent-ui/components/tools/todo-tool.tsx`), MIT License,
 * Copyright (c) 2026 21st.dev. See THIRD_PARTY_NOTICES.md at the repo root
 * for the full license text.
 *
 * Modus adaptations: Modus tokens + Tabler status glyphs (all five Modus
 * statuses, including blocked with its reason), the collapsible
 * `.timeline-wire` chrome, ShinyText (respects reduced motion) for the
 * in-flight hints, and change detection keyed by todo id (upstream keys by
 * index). When a list update arrives while the card is mounted, rows whose
 * status changed (or that are new) get a short highlight + glyph pop — the
 * upstream "pending update" diff; skipped under reduced motion.
 */
import {
  IconAlertCircle,
  IconChevronRight,
  IconCircleArrowRight,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconListCheck,
} from "@tabler/icons-react";
import { m, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { TodoItem, TodoStatus } from "../../../../shared/contracts";
import { CollapsibleMotion } from "../../components/ui/CollapsibleMotion";
import { ShinyText } from "../../components/ui/ShinyText";
import { cn } from "../../lib/cn";

/** How long a changed row stays highlighted after an update arrives. */
export const TODO_CHANGE_HIGHLIGHT_MS = 1400;

export type TodoChange = {
  id: string;
  oldStatus?: TodoStatus;
  newStatus: TodoStatus;
};

/**
 * Rows that are new or whose status changed between two snapshots
 * (upstream `detectChanges`, keyed by id so reordering isn't a change).
 */
export function detectTodoChanges(previous: TodoItem[], next: TodoItem[]): TodoChange[] {
  const before = new Map(previous.map((todo) => [todo.id, todo.status]));
  const changes: TodoChange[] = [];
  for (const todo of next) {
    const oldStatus = before.get(todo.id);
    if (oldStatus !== todo.status) {
      changes.push({
        id: todo.id,
        newStatus: todo.status,
        ...(oldStatus ? { oldStatus } : {}),
      });
    }
  }
  return changes;
}

/**
 * Agent task-list snapshot (wireframe To-dos card). The timeline renders one
 * card when the agent creates the list and another when all items are completed.
 * While the displayed `todo_write` call is in flight, the header shows a
 * shimmering "Updating to-dos…" hint.
 *
 * Chrome is `.timeline-wire` — transparent fill + slight radius — so the card
 * shares the chat canvas instead of floating as a grey blotch.
 */
export function TodosCard({ todos, updating }: { todos: TodoItem[]; updating: boolean }) {
  const [open, setOpen] = useState(true);
  const reduceMotion = useReducedMotion();
  const previousRef = useRef(todos);
  const [changed, setChanged] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = todos;
    if (previous === todos) return undefined;
    const changes = detectTodoChanges(previous, todos);
    if (changes.length === 0) return undefined;
    setChanged(new Set(changes.map((change) => change.id)));
    const timeout = globalThis.setTimeout(() => setChanged(new Set()), TODO_CHANGE_HIGHLIGHT_MS);
    return () => globalThis.clearTimeout(timeout);
  }, [todos]);

  const done = todos.filter((todo) => todo.status === "completed").length;
  const creating = updating && todos.length === 0;

  return (
    <section
      className="timeline-wire overflow-hidden"
      data-todos-state={creating ? "creating" : updating ? "updating" : "settled"}
    >
      <button
        aria-expanded={open}
        className="flex h-9 w-full items-center gap-2 px-3 text-left transition-colors hover:bg-hover"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <IconListCheck className="shrink-0 text-fg-subtle" size={14} stroke={1.7} />
        <span className="shrink-0 text-sm text-fg-subtle">To-dos</span>
        <span className="shrink-0 text-sm text-fg-faint tabular-nums">{todos.length}</span>
        {todos.length > 0 ? (
          <span
            className="shrink-0 text-fg-faint text-xs tabular-nums"
            title={`${done} of ${todos.length} completed`}
          >
            · {done} done
          </span>
        ) : null}
        {updating ? (
          <span className="min-w-0 truncate text-xs">
            <ShinyText>{creating ? "Creating to-do list…" : "Updating to-dos…"}</ShinyText>
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        <IconChevronRight
          className={cn(
            "shrink-0 text-fg-faint transition-transform duration-150",
            open && "rotate-90",
          )}
          size={14}
          stroke={1.7}
        />
      </button>
      <CollapsibleMotion open={open} preset="timeline">
        <ul className="border-hairline border-t px-3 py-1.5">
          {todos.length === 0 ? (
            <li className="py-1.5 text-fg-faint text-xs" data-todos-empty>
              {creating ? "Waiting for the first items…" : "No to-dos yet."}
            </li>
          ) : (
            todos.map((todo) => (
              <TodoRow
                animate={!reduceMotion}
                changed={changed.has(todo.id)}
                key={todo.id}
                todo={todo}
              />
            ))
          )}
        </ul>
      </CollapsibleMotion>
    </section>
  );
}

/**
 * Per-status visual language for a to-do row. Centralizing icon + colour here
 * (instead of branching inline) keeps the hierarchy systematic and legible:
 * unfinished work stays muted, the active item gains weight, and finished work
 * recedes to a clearly struck, dimmed tone. Every colour is a Modus token, so
 * dark/light themes flip automatically — no brand purple on the wireframe.
 */
const TODO_ROW_STYLES: Record<
  TodoStatus,
  { Glyph: typeof IconCircleCheck; iconClass: string; iconStroke: number; textClass: string }
> = {
  pending: {
    Glyph: IconCircleDashed,
    iconClass: "text-fg-faint",
    iconStroke: 1.6,
    textClass: "text-fg-subtle",
  },
  in_progress: {
    Glyph: IconCircleArrowRight,
    iconClass: "text-fg-muted",
    iconStroke: 1.8,
    textClass: "text-fg font-medium",
  },
  completed: {
    Glyph: IconCircleCheck,
    iconClass: "text-fg-faint",
    iconStroke: 1.7,
    textClass: "text-fg-faint line-through decoration-fg-faint",
  },
  cancelled: {
    Glyph: IconCircleX,
    iconClass: "text-fg-faint",
    iconStroke: 1.7,
    textClass: "text-fg-faint line-through decoration-fg-faint",
  },
  blocked: {
    Glyph: IconAlertCircle,
    iconClass: "text-warning",
    iconStroke: 1.7,
    textClass: "text-fg-subtle",
  },
};

function TodoRow({
  todo,
  changed = false,
  animate = true,
}: {
  todo: TodoItem;
  changed?: boolean;
  animate?: boolean;
}) {
  const { Glyph, iconClass, iconStroke, textClass } = TODO_ROW_STYLES[todo.status];
  const blocked = todo.status === "blocked";
  return (
    <li
      className={cn(
        "-mx-1.5 flex items-start gap-2.5 rounded-md px-1.5 py-1.5 transition-colors duration-500",
        changed && "bg-build/12",
      )}
      data-changed={changed || undefined}
      data-status={todo.status}
    >
      <m.span
        animate={{ scale: 1, opacity: 1 }}
        className="mt-0.5 flex shrink-0"
        initial={changed && animate ? { scale: 0.6, opacity: 0.4 } : false}
        key={`${todo.status}-${changed ? "changed" : "steady"}`}
        transition={{ duration: 0.22, ease: "easeOut" }}
      >
        <Glyph className={cn("shrink-0", iconClass)} size={14} stroke={iconStroke} />
      </m.span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={cn("text-sm leading-snug", textClass)}>{todo.content}</span>
          {blocked ? <span className="text-xs font-medium text-warning">Blocked</span> : null}
        </div>
        {blocked && todo.blockedReason ? (
          <p className="mt-0.5 break-words text-xs leading-snug text-fg-muted">
            {todo.blockedReason}
          </p>
        ) : null}
      </div>
    </li>
  );
}
