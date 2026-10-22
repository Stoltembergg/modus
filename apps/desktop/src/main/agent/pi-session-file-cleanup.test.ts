import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ userData: "", references: vi.fn<() => string[]>() }));
vi.mock("electron", () => ({ app: { getPath: () => state.userData } }));
vi.mock("./agent-store", () => ({ listOtherAgentSessionPiSessionFiles: state.references }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

const { deleteOwnedPiSessionFile } = await import("./pi-session-file-cleanup");

let store: string;
let candidate: string;
const session = () => ({ id: "app-session", piSessionId: "pi-session", piSessionFile: candidate });
function header(id = "pi-session"): string {
  return `${JSON.stringify({ type: "session", id })}\n`;
}
function writeOwned(): void {
  fs.writeFileSync(candidate, `${header()}${JSON.stringify({ type: "message" })}\n`);
}
function expectPreserved(): void {
  expect(deleteOwnedPiSessionFile(session())).toBe("preserved");
  expect(fs.existsSync(candidate)).toBe(true);
  expect(fs.unlinkSync).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.mocked(fs.lstatSync).mockRestore();
  vi.mocked(fs.unlinkSync).mockRestore();
  state.references.mockReset().mockReturnValue([]);
  state.userData = fs.mkdtempSync(join(tmpdir(), "modus-pi-cleanup-"));
  store = join(state.userData, "pi-sessions");
  fs.mkdirSync(store);
  candidate = join(store, "owned.jsonl");
  writeOwned();
});

afterEach(() => {
  vi.mocked(fs.lstatSync).mockRestore();
  vi.mocked(fs.unlinkSync).mockRestore();
  fs.rmSync(state.userData, { recursive: true, force: true });
});

describe("deleteOwnedPiSessionFile", () => {
  it("deletes only a proven owned file and leaves unrelated data intact", () => {
    const protectedPaths = ["memories/data", "backups/data", "workspace/export.jsonl", "pi-sessions/other.jsonl"];
    for (const path of protectedPaths) {
      const full = join(state.userData, path);
      fs.mkdirSync(join(full, ".."), { recursive: true });
      fs.writeFileSync(full, "must survive");
    }
    expect(deleteOwnedPiSessionFile(session())).toBe("deleted");
    expect(fs.existsSync(candidate)).toBe(false);
    expect(state.references).toHaveBeenCalledExactlyOnceWith("app-session");
    for (const path of protectedPaths) expect(fs.readFileSync(join(state.userData, path), "utf8")).toBe("must survive");
  });

  it.each(["piSessionId", "piSessionFile"] as const)("preserves when %s is missing", (key) => {
    expect(deleteOwnedPiSessionFile({ ...session(), [key]: undefined })).toBe("preserved");
    expect(fs.existsSync(candidate)).toBe(true);
  });

  it("preserves a missing file", () => {
    fs.rmSync(candidate);
    expect(deleteOwnedPiSessionFile(session())).toBe("preserved");
  });

  it("preserves relative paths", () => {
    const input = { ...session(), piSessionFile: relative(process.cwd(), candidate) };
    expect(deleteOwnedPiSessionFile(input)).toBe("preserved");
    expect(fs.existsSync(candidate)).toBe(true);
  });

  it("preserves outside-store paths even with a valid header", () => {
    candidate = join(state.userData, "outside.jsonl");
    writeOwned();
    expectPreserved();
  });

  it("preserves nested files", () => {
    fs.mkdirSync(join(store, "nested"));
    candidate = join(store, "nested", "owned.jsonl");
    writeOwned();
    expectPreserved();
  });

  it("preserves traversal even when it normalizes to an owned direct child", () => {
    const input = { ...session(), piSessionFile: `${store}/../pi-sessions/owned.jsonl` };
    expect(deleteOwnedPiSessionFile(input)).toBe("preserved");
    expect(fs.existsSync(candidate)).toBe(true);
  });

  it("preserves directories used as candidate files", () => {
    fs.rmSync(candidate);
    fs.mkdirSync(candidate);
    expectPreserved();
  });

  it.each(["", "{broken\n", "null\n", "[]\n", '{"type":"message","id":"pi-session"}\n', header("different"), '{"type":"session"}\n', `\n${header()}`, `${" ".repeat(70_000)}${header()}`])(
    "preserves missing, invalid, mismatched or unbounded headers (%#)", (contents) => {
      fs.writeFileSync(candidate, contents);
      expectPreserved();
    },
  );

  it("accepts a header-only JSONL without a trailing newline", () => {
    fs.writeFileSync(candidate, header().trimEnd());
    expect(deleteOwnedPiSessionFile(session())).toBe("deleted");
  });

  it("does not parse malformed conversation records after the header", () => {
    fs.writeFileSync(candidate, `${header()}{invalid conversation record\n`);
    expect(deleteOwnedPiSessionFile(session())).toBe("deleted");
  });

  it("preserves a shared file until its last referencing session is removed", () => {
    state.references.mockReturnValue([candidate]);
    expectPreserved();
    state.references.mockReturnValue([]);
    expect(deleteOwnedPiSessionFile(session())).toBe("deleted");
  });

  it("preserves references containing lexical traversal aliases", () => {
    state.references.mockReturnValue([`${store}/../pi-sessions/owned.jsonl`]);
    expectPreserved();
  });

  it("preserves when another reference cannot be resolved safely", () => {
    state.references.mockReturnValue(["relative/unknown.jsonl"]);
    expectPreserved();
  });

  it.skipIf(process.platform === "win32")("preserves a candidate symlink and its target", () => {
    const target = join(state.userData, "target.jsonl");
    fs.renameSync(candidate, target);
    fs.symlinkSync(target, candidate);
    expectPreserved();
    expect(fs.readFileSync(target, "utf8")).toContain("pi-session");
  });

  it.skipIf(process.platform === "win32")("preserves a symlinked store directory", () => {
    const target = join(state.userData, "real-store");
    fs.renameSync(store, target);
    fs.symlinkSync(target, store, "dir");
    expectPreserved();
  });

  it.skipIf(process.platform === "win32")("preserves another session's symlink alias", () => {
    const alias = join(state.userData, "shared-alias.jsonl");
    fs.symlinkSync(candidate, alias);
    state.references.mockReturnValue([alias]);
    expectPreserved();
  });

  it("preserves hard-linked files", () => {
    fs.linkSync(candidate, join(state.userData, "hard-link.jsonl"));
    expectPreserved();
  });

  it("preserves when the candidate is replaced after inspection", () => {
    state.references.mockImplementation(() => {
      fs.renameSync(candidate, join(store, "original.jsonl"));
      writeOwned();
      return [];
    });
    expectPreserved();
    expect(fs.existsSync(join(store, "original.jsonl"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("preserves a symlink replacement immediately before unlink", () => {
    state.references.mockImplementation(() => {
      const target = join(store, "original.jsonl");
      fs.renameSync(candidate, target);
      fs.symlinkSync(target, candidate);
      return [];
    });
    expectPreserved();
  });

  it("preserves if the inspected file is modified in place", () => {
    state.references.mockImplementation(() => {
      fs.appendFileSync(candidate, "changed\n");
      return [];
    });
    expectPreserved();
  });

  it("preserves if another link is created after inspection", () => {
    state.references.mockImplementation(() => {
      fs.linkSync(candidate, join(state.userData, "late-link.jsonl"));
      return [];
    });
    expectPreserved();
  });

  it.skipIf(process.platform === "win32")("preserves if the store is replaced by a symlink after inspection", () => {
    state.references.mockImplementation(() => {
      const moved = join(state.userData, "moved-store");
      fs.renameSync(store, moved);
      fs.symlinkSync(moved, store, "dir");
      return [];
    });
    expectPreserved();
  });

  it("returns failed without exposing the filesystem error", () => {
    vi.mocked(fs.unlinkSync).mockImplementationOnce(() => { throw new Error(`secret ${candidate}`); });
    expect(deleteOwnedPiSessionFile(session())).toBe("failed");
    expect(fs.existsSync(candidate)).toBe(true);
  });

  it("returns failed when the reference query fails, without deleting", () => {
    state.references.mockImplementation(() => { throw new Error("database unavailable"); });
    expect(deleteOwnedPiSessionFile(session())).toBe("failed");
    expect(fs.existsSync(candidate)).toBe(true);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });
});
