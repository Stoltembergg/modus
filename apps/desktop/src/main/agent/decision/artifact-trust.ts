import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open, readFile, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NATIVE_ARTIFACT_TRUST } from "./native-trust-root.ts";

const artifactError = () => new Error("decision_runtime:artifact_trust");
/** Initial OS user namespace is part of the privileged installation trust boundary. */
async function initialNamespace(): Promise<void> {
  if (
    (await readFile("/proc/self/uid_map", "utf8")).trim().split(/\s+/u).join(" ") !==
    "0 0 4294967295"
  )
    throw artifactError();
}
async function rootMetadata(file: FileHandle, regular: boolean): Promise<void> {
  const info = await file.stat({ bigint: true });
  if (
    info.uid !== 0n ||
    (info.mode & 0o022n) !== 0n ||
    (regular ? !info.isFile() || (info.mode & 0o6000n) !== 0n : !info.isDirectory())
  )
    throw artifactError();
  if ((await statfs(`/proc/self/fd/${file.fd}`, { bigint: true })).type === 0x65735546n)
    throw artifactError();
}
async function rootDescriptor(path: string): Promise<FileHandle> {
  if (
    !path.startsWith("/") ||
    path
      .slice(1)
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  )
    throw artifactError();
  await initialNamespace();
  let directory = await open(
    "/",
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await rootMetadata(directory, false);
    const parts = path.slice(1).split("/");
    for (let i = 0; i < parts.length; i++) {
      const final = i === parts.length - 1;
      // /proc references this held directory inode; mutable ancestor names are not re-resolved.
      const next = await open(
        `/proc/self/fd/${directory.fd}/${parts[i]}`,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          (final ? constants.O_NONBLOCK : constants.O_DIRECTORY),
      );
      await directory.close();
      directory = next;
      await rootMetadata(directory, final);
    }
    return directory;
  } catch {
    await directory.close().catch(() => undefined);
    throw artifactError();
  }
}
/** Returns the SAME authenticated FD used by the host for child exec, not a pathname approval. */
export async function openRootVerifiedFile(
  path: string,
  expected: string,
  signal?: AbortSignal,
): Promise<FileHandle> {
  let file: FileHandle | undefined;
  try {
    if (!/^[a-f0-9]{64}$/u.test(expected)) throw artifactError();
    file = await rootDescriptor(path);
    const before = await file.stat({ bigint: true });
    if (before.size > 128n * 1024n * 1024n) throw artifactError();
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < Number(before.size)) {
      if (signal?.aborted) throw artifactError();
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, Number(before.size) - position),
        position,
      );
      if (!bytesRead) throw artifactError();
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      hash.digest("hex") !== expected ||
      signal?.aborted
    )
      throw artifactError();
    return file;
  } catch {
    await file?.close().catch(() => undefined);
    throw artifactError();
  }
}
export async function openTrustedExecutable(
  config: { executablePath: string; executableSha256: string },
  signal?: AbortSignal,
): Promise<FileHandle> {
  const trust = NATIVE_ARTIFACT_TRUST;
  // A writable AppImage cannot approve its own trust root. No development bypass.
  if (
    process.resourcesPath !== dirname(trust.applicationAnchor) ||
    config.executableSha256 !== trust.executableSha256 ||
    config.executablePath !==
      join(trust.debPrefix, trust.executableSha256, "bin", "modus-decision-runtime")
  )
    throw artifactError();
  const anchor = await rootDescriptor(trust.applicationAnchor);
  await anchor.close();
  const executable = await openRootVerifiedFile(
    config.executablePath,
    trust.executableSha256,
    signal,
  );
  // Root ownership + an FD prevents an unprivileged writer/rename substitution,
  // but cannot stop a privileged updater rewriting that inode after authentication.
  // No immutable executable/bootstrap mechanism has been validated for a shipped
  // installation. Keep BOTH distribution modes unavailable; this is not a feature
  // flag and there is no config/environment bypass.
  await executable.close();
  throw new Error("decision_runtime:artifact_bootstrap_immutability_unproven");
}
