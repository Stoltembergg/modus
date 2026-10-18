import { IconCornerDownRight, IconPhoto, IconX } from "@tabler/icons-react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import type { QueuedPromptItem } from "../../../../shared/contracts";
import { queuedPromptMotion } from "../../lib/motion";

/** One line of what the user typed: whitespace collapsed, truncated by CSS. */
export function queuedPromptPreview(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Prompts sent while the agent works, in arrival order, until the agent takes
 * them. One borderless glass surface above the composer, no dividers and no
 * labels. Each row's remove button shows on hover or keyboard focus and
 * removes that prompt (by its queue id) from the runtime queue.
 */
export function QueuedPromptStrip({
  items,
  onRemove,
}: {
  items: QueuedPromptItem[];
  onRemove(id: string): void;
}) {
  const reducedMotion = useReducedMotion() ?? false;
  const motion = queuedPromptMotion(reducedMotion);

  return (
    <AnimatePresence initial={false}>
      {items.length > 0 ? (
        <m.div
          animate={motion.strip.animate}
          className="queued-prompt-strip mb-1.5"
          data-testid="queued-prompt-strip"
          exit={motion.strip.exit}
          initial={motion.strip.initial}
          key="queued-prompt-strip"
          layout
          transition={motion.strip.transition}
        >
          <ul aria-label="Queued messages" className="flex flex-col gap-0.5 p-1">
            <AnimatePresence initial={false}>
              {items.map((item) => {
                const preview = queuedPromptPreview(item.text);
                return (
                  <m.li
                    animate={motion.item.animate}
                    className="queued-prompt-item group/queued flex min-w-0 items-center gap-2 py-1 pr-1 pl-2"
                    data-queued-prompt-id={item.id}
                    exit={motion.item.exit}
                    initial={motion.item.initial}
                    key={item.id}
                    layout
                    transition={motion.item.transition}
                  >
                    <IconCornerDownRight
                      aria-hidden
                      className="queued-prompt-glyph shrink-0"
                      size={14}
                      stroke={1.7}
                    />
                    <span
                      className="queued-prompt-text min-w-0 flex-1 truncate text-sm"
                      title={item.text}
                    >
                      {preview}
                    </span>
                    {item.imageCount > 0 ? (
                      <span
                        className="queued-prompt-meta inline-flex shrink-0 items-center gap-1 text-xs tabular-nums"
                        data-testid="queued-prompt-images"
                      >
                        <IconPhoto
                          aria-label={item.imageCount === 1 ? "image" : "images"}
                          role="img"
                          size={13}
                          stroke={1.7}
                        />
                        {item.imageCount}
                      </span>
                    ) : null}
                    <button
                      aria-label={`Remove queued message: ${preview}`}
                      className="queued-prompt-remove flex size-6 shrink-0 items-center justify-center opacity-0 group-hover/queued:opacity-100 focus-visible:opacity-100"
                      onClick={() => onRemove(item.id)}
                      type="button"
                    >
                      <IconX aria-hidden size={13} stroke={1.8} />
                    </button>
                  </m.li>
                );
              })}
            </AnimatePresence>
          </ul>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}
