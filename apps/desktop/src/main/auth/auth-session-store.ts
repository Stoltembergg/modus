import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthPersistence } from "../../shared/auth";

/** Subset of Electron's safeStorage used here (injected so tests never touch the OS keychain). */
export interface AuthSafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  /** Linux only in Electron: "basic_text" means a hardcoded key, i.e. no real protection. */
  getSelectedStorageBackend?(): string;
}

/**
 * Keeps only the Supabase refresh token, encrypted with safeStorage
 * (same file discipline as composio-secret-store.ts: 0700 dir, 0600 file, atomic rename).
 * With no OS-backed encryption nothing is written and any old file is removed.
 */
export interface AuthSessionStore {
  persistence(): Promise<AuthPersistence>;
  load(): Promise<string | undefined>;
  /** Returns false (and stores nothing) when persistence is memory-only. */
  save(refreshToken: string): Promise<boolean>;
  clear(): Promise<void>;
}

type CreateAuthSessionStoreOptions = {
  userDataPath: string;
  safeStorage: AuthSafeStorage;
  platform?: NodeJS.Platform;
};

const DIRECTORY_NAME = "auth";
const FILE_NAME = "supabase-refresh-token.enc";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
/** Backends with no real secret: treat as "no encryption" and keep the session in memory. */
const UNSAFE_LINUX_BACKENDS = new Set(["basic_text", "unknown"]);

export function createAuthSessionStore({
  userDataPath,
  safeStorage,
  platform = process.platform,
}: CreateAuthSessionStoreOptions): AuthSessionStore {
  const directoryPath = join(userDataPath, DIRECTORY_NAME);
  const filePath = join(directoryPath, FILE_NAME);

  async function persistence(): Promise<AuthPersistence> {
    try {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) return "memory-only";
      if (platform === "linux") {
        const backend = safeStorage.getSelectedStorageBackend?.();
        if (!backend || UNSAFE_LINUX_BACKENDS.has(backend)) return "memory-only";
      }
      return "encrypted";
    } catch {
      return "memory-only";
    }
  }

  async function clear(): Promise<void> {
    await rm(filePath, { force: true });
  }

  async function writeAtomically(ciphertext: Buffer): Promise<void> {
    await mkdir(directoryPath, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(directoryPath, DIRECTORY_MODE);
    const temporaryPath = join(directoryPath, `${FILE_NAME}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, ciphertext, { flag: "wx", mode: FILE_MODE });
      await rename(temporaryPath, filePath);
      await chmod(filePath, FILE_MODE);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  return {
    persistence,
    clear,

    async load(): Promise<string | undefined> {
      if ((await persistence()) !== "encrypted") {
        await clear();
        return undefined;
      }
      let ciphertext: Buffer;
      try {
        ciphertext = await readFile(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      try {
        const decrypted = await safeStorage.decryptStringAsync(ciphertext);
        if (typeof decrypted.result !== "string" || decrypted.result.length === 0) {
          throw new Error("empty");
        }
        if (decrypted.shouldReEncrypt) {
          await writeAtomically(await safeStorage.encryptStringAsync(decrypted.result));
        }
        return decrypted.result;
      } catch {
        // Unreadable (key rotated, corrupt): drop it and ask for a new sign-in.
        await clear();
        return undefined;
      }
    },

    async save(refreshToken: string): Promise<boolean> {
      if (!refreshToken) throw new Error("A refresh token is required.");
      if ((await persistence()) !== "encrypted") {
        await clear();
        return false;
      }
      let ciphertext: Buffer;
      try {
        ciphertext = await safeStorage.encryptStringAsync(refreshToken);
      } catch {
        throw new Error("The session could not be encrypted.");
      }
      if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) {
        throw new Error("The session could not be encrypted safely.");
      }
      await writeAtomically(ciphertext);
      return true;
    },
  };
}
