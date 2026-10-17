import { describe, expect, it } from "vitest";
import { evaluateIntentGate, type IntentGateInput } from "./intent-gate";

const input = (text: string, contextPaths: string[] = []) => ({
  text,
  mode: "build" as const,
  contextPaths,
  changedPaths: [],
});

describe("evaluateIntentGate", () => {
  it("proceeds for a clear low-consequence request", () => {
    expect(evaluateIntentGate(input("Fix the typo in the SaveButton label"))).toEqual({
      action: "proceed",
    });
  });

  it("suggests planning for complex scoped work", () => {
    expect(
      evaluateIntentGate(
        input("Implement the cross-cutting feature", [
          "src/main/a.ts",
          "src/main/b.ts",
          "src/renderer/c.tsx",
          "src/shared/d.ts",
        ]),
      ),
    ).toMatchObject({ action: "suggest_plan", classification: { complexity: "complex" } });
  });

  it("asks a generic clarifying question for material ambiguity without embedding intent text", () => {
    const result = evaluateIntentGate(input("Which deployment option should I choose?"));
    expect(result).toMatchObject({
      action: "clarify",
      default: "Use a conservative default and proceed.",
      question: { header: expect.stringContaining("requirement or target"), multiSelect: false },
    });
    expect(JSON.stringify(result)).not.toContain("Which deployment option");
  });

  it("confirms consequential destructive requests with a generic question", () => {
    const result = evaluateIntentGate(input("Delete the production database"));
    expect(result).toMatchObject({
      action: "confirm",
      question: { header: "Confirm consequential action", multiSelect: false },
    });
    expect(JSON.stringify(result)).not.toContain("production database");
  });

  it("does not confirm read-only security review or Plan Mode migration discussion", () => {
    expect(evaluateIntentGate(input("Review the security of the authentication changes"))).toEqual({
      action: "proceed",
    });
    expect(
      evaluateIntentGate({ ...input("Discuss the database migration plan"), mode: "plan" }),
    ).not.toMatchObject({ action: "confirm" });
  });

  it("confirms explicit destructive Build effects and destructive flags, but not Plan Mode flags", () => {
    expect(evaluateIntentGate(input("Delete production data"))).toMatchObject({
      action: "confirm",
    });
    expect(evaluateIntentGate(input("Please delete production data"))).toMatchObject({
      action: "confirm",
    });
    expect(evaluateIntentGate(input("I want you to delete production data"))).toMatchObject({
      action: "confirm",
    });
    expect(
      evaluateIntentGate({ ...input("Apply the requested operation"), hasDestructiveAction: true }),
    ).toMatchObject({ action: "confirm" });
    expect(
      evaluateIntentGate({
        ...input("Discuss the migration"),
        mode: "plan",
        hasDestructiveAction: true,
      }),
    ).not.toMatchObject({ action: "confirm" });
  });

  it("detects direct destructive clauses anywhere without confirming discussion or routine edits", () => {
    expect(
      evaluateIntentGate(input("Back up the database, then delete production data")),
    ).toMatchObject({ action: "confirm" });
    expect(evaluateIntentGate(input("Explain whether we should delete production data"))).toEqual({
      action: "proceed",
    });
    expect(evaluateIntentGate(input("Review the security implications of deleting data"))).toEqual({
      action: "proceed",
    });
    expect(evaluateIntentGate(input("Remove the unused import"))).toEqual({ action: "proceed" });
    expect(evaluateIntentGate(input("Remove the unused import in Sidebar.tsx"))).toEqual({
      action: "proceed",
    });
  });

  it("confirms deleting a personal account or dropping a named table", () => {
    expect(evaluateIntentGate(input("Delete my account"))).toMatchObject({ action: "confirm" });
    expect(evaluateIntentGate(input("Drop the orders table"))).toMatchObject({ action: "confirm" });
  });

  it("asks for the missing decision and keeps free-text input out of the gate artifact", () => {
    const result = evaluateIntentGate(input("Which deployment option should I choose?"));
    expect(result).toMatchObject({
      action: "clarify",
      question: { header: expect.stringContaining("requirement or target") },
    });
    expect(JSON.stringify(result)).not.toContain("Which deployment option");
  });

  // Labels written before the missing-target rule was implemented. "clarify" means the gate
  // asks one question (the conservative default still proceeds with the same tools); every
  // other row must keep today's "proceed".
  const assistant = (text: string) => ({ assistantText: text });
  const user = (text: string) => ({ userText: text });
  const table: Array<{
    label: "clarify" | "proceed";
    text: string;
    note: string;
    extra?: Partial<IntentGateInput>;
  }> = [
    // Action with no target (pt-BR / English)
    { label: "clarify", note: "no target en", text: "Fix it" },
    { label: "clarify", note: "no target en", text: "Please fix the bug" },
    {
      label: "clarify",
      note: "no target en",
      text: "Refactor that class to use dependency injection",
    },
    { label: "clarify", note: "no target en", text: "Add error handling to the endpoint" },
    { label: "clarify", note: "no target en", text: "Convert this JavaScript file to TypeScript" },
    { label: "clarify", note: "no target en", text: "Improve performance" },
    { label: "clarify", note: "no target en", text: "Clean up the project" },
    { label: "clarify", note: "no target en", text: "Do it" },
    { label: "clarify", note: "no target en", text: "Delete the old file we don't use anymore" },
    { label: "clarify", note: "no target pt", text: "Melhora isso" },
    { label: "clarify", note: "no target pt", text: "Arruma isso" },
    { label: "clarify", note: "no target pt", text: "Corrija o bug no componente" },
    { label: "clarify", note: "no target pt", text: "Remova o código duplicado" },
    { label: "clarify", note: "no target pt", text: "Atualiza a versão da biblioteca" },
    { label: "clarify", note: "no target pt", text: "Otimize essa query" },
    { label: "clarify", note: "no target pt", text: "Muda o design" },
    { label: "clarify", note: "no target pt", text: "Pode corrigir isso?" },
    { label: "clarify", note: "no target pt", text: "Por favor, adiciona testes para essa função" },
    // Action with a target in the request
    // Targets that are unique in any project (lint, tests, build, CI, version, dependencies)
    { label: "proceed", note: "project target", text: "Fix the lint errors" },
    { label: "proceed", note: "project target", text: "Corrija os erros de lint" },
    { label: "proceed", note: "project target", text: "Update the version" },
    { label: "proceed", note: "project target", text: "Atualize a versão" },
    { label: "proceed", note: "project target", text: "Fix the failing tests" },
    { label: "proceed", note: "project target", text: "Fix the build" },
    { label: "proceed", note: "project target", text: "Fix CI" },
    { label: "proceed", note: "project target", text: "Resolve the merge conflicts" },
    { label: "proceed", note: "project target", text: "Update dependencies" },
    { label: "proceed", note: "project target", text: "Remove the unused import" },
    { label: "proceed", note: "project target", text: "fix the warnings" },
    { label: "proceed", note: "project target", text: "Corrija os erros de tipo" },
    { label: "proceed", note: "project target", text: "Fix the type errors" },
    { label: "proceed", note: "project target", text: "Resolva os conflitos de merge" },
    { label: "proceed", note: "project target", text: "Atualize as dependências" },
    { label: "proceed", note: "project target", text: "Conserta os testes" },
    { label: "proceed", note: "project target", text: "Fix the typecheck" },
    { label: "clarify", note: "open-ended verb", text: "Improve the tests" },
    { label: "clarify", note: "open-ended verb", text: "Melhora os testes" },
    { label: "clarify", note: "which dependency", text: "Update the dependency" },
    { label: "proceed", note: "lowercase error", text: "fix this: error: cannot read config" },
    { label: "proceed", note: "lowercase error", text: "fix typeerror: x is undefined" },
    // A leading "ok"/"sim" does not hide the verb
    { label: "clarify", note: "leading ok", text: "ok, fix it" },
    { label: "clarify", note: "leading sim", text: "sim corrige isso" },
    { label: "proceed", note: "leading ok", text: "ok fix the build" },
    { label: "proceed", note: "file", text: "Fix the type error in TodosCard.tsx" },
    {
      label: "proceed",
      note: "path",
      text: "Corrija o bug em src/main/agent/harness/intent-gate.ts",
    },
    { label: "proceed", note: "camelCase", text: "Rename applyModelSelection to applyUserModel" },
    { label: "proceed", note: "PascalCase", text: "Refatora a classe PlanStore" },
    { label: "proceed", note: "snake_case", text: "Atualiza o max_retries para 5" },
    { label: "proceed", note: "backticks", text: "Remove the `reasoning` filter" },
    { label: "proceed", note: "quoted text", text: 'Change the button text to "Salvar"' },
    {
      label: "proceed",
      note: "error text",
      text: "Fix TypeError: Cannot read properties of undefined (reading 'map')",
    },
    {
      label: "proceed",
      note: "pasted error + fix it",
      text: "error TS2554: Expected 1 arguments, but got 2.\nFix it",
    },
    {
      label: "proceed",
      note: "attached file",
      text: "Fix it",
      extra: { contextPaths: ["src/renderer/Sidebar.tsx"] },
    },
    {
      label: "proceed",
      note: "attached element/image",
      text: "Muda isso",
      extra: { hasAttachedContext: true },
    },
    {
      label: "proceed",
      note: "component name",
      text: "Troque as bordas da Sidebar por espaçamento",
    },
    { label: "proceed", note: "known file", text: "Atualize o README com as instruções de build" },
    { label: "proceed", note: "dotfile", text: "Add a .nvmrc file with Node 22" },
    { label: "proceed", note: "version", text: "Add a changelog entry for v0.1.7" },
    // Prior conversational context
    {
      label: "proceed",
      note: "previous pasted error + Fix it",
      text: "Fix it",
      extra: {
        previousTurn: user(
          "TypeError: Cannot read properties of undefined (reading 'map') at TodosCard.tsx:42",
        ),
      },
    },
    {
      label: "proceed",
      note: "previous pasted error + Arruma isso",
      text: "Arruma isso",
      extra: {
        previousTurn: user(
          "src/main/agent/harness/intent-gate.ts(59,53): error TS2554: Expected 1 arguments, but got 2.",
        ),
      },
    },
    {
      label: "proceed",
      note: "agent named the file",
      text: "fix it",
      extra: { previousTurn: assistant("The divider comes from Sidebar.tsx line 326.") },
    },
    {
      label: "proceed",
      note: "agent question + sim, remove",
      text: "sim, remove",
      extra: { previousTurn: assistant("Quer que eu remova o import não usado?") },
    },
    {
      label: "proceed",
      note: "agent question + sim",
      text: "sim",
      extra: { previousTurn: assistant("Posso remover o divisor?") },
    },
    {
      label: "proceed",
      note: "agent question + yes, do it",
      text: "yes, do it",
      extra: { previousTurn: assistant("Should I also update the tests?") },
    },
    {
      label: "proceed",
      note: "agent question + pode corrigir",
      text: "pode corrigir",
      extra: { previousTurn: assistant("Encontrei o problema. Quer que eu corrija?") },
    },
    {
      label: "clarify",
      note: "agent listed options, no question",
      text: "do it",
      extra: {
        previousTurn: assistant(
          "I found three ways to fix the race condition: a lock, a queue, or debouncing.",
        ),
      },
    },
    {
      label: "clarify",
      note: "agent asked, reply is a new vague action",
      text: "make it better",
      extra: { previousTurn: assistant("Done. Anything else?") },
    },
    {
      label: "clarify",
      note: "unrelated previous user turn",
      text: "ok, update it",
      extra: { previousTurn: user("what's new in the repo?") },
    },
    // Read-only questions stay proceed
    { label: "proceed", note: "read-only en", text: "What does this function do?" },
    { label: "proceed", note: "read-only en", text: "How do I fix this?" },
    { label: "proceed", note: "read-only en", text: "Can you explain how to fix it?" },
    {
      label: "proceed",
      note: "read-only en",
      text: "Explain why this assertion fails, don't change anything yet",
    },
    { label: "proceed", note: "read-only en", text: "Where is the billing logic implemented?" },
    { label: "proceed", note: "read-only pt", text: "Explique o que a função faz" },
    {
      label: "proceed",
      note: "read-only pt",
      text: "Por que esse teste está falhando? Só quero entender, não mexa em nada",
    },
    { label: "proceed", note: "read-only pt", text: "Como funciona o fluxo de autenticação?" },
    { label: "proceed", note: "read-only pt", text: "Qual o risco de usar == aqui?" },
    { label: "proceed", note: "negated en", text: "Do not run tests" },
    { label: "proceed", note: "question en", text: "Do you know where the billing code lives?" },
    { label: "proceed", note: "question pt", text: "Faz sentido mudar isso?" },
    // Plan Mode never gets the missing-target question
    { label: "proceed", note: "plan mode", text: "Fix it", extra: { mode: "plan" } },
  ];

  it.each(table)("labels $note: $text -> $label", ({ label, text, extra }) => {
    const result = evaluateIntentGate({ ...input(text), ...extra });
    expect(result.action).toBe(label);
    if (label === "clarify") {
      expect(result).toMatchObject({
        question: { id: "intent-clarification", multiSelect: false },
        default: "Use a conservative default and proceed.",
      });
      expect(JSON.stringify(result)).not.toContain(text);
    }
  });

  it("keeps destructive confirmation ahead of the missing-target question", () => {
    expect(evaluateIntentGate(input("Delete all the data"))).toMatchObject({ action: "confirm" });
    expect(evaluateIntentGate({ ...input("Fix it"), hasDestructiveAction: true })).toMatchObject({
      action: "confirm",
    });
  });

  describe("previous-reply cost", () => {
    it("keeps a 100 KB previous agent reply under 50 ms", () => {
      const huge = `${"a".repeat(50_000)}${"-".repeat(50_000)}`;
      const started = performance.now();
      const result = evaluateIntentGate({ ...input("Fix it"), previousTurn: assistant(huge) });
      const elapsed = performance.now() - started;
      expect(result.action).toBe("clarify");
      expect(elapsed).toBeLessThan(50);
    });

    it("only reads the tail of the previous agent reply", () => {
      const filler = "word ".repeat(1_000);
      expect(
        evaluateIntentGate({
          ...input("Fix it"),
          previousTurn: assistant(`Edited Sidebar.tsx.\n${filler}`),
        }).action,
      ).toBe("clarify");
      expect(
        evaluateIntentGate({
          ...input("Fix it"),
          previousTurn: assistant(`${filler}\nEdited Sidebar.tsx.`),
        }).action,
      ).toBe("proceed");
    });

    it("skips the edit-verb scan for a long request", () => {
      const long = `fix ${"x".repeat(100_000)}`;
      const started = performance.now();
      expect(evaluateIntentGate(input(long)).action).not.toBe("clarify");
      expect(performance.now() - started).toBeLessThan(50);
    });
  });

  describe("user setting: ask before acting when the target is missing", () => {
    const off = { askMissingTarget: false } as const;

    it("asks by default", () => {
      expect(evaluateIntentGate(input("Fix it")).action).toBe("clarify");
    });

    it.each([
      "Fix it",
      "Melhora isso",
      "ok, fix it",
      "Please fix the bug",
    ])("proceeds directly when off: %s", (text) => {
      expect(evaluateIntentGate({ ...input(text), ...off })).toEqual({ action: "proceed" });
    });

    it("proceeds directly when off after a previous turn", () => {
      expect(
        evaluateIntentGate({
          ...input("Fix it"),
          ...off,
          previousTurn: { userText: "what's new in the repo?", assistantText: "Nothing changed." },
        }),
      ).toEqual({ action: "proceed" });
    });

    it("keeps destructive confirmation when off", () => {
      expect(evaluateIntentGate({ ...input("Delete all the data"), ...off })).toMatchObject({
        action: "confirm",
      });
    });
  });
});
