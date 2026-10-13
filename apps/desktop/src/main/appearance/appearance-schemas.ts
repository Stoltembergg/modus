import { z } from "zod";
import type { AppearanceSetInput } from "../../shared/appearance";

export const themePreferenceSchema = z.enum(["dark", "light", "dark-plus", "system"]);
export const transparencyPreferenceSchema = z.enum(["full", "sidebar", "off"]);
/** Legacy files may hold "classic"; it is accepted and read as "new". */
export const lookPreferenceSchema = z.enum(["classic", "new"]).transform(() => "new" as const);

/** IPC input: exactly these optional fields, nothing else (no `auto` / `on`). */
export const appearanceSetInputSchema: z.ZodType<AppearanceSetInput> = z
  .object({
    theme: themePreferenceSchema.optional(),
    transparency: transparencyPreferenceSchema.optional(),
    look: lookPreferenceSchema.optional(),
  })
  .strict();
