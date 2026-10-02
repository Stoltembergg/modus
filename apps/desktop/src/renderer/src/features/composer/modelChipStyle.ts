/**
 * Shared look of the composer model chips (C5): the 1:1 composer's interactive
 * ModelSelect / effort triggers and the group composer's read-only chip.
 */
export const MODEL_CHIP_BASE =
  "inline-flex h-7 min-w-0 flex-none items-center gap-1 rounded-lg border border-hairline-soft bg-chip-faint px-2 text-xs font-medium text-fg-muted select-none";

/** Only for real triggers (opens a menu); the read-only chip never gets this. */
export const MODEL_CHIP_INTERACTIVE =
  "app-no-drag cursor-pointer touch-manipulation outline-none transition-colors hover:bg-hover hover:text-fg data-popup-open:bg-hover data-popup-open:text-fg data-disabled:pointer-events-none data-disabled:opacity-45";
