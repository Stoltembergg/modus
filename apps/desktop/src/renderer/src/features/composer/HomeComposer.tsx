import { Composer, type ComposerProps } from "./Composer";
import { HeroModelPicker } from "./SessionModelPicker";

type HomeComposerProps = Omit<ComposerProps, "branchControl" | "model"> & {
  /** App default model from Settings; "" when none is configured. */
  defaultModelId: string;
  /** Model picked for the first message; "" = follow the app default. */
  heroModel: string;
  onHeroModelChange(modelId: string): void;
};

/**
 * Home (hero) composer: there is no chat yet, so the model comes from the host-held
 * pick or the app default. The model chip is the only way to make it sendable when no
 * default is configured, so it is wired here rather than left to the host.
 */
export function HomeComposer({
  defaultModelId,
  heroModel,
  onHeroModelChange,
  models,
  ...rest
}: HomeComposerProps) {
  return (
    <Composer
      {...rest}
      branchControl={
        <HeroModelPicker
          defaultModelId={defaultModelId}
          models={models}
          onValueChange={onHeroModelChange}
          value={heroModel}
        />
      }
      model={heroModel || defaultModelId}
      models={models}
    />
  );
}
