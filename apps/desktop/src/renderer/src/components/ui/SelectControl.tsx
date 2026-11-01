import { Select } from "@base-ui/react/select";
import { IconCheck, IconChevronDown } from "@tabler/icons-react";

const EMPTY_OPTION = "\u0000modus-empty-option";

export type SelectControlOption<T extends string> = {
  label: string;
  value: T;
  disabled?: boolean | undefined;
  lang?: string | undefined;
};

export type SelectControlGroup<T extends string> = {
  key?: string | undefined;
  label: string;
  options: readonly SelectControlOption<T>[];
};

/** Branded, keyboard-accessible select popup shared by renderer form controls. */
export function SelectControl<T extends string>({
  ariaLabel,
  className,
  disabled = false,
  form,
  groups = [],
  id,
  name,
  onValueChange,
  options,
  placeholder,
  required,
  testId,
  value,
}: {
  ariaLabel?: string | undefined;
  className?: string | undefined;
  disabled?: boolean | undefined;
  form?: string | undefined;
  groups?: readonly SelectControlGroup<T>[] | undefined;
  id?: string | undefined;
  name?: string | undefined;
  onValueChange(value: T): void;
  options: readonly SelectControlOption<T>[];
  placeholder?: string | undefined;
  required?: boolean | undefined;
  testId?: string | undefined;
  value: T | null | undefined;
}) {
  const allOptions = [...options, ...groups.flatMap((group) => group.options)];
  const hasEmptyOption = allOptions.some((option) => option.value === "");
  const encodeValue = (optionValue: string) => (optionValue === "" ? EMPTY_OPTION : optionValue);
  const selectedValue =
    value == null || (value === "" && !hasEmptyOption) ? null : encodeValue(value);

  function renderOption(option: SelectControlOption<T>) {
    return (
      <Select.Item
        className="grid h-8 cursor-default grid-cols-[minmax(0,1fr)_16px] items-center gap-2 rounded-md px-2 text-sm text-fg-muted outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 data-highlighted:bg-hover data-highlighted:text-fg"
        disabled={option.disabled}
        key={option.value}
        value={encodeValue(option.value)}
      >
        <Select.ItemText className="min-w-0 truncate" lang={option.lang}>
          {option.label}
        </Select.ItemText>
        <span className="flex justify-center text-fg">
          <Select.ItemIndicator>
            <IconCheck size={13} stroke={2} />
          </Select.ItemIndicator>
        </span>
      </Select.Item>
    );
  }

  return (
    <Select.Root
      disabled={disabled}
      form={form}
      name={name}
      onValueChange={(next) => {
        if (typeof next === "string") {
          onValueChange((next === EMPTY_OPTION ? "" : next) as T);
        }
      }}
      required={required}
      value={selectedValue}
    >
      <Select.Trigger
        aria-label={ariaLabel}
        className={
          className ??
          "flex h-10 w-full items-center justify-between gap-3 rounded-md border border-hairline bg-canvas px-3 text-sm text-fg outline-none transition-colors hover:border-hairline-strong focus-visible:border-focus-ring/60 focus-visible:ring-2 focus-visible:ring-focus-ring data-popup-open:border-hairline-strong"
        }
        data-testid={testId}
        id={id}
      >
        <Select.Value>
          {(selected) => {
            if (selected == null) return placeholder ?? "";
            const option = allOptions.find((entry) => encodeValue(entry.value) === selected);
            return option?.label ?? String(selected);
          }}
        </Select.Value>
        <Select.Icon>
          <IconChevronDown className="shrink-0 text-fg-faint" size={14} stroke={1.8} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          align="start"
          alignItemWithTrigger={false}
          collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
          side="bottom"
          sideOffset={5}
        >
          <Select.Popup className="scroll-thin origin-(--transform-origin) max-h-[min(20rem,var(--available-height))] min-w-[var(--anchor-width)] overflow-y-auto popup-chrome p-1 transition-[transform,opacity] duration-(--motion-duration-fast) data-[side=bottom]:data-ending-style:translate-y-[-4px] data-[side=bottom]:data-starting-style:translate-y-[-4px] data-[side=top]:data-ending-style:translate-y-[4px] data-[side=top]:data-starting-style:translate-y-[4px] data-ending-style:opacity-0 data-starting-style:opacity-0">
            {options.map(renderOption)}
            {groups.map((group) => (
              <Select.Group key={group.key ?? group.label}>
                <Select.GroupLabel className="px-2 pt-2 pb-1 font-medium text-2xs text-fg-muted first:pt-1">
                  {group.label}
                </Select.GroupLabel>
                {group.options.map(renderOption)}
              </Select.Group>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
