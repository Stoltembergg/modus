import { Combobox } from "@base-ui/react/combobox";
import { IconCheck, IconChevronDown, IconSearch, IconSelector } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { buildModelPickerGroups, type PickableModel } from "../../lib/modusModels";
import {
  MODEL_CHIP_BASE,
  MODEL_CHIP_INTERACTIVE,
  MODEL_CHIP_TONE,
  MODEL_CHIP_WARNING,
} from "../composer/modelChipStyle";
import { ProviderLogo } from "../settings/ProviderLogo";

/** One option of the picker; `{ value, label }` lets the Combobox derive label and value. */
type PickerItem = {
  /** Model id; "" is "App default". */
  value: string;
  label: string;
  /** Provider group label (searchable); null for the loose options. */
  provider: string | null;
  providerId: string | null;
  unavailable?: true;
};

type PickerGroup = {
  key: string;
  /** null = the loose options at the top (no heading). */
  label: string | null;
  providerId: string | null;
  items: PickerItem[];
};

/** Lowercased with diacritics stripped (NFKD, then drop combining marks): "Pokémon" → "pokemon". */
export const normalizeSearch = (text: string) =>
  text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();

/** Matches the model name or its provider name (case- and accent-insensitive). */
function matches(item: PickerItem, query: string): boolean {
  const q = normalizeSearch(query.trim());
  if (!q) return true;
  return (
    normalizeSearch(item.label).includes(q) || normalizeSearch(item.provider ?? "").includes(q)
  );
}

/**
 * The agent dialog's model picker: a searchable popover over `buildModelPickerGroups`
 * (provider groups with logo + name, loose "App default" / "(unavailable)" on top, locked
 * Modus models hidden). Base UI Combobox with the input inside the popup: the trigger is the
 * `combobox`, the list a `listbox` with `group`s and `option`s; arrows / Enter / Esc and
 * closed-trigger typeahead come from the primitive, and Esc returns focus to the trigger.
 * Same value semantics as the native select it replaces: `value` is a model id, "" is the
 * app default (only offered when `defaultLabel` is set), anything else unlisted is shown
 * as `placeholder`.
 */
