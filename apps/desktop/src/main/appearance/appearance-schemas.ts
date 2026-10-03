import { z } from "zod";
import type { AppearanceSetInput } from "../../shared/appearance";

export const themePreferenceSchema = z.enum(["dark", "light", "dark-plus", "system"]);
export const transparencyPreferenceSchema = z.enum(["full", "sidebar", "off"]);

/** IPC input: exactly these two optional fields, nothing else (no `auto` / `on`). */
export const appearanceSetInputSchema: z.ZodType<AppearanceSetInput> = z
  .object({
    theme: themePreferenceSchema.optional(),
    transparency: transparencyPreferenceSchema.optional(),
  })
  .strict();
