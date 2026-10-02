/**
 * Shared look of the composer model chips (C5): the 1:1 composer's interactive
 * ModelSelect / effort triggers and the group composer's read-only chip.
 * `cn` does not merge classes, so tone classes never compete in one element.
 */
export const MODEL_CHIP_BASE =
  "inline-flex h-7 min-w-0 flex-none items-center gap-1 rounded-lg border bg-chip-faint px-2 text-xs font-medium select-none";

/** Neutral tone (border + text); kept out of the base so a warning tone can replace it. */
export const MODEL_CHIP_TONE = "border-hairline-soft text-fg-muted";

/** Only for real triggers (opens a menu); the read-only chip never gets this. */
export const MODEL_CHIP_INTERACTIVE =
  "app-no-drag cursor-pointer touch-manipulation outline-none transition-colors hover:bg-hover hover:text-fg data-popup-open:bg-hover data-popup-open:text-fg data-disabled:pointer-events-none data-disabled:opacity-45";
