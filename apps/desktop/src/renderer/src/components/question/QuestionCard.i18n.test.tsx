// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionPrompt } from "../../../../shared/contracts";
import { SETTINGS_TEXT_EN as EN } from "../../../../shared/settings-text";
import { QuestionCard } from "./QuestionCard";

afterEach(() => {
  cleanup();
  document.documentElement.lang = "en";
});

/**
 * The clarification prompt as main sends it (intent-gate.test.ts checks that
 * main's text is exactly these English catalog values).
 */
function clarification(): QuestionPrompt {
  return {
    id: "intent-clarification",
    header: EN["settings.question.clarify.header"],
    detail: EN["settings.question.clarify.detail"],
    multiSelect: false,
    options: [
      { label: EN["settings.question.clarify.useDefault"], recommended: true },
      { label: EN["settings.question.clarify.cancelTurn"] },
    ],
  };
}

describe("clarification card language", () => {
  it("shows main's English prompt unchanged by default", () => {
    const question = clarification();
    render(<QuestionCard mode="question" onSubmit={vi.fn()} questions={[question]} />);
    expect(screen.getByText(question.header)).toBeTruthy();
    for (const option of question.options) expect(screen.getByText(option.label)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Submit/ })).toBeTruthy();
  });

  it("shows the card in Portuguese and still answers with main's English label", async () => {
    document.documentElement.lang = "pt-BR";
    const question = clarification();
    const onSubmit = vi.fn();
    render(<QuestionCard mode="question" onSubmit={onSubmit} questions={[question]} />);
    expect(screen.getByText("Qual requisito ou alvo deve guiar esta tarefa?")).toBeTruthy();
    expect(
      screen.getByText(
        "Digite uma resposta curta, escolha o padrão conservador ou cancele este turno.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("(Recomendado)")).toBeTruthy();
    expect(screen.getByPlaceholderText("Ou digite outra resposta…")).toBeTruthy();
    expect(screen.queryByText(question.header)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Cancelar este turno/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Enviar/ }));
    });
    expect(onSubmit).toHaveBeenCalledWith([
      { questionId: "intent-clarification", selected: ["Cancel this turn"] },
    ]);
  });

  it("follows a change of <html lang> without remounting", () => {
    render(<QuestionCard mode="question" onSubmit={vi.fn()} questions={[clarification()]} />);
    expect(screen.getByRole("button", { name: /Submit/ })).toBeTruthy();
    act(() => {
      document.documentElement.lang = "pt-BR";
    });
    return vi.waitFor(() => expect(screen.getByRole("button", { name: /Enviar/ })).toBeTruthy());
  });

  it("leaves agent-written ask_user prompts as the agent wrote them", () => {
    document.documentElement.lang = "pt-BR";
    const question: QuestionPrompt = {
      id: "q1",
      header: "Which database?",
      multiSelect: false,
      options: [{ label: "Postgres" }, { label: "SQLite" }],
    };
    render(<QuestionCard mode="question" onSubmit={vi.fn()} questions={[question]} />);
    expect(screen.getByText("Which database?")).toBeTruthy();
    expect(screen.getByText("Postgres")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Pergunta" })).toBeTruthy();
  });
});
