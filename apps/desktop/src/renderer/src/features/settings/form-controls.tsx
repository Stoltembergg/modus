import { Switch } from "@base-ui/react/switch";
import { IconChevronRight, IconPlus, IconTrash } from "@tabler/icons-react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { type ReactNode, useId, useState } from "react";
import { CollapsibleMotion } from "../../components/ui/CollapsibleMotion";
import {
  SelectControl,
  type SelectControlGroup,
  type SelectControlOption,
} from "../../components/ui/SelectControl";
import { cn } from "../../lib/cn";
import { MOTION_SPRING, motionTransition, tween } from "../../lib/motion";
import { useSettingsText } from "../../lib/settingsText";
import type { KeyValueRow } from "./provider-form-mapping";

/**
 * Shared low-level form primitives for the Settings surface (fields, selects,
 * switches, disclosures, key/value rows). Extracted from SettingsPanel so the
 * provider dialogs and future settings pages compose the same building blocks.
 * Pure value helpers (key/value rows, numeric parsing) live in
 * provider-form-mapping and are re-exported here for UI consumers.
 */

export {
  createKeyValueRow,
  type KeyValueRow,
  keyValueRowsToRecord,
  parseOptionalNumber,
  parsePositiveInteger,
  recordToKeyValueRows,
} from "./provider-form-mapping";

export function optionLabel<T extends string>(
  options: readonly { label: string; value: T }[],
  value: string,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

export type SelectFieldOption<T extends string> = SelectControlOption<T>;
export type SelectFieldOptionGroup<T extends string> = SelectControlGroup<T>;

export function Field({
  autoComplete,
  description,
  label,
  mono = false,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  autoComplete?: string;
  description?: string;
  label: string;
  /** Render the input in the mono face (ids, URLs, header values). */
  mono?: boolean;
  value: string;
  onChange(value: string): void;
  placeholder: string;
  type?: string;
}) {
  return (
    <label className="grid gap-2">
      <span className="text-xs text-fg-muted">{label}</span>
      <input
        autoComplete={autoComplete}
        className={cn(
          "h-10 w-full rounded-md border border-hairline bg-canvas px-3 text-sm text-fg outline-none placeholder:text-fg-faint transition-colors hover:border-hairline-strong focus:border-focus-ring/60 focus:ring-2 focus:ring-focus-ring/35",
          mono && "font-mono",
        )}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type={type}
        value={value}
      />
      {description ? <span className="text-xs leading-5 text-fg-muted">{description}</span> : null}
    </label>
  );
}

export function SelectField<T extends string>({
  label,
  labelHidden = false,
  value,
  options,
  groups = [],
  onChange,
  placeholder,
  disabled = false,
  triggerClassName,
}: {
  label: string;
  /** Keep the label for screen readers only (the row title already shows it). */
  labelHidden?: boolean;
  value: T | null | undefined;
  /** `lang` marks an option written in another language (native language names). */
  options: readonly SelectFieldOption<T>[];
  /** Provider or category groups, rendered inside the same themed popup. */
  groups?: readonly SelectFieldOptionGroup<T>[];
  /** Shown while no option is selected. */
  placeholder?: string;
  onChange(value: T): void;
  disabled?: boolean;
  /** Replaces the default trigger classes for compact or context-specific controls. */
  triggerClassName?: string;
}) {
  return (
    <div className="grid gap-2">
      <span className={labelHidden ? "sr-only" : "text-xs text-fg-muted"}>{label}</span>
      <SelectControl
        ariaLabel={label}
        className={triggerClassName}
        disabled={disabled}
        groups={groups}
        onValueChange={onChange}
        options={options}
        placeholder={placeholder}
        value={value}
      />
    </div>
  );
}

export function SwitchControl({
  ariaLabel,
  checked,
  disabled,
  onCheckedChange,
}: {
  ariaLabel: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange(checked: boolean): void;
}) {
  return (
    <Switch.Root
      aria-label={ariaLabel}
      checked={checked}
      className={cn(
        "relative flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-chip-strong px-0.5 outline-none transition-colors duration-(--motion-duration-base) ease-standard",
        "data-[checked]:bg-accent",
        "data-[unchecked]:hover:bg-chip-strong",
        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        "focus-visible:ring-2 focus-visible:ring-focus-ring/50 focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
      )}
      disabled={disabled}
      onCheckedChange={(nextChecked) => onCheckedChange(nextChecked)}
    >
      <Switch.Thumb
        className={cn(
          "block size-4 rounded-full bg-fg-muted shadow-sm transition-[translate,background-color] duration-(--motion-duration-base) ease-standard motion-reduce:transition-colors",
          "data-[checked]:translate-x-4 data-[checked]:bg-on-accent",
          "data-[unchecked]:translate-x-0",
        )}
      />
    </Switch.Root>
  );
}

/**
 * Segmented choice (theme, transparency, scopes). The selected option gets the
 * accent tint and text; the tint slides between options with the snappy spring,
 * and fades in place when motion is reduced.
 */
export function SettingsSegmented<T extends string>({
  disabled = false,
  label,
  onChange,
  options,
  value,
}: {
  disabled?: boolean;
  label: string;
  onChange(value: T): void;
  options: ReadonlyArray<{ value: T; label: string; title?: string; icon?: ReactNode }>;
  value: T;
}) {
  const indicatorId = useId();
  const reduced = useReducedMotion() ?? false;
  return (
    <fieldset
      aria-label={label}
      className={cn(
        "flex min-w-0 items-center gap-0.5 rounded-lg bg-chip p-0.5",
        disabled && "opacity-50",
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            aria-pressed={active}
            className={cn(
              "relative flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs outline-none transition-colors disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-focus-ring/50",
              active ? "text-(--accent-text,var(--color-accent))" : "text-fg-muted hover:text-fg",
            )}
            disabled={disabled}
            key={option.value}
            onClick={() => onChange(option.value)}
            title={option.title}
            type="button"
          >
            {active ? (
              <m.span
                aria-hidden
                className="absolute inset-0 rounded-md bg-selected"
                data-settings-selected=""
                layoutId={indicatorId}
                transition={motionTransition(MOTION_SPRING.snappy, reduced)}
              />
            ) : null}
            <span className="relative flex items-center gap-1.5">
              {option.icon}
              {option.label}
            </span>
          </button>
        );
      })}
    </fieldset>
  );
}

