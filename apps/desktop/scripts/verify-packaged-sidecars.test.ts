import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import verifier from "./verify-packaged-sidecars.cjs";

const { inspectArchitecture, verifyPackagedSidecars } = verifier;
let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function resourcesRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "modus-sidecars-"));
  roots.push(root);
  mkdirSync(join(root, "bin"));
  return root;
}

function machO(arch: "arm64" | "x64"): Buffer {
  const bytes = Buffer.alloc(32);
  Buffer.from("cffaedfe", "hex").copy(bytes, 0);
  bytes.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  return bytes;
}

function universalMachO(): Buffer {
  const bytes = Buffer.alloc(8 + 2 * 20);
  Buffer.from("cafebabe", "hex").copy(bytes, 0);
  bytes.writeUInt32BE(2, 4);
  bytes.writeUInt32BE(0x01000007, 8);
  bytes.writeUInt32BE(0x0100000c, 28);
  return bytes;
}

function elf(arch: "arm64" | "x64"): Buffer {
  const bytes = Buffer.alloc(64);
  Buffer.from("7f454c46", "hex").copy(bytes, 0);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(arch === "arm64" ? 183 : 62, 18);
  return bytes;
}

function pe(arch: "arm64" | "x64"): Buffer {
  const bytes = Buffer.alloc(0x80);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x40, 0x3c);
  bytes.write("PE\0\0", 0x40, "binary");
  bytes.writeUInt16LE(arch === "arm64" ? 0xaa64 : 0x8664, 0x44);
  return bytes;
}

function writeSidecars(
  resources: string,
  platform: "darwin" | "linux" | "win32",
  bytes: Buffer,
): void {
  const extension = platform === "win32" ? ".exe" : "";
  const names = ["modus-pty-host", "modus-rea-process-supervisor"];
  if (platform === "linux") names.push("modus-plugin-execution-supervisor", "modus-plugin-worker");
  for (const name of names) writeFileSync(join(resources, "bin", `${name}${extension}`), bytes);
}

describe("verify-packaged-sidecars", () => {
  it("accepts correctly-targeted macOS arm64 and x64 sidecars", () => {
    const resources = resourcesRoot();
    writeSidecars(resources, "darwin", machO("arm64"));
    expect(verifyPackagedSidecars(resources, "darwin", "arm64")).toHaveLength(2);

    rmSync(join(resources, "bin", "modus-pty-host"));
    rmSync(join(resources, "bin", "modus-rea-process-supervisor"));
    writeSidecars(resources, "darwin", machO("x64"));
    expect(verifyPackagedSidecars(resources, "darwin", "x64")).toHaveLength(2);
  });

  it("accepts a universal Mach-O only when the requested architecture is present", () => {
    const resources = resourcesRoot();
    writeSidecars(resources, "darwin", universalMachO());
    expect(verifyPackagedSidecars(resources, "darwin", "arm64")).toHaveLength(2);
    expect(verifyPackagedSidecars(resources, "darwin", "x64")).toHaveLength(2);
    expect(inspectArchitecture(machO("x64"), "darwin")).toEqual(["x64"]);
  });

  it("accepts Linux ELF and Windows PE sidecars with matching target headers", () => {
    const linuxResources = resourcesRoot();
    writeSidecars(linuxResources, "linux", elf("x64"));
    expect(verifyPackagedSidecars(linuxResources, "linux", "x64")).toHaveLength(4);

    const windowsResources = resourcesRoot();
    writeSidecars(windowsResources, "win32", pe("arm64"));
    expect(verifyPackagedSidecars(windowsResources, "win32", "arm64")).toHaveLength(2);
  });

  it.each([
    ["linux", "arm64", "x64"],
    ["linux", "x64", "arm64"],
    ["win32", "arm64", "x64"],
    ["win32", "x64", "arm64"],
  ] as const)("rejects %s package arch %s when sidecars are %s", (platform, arch, binaryArch) => {
    const resources = resourcesRoot();
    writeSidecars(resources, platform, platform === "linux" ? elf(binaryArch) : pe(binaryArch));
    expect(() => verifyPackagedSidecars(resources, platform, arch)).toThrow(
      /architecture mismatch/,
    );
  });

  it("requires both Linux plugin sidecars", () => {
    const resources = resourcesRoot();
    writeSidecars(resources, "linux", elf("x64"));
    rmSync(join(resources, "bin", "modus-plugin-worker"));
    expect(() => verifyPackagedSidecars(resources, "linux", "x64")).toThrow(/sidecar is missing/);
  });

  it("requires the packaged PTY and REA sidecars", () => {
    const resources = resourcesRoot();
    writeSidecars(resources, "darwin", machO("arm64"));
    rmSync(join(resources, "bin", "modus-pty-host"));
    expect(() => verifyPackagedSidecars(resources, "darwin", "arm64")).toThrow(
      /sidecar is missing/,
    );
  });

  it("rejects unsupported package architectures and malformed binaries", () => {
    const resources = resourcesRoot();
    writeSidecars(resources, "darwin", machO("arm64"));
    expect(() => verifyPackagedSidecars(resources, "darwin", "x64" as never)).toThrow(
      /architecture mismatch/,
    );
    expect(() => verifyPackagedSidecars(resources, "darwin", "universal" as never)).toThrow(
      /Unsupported/,
    );
    expect(inspectArchitecture(Buffer.from("not a binary"), "darwin")).toEqual([]);
  });
});
