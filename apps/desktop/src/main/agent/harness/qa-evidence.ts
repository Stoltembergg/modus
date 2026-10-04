import { createHash } from "node:crypto";
import {
  accessSync,
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";
import type { HarnessTaskCheckKind } from "../../../shared/contracts";

export type VerificationEvidenceStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "missing"
  | "unavailable"
  | "user_confirmed";

export type AutoQAStatus = VerificationEvidenceStatus | "not_required";

export type HarnessEvidenceRef = {
  id: string;
  kind: string;
  status: VerificationEvidenceStatus;
  runId?: string;
  eventId?: string;
  revision?: string;
  paths?: string[];
  label: string;
  checkName?: HarnessTaskCheckKind;
};

type ToolEventBase = {
  sessionId: string;
  runId: string;
  eventId: string;
  toolCallId: string;
  toolName: string;
  checkName?: string;
  command?: string;
  paths?: string[];
  fullProject?: boolean;
  mutatesSource?: boolean;
  revision?: string;
};

export type RecognizedCheckName = "tests" | "typecheck" | "lint" | "build";
export type RecognizedCheckInvocation = {
  checkName: RecognizedCheckName;
  fullProject: boolean;
  paths?: string[];
  workspace?: string;
  mutatesSource?: boolean;
  packageConfigDigest?: string;
};

export type RunQAEvent =
  | (ToolEventBase & { type: "tool.started" })
  | (ToolEventBase & {
      type: "tool.ended";
      checkConfigStable?: boolean;
      exitCode?: number;
      error?: boolean;
      aborted?: boolean;
      skipped?: boolean;
      output?: string;
    })
  | {
      type: "check.confirmed";
      sessionId: string;
      runId: string;
      eventId: string;
      checkName: string;
      paths?: string[];
      revision?: string;
    };

export type SummarizeRunQAInput = {
  sessionId: string;
  runId: string;
  changedPaths: string[];
  requiredChecks: string[];
  events: RunQAEvent[];
};

export type HarnessQAResult = {
  required: boolean;
  status: AutoQAStatus;
  reasonCode: string;
  evidence: HarnessEvidenceRef[];
  sourceFingerprint?: string;
};

const MAX_EVENTS = 500;
const MAX_EVIDENCE = 20;
const CHECK_LABELS: Record<string, { label: string; aliases: string[] }> = {
  tests: { label: "Tests", aliases: ["test", "tests", "unit tests", "vitest", "jest", "npm test"] },
  typecheck: { label: "Typecheck", aliases: ["typecheck", "type check", "tsc", "typescript"] },
  lint: { label: "Lint", aliases: ["lint", "eslint", "biome"] },
  build: { label: "Build", aliases: ["build", "compile", "compilation"] },
};

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/\\/g, "/").replace(/^\.\//, "");
}

function checkKey(identity: string | undefined): RecognizedCheckName | undefined {
  if (!identity) return undefined;
  const candidate = normalized(identity);
  for (const [key, check] of Object.entries(CHECK_LABELS)) {
    if (check.aliases.includes(candidate)) return key as RecognizedCheckName;
  }
  return undefined;
}

const CHECK_SCRIPTS: Record<string, RecognizedCheckName> = {
  test: "tests",
  typecheck: "typecheck",
  lint: "lint",
  build: "build",
};
const SHELL_EXPANSION_CHARACTERS = [..."$`*?[]{}()~"];
const RECOGNIZED_WORKSPACE_ROOTS: Record<string, string> = {
  "@modus/desktop": "apps/desktop",
};