/** Compact labeled switch row — one line, no card chrome. */
export function ToggleField({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange(value: boolean): void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <span className="min-w-0 text-sm text-fg">{label}</span>
      <SwitchControl ariaLabel={label} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export function Disclosure({
  label,
  defaultOpen = false,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="grid gap-3">
      <button
        aria-expanded={open}
        className="flex w-fit items-center gap-1.5 text-xs text-fg-subtle transition-colors hover:text-fg"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <IconChevronRight
          className="disclosure-chevron duration-(--motion-duration-base)"
          data-open={open ? "" : undefined}
          size={13}
          stroke={1.8}
        />
        {label}
      </button>
      <CollapsibleMotion open={open} preset="default">
        <div className="grid gap-5 pt-1">{children}</div>
      </CollapsibleMotion>
    </div>
  );
}

/** Borderless key/value row list with add/remove — used for header editors. */
export function KeyValueEditor({
  addLabel,
  emptyLabel,
  keyPlaceholder,
  rows,
  title,
  valuePlaceholder,
  onAdd,
  onChange,
  onRemove,
}: {
  addLabel: string;
  emptyLabel: string;
  keyPlaceholder: string;
  rows: KeyValueRow[];
  title: string;
  valuePlaceholder: string;
  onAdd(): void;
  onChange(rowId: string, patch: Partial<KeyValueRow>): void;
  onRemove(rowId: string): void;
}) {
  const t = useSettingsText();
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="min-w-0 text-xs text-fg-muted">{title}</h3>
        <button
          className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
          onClick={onAdd}
          type="button"
        >
          <IconPlus size={13} stroke={1.8} />
          {addLabel}
        </button>
      </div>
      <div className="grid gap-2">
        <AnimatePresence initial={false}>
          {rows.map((row) => (
            <m.div
              animate={{ opacity: 1, y: 0 }}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] gap-2"
              exit={{ opacity: 0, y: -4 }}
              initial={{ opacity: 0, y: 4 }}
              key={row.rowId}
              layout
              transition={tween("base")}
            >
              <input
                aria-label={t("settings.window.keyValueKeyAriaLabel", { title })}
                className="h-9 rounded-md border border-hairline bg-canvas px-3 font-mono text-xs text-fg outline-none placeholder:text-fg-faint transition-colors hover:border-hairline-strong focus:border-focus-ring/60 focus:ring-2 focus:ring-focus-ring/35"
                onChange={(event) => onChange(row.rowId, { key: event.target.value })}
                placeholder={keyPlaceholder}
                value={row.key}
              />
              <input
                aria-label={t("settings.window.keyValueValueAriaLabel", { title })}
                className="h-9 rounded-md border border-hairline bg-canvas px-3 font-mono text-xs text-fg outline-none placeholder:text-fg-faint transition-colors hover:border-hairline-strong focus:border-focus-ring/60 focus:ring-2 focus:ring-focus-ring/35"
                onChange={(event) => onChange(row.rowId, { value: event.target.value })}
                placeholder={valuePlaceholder}
                value={row.value}
              />
              <button
                aria-label={t("settings.window.removeRow")}
                className="flex size-7 items-center justify-center self-center rounded-md text-fg-faint transition-colors hover:bg-hover hover:text-fg"
                onClick={() => onRemove(row.rowId)}
                type="button"
              >
                <IconTrash size={13} stroke={1.7} />
              </button>
            </m.div>
          ))}
        </AnimatePresence>
        {rows.length === 0 ? <p className="text-xs text-fg-muted">{emptyLabel}</p> : null}
      </div>
    </section>
  );
}
