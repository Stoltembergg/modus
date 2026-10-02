import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const toolkitPolicySchema = z
  .object({
    enabled: z.boolean(),
    selectedToolSlugs: z.array(z.string().min(1)),
    selectedAccountId: z.string().min(1).optional(),
    aliases: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict();

const profileConfigSchema = z
  .object({
    version: z.literal(1),
    profileId: z.string().uuid(),
    sessionId: z.string().min(1).optional(),
    forYou: z
      .object({
        enabled: z.boolean(),
        selectedToolSlugs: z.array(z.string().min(1).max(160)).max(500),
      })
      .strict()
      .optional(),
    toolkits: z.record(z.string().min(1), toolkitPolicySchema),
  })
  .strict();

export type ComposioProfileConfig = z.infer<typeof profileConfigSchema>;

export interface ComposioProfileStore {
  load(): ComposioProfileConfig;
  save(config: ComposioProfileConfig): void;
  update(updater: (current: ComposioProfileConfig) => ComposioProfileConfig): ComposioProfileConfig;
}

interface CreateComposioProfileStoreOptions {
  userDataPath: string;
}

const DIRECTORY_MODE = 0o700;
const PROFILE_FILE_MODE = 0o600;

export function createComposioProfileStore({
  userDataPath,
}: CreateComposioProfileStoreOptions): ComposioProfileStore {
  const directoryPath = join(userDataPath, "composio");
  const profilePath = join(directoryPath, "profile.json");

  function writeProfile(config: ComposioProfileConfig): ComposioProfileConfig {
    const parsed = profileConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new Error("Composio profile data is invalid.");
    }

    mkdirSync(directoryPath, { recursive: true, mode: DIRECTORY_MODE });
    chmodSync(directoryPath, DIRECTORY_MODE);
    const temporaryPath = join(directoryPath, `profile.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(parsed.data, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: PROFILE_FILE_MODE,
      });
      renameSync(temporaryPath, profilePath);
      chmodSync(profilePath, PROFILE_FILE_MODE);
    } catch {
      rmSync(temporaryPath, { force: true });
      throw new Error("Composio profile data could not be saved.");
    }
    return parsed.data;
  }

  function load(): ComposioProfileConfig {
    let contents: string;
    try {
      contents = readFileSync(profilePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Composio profile data could not be read.");
      }

      return writeProfile({ version: 1, profileId: randomUUID(), toolkits: {} });
    }

    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      throw new Error("Composio profile data is malformed.");
    }

    const parsed = profileConfigSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error("Composio profile data is invalid.");
    }
    return parsed.data;
  }

  return {
    load,
    save(config): void {
      writeProfile(config);
    },
    update(updater): ComposioProfileConfig {
      return writeProfile(updater(load()));
    },
  };
}