/** Resolve npm script bodies only from the root manifest or an explicitly trusted workspace. */
export function resolvePackageCheckScript(
  cwd: string,
  packageName: string | undefined,
  scriptName: string,
): { body: string; configDigest: string; workspaceRoot?: string } | undefined {
  const artifactDirectories = new Set<string>();
  try {
    artifactDirectories.add(realpathSync(cwd));
  } catch {
    return undefined;
  }
  const directoryNeedsMetadata = (path: string, entry: BigIntStats): boolean => {
    if (artifactDirectories.has(path)) return false;
    const uid = process.getuid?.();
    // Owners can chmod a protected ancestor, temporarily enabling descendant replacement.
    if (uid === 0 || (uid !== undefined && entry.uid === BigInt(uid))) return true;
    if (dirname(path) === path) return false;
    const parent = dirname(path);
    try {
      const parentEntry = statSync(parent, { bigint: true });
      if (uid !== undefined && parentEntry.uid === BigInt(uid)) return true;
      accessSync(parent, constants.W_OK | constants.X_OK);
      // Sticky parents allow removal only to root, the parent owner or the entry owner.
      return (
        uid === undefined ||
        uid === 0 ||
        (parentEntry.mode & 0o1000n) === 0n ||
        parentEntry.uid === BigInt(uid) ||
        entry.uid === BigInt(uid)
      );
    } catch (error) {
      if (["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return false;
      }
      throw error;
    }
  };
  const entryIdentity = (entry: BigIntStats, path: string): string[] => {
    if (entry.isDirectory() && !directoryNeedsMetadata(realpathSync(path), entry)) {
      return [entry.dev, entry.ino].map(String);
    }
    return [entry.dev, entry.ino, entry.size, entry.mtimeNs, entry.ctimeNs].map(String);
  };
  // Observe every directory and link used to resolve the path, including link targets.
  // Renameable/owned ancestors include metadata; artifact roots/protected globals use dev/ino.
  const resolutionEntries = (path: string): unknown[] => {
    let resolved = parse(resolve(path)).root;
    let remaining = resolve(path).slice(resolved.length).split(sep).filter(Boolean);
    const root = lstatSync(resolved, { bigint: true });
    const entries: unknown[] = [
      {
        type: "directory",
        entry: entryIdentity(root, resolved),
      },
    ];
    let linkCount = 0;
    while (remaining.length > 0) {
      const component = remaining.shift();
      if (!component) continue;
      const candidate = join(resolved, component);
      const entry = lstatSync(candidate, { bigint: true });
      if (entry.isSymbolicLink()) {
        if (++linkCount > 40) throw new Error("Too many links in manifest resolution.");
        const destination = readlinkSync(candidate);
        entries.push({
          type: "symlink",
          entry: [entry.dev, entry.ino, entry.size, entry.mtimeNs, entry.ctimeNs].map(String),
          destination,
        });
        const target = resolve(dirname(candidate), destination);
        resolved = parse(target).root;
        remaining = [...target.slice(resolved.length).split(sep).filter(Boolean), ...remaining];
      } else {
        if (entry.isDirectory()) {
          entries.push({
            type: "directory",
            entry: entryIdentity(entry, candidate),
          });
        }
        resolved = candidate;
      }
    }
    return entries;
  };
  const manifestIdentity = (path: string): string | undefined => {
    try {
      const entry = lstatSync(path, { bigint: true });
      const target = statSync(path, { bigint: true });
      return JSON.stringify({
        entry: entryIdentity(entry, path),
        target: entryIdentity(target, path),
        link: entry.isSymbolicLink() ? readlinkSync(path) : null,
        resolutionEntries: resolutionEntries(path),
      });
    } catch {
      return undefined;
    }
  };
  const readManifest = (
    path: string,
  ): { value: Record<string, unknown>; identity: string } | undefined => {
    let fd: number | undefined;
    try {
      const before = manifestIdentity(path);
      if (!before) return undefined;
      fd = openSync(path, "r");
      const fileIdentity = () => {
        const stat = fstatSync(fd as number, { bigint: true });
        return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
      };
      const opened = JSON.stringify(fileIdentity());
      if (opened !== JSON.stringify(JSON.parse(before).target)) return undefined;
      const text = readFileSync(fd, "utf8");
      if (Buffer.byteLength(text, "utf8") > 256 * 1024) return undefined;
      if (opened !== JSON.stringify(fileIdentity()) || before !== manifestIdentity(path)) {
        return undefined;
      }
      const value = JSON.parse(text) as Record<string, unknown>;
      return value && typeof value === "object" && !Array.isArray(value)
        ? { value, identity: before }
        : undefined;
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  const rootManifestPath = join(cwd, "package.json");
  // Cwd itself permits artifacts; its observed ancestors detect directory replacement.
  const cwdIdentity = manifestIdentity(cwd);
  const rootSnapshot = readManifest(rootManifestPath);
  if (!rootSnapshot || !cwdIdentity) return undefined;
  const root = rootSnapshot.value;
  const rootIdentity = rootSnapshot.identity;
  let manifest = root;
  let manifestPath = rootManifestPath;
  let checkManifestIdentity = rootIdentity;
  let workspaceContainerIdentity: string | null | undefined = null;
  let workspaceRoot: string | undefined;
  if (packageName) {
    workspaceRoot = RECOGNIZED_WORKSPACE_ROOTS[packageName];
    if (!workspaceRoot) return undefined;
    try {
      artifactDirectories.add(realpathSync(join(cwd, workspaceRoot)));
    } catch {
      return undefined;
    }
    const patterns = Array.isArray(root.workspaces)
      ? root.workspaces
      : root.workspaces &&
          typeof root.workspaces === "object" &&
          Array.isArray((root.workspaces as { packages?: unknown }).packages)
        ? (root.workspaces as { packages: unknown[] }).packages
        : [];
    const relative = workspaceRoot.split("/");
    if (
      !patterns.some((pattern) => typeof pattern === "string" && pattern === `${relative[0]}/*`)
    ) {
      return undefined;
    }
    // Keep the trusted workspace container in the final coherent-read revalidation.
    workspaceContainerIdentity = manifestIdentity(join(cwd, dirname(workspaceRoot)));
    if (!workspaceContainerIdentity) return undefined;
    manifestPath = join(cwd, workspaceRoot, "package.json");
    const workspaceSnapshot = readManifest(manifestPath);
    if (!workspaceSnapshot) return undefined;
    manifest = workspaceSnapshot.value;
    checkManifestIdentity = workspaceSnapshot.identity;
    if (manifest.name !== packageName) return undefined;
  }
  // Reject mixed snapshots if any relevant resolution changed during these reads.
  if (
    rootIdentity !== manifestIdentity(rootManifestPath) ||
    checkManifestIdentity !== manifestIdentity(manifestPath) ||
    cwdIdentity !== manifestIdentity(cwd) ||
    (workspaceRoot &&
      workspaceContainerIdentity !== manifestIdentity(join(cwd, dirname(workspaceRoot))))
  )
    return undefined;
  const scripts = manifest.scripts;
  const packageScripts =
    scripts && typeof scripts === "object" && !Array.isArray(scripts)
      ? (scripts as Record<string, unknown>)
      : undefined;
  const body = packageScripts?.[scriptName];
  if (typeof body !== "string" || !body.trim()) return undefined;
  const preHook = packageScripts?.[`pre${scriptName}`];
  const postHook = packageScripts?.[`post${scriptName}`];
  if (
    [preHook, postHook].some(
      (hookBody) => typeof hookBody === "string" && hookBody.trim().length > 0,
    )
  ) {
    return undefined;
  }
  const configDigest = createHash("sha256")
    .update(
      JSON.stringify({
        scriptName,
        body,
        preHook: typeof preHook === "string" ? preHook : null,
        postHook: typeof postHook === "string" ? postHook : null,
        rootIdentity,
        cwdIdentity,
        checkManifestIdentity,
        workspaceContainerIdentity,
      }),
    )
    .digest("hex");
  return { body, configDigest, ...(workspaceRoot ? { workspaceRoot } : {}) };
}

function scopedPaths(arguments_: string[]): string[] | undefined {
  const paths = arguments_.flatMap((argument) => {
    const value = argument.includes("=") ? (argument.split("=").at(-1) ?? argument) : argument;
    if (value.startsWith("-")) return [];
    if (!/[/.]/.test(value)) return [];
    if (!/\.(?:[cm]?[jt]sx?|json|md)$/i.test(value) && !/^(?:src|apps|packages)\//i.test(value)) {
      return [];
    }
    return [safePath(value)].filter((path): path is string => path !== undefined);
  });
  return paths.length > 0 ? [...new Set(paths)].slice(0, 20) : undefined;
}

function hasScopedArguments(arguments_: string[]): boolean {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument) continue;
    if (argument === ".") continue;
    if (argument === "--root") {
      const root = arguments_[index + 1];
      if (root && root !== ".") return true;
      index += root ? 1 : 0;
      continue;
    }
    if (argument === "--" || argument.startsWith("-")) continue;
    return true;
  }
  return false;
}

/** Recognize only direct, supported check invocations by bash/terminal_run. */
export function recognizeCheckInvocation(
  toolName: string,
  command: string | undefined,
  cwd?: string,
): RecognizedCheckInvocation | undefined {
  if ((toolName !== "bash" && toolName !== "terminal_run") || !command) return undefined;
  const text = command.trim();
  if (
    !text ||
    SHELL_EXPANSION_CHARACTERS.some((character) => text.includes(character)) ||
    /['";&|<>\n\r]/.test(text)
  ) {
    return undefined;
  }
  const tokens = text.split(/\s+/);
  if (
    tokens.some(
      (token) =>
        /^(?:--help|--version|--listtests|--list-tests|--list|--showconfig)(?:=.*)?$/i.test(
          token,
        ) || /^-[hv]$/i.test(token),
    )
  ) {
    return undefined;
  }
  const mutatesSource = tokens.some((token) => /^--(?:write|fix|apply)(?:=.*)?$/i.test(token));
  const executable = tokens[0]?.toLowerCase();
  if (!executable) return undefined;

  let kind: RecognizedCheckName | undefined;
  let argumentStart = 1;
  if (executable === "npm" || executable === "pnpm" || executable === "yarn") {
    let cursor = 1;
    let workspace: string | undefined;
    if (executable === "npm") {
      while (cursor < tokens.length) {
        const option = tokens[cursor]?.toLowerCase();
        if (option === "--workspace" || option === "-w") {
          const next = tokens[cursor + 1];
          if (!next || workspace) return undefined;
          workspace = next;
          cursor += 2;
        } else if (option?.startsWith("--workspace=") || option?.startsWith("-w=")) {
          if (workspace) return undefined;
          const workspaceOption = tokens[cursor] ?? "";
          workspace = workspaceOption.slice(workspaceOption.indexOf("=") + 1);
          if (!workspace) return undefined;
          cursor += 1;
        } else {
          break;
        }
      }
    }
    const scriptIndex = tokens[cursor]?.toLowerCase() === "run" ? cursor + 1 : cursor;
    const script = tokens[scriptIndex]?.toLowerCase();
    kind = script ? CHECK_SCRIPTS[script] : undefined;
    argumentStart = scriptIndex + 1;
    if (kind && mutatesSource) {
      return { checkName: kind, fullProject: true, mutatesSource: true };
    }
    if (kind && cwd && tokens.length === argumentStart) {
      const resolved = resolvePackageCheckScript(cwd, workspace, script ?? "");
      if (!resolved) return undefined;
      const workspaceRoot = resolved.workspaceRoot;
      if (workspace && !workspaceRoot) return undefined;
      const body = recognizeCheckInvocation(toolName, resolved.body);
      if (!body || body.checkName !== kind || body.mutatesSource) return undefined;
      return {
        ...body,
        packageConfigDigest: resolved.configDigest,
        fullProject: workspace ? false : body.fullProject,
        ...(workspace
          ? {
              workspace,
              paths:
                body.paths?.map((path) => `${workspaceRoot}/${path}`) ??
                (workspaceRoot ? [workspaceRoot] : []),
            }
          : {}),
      };
    }
    if (kind) return undefined;
    if (workspace) {
      const workspaceRoot = RECOGNIZED_WORKSPACE_ROOTS[workspace];
      if (!workspaceRoot || !kind) return undefined;
      const paths = scopedPaths(tokens.slice(argumentStart));
      return {
        checkName: kind,
        fullProject: false,
        paths: paths?.map((path) => `${workspaceRoot}/${path}`) ?? [workspaceRoot],
        workspace,
        ...(mutatesSource ? { mutatesSource: true } : {}),
      };
    }
  } else if (executable === "npx") {
    const program = tokens[1]?.toLowerCase();
    if (program === "vitest" && tokens[2]?.toLowerCase() === "run") {
      kind = "tests";
      argumentStart = 3;
    } else if (program === "jest" || program === "mocha") {
      kind = "tests";
      argumentStart = 2;
    } else if (program === "tsc") {
      kind = "typecheck";
      argumentStart = 2;
    } else if (program === "eslint") {
      kind = "lint";
      argumentStart = 2;
    } else if (program === "biome" && tokens[2]?.toLowerCase() === "check") {
      kind = "lint";
      argumentStart = 3;
    } else if (program === "vite" && tokens[2]?.toLowerCase() === "build") {
      kind = "build";
      argumentStart = 3;
    }
  } else if (executable === "vitest" && tokens[1]?.toLowerCase() === "run") {
    kind = "tests";
    argumentStart = 2;
  } else if (executable === "jest" || executable === "mocha") {
    kind = "tests";
    argumentStart = 1;
  } else if (executable === "tsc") {
    kind = "typecheck";
  } else if (executable === "eslint") {
    kind = "lint";
  } else if (executable === "biome" && tokens[1]?.toLowerCase() === "check") {
    kind = "lint";
    argumentStart = 2;
  } else if (executable === "vite" && tokens[1]?.toLowerCase() === "build") {
    kind = "build";
    argumentStart = 2;
  }

  if (!kind) return undefined;
  const arguments_ = tokens.slice(argumentStart);
  const paths = scopedPaths(arguments_);
  return {
    checkName: kind,
    fullProject: !hasScopedArguments(arguments_),
    ...(paths ? { paths } : {}),
    ...(mutatesSource ? { mutatesSource: true } : {}),
  };
}

function safePath(path: string): string | undefined {
  const cleaned = path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!cleaned || cleaned.length > 240 || cleaned.includes("\0")) return undefined;
  return cleaned;
}

function evidencePaths(eventPaths: string[] | undefined): string[] | undefined {
  if (!eventPaths) return undefined;
  return [
    ...new Set(eventPaths.map(safePath).filter((path): path is string => path !== undefined)),
  ].slice(0, 20);
}

function coversChangedPaths(
  eventPaths: string[] | undefined,
  changedPaths: string[],
  fullProject: boolean | undefined,
): boolean {
  if (changedPaths.length === 0) return true;
  if (!eventPaths) return fullProject === true;
  const checked = new Set(eventPaths.map(normalized));
  return changedPaths.every((path) => {
    const changed = normalized(path);
    return [...checked].some((scope) => changed === scope || changed.startsWith(`${scope}/`));
  });
}

function evidenceRef(
  input: SummarizeRunQAInput,
  check: string,
  status: VerificationEvidenceStatus,
  eventId?: string,
  paths?: string[],
  revision?: string,
): HarnessEvidenceRef {
  const result: HarnessEvidenceRef = {
    id: `${input.runId}:${check}${eventId ? `:${eventId}` : ""}`.slice(0, 240),
    kind: "check",
    status,
    runId: input.runId,
    label: CHECK_LABELS[check]?.label ?? "Required check",
    ...(["tests", "typecheck", "lint", "build"].includes(check)
      ? { checkName: check as HarnessTaskCheckKind }
      : {}),
  };
  if (eventId) result.eventId = eventId.slice(0, 120);
  if (revision) result.revision = revision.slice(0, 120);
  if (paths) result.paths = paths;
  return result;
}

export function summarizeRunQA(input: SummarizeRunQAInput): HarnessQAResult {
  const requested = [
    ...new Set(
      input.requiredChecks.map(
        (identity, index) => checkKey(identity) ?? `unknown-required-${index}`,
      ),
    ),
  ];
  if (input.requiredChecks.length === 0) {
    return { required: false, status: "not_required", reasonCode: "qa_not_required", evidence: [] };
  }

  const events = input.events
    .slice(-MAX_EVENTS)
    .filter((event) => event.sessionId === input.sessionId && event.runId === input.runId);
  const starts = new Map<
    string,
    {
      event: Extract<RunQAEvent, { type: "tool.started" }>;
      checkName?: RecognizedCheckName;
      paths?: string[];
      fullProject?: boolean;
      mutatesSource?: boolean;
      generation: number;
    }
  >();
  const invalidatingActions = new Set<string>();
  const latest = new Map<string, HarnessEvidenceRef>();
  let generation = 0;

  for (const event of events) {
    if (event.type === "tool.started") {
      const shellTool = event.toolName === "bash" || event.toolName === "terminal_run";
      const invocation = shellTool
        ? recognizeCheckInvocation(event.toolName, event.command)
        : undefined;
      const checkName = checkKey(event.checkName) ?? invocation?.checkName;
      const paths = event.paths ?? invocation?.paths;
      const fullProject = event.fullProject ?? invocation?.fullProject;
      const mutatesSource = event.mutatesSource ?? invocation?.mutatesSource;
      const sourceMutation =
        mutatesSource === true || ["write", "edit", "terminal_write"].includes(event.toolName);
      const unclassifiedShellAction = shellTool && !invocation && !checkName;
      if (sourceMutation || unclassifiedShellAction) {
        generation += 1;
        latest.clear();
        invalidatingActions.add(event.toolCallId);
      }
      starts.set(event.toolCallId, {
        event,
        ...(checkName ? { checkName } : {}),
        ...(paths ? { paths } : {}),
        ...(fullProject ? { fullProject: true } : {}),
        ...(mutatesSource ? { mutatesSource: true } : {}),
        generation,
      });
      continue;
    }

    if (event.type === "tool.ended" && invalidatingActions.delete(event.toolCallId)) {
      generation += 1;
      latest.clear();
    }

    if (event.type === "tool.ended" && event.checkConfigStable === false) {
      generation += 1;
      latest.clear();
      continue;
    }

    if (event.type === "check.confirmed") {
      const check = checkKey(event.checkName);
      if (
        !check ||
        !requested.includes(check) ||
        !coversChangedPaths(event.paths, input.changedPaths, false)
      )
        continue;
      latest.set(
        check,
        evidenceRef(
          input,
          check,
          "user_confirmed",
          event.eventId,
          evidencePaths(event.paths),
          event.revision,
        ),
      );
      continue;
    }

    const started = starts.get(event.toolCallId);
    if (!started || (event.toolName && started.event.toolName !== event.toolName)) continue;
    const shellTool = event.toolName === "bash" || event.toolName === "terminal_run";
    const endCheck = shellTool
      ? (checkKey(event.checkName) ??
        recognizeCheckInvocation(event.toolName, event.command)?.checkName)
      : checkKey(event.checkName);
    if (endCheck && started.checkName && endCheck !== started.checkName) continue;
    const check = started.checkName;
    if (
      !check ||
      !requested.includes(check) ||
      started.mutatesSource === true ||
      started.generation !== generation ||
      !coversChangedPaths(
        event.paths ?? started.paths,
        input.changedPaths,
        event.fullProject ?? started.fullProject,
      )
    )
      continue;
    const eligibleShell =
      started.event.toolName === "bash" || started.event.toolName === "terminal_run";
    const status: VerificationEvidenceStatus = event.aborted
      ? "unavailable"
      : event.skipped
        ? "skipped"
        : event.error || (event.exitCode !== undefined && event.exitCode !== 0)
          ? "failed"
          : !eligibleShell
            ? "unavailable"
            : event.exitCode === undefined
              ? started.event.toolName === "bash"
                ? "passed"
                : "unavailable"
              : "passed";
    latest.set(
      check,
      evidenceRef(
        input,
        check,
        status,
        event.eventId,
        evidencePaths(event.paths ?? started.paths),
        event.revision ?? started.event.revision,
      ),
    );
  }

  const evidence = requested
    .map((check) => latest.get(check) ?? evidenceRef(input, check, "missing"))
    .slice(0, MAX_EVIDENCE);
  const statuses = evidence.map(({ status }) => status);
  let status: AutoQAStatus;
  let reasonCode: string;
  if (statuses.includes("failed")) {
    status = "failed";
    reasonCode = "required_check_failed";
  } else if (statuses.includes("skipped")) {
    status = "skipped";
    reasonCode = "required_check_skipped";
  } else if (statuses.includes("missing")) {
    status = "missing";
    reasonCode = "required_check_missing";
  } else if (statuses.includes("unavailable")) {
    status = "unavailable";
    reasonCode = "required_check_unavailable";
  } else if (statuses.includes("user_confirmed")) {
    status = "user_confirmed";
    reasonCode = "automated_check_unverified";
  } else {
    status = "passed";
    reasonCode = "required_checks_passed";
  }

  return { required: true, status, reasonCode, evidence };
}