export function ModelPicker({
  label,
  models,
  value,
  onValueChange,
  savedModelId,
  defaultLabel,
  placeholder,
  variant = "field",
  disabled = false,
  tone = "neutral",
  triggerText,
  description,
}: {
  label: string;
  models: readonly PickableModel[];
  value: string;
  onValueChange(modelId: string): void;
  /** Kept as a loose "(unavailable)" option when no longer listed. */
  savedModelId?: string | null | undefined;
  /** Label of the selectable "" option (e.g. "App default"); absent = not offered. */
  defaultLabel?: string | undefined;
  /** Trigger text when nothing is selected. */
  placeholder: string;
  variant?: "field" | "chip" | undefined;
  disabled?: boolean | undefined;
  tone?: "neutral" | "warning" | undefined;
  triggerText?: string | undefined;
  /** Extra screen-reader text on the trigger (e.g. why it is disabled). */
  description?: string | undefined;
}) {
  const groups = useMemo<PickerGroup[]>(() => {
    const built = buildModelPickerGroups(models, savedModelId);
    const loose: PickerItem[] = [
      ...(defaultLabel !== undefined
        ? [{ value: "", label: defaultLabel, provider: null, providerId: null }]
        : []),
      ...built.loose.map((option) => ({
        value: option.id,
        label: option.label,
        provider: null,
        providerId: null,
        unavailable: true as const,
      })),
    ];
    return [
      ...(loose.length > 0 ? [{ key: "loose", label: null, providerId: null, items: loose }] : []),
      ...built.groups.map((group) => ({
        key: group.providerId,
        label: group.label,
        providerId: group.providerId,
        items: group.models.map((model) => ({
          value: model.id,
          label: model.name,
          provider: group.label,
          providerId: group.providerId,
        })),
      })),
    ];
  }, [models, savedModelId, defaultLabel]);

  const byValue = useMemo(
    () => new Map(groups.flatMap((group) => group.items.map((item) => [item.value, item]))),
    [groups],
  );
  const selected = byValue.get(value) ?? null;
  // Only drives the empty-state copy; never touches the chosen model.
  const [query, setQuery] = useState("");

  return (
    <Combobox.Root<PickerItem>
      disabled={disabled}
      filter={matches}
      isItemEqualToValue={(item, current) => item.value === current.value}
      items={groups}
      onInputValueChange={setQuery}
      onValueChange={(item) => {
        if (item) onValueChange(item.value);
      }}
      value={selected}
    >
      {variant === "field" ? (
        <Combobox.Label className="font-medium text-2xs text-fg-subtle">{label}</Combobox.Label>
      ) : null}
      <Combobox.Trigger
        {...(variant === "chip" ? { "aria-label": label } : {})}
        className={
          variant === "chip"
            ? cn(
                MODEL_CHIP_BASE,
                tone === "warning" ? MODEL_CHIP_WARNING : MODEL_CHIP_TONE,
                MODEL_CHIP_INTERACTIVE,
              )
            : cn(
                "group/model flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-hairline bg-canvas/70 pr-2 pl-3 text-left text-sm text-fg outline-none",
                "transition-[border-color,background-color,transform] duration-(--motion-duration-base) ease-standard",
                "hover:border-hairline-strong focus-visible:border-hairline-strong focus-visible:ring-2 focus-visible:ring-focus-ring/40",
                "active:scale-[0.99] data-popup-open:border-hairline-strong motion-reduce:transition-reduced-fade motion-reduce:active:scale-100",
              )
        }
        aria-description={description}
        data-testid="model-picker-trigger"
        data-value={value}
        disabled={disabled}
      >
        {selected?.providerId ? (
          <span aria-hidden className="contents">
            <ProviderLogo
              framed={false}
              name={selected.provider ?? selected.providerId}
              provider={selected.providerId}
              size="sm"
            />
          </span>
        ) : null}
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            variant === "chip"
              ? undefined
              : !selected || selected.unavailable
                ? "text-fg-faint"
                : undefined,
          )}
        >
          {triggerText ?? selected?.label ?? placeholder}
        </span>
        {variant === "chip" ? (
          <IconChevronDown aria-hidden className="shrink-0" size={12} stroke={2} />
        ) : (
          <IconSelector aria-hidden className="shrink-0 text-fg-faint" size={14} />
        )}
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner align="start" className="z-[60] outline-none" sideOffset={6}>
          <Combobox.Popup
            aria-label={label}
            className={cn(
              "flex w-[max(var(--anchor-width),18rem)] max-w-[var(--available-width)] origin-(--transform-origin) flex-col overflow-hidden popup-chrome",
              "transition-[transform,opacity,scale] duration-(--motion-duration-base) ease-standard motion-reduce:transition-reduced-fade",
              "data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0",
            )}
            data-testid="model-picker-popup"
          >
            <div className="flex shrink-0 items-center gap-2 px-3">
              <IconSearch aria-hidden className="shrink-0 text-fg-faint" size={14} />
              <Combobox.Input
                aria-label="Search models"
                className="h-9 w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-muted"
                placeholder="Search models…"
              />
            </div>
            <Combobox.Empty>
              <p className="px-3 py-6 text-center text-xs text-fg-muted">
                {query.trim() ? "No models match" : "No models"}
              </p>
            </Combobox.Empty>
            <Combobox.List className="scroll-thin max-h-[min(22rem,calc(var(--available-height)-3rem))] min-h-0 scroll-pt-8 overflow-y-auto overscroll-contain p-1 outline-none empty:p-0">
              {(group: PickerGroup) => (
                <Combobox.Group
                  className="pb-1 last:pb-0"
                  data-provider={group.providerId ?? undefined}
                  items={group.items}
                  key={group.key}
                >
                  {group.label !== null && group.providerId ? (
                    <Combobox.GroupLabel
                      className="sticky-glass-strip sticky top-0 z-[1] -mx-1 flex items-center gap-2 px-3 pt-2 pb-1 text-2xs text-fg-subtle select-none"
                      data-strip="elevated"
                    >
                      <span aria-hidden className="contents">
                        <ProviderLogo
                          framed={false}
                          name={group.label}
                          provider={group.providerId}
                          size="sm"
                        />
                      </span>
                      {group.label}
                    </Combobox.GroupLabel>
                  ) : null}
                  <Combobox.Collection>
                    {(item: PickerItem) => (
                      <Combobox.Item
                        className={cn(
                          "flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm text-fg outline-none select-none",
                          "transition-colors duration-(--motion-duration-fast) data-highlighted:bg-(--color-picker-highlight) motion-reduce:transition-reduced-fade",
                          item.providerId ? "pl-9" : undefined,
                          item.unavailable ? "text-fg-faint" : undefined,
                        )}
                        key={item.value || "app-default"}
                        value={item}
                      >
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        <Combobox.ItemIndicator className="shrink-0 text-(--color-accent-check)">
                          <IconCheck aria-hidden size={14} stroke={2} />
                        </Combobox.ItemIndicator>
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
