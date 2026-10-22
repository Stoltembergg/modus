import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import ts from "typescript";
import type { QualityCheck, QualityFixture } from "./fixtures";

export const CODE_REPAIR_PROVENANCE = {
  revision: "ba6ca5e56d4393316653b6542a9311be08008295",
  source: "apps/desktop/src/shared/command-line.ts",
  sourceSha256: "99157e8a187b73579088d3f5af1a001eaa6ab1cc8780eed4b974a9a94edf3945",
  tests: "apps/desktop/src/shared/command-line.test.ts",
  testsSha256: "02454b1261988ba1b7a7603ff3f215a431e249b7f5f7ca6558d60d770d9a203b",
} as const;

const snapshot = (name: string) =>
  readFileSync(new URL(`./code-repair/${name}.txt`, import.meta.url), "utf8");

export type CommandLineCase = {
  name: string;
  operation: "split" | "join" | "roundTrip";
  input: string | string[];
  expected: string | string[];
};

// Oracle values stay outside the candidate's context and outside its workspace.
export const COMMAND_LINE_CASES: readonly CommandLineCase[] = [
  {
    name: "plain command",
    operation: "split",
    input: "npx -y @scope/server .",
    expected: ["npx", "-y", "@scope/server", "."],
  },
  {
    name: "Windows quoted path",
    operation: "split",
    input: 'node "C:\\My Tools\\server.js" --flag',
    expected: ["node", "C:\\My Tools\\server.js", "--flag"],
  },
  {
    name: "single quoted input",
    operation: "split",
    input: "echo 'hello world'",
    expected: ["echo", "hello world"],
  },
  {
    name: "empty quoted input",
    operation: "split",
    input: 'cmd  ""   tail',
    expected: ["cmd", "", "tail"],
  },
  { name: "blank input", operation: "split", input: "   ", expected: [] },
  {
    name: "existing path formatting",
    operation: "join",
    input: ["node", "C:\\My Tools\\server.js"],
    expected: 'node "C:\\My Tools\\server.js"',
  },
  { name: "existing empty formatting", operation: "join", input: ["a", ""], expected: 'a ""' },
  ...[
    ["npx", "-y", "@scope/server", "."],
    ['a"b'],
    ["it's"],
    [`both'and"quotes`],
    ["", "", "tail"],
    ["C:\\My Tools\\", 'a\\"b', "\\"],
    ["ação", "中文 空格", "line\nbreak", "tab\tvalue"],
    ['"', "'", `"'`, 'ends"', '"starts'],
    [],
  ].map((parts, index) => ({
    name: `round trip ${index + 1}`,
    operation: "roundTrip" as const,
    input: parts,
    expected: parts,
  })),
];

// A fresh process has no provider credentials or inherited NODE_OPTIONS. Only
// strings cross the VM boundary. No require/process/host callbacks are injected.
// These limits are defense in depth for trusted fixtures, NOT a security sandbox.
const CHECK_PROCESS = String.raw`
const vm = require("node:vm");
const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const results = input.cases.map(test => {
  const argument = JSON.stringify(test.input);
  const expression = test.operation === "split" ? "exports.splitCommandLine(" + argument + ")"
    : test.operation === "join" ? "exports.joinCommandLine(" + argument + ")"
    : "exports.splitCommandLine(exports.joinCommandLine(" + argument + "))";
  try {
    const actual = vm.runInNewContext(
      "const exports = Object.create(null);\n" + input.source + "\nJSON.stringify(" + expression + ")",
      Object.create(null),
      { timeout: 100, contextCodeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" },
    );
    return typeof actual === "string" ? { actual } : { error: "Non-JSON result" };
  } catch { return { error: "Candidate threw or exceeded VM limit" }; }
});
process.stdout.write(JSON.stringify(results));
`;

export function verifyCommandLine(source: string): QualityCheck[] {
  const failed = (detail: string): QualityCheck[] => [
    { name: "command-line.ts: executable candidate", passed: false, detail },
  ];
  if (Buffer.byteLength(source) > 64 * 1024) return failed("Candidate exceeds 64 KiB");
  try {
    const compiled = ts.transpileModule(source, {
      fileName: "command-line.ts",
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    });
    if (compiled.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error))
      return failed("Candidate has TypeScript syntax errors");
    const output = execFileSync(
      process.execPath,
      [
        "--max-old-space-size=64",
        "--disable-proto=throw",
        "--disallow-code-generation-from-strings",
        "-e",
        CHECK_PROCESS,
      ],
      {
        input: JSON.stringify({
          source: compiled.outputText,
          cases: COMMAND_LINE_CASES.map(({ expected: _expected, ...test }) => test),
        }),
        encoding: "utf8",
        env: {},
        cwd: tmpdir(),
        timeout: 3_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const results = JSON.parse(output) as { actual?: string; error?: string }[];
    return COMMAND_LINE_CASES.map((test, index) => ({
      name: `command-line.ts: ${test.name}`,
      passed: results[index]?.actual === JSON.stringify(test.expected),
      ...(results[index]?.error ? { detail: results[index]?.error } : {}),
    }));
  } catch {
    return failed("Verifier process failed, timed out, or exceeded output/memory limits");
  }
}

export const CODE_REPAIR_FIXTURE: QualityFixture = {
  id: "repair-command-line-pt",
  language: "pt",
  prompt:
    "Corrija o bug real de round-trip em command-line.ts, usado pelo formulário de servidores MCP. splitCommandLine(joinCommandLine(parts)) deve devolver exatamente parts, inclusive tokens com aspas simples/duplas, espaços, barras invertidas e strings vazias. Preserve os comportamentos existentes em command-line.test.ts e o contrato sem expansão de shell do README.md. Edite somente command-line.ts. Os testes independentes serão executados pelo avaliador depois da sua resposta; você não tem shell e não deve afirmar que executou testes.",
  files: {
    "README.md":
      '# Command-line repair\n\nSnapshot of the real Modus MCP form utility at ba6ca5e. Read command-line.ts and command-line.test.ts. The reported bug: round-tripping the token a"b loses its quote and adds a backslash. Preserve existing behavior: quotes group segments, backslashes are literal (including Windows paths), there is no shell expansion. Fix the encoder rather than introducing escape decoding in the splitter. Preserve exported function names/signatures. Only command-line.ts is writable. The evaluator runs independent behavioral checks, not source-text matching.\n',
    "command-line.ts": snapshot("command-line.ts"),
    "command-line.test.ts": snapshot("command-line.test.ts"),
  },
  writable: ["command-line.ts"],
  verify: ({ files }) => verifyCommandLine(files["command-line.ts"] ?? ""),
};
