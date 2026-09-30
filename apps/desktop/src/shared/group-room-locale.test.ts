import { describe, expect, it } from "vitest";
import {
  groupRoomLabel,
  resolveGroupRoomLocale,
  thinkingStateKeyFromLive,
} from "./group-room-locale";
import {
  extractUsefulSources,
  inlineLiveStatusLabel,
  shouldPersistCollabStatusInTranscript,
  stripAgentSelfIntro,
} from "./group-room-transcript";

describe("group-room-locale", () => {
  it("resolves pt / zh / en catalogs", () => {
    expect(resolveGroupRoomLocale("pt-BR")).toBe("pt");
    expect(resolveGroupRoomLocale("zh-CN")).toBe("zh");
    expect(resolveGroupRoomLocale("en-US")).toBe("en");
  });

  it("localizes thinking states", () => {
    expect(groupRoomLabel("thinking", "en")).toBe("Thinking…");
    expect(groupRoomLabel("thinking", "pt-BR")).toBe("Pensando…");
    expect(groupRoomLabel("reading", "pt")).toBe("Lendo arquivos…");
    expect(groupRoomLabel("queued", "pt")).toBe("Na fila…");
    expect(groupRoomLabel("ready", "pt")).toBe("Pronto para você");
  });

  it("maps live presence to thinking keys", () => {
    expect(thinkingStateKeyFromLive({ phase: "Exploring", presenceState: "exploring" })).toBe(
      "exploring",
    );
    expect(thinkingStateKeyFromLive({ phase: "Thinking", stillWorking: true })).toBe(
      "stillWorking",
    );
  });
});

describe("stripAgentSelfIntro / sources / ready persistence", () => {
  it("strips redundant self-intros", () => {
    expect(stripAgentSelfIntro("Aqui é o @Planner, vamos começar.")).toBe("vamos começar.");
    expect(stripAgentSelfIntro("Here is @Builder — shipping next.")).toBe("shipping next.");
    expect(stripAgentSelfIntro("I'll take the review.")).toBe("I'll take the review.");
  });

  it("extracts useful http sources and skips localhost", () => {
    expect(
      extractUsefulSources("See https://example.com/docs and http://localhost:3000/x"),
    ).toEqual([{ href: "https://example.com/docs", label: "example.com" }]);
  });

  it("does not persist Ready in the transcript", () => {
    expect(shouldPersistCollabStatusInTranscript({ kind: "ready" })).toBe(false);
    expect(shouldPersistCollabStatusInTranscript({ kind: "blocked", reason: "need key" })).toBe(
      true,
    );
  });

  it("localizes inline live status", () => {
    expect(
      inlineLiveStatusLabel({ phase: "Thinking", presenceState: "thinking", locale: "pt-BR" }),
    ).toBe("Pensando…");
    expect(inlineLiveStatusLabel({ phase: "Queued", presenceState: "queued", locale: "pt" })).toBe(
      "Na fila…",
    );
  });
});
