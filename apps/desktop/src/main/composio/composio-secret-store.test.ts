import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createComposioSecretStore } from "./composio-secret-store";

describe("Composio secret store", () => {
  let userDataPath: string;

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), "modus-composio-secret-"));
  });

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true });
  });

  function createSafeStorage(available = true) {
    return {
      isAsyncEncryptionAvailable: vi.fn(async () => available),
      encryptStringAsync: vi.fn(async (value: string) =>
        Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`),
      ),
      decryptStringAsync: vi.fn(async (value: Buffer) => {
        const encoded = value.toString("utf8");
        if (!encoded.startsWith("encrypted:")) {
          throw new Error("Invalid encrypted payload");
        }
        const plainText = Buffer.from(encoded.slice("encrypted:".length), "base64").toString(
          "utf8",
        );
        return { result: plainText, shouldReEncrypt: false };
      }),
    };
  }

  it("persists ciphertext and decrypts it after the store is recreated", async () => {
    const apiKey = "cmp_project_key_do_not_store_as_plaintext";
    const safeStorage = createSafeStorage();
    const store = createComposioSecretStore({ userDataPath, safeStorage });

    await store.save(apiKey);

    const secretPath = join(userDataPath, "composio", "project-api-key.enc");
    const ciphertext = await readFile(secretPath);
    expect(ciphertext.includes(Buffer.from(apiKey))).toBe(false);
    expect(ciphertext.toString("utf8")).toBe(`encrypted:${Buffer.from(apiKey).toString("base64")}`);
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600);

    const reloaded = createComposioSecretStore({ userDataPath, safeStorage });
    await expect(reloaded.load()).resolves.toBe(apiKey);
  });

  it("rejects saving when operating-system encryption is unavailable", async () => {
    const store = createComposioSecretStore({
      userDataPath,
      safeStorage: createSafeStorage(false),
    });

    await expect(store.save("cmp_project_key")).rejects.toThrow(/encryption/i);
    await expect(
      readFile(join(userDataPath, "composio", "project-api-key.enc")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed when the encrypted payload cannot be decrypted", async () => {
    const secretDirectory = join(userDataPath, "composio");
    const secretPath = join(secretDirectory, "project-api-key.enc");
    await mkdir(secretDirectory, { recursive: true });
    await writeFile(secretPath, Buffer.from("corrupt ciphertext"), { mode: 0o600 });
    const store = createComposioSecretStore({ userDataPath, safeStorage: createSafeStorage() });

    await expect(store.load()).rejects.toThrow(/could not be decrypted/i);
  });

  it("retries decryption when Electron requests key re-encryption", async () => {
    const safeStorage = createSafeStorage();
    safeStorage.decryptStringAsync
      .mockResolvedValueOnce({ result: "stale result", shouldReEncrypt: true })
      .mockResolvedValueOnce({ result: "current key", shouldReEncrypt: false });
    const secretDirectory = join(userDataPath, "composio");
    await mkdir(secretDirectory, { recursive: true });
    await writeFile(join(secretDirectory, "project-api-key.enc"), Buffer.from("encrypted payload"));
    const store = createComposioSecretStore({ userDataPath, safeStorage });

    await expect(store.load()).resolves.toBe("current key");
    expect(safeStorage.decryptStringAsync).toHaveBeenCalledTimes(2);
  });

  it("removes the encrypted key when cleared", async () => {
    const store = createComposioSecretStore({ userDataPath, safeStorage: createSafeStorage() });
    await store.save("cmp_project_key");

    await store.clear();

    await expect(store.load()).resolves.toBeUndefined();
  });
});
