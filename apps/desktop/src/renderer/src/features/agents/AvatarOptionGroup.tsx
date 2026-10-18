import { m, useReducedMotion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import { cn } from "../../lib/cn";
import { MOTION_SPRING, reducedFade } from "../../lib/motion";

/** Selection ring spring (transform only); reduced motion gets a short fade instead. */
const RING_SPRING = MOTION_SPRING.snappy;

export type AvatarOptionGroupProps<T extends string> = {
  /** Group name read by assistive tech ("Face", "Shape", "Color"); also the visible label. */
  label: string;
  options: readonly T[];
  value: T;
  onChange(value: NoInfer<T>): void;
  /** Accessible name of one option. */
  optionLabel(option: NoInfer<T>): string;
  /** The option's visual (an avatar or a color swatch). */
  renderOption(option: NoInfer<T>): ReactNode;
  /** Options that cannot be picked (skipped by the arrow keys). */
  isDisabled?(option: NoInfer<T>): boolean;
  /** Tooltip of a disabled option. */
  disabledTitle?: string | undefined;
  /** `tile` (default): 32 px rounded tiles. `swatch`: round color dots. */
  variant?: "tile" | "swatch";
};

/**
 * One avatar picker row as a radio group: Tab enters on the selected option,
 * arrow keys (and Home / End) move AND select like native radios, disabled
 * options are skipped. The selected option carries the purple accent ring,
 * which slides between options (a short fade with reduced motion).
 */
export function AvatarOptionGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  optionLabel,
  renderOption,
  isDisabled = () => false,
  disabledTitle,
  variant = "tile",
}: AvatarOptionGroupProps<T>) {
  const reduceMotion = useReducedMotion();
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const labelId = useId();
  const swatch = variant === "swatch";

  function move(event: KeyboardEvent<HTMLButtonElement>, from: T): void {
    const enabled = options.filter((option) => option === from || !isDisabled(option));
    const index = enabled.indexOf(from);
    let next: T | undefined;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = enabled[(index + 1) % enabled.length];
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = enabled[(index - 1 + enabled.length) % enabled.length];
        break;
      case "Home":
        next = enabled[0];
        break;
      case "End":
        next = enabled.at(-1);
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next === undefined) return;
    onChange(next);
    refs.current.get(next)?.focus();
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="font-medium text-2xs text-fg-muted" id={labelId}>
        {label}
      </span>
      <div
        aria-labelledby={labelId}
        className={cn("flex flex-wrap", swatch ? "gap-2" : "gap-1")}
        role="radiogroup"
      >
        {options.map((option) => {
          const selected = option === value;
          const disabled = !selected && isDisabled(option);
          return (
            // biome-ignore lint/a11y/useSemanticElements: avatar tiles with a sliding selection ring, not text radios; arrow keys are handled in move()
            <button
              aria-checked={selected}
              aria-label={optionLabel(option)}
              className={cn(
                "relative flex items-center justify-center outline-none",
                "transition-[background-color,opacity,transform] duration-(--motion-duration-base) ease-standard",
                "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-elevated",
                "motion-reduce:transition-reduced-fade motion-reduce:active:scale-100",
                swatch
                  ? "size-6 rounded-full active:scale-90"
                  : "size-8 rounded-lg active:scale-95",
                disabled
                  ? "cursor-not-allowed opacity-35"
                  : !selected && !swatch
                    ? "hover:bg-hover"
                    : null,
              )}
              data-selected={selected || undefined}
              disabled={disabled}
              key={option}
              onClick={() => {
                if (!disabled) onChange(option);
              }}
              onKeyDown={(event) => move(event, option)}
              ref={(node) => {
                if (node) refs.current.set(option, node);
                else refs.current.delete(option);
              }}
              role="radio"
              tabIndex={selected ? 0 : -1}
              title={disabled ? disabledTitle : undefined}
              type="button"
            >
              {selected ? (
                <m.span
                  animate={{ opacity: 1 }}
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute border-2 border-accent",
                    swatch ? "-inset-[3px] rounded-full" : "inset-0 rounded-lg bg-accent/12",
                  )}
                  data-testid="avatar-option-ring"
                  initial={reduceMotion ? { opacity: 0 } : false}
                  {...(reduceMotion ? {} : { layoutId: `${labelId}-ring` })}
                  transition={reduceMotion ? reducedFade : { layout: RING_SPRING }}
                />
              ) : null}
              <span className={cn("relative", swatch && "size-full rounded-full")}>
                {renderOption(option)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** "roundedSquare" → "Rounded square". */
export function humanizeOption(option: string): string {
  const words = option.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
