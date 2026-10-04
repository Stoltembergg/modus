import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeSafeStorage } from "./auth.test-helpers";
import { createAuthSessionStore } from "./auth-session-store";

const TOKEN = "refresh-token-SECRET";

describe("auth session store", () => {
  let userDataPath: string;
  const filePath = () => join(userDataPath, "auth", "supabase-refresh-token.enc");

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), "modus-auth-store-"));
  });

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true });
  });

  it("stores only ciphertext with private permissions and reads it back", async () => {
    const safeStorage = createFakeSafeStorage();
    const store = createAuthSessionStore({ userDataPath, safeStorage, platform: "linux" });
    expect(await store.persistence()).toBe("encrypted");
    expect(await store.save(TOKEN)).toBe(true);
    const bytes = await readFile(filePath());
    expect(bytes.includes(Buffer.from(TOKEN))).toBe(false);
    expect((await stat(filePath())).mode & 0o777).toBe(0o600);
    expect((await stat(join(userDataPath, "auth"))).mode & 0o777).toBe(0o700);
    const reloaded = createAuthSessionStore({ userDataPath, safeStorage, platform: "linux" });
    await expect(reloaded.load()).resolves.toBe(TOKEN);
  });

  it("does not persist anything when the Linux backend is basic_text", async () => {
    const safeStorage = createFakeSafeStorage({ backend: "basic_text" });
    const store = createAuthSessionStore({ userDataPath, safeStorage, platform: "linux" });
    expect(await store.persistence()).toBe("memory-only");
    expect(await store.save(TOKEN)).toBe(false);
    await expect(readFile(filePath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
  });

  it("drops a token stored earlier once the backend downgrades to basic_text", async () => {
    await createAuthSessionStore({
      userDataPath,
      safeStorage: createFakeSafeStorage(),
      platform: "linux",
    }).save(TOKEN);
    const downgraded = createAuthSessionStore({
      userDataPath,
      safeStorage: createFakeSafeStorage({ backend: "basic_text" }),
      platform: "linux",
    });
    await expect(downgraded.load()).resolves.toBeUndefined();
    await expect(readFile(filePath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats unavailable encryption or an unknown Linux backend as memory-only", async () => {
    for (const safeStorage of [
      createFakeSafeStorage({ available: false }),
      createFakeSafeStorage({ backend: "unknown" }),
    ]) {
      const store = createAuthSessionStore({ userDataPath, safeStorage, platform: "linux" });
      expect(await store.persistence()).toBe("memory-only");
      expect(await store.save(TOKEN)).toBe(false);
    }
    await expect(readFile(filePath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not consult the Linux-only backend on macOS and Windows", async () => {
    const safeStorage = createFakeSafeStorage({ backend: "basic_text" });
    for (const platform of ["darwin", "win32"] as const) {
      const store = createAuthSessionStore({ userDataPath, safeStorage, platform });
      expect(await store.persistence()).toBe("encrypted");
    }
    expect(safeStorage.getSelectedStorageBackend).not.toHaveBeenCalled();
  });

  it("clear() removes the stored token", async () => {
    const store = createAuthSessionStore({
      userDataPath,
      safeStorage: createFakeSafeStorage(),
      platform: "linux",
    });
    await store.save(TOKEN);
    await store.clear();
    await expect(readFile(filePath())).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.load()).resolves.toBeUndefined();
  });

  it("discards an undecryptable file instead of failing open", async () => {
    await mkdir(join(userDataPath, "auth"), { recursive: true });
    await writeFile(filePath(), "garbage", { mode: 0o600 });
    const store = createAuthSessionStore({
      userDataPath,
      safeStorage: createFakeSafeStorage(),
      platform: "linux",
    });
    await expect(store.load()).resolves.toBeUndefined();
    await expect(readFile(filePath())).rejects.toMatchObject({ code: "ENOENT" });
  });
});
