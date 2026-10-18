import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalModelsLogFile,
  emitLocalModelsLine,
  LOCAL_MODELS_LOG_FILE_NAME,
  LOCAL_MODELS_LOG_MAX_BYTES,
  LOCAL_MODELS_LOG_MAX_PENDING,
  type LocalModelsLogFs,
  setLocalModelsLogFile,
} from "./local-models-log-file";
import { formatToolsExpandLog } from "./turn-tool-filter";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "modus-lm-log-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  setLocalModelsLogFile(null);
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;
const filtered = (n: number) => `[local-models] tool filter: filtered sent=8 of=${n} core=8 ms=41`;

describe("local-models.log writer", () => {
  it("creates <dir>/local-models.log on the first line, ISO-timestamped, in order", async () => {
    const root = tempDir();
    const dir = join(root, "logs");
    const file = createLocalModelsLogFile(dir, { now: () => new Date("2026-10-18T03:57:00.000Z") });
    expect(file.path).toBe(join(dir, LOCAL_MODELS_LOG_FILE_NAME));
    expect(readdirSync(root)).toEqual([]);
    file.write(filtered(1));
    file.write("[local-models] tool filter: expand turn=3 added=14 after=filtered");
    await file.flush();
    expect(readFileSync(file.path, "utf8")).toBe(
      "2026-10-18T03:57:00.000Z [local-models] tool filter: filtered sent=8 of=1 core=8 ms=41\n" +
        "2026-10-18T03:57:00.000Z [local-models] tool filter: expand turn=3 added=14 after=filtered\n",
    );
  });

  it("only takes [local-models] tool filter lines; [modus] and other [local-models] lines stay out", async () => {
    const file = createLocalModelsLogFile(tempDir());
    file.write("[modus] Unable to persist the tool filter preference.");
    file.write("[local-models] onnxruntime probe failed: /Users/someone/Library/x.dylib");
    file.write("[local-models] model process exit: crashed (code 1)");
    file.write("tool filter: filtered sent=1 of=2 core=3 ms=4");
    file.write(filtered(2));
    await file.flush();
    const lines = readFileSync(file.path, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    for (const line of lines) {
      expect(line).toMatch(ISO);
      expect(line.replace(ISO, "")).toMatch(/^\[local-models\] tool filter: /);
    }
  });

  it("a line can never span two lines in the file", async () => {
    const file = createLocalModelsLogFile(tempDir());
    file.write("[local-models] tool filter: filtered sent=1\nforged line\r\n");
    await file.flush();
    expect(readFileSync(file.path, "utf8").split("\n")).toHaveLength(2);
  });

  it("rotates at ~1 MB and keeps exactly two files (local-models.log + .1)", async () => {
    const dir = tempDir();
    const file = createLocalModelsLogFile(dir);
    const line = filtered(22);
    const perLine = Buffer.byteLength(`${new Date().toISOString()} ${line}\n`);
    const total = Math.ceil((LOCAL_MODELS_LOG_MAX_BYTES * 2.5) / perLine);
    for (let index = 0; index < total; index += 1) {
      file.write(index === total - 1 ? filtered(999_999) : line);
      if (index % 256 === 255) await file.flush();
    }
    await file.flush();
    expect(readdirSync(dir).sort()).toEqual([
      LOCAL_MODELS_LOG_FILE_NAME,
      `${LOCAL_MODELS_LOG_FILE_NAME}.1`,
    ]);
    const current = statSync(join(dir, LOCAL_MODELS_LOG_FILE_NAME)).size;
    const previous = statSync(join(dir, `${LOCAL_MODELS_LOG_FILE_NAME}.1`)).size;
    expect(current).toBeLessThanOrEqual(LOCAL_MODELS_LOG_MAX_BYTES);
    expect(previous).toBeLessThanOrEqual(LOCAL_MODELS_LOG_MAX_BYTES);
    // .1 was full when it rotated (within one batch of the cap).
    expect(previous).toBeGreaterThan(LOCAL_MODELS_LOG_MAX_BYTES - 256 * perLine);
    // The newest line is in local-models.log; everything on disk is whole lines.
    expect(
      readFileSync(join(dir, LOCAL_MODELS_LOG_FILE_NAME), "utf8").trimEnd().split("\n").at(-1),
    ).toContain("of=999999");
    for (const name of readdirSync(dir)) {
      for (const entry of readFileSync(join(dir, name), "utf8").trimEnd().split("\n")) {
        expect(entry).toMatch(ISO);
      }
    }
  }, 60_000);

  it("continues an existing file and rotates it when it is already near the cap", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, LOCAL_MODELS_LOG_FILE_NAME),
      "x".repeat(LOCAL_MODELS_LOG_MAX_BYTES - 10),
    );
    writeFileSync(join(dir, `${LOCAL_MODELS_LOG_FILE_NAME}.1`), "old");
    const file = createLocalModelsLogFile(dir);
    file.write(filtered(3));
    await file.flush();
    expect(readdirSync(dir).sort()).toEqual([
      LOCAL_MODELS_LOG_FILE_NAME,
      `${LOCAL_MODELS_LOG_FILE_NAME}.1`,
    ]);
    expect(readFileSync(join(dir, `${LOCAL_MODELS_LOG_FILE_NAME}.1`), "utf8")).toHaveLength(
      LOCAL_MODELS_LOG_MAX_BYTES - 10,
    );
    expect(readFileSync(join(dir, LOCAL_MODELS_LOG_FILE_NAME), "utf8")).toContain("of=3");
  });

  it("swallows every fs error: write never throws, flush never rejects, later lines still land", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const dir = tempDir();
      let failing = true;
      const real = await import("node:fs/promises");
      const fs: LocalModelsLogFs = {
        mkdir: (path, options) =>
          failing ? Promise.reject(new Error("EACCES")) : real.mkdir(path, options),
        stat: (path) => real.stat(path),
        rename: (from, to) => real.rename(from, to),
        appendFile: (path, data, encoding) =>
          failing ? Promise.reject(new Error("ENOSPC")) : real.appendFile(path, data, encoding),
      };
      const file = createLocalModelsLogFile(dir, { fs });
      expect(() => file.write(filtered(1))).not.toThrow();
      await expect(file.flush()).resolves.toBeUndefined();
      failing = false;
      file.write(filtered(2));
      await file.flush();
      expect(readFileSync(file.path, "utf8")).not.toContain("of=1 ");
      expect(readFileSync(file.path, "utf8")).toContain("of=2 ");

      // A real fs error: the log directory path is a file.
      const blocker = join(tempDir(), "logs");
      writeFileSync(blocker, "not a directory");
      const broken = createLocalModelsLogFile(blocker);
      expect(() => broken.write(filtered(3))).not.toThrow();
      await expect(broken.flush()).resolves.toBeUndefined();

      // Synchronous throws from the fs layer are dropped too.
      const throwing = createLocalModelsLogFile(dir, {
        fs: {
          ...fs,
          mkdir: () => {
            throw new Error("sync EPERM");
          },
        },
      });
      expect(() => throwing.write(filtered(4))).not.toThrow();
      await expect(throwing.flush()).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("caps the queue while the disk is stuck, so memory cannot grow", async () => {
    let release: () => void = () => {};
    const appended: string[] = [];
    const file = createLocalModelsLogFile(tempDir(), {
      fs: {
        mkdir: async () => undefined,
        stat: async () => ({ size: 0 }),
        rename: async () => undefined,
        appendFile: async (_path, data) => {
          if (appended.length === 0) await new Promise<void>((resolve) => (release = resolve));
          appended.push(data);
        },
      },
    });
    file.write(filtered(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let index = 1; index <= LOCAL_MODELS_LOG_MAX_PENDING + 100; index += 1)
      file.write(filtered(index));
    release();
    await file.flush();
    const lines = appended.join("").trimEnd().split("\n");
    expect(lines).toHaveLength(1 + LOCAL_MODELS_LOG_MAX_PENDING);
  });

  it("emitLocalModelsLine: stdout as before, plus the installed file", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const file = createLocalModelsLogFile(tempDir());
    emitLocalModelsLine(filtered(5));
    expect(info).toHaveBeenCalledWith(filtered(5));
    setLocalModelsLogFile(file);
    emitLocalModelsLine(filtered(6));
    await file.flush();
    expect(info).toHaveBeenCalledTimes(2);
    const text = readFileSync(file.path, "utf8");
    expect(text).not.toContain("of=5 ");
    expect(text).toContain("of=6 ");
  });
});

describe("tools_expand log line", () => {
  it("is counts plus the first-turn mode only", () => {
    expect(formatToolsExpandLog({ turn: 3, added: 14, after: "filtered" })).toBe(
      "[local-models] tool filter: expand turn=3 added=14 after=filtered",
    );
    expect(formatToolsExpandLog({ turn: 1, added: 0, after: "fallback" })).toBe(
      "[local-models] tool filter: expand turn=1 added=0 after=fallback",
    );
    expect(formatToolsExpandLog({ turn: -2.5, added: 3.9, after: "filtered" })).toBe(
      "[local-models] tool filter: expand turn=0 added=3 after=filtered",
    );
  });
});
