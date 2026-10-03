import { z } from "zod";
import type { AppearancePreferences, AppearanceSetInput } from "../../shared/appearance";

const themePreferenceSchema = z.enum(["dark", "light", "dark-plus", "system"]);
const transparencyPreferenceSchema = z.enum(["auto", "off"]);

export const appearancePreferencesSchema: z.ZodType<AppearancePreferences> = z.object({
  theme: themePreferenceSchema,
  transparency: transparencyPreferenceSchema,
});

export const appearanceSetInputSchema: z.ZodType<AppearanceSetInput> = z
  .object({
    theme: themePreferenceSchema.optional(),
    transparency: transparencyPreferenceSchema.optional(),
  })
  .strict();
