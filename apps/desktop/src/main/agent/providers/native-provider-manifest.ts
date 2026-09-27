import { z } from "zod";
import { antigravityModels } from "./antigravity-models";
import { commandCodeModels } from "./commandcode-models";

export const COMMANDCODE_API_ID = "commandcode-alpha-generate";
export const ANTIGRAVITY_API_ID = "antigravity-cloud-code-assist";
export const COMMANDCODE_PR_HEAD = "7846a5c1d65f7732d69c96a65df74df4d6f3d521";
export const ANTIGRAVITY_SOURCE_COMMIT = "16e0056431d0a1291ee66e5938c732720b13a851";

const reasoningVariantSchema = z
  .object({
    thinkingLevel: z.enum(["minimal", "low", "medium", "high"]).optional(),
    thinkingBudget: z.number().int().positive().optional(),
  })
  .strict();

export const nativeProviderModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    reasoningSupported: z.boolean(),
    contextWindow: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    tier: z.enum(["premium", "open-source"]).optional(),
    toolCallsSupported: z.boolean().optional(),
    input: z.array(z.enum(["text", "image"])).min(1),
    pricingAvailability: z.literal("unknown").optional(),
    quotaRoute: z.enum(["antigravity", "gemini-cli"]).optional(),
    sourceModalities: z.array(z.enum(["text", "image", "pdf"])).optional(),
    reasoningVariants: z.record(z.string(), reasoningVariantSchema).optional(),
  })
  .strict();

const nativeProviderEntrySchema = z
  .object({
    apiId: z.string().min(1),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    models: z.array(nativeProviderModelSchema).min(1),
  })
  .strict();

const providersSchema = z
  .record(z.string(), nativeProviderEntrySchema)
  .superRefine((providers, ctx) => {
    const apiIds = new Set<string>();
    for (const [providerId, provider] of Object.entries(providers)) {
      if (apiIds.has(provider.apiId)) {
        ctx.addIssue({ code: "custom", message: `Duplicate native API ID: ${provider.apiId}` });
      }
      apiIds.add(provider.apiId);

      const modelIds = new Set<string>();
      for (const model of provider.models) {
        if (modelIds.has(model.id)) {
          ctx.addIssue({
            code: "custom",
            message: `Duplicate model identity: ${providerId}/${model.id}`,
          });
        }
        modelIds.add(model.id);
        if (providerId === "antigravity" && "toolCallsSupported" in model) {
          ctx.addIssue({
            code: "custom",
            message: `Antigravity tool-call support must be absent: ${model.id}`,
          });
        }
      }
    }
  });

export const nativeProviderManifestSchema = z.object({ providers: providersSchema }).strict();

export type NativeProviderModel = z.infer<typeof nativeProviderModelSchema>;
export type NativeProviderManifest = z.infer<typeof nativeProviderManifestSchema>;

export const nativeProviderManifest = nativeProviderManifestSchema.parse({
  providers: {
    commandcode: {
      apiId: COMMANDCODE_API_ID,
      sourceCommit: COMMANDCODE_PR_HEAD,
      models: commandCodeModels,
    },
    antigravity: {
      apiId: ANTIGRAVITY_API_ID,
      sourceCommit: ANTIGRAVITY_SOURCE_COMMIT,
      models: antigravityModels,
    },
  },
});

type CatalogModel = { id: string; [key: string]: unknown };
type Catalog = { providers: Record<string, readonly CatalogModel[]>; [key: string]: unknown };
type NativeProviderMergeInput =
  | NativeProviderManifest
  | { providers: Record<string, readonly CatalogModel[]> };

export function mergeNativeProviderMetadata<T extends Catalog>(
  baseCatalog: T,
  manifest: NativeProviderMergeInput,
): T {
  const providersToMerge = Object.entries(manifest.providers).map(
    ([providerId, provider]) =>
      [providerId, Array.isArray(provider) ? provider : provider.models] as const,
  );
  for (const [providerId, models] of providersToMerge) {
    const baseModels = baseCatalog.providers[providerId] ?? [];
    const baseIds = new Set(baseModels.map(({ id }) => id));
    for (const model of models) {
      if (baseIds.has(model.id)) {
        throw new Error(`Native provider metadata collision: ${providerId}/${model.id}`);
      }
      baseIds.add(model.id);
    }
  }

  const providers: Record<string, readonly CatalogModel[]> = { ...baseCatalog.providers };
  for (const [providerId, models] of providersToMerge) {
    providers[providerId] = [...(providers[providerId] ?? []), ...models];
  }
  return { ...baseCatalog, providers } as T;
}

export { antigravityModels, commandCodeModels };
