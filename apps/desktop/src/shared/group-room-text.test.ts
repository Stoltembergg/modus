import { describe, expect, it } from "vitest";
import {
  FILES_SEARCH_TEXT_EN,
  FILES_SEARCH_TEXT_PT,
  FILES_SEARCH_TEXT_ZH,
} from "./files-search-text";
import {
  filesSearchPluralText,
  filesSearchText,
  GROUP_ROOM_CATALOGS,
  type GroupRoomLocale,
  groupPluralText,
  groupRoomIntlLocale,
  groupText,
  isLegacyWaitingForYouBody,
  localizeGroupStatusBody,
  matchGroupStatusBody,
} from "./group-room-locale";
import { GROUP_ROOM_TEXT_EN, GROUP_ROOM_TEXT_PT, GROUP_ROOM_TEXT_ZH } from "./group-room-text";

const LOCALES: readonly GroupRoomLocale[] = ["en", "pt", "zh"];
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/**
 * Key parity (C6): every room catalog has exactly the same keys in en, pt and
 * zh, every value is non-empty, and the `{placeholder}` set of a key is the
 * same in the three locales. A key missing (or extra) in one locale fails.
 */
describe("group room catalog parity (en / pt / zh)", () => {
  for (const [name, catalog] of Object.entries(GROUP_ROOM_CATALOGS)) {
    it(`${name}: same key set in every locale`, () => {
      const en = Object.keys(catalog.en).sort();
      expect(en.length).toBeGreaterThan(0);
      for (const locale of LOCALES) {
        const keys = Object.keys(catalog[locale]).sort();
        const missing = en.filter((key) => !keys.includes(key));
        const extra = keys.filter((key) => !en.includes(key));
        expect({ locale, missing, extra }).toEqual({ locale, missing: [], extra: [] });
      }
    });

    it(`${name}: non-empty values with the same placeholders`, () => {
      for (const key of Object.keys(catalog.en)) {
        const enText = (catalog.en as Record<string, string>)[key] ?? "";
        for (const locale of LOCALES) {
          const text = (catalog[locale] as Record<string, string>)[key] ?? "";
          expect(text.trim(), `${name}.${locale}.${key}`).not.toBe("");
          expect(placeholders(text), `${name}.${locale}.${key}`).toEqual(placeholders(enText));
        }
      }
    });
  }

  it("plural keys always come as _one / _other pairs", () => {
    for (const table of [GROUP_ROOM_TEXT_EN, FILES_SEARCH_TEXT_EN]) {
      const keys = Object.keys(table);
      for (const key of keys) {
        if (key.endsWith("_one")) expect(keys).toContain(key.replace(/_one$/, "_other"));
        if (key.endsWith("_other")) expect(keys).toContain(key.replace(/_other$/, "_one"));
      }
    }
  });

  it("the Files / Search catalog (C6.1) is under the parity check", () => {
    expect(GROUP_ROOM_CATALOGS.filesSearch).toEqual({
      en: FILES_SEARCH_TEXT_EN,
      pt: FILES_SEARCH_TEXT_PT,
      zh: FILES_SEARCH_TEXT_ZH,
    });
  });

  it("Files / Search: pt and zh are translations, not English copies", () => {
    const same = (
      Object.keys(FILES_SEARCH_TEXT_EN) as (keyof typeof FILES_SEARCH_TEXT_EN)[]
    ).filter(
      (key) =>
        FILES_SEARCH_TEXT_PT[key] === FILES_SEARCH_TEXT_EN[key] &&
        FILES_SEARCH_TEXT_ZH[key] === FILES_SEARCH_TEXT_EN[key],
    );
    expect(same).toEqual([]);
  });

  it("pt and zh are translations, not English copies (except brand / shared words)", () => {
    const same = Object.keys(GROUP_ROOM_TEXT_EN).filter(
      (key) =>
        GROUP_ROOM_TEXT_PT[key as keyof typeof GROUP_ROOM_TEXT_PT] ===
          GROUP_ROOM_TEXT_EN[key as keyof typeof GROUP_ROOM_TEXT_EN] &&
        GROUP_ROOM_TEXT_ZH[key as keyof typeof GROUP_ROOM_TEXT_ZH] ===
          GROUP_ROOM_TEXT_EN[key as keyof typeof GROUP_ROOM_TEXT_EN],
    );
    // "Lead" is a product term kept in every locale.
    expect(same).toEqual(["common.lead"]);
  });
});

