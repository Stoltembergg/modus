import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ComposioSafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{
    result: string;
    shouldReEncrypt: boolean;
  }>;
}

export interface ComposioSecretStore {
  load(): Promise<string | undefined>;
  save(apiKey: string): Promise<void>;
  clear(): Promise<void>;
}

interface CreateComposioSecretStoreOptions {
  userDataPath: string;
  safeStorage: ComposioSafeStorage;
}

const SECRET_DIRECTORY_NAME = "composio";
const SECRET_FILE_NAME = "project-api-key.enc";
const DIRECTORY_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;

export function createComposioSecretStore({
  userDataPath,
  safeStorage,
}: CreateComposioSecretStoreOptions): ComposioSecretStore {
  const directoryPath = join(userDataPath, SECRET_DIRECTORY_NAME);
  const secretPath = join(directoryPath, SECRET_FILE_NAME);

  async function assertAsyncEncryptionAvailable(): Promise<void> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error("OS-backed asynchronous encryption is not available.");
    }
  }

  async function writeCiphertextAtomically(ciphertext: Buffer): Promise<void> {
    await mkdir(directoryPath, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(directoryPath, DIRECTORY_MODE);

    const temporaryPath = join(directoryPath, `${SECRET_FILE_NAME}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, ciphertext, { flag: "wx", mode: SECRET_FILE_MODE });
      await rename(temporaryPath, secretPath);
      await chmod(secretPath, SECRET_FILE_MODE);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  return {
    async load(): Promise<string | undefined> {
      let ciphertext: Buffer;
      try {
        ciphertext = await readFile(secretPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }

      await assertAsyncEncryptionAvailable();

      let decrypted: Awaited<ReturnType<ComposioSafeStorage["decryptStringAsync"]>>;
      try {
        decrypted = await safeStorage.decryptStringAsync(ciphertext);
        if (decrypted.shouldReEncrypt) {
          decrypted = await safeStorage.decryptStringAsync(ciphertext);
        }
      } catch {
        throw new Error("The stored Composio API key could not be decrypted.");
      }

      if (decrypted.shouldReEncrypt || typeof decrypted.result !== "string") {
        throw new Error("The stored Composio API key could not be decrypted safely.");
      }
      return decrypted.result;
    },

    async save(apiKey: string): Promise<void> {
      if (!apiKey) {
        throw new Error("A Composio API key is required.");
      }
      await assertAsyncEncryptionAvailable();

      let ciphertext: Buffer;
      try {
        ciphertext = await safeStorage.encryptStringAsync(apiKey);
      } catch {
        throw new Error("The Composio API key could not be encrypted.");
      }
      if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) {
        throw new Error("The Composio API key could not be encrypted safely.");
      }

      await writeCiphertextAtomically(ciphertext);
    },

    async clear(): Promise<void> {
      await rm(secretPath, { force: true });
    },
  };
}
