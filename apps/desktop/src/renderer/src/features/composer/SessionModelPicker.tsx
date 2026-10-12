import { Menu } from "@base-ui/react/menu";
import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import type { ModelInfo } from "../../../../shared/contracts";
import { cn } from "../../lib/cn";
import { modelThinkingOptions, selectedThinkingOption } from "../../lib/modelThinking";
import { type PickableModel, selectableModels } from "../../lib/modusModels";
import { useShellText } from "../../lib/shellText";
import { ModelPicker } from "../agents/ModelPicker";
import { MODEL_CHIP_BASE, MODEL_CHIP_INTERACTIVE, MODEL_CHIP_TONE } from "./modelChipStyle";

type SessionModelPickerProps = {
  sessionId: string;
  /** The model saved on the session; undefined = the chat follows the app default. */
  storedModelId: string | undefined;
  defaultModelId: string;
  models: ModelInfo[];
  /** False while the catalog loads: an empty list then means "unknown", never "unusable". */
  modelsReady: boolean;
  isRunning: boolean;
  /** True while the saved model can't be used: the host blocks sending. */
  onBlockedChange(blocked: boolean): void;
  onError(message: string): void;
  /** Called after main saved the change (the host refreshes its session rows). */
  onChanged(): void;
};

/** Usable here = offered by the picker (locked Modus models hidden), enabled and available. */
export function isPickableModel(models: readonly ModelInfo[], modelId: string): boolean {
  const model = models.find((item) => item.id === modelId);
  return Boolean(model && !model.locked && model.available && model.enabled);
}

/** The picker's view of the registry: usable models only (locked Modus ones hidden too). */
function pickableModels(models: readonly ModelInfo[]): PickableModel[] {
  return selectableModels(
    models
      .filter((model) => model.available && model.enabled)
      .map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        providerName: model.providerName,
        locked: Boolean(model.locked),
      })),
  );
}

/**
 * Composer model chip (PR 2): changes ONLY this chat's model through `agent.setModel`
 * (main validates the id and refuses while a run is active). The app default in Settings
 * is never touched. An unusable saved model asks the user to pick and blocks sending.
 * The effort chip appears only when the model has more than one thinking option.
 * Choosing an effort calls `setModel` with the effective model, so it also PINS that model
 * on the chat (a chat on "Default (X)" stops following the default). The level lives on the
 * chat's runtime session; the chip shows the last pick until the pane remounts, then the
 * model's configured level.
 */
export function SessionModelPicker({
  sessionId,
  storedModelId,
  defaultModelId,
  models,
  modelsReady,
  isRunning,
  onBlockedChange,
  onError,
  onChanged,
}: SessionModelPickerProps) {
  const t = useShellText();
  const pickable = useMemo(() => pickableModels(models), [models]);
  const effectiveId = storedModelId || defaultModelId;
  const blocked =
    modelsReady && Boolean(storedModelId) && !isPickableModel(models, storedModelId ?? "");
  const effective = models.find((model) => model.id === effectiveId);
  const options = useMemo(() => (effective ? modelThinkingOptions(effective) : []), [effective]);
  const [effort, setEffort] = useState<string | undefined>(undefined);

  useEffect(() => {
    onBlockedChange(blocked);
  }, [blocked, onBlockedChange]);

  // A new model starts from its configured thinking option.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the model changes.
  useEffect(() => {
    setEffort(undefined);
  }, [effectiveId]);

  async function save(model: string, thinkingVariant?: string): Promise<void> {
    try {
      await window.modus.agent.setModel({
        sessionId,
        model,
        ...(thinkingVariant ? { thinkingVariant } : {}),
      });
      onChanged();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Main's idle-only refusal (pi-sdk-runtime MODEL_CHANGE_RUNNING_ERROR), translated.
      onError(
        message.includes("Can't change the model while a run is active.")
          ? t("shell.modelRunning")
          : message,
      );
    }
  }

  const defaultName = models.find((model) => model.id === defaultModelId)?.name ?? defaultModelId;
  const triggerText = blocked
    ? t("shell.pickModel")
    : storedModelId
      ? undefined
      : t("shell.modelDefault", { name: defaultName });
  const currentEffort = effective
    ? (options.find((option) => option.value === effort) ?? selectedThinkingOption(effective))
    : undefined;

  return (
    <>
      <span className="inline-flex min-w-0" title={isRunning ? t("shell.modelRunning") : undefined}>
        <ModelPicker
          description={isRunning ? t("shell.modelRunning") : undefined}
          disabled={isRunning}
          label={t("shell.model")}
          models={pickable}
          onValueChange={(next) => {
            if (next && next !== storedModelId) void save(next);
          }}
          placeholder={t("shell.pickModel")}
          savedModelId={storedModelId}
          tone={blocked ? "warning" : "neutral"}
          {...(triggerText ? { triggerText } : {})}
          value={storedModelId ?? defaultModelId}
          variant="chip"
        />
      </span>
      {!blocked && effective && options.length > 1 && currentEffort ? (
        <Menu.Root>
          <Menu.Trigger
            aria-description={isRunning ? t("shell.modelRunning") : undefined}
            aria-label={t("shell.effort")}
            className={cn(MODEL_CHIP_BASE, MODEL_CHIP_INTERACTIVE, MODEL_CHIP_TONE)}
            data-testid="session-effort-picker"
            disabled={isRunning}
          >
            <span className="max-w-[6rem] truncate">{currentEffort.label}</span>
            <IconChevronDown aria-hidden size={12} stroke={2} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner align="start" side="top" sideOffset={6}>
              <Menu.Popup className="origin-(--transform-origin) min-w-[160px] popup-chrome popup-motion p-1">
                {options.map((option) => (
                  <Menu.Item
                    className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-fg text-sm outline-none select-none data-highlighted:bg-hover"
                    key={option.value}
                    onClick={() => {
                      setEffort(option.value);
                      void save(effectiveId, option.value);
                    }}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center text-accent">
                      {option.value === currentEffort.value ? (
                        <IconCheck size={14} stroke={2} />
                      ) : null}
                    </span>
                    {option.label}
                  </Menu.Item>
                ))}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      ) : null}
    </>
  );
}