describe("filesSearchText / filesSearchPluralText (C6.1)", () => {
  it("resolves with the room rule and fills placeholders", () => {
    expect(filesSearchText("files.dialogTitle", "pt-BR", { name: "a.ts" })).toBe(
      "Salvar as alterações em a.ts?",
    );
    expect(filesSearchText("files.dialogTitle", "zh-TW", { name: "a.ts" })).toBe(
      "保存对 a.ts 的更改？",
    );
    expect(filesSearchText("files.dialogTitle", "fr", { name: "a.ts" })).toBe(
      "Save changes to a.ts?",
    );
    expect(filesSearchPluralText("search.found", 1, "en")).toBe("Found 1 result");
    expect(filesSearchPluralText("search.found", 4, "en")).toBe("Found 4 results");
    expect(filesSearchPluralText("search.found", 4, "pt")).toBe("4 resultados encontrados");
    expect(filesSearchPluralText("search.matches", 1, "pt")).toBe("1 ocorrência");
  });
});

describe("groupText / groupPluralText", () => {
  it("fills placeholders in the resolved locale", () => {
    expect(groupText("row.replyingTo", "en", { name: "Ana" })).toBe("Replying to Ana");
    expect(groupText("row.replyingTo", "pt-BR", { name: "Ana" })).toBe("Respondendo a Ana");
    expect(groupText("row.replyingTo", "zh-CN", { name: "Ana" })).toBe("回复 Ana");
    expect(groupText("row.replyingTo", "fr", { name: "Ana" })).toBe("Replying to Ana");
  });

  it("picks _one / _other by count", () => {
    expect(groupPluralText("list.newMessages", 1, "en")).toBe("1 new message");
    expect(groupPluralText("list.newMessages", 3, "en")).toBe("3 new messages");
    expect(groupPluralText("list.newMessages", 3, "pt")).toBe("3 novas mensagens");
    expect(groupPluralText("list.newMessages", 1, "zh")).toBe("1 条新消息");
  });

  it("maps a tag to an Intl locale with the catalog's rule", () => {
    expect(groupRoomIntlLocale("pt-BR")).toBe("pt-BR");
    expect(groupRoomIntlLocale("pt_PT")).toBe("pt-PT");
    expect(groupRoomIntlLocale("zh-TW")).toBe("zh-TW");
    expect(groupRoomIntlLocale("en-GB")).toBe("en-GB");
    expect(groupRoomIntlLocale("de-DE")).toBe("en-US");
    expect(groupRoomIntlLocale("not a tag")).toBe("en-US");
  });
});

describe("persisted status bodies are localised at render time", () => {
  it("recognises the English templates and keeps their values", () => {
    expect(matchGroupStatusBody("Worktree ready: `feat/x`")).toEqual({
      key: "status.worktreeReady",
      vars: { branch: "feat/x" },
    });
    expect(localizeGroupStatusBody("Worktree ready: `feat/x`", "pt")).toBe(
      "Worktree pronta: `feat/x`",
    );
    expect(localizeGroupStatusBody("Planner is archived", "zh")).toBe("Planner 已归档");
    expect(localizeGroupStatusBody("Turn failed", "pt")).toBe("Turno falhou");
  });

  it("leaves unknown bodies unchanged and English as is", () => {
    expect(localizeGroupStatusBody("Something else", "pt")).toBe("Something else");
    expect(localizeGroupStatusBody("Turn stopped", "en")).toBe("Turn stopped");
  });

  it("localises the legacy 'Waiting for you' text body", () => {
    expect(isLegacyWaitingForYouBody("Waiting for you")).toBe(true);
    expect(isLegacyWaitingForYouBody("  Waiting for you — approve the plan")).toBe(true);
    expect(isLegacyWaitingForYouBody("Turn failed")).toBe(false);
    expect(localizeGroupStatusBody("Waiting for you", "pt")).toBe("Aguardando você");
    expect(localizeGroupStatusBody("Waiting for you", "zh")).toBe("等待你");
    expect(localizeGroupStatusBody("Waiting for you", "en")).toBe("Waiting for you");
  });
});
