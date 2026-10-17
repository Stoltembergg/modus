import type { QuestionPrompt } from "../../../../shared/contracts";
import { SETTINGS_TEXT_EN, type SettingsTextKey } from "../../../../shared/settings-text";
import type { SettingsTextFn } from "../../lib/settingsText";

type PromptText = {
  header: SettingsTextKey;
  detail: SettingsTextKey;
  options: Readonly<Record<string, SettingsTextKey>>;
};

/**
 * Display copy for the prompts the app itself writes (the intent gate in
 * main), keyed by question id. Main sends English and compares the English
 * option label it gets back, so only what the card SHOWS is translated; the
 * selection still carries `option.label`. Prompts from the agent (`ask_user`)
 * are the model's own words and pass through untouched.
 */
const APP_PROMPT_TEXT: Readonly<Record<string, PromptText>> = {
  "intent-clarification": {
    header: "settings.question.clarify.header",
    detail: "settings.question.clarify.detail",
    options: {
      "Use a conservative default": "settings.question.clarify.useDefault",
      "Cancel this turn": "settings.question.clarify.cancelTurn",
    },
  },
  "intent-confirmation": {
    header: "settings.question.confirm.header",
    detail: "settings.question.confirm.detail",
    options: {
      Proceed: "settings.question.confirm.proceed",
      Cancel: "settings.question.confirm.cancel",
    },
  },
};

export type QuestionPromptDisplay = {
  header: string;
  detail: string | undefined;
  optionLabel: (label: string) => string;
};

export function questionPromptDisplay(
  question: Pick<QuestionPrompt, "id" | "header" | "detail">,
  t: SettingsTextFn,
): QuestionPromptDisplay {
  const known = APP_PROMPT_TEXT[question.id];
  // Only translate main's text as this catalog knows it: if main changes a
  // prompt, the card shows what was sent instead of a stale translation.
  if (!known || SETTINGS_TEXT_EN[known.header] !== question.header) {
    return { header: question.header, detail: question.detail, optionLabel: (label) => label };
  }
  return {
    header: t(known.header),
    detail:
      question.detail && SETTINGS_TEXT_EN[known.detail] === question.detail
        ? t(known.detail)
        : question.detail,
    optionLabel: (label) => {
      const key = known.options[label];
      return key ? t(key) : label;
    },
  };
}
