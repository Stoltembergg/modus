import { describe, expect, it, vi, afterEach } from "vitest";
import {
  groupAgentWorkingLabel,
  groupRoomLabel,
  resolveGroupRoomLocale,
  thinkingStateKeyFromLive,
  systemHourCycle,
} from "./group-room-locale";

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

describe("groupAgentWorkingLabel", () => {
  it("localizes working shimmer agent names", () => {
    expect(groupAgentWorkingLabel(["Planner"], "en")).toBe("Planner is working…");
    expect(groupAgentWorkingLabel(["Planner"], "pt-BR")).toBe("Planner está a trabalhar…");
    expect(groupAgentWorkingLabel(["Planner", "Builder"], "en")).toBe(
      "Planner and Builder are working…",
    );
    expect(groupAgentWorkingLabel(["Planner", "Builder"], "pt")).toBe(
      "Planner e Builder estão a trabalhar…",
    );
    expect(groupAgentWorkingLabel([], "en")).toBe("Working…");
  });
});

describe("systemHourCycle", () => {
  const OriginalIntl = Intl;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns hour cycle when available", () => {
    const mockResolvedOptions = vi.fn().mockReturnValue({ hourCycle: "h23" });
    const MockDateTimeFormat = vi.fn().mockImplementation(function() {
      return { resolvedOptions: mockResolvedOptions };
    });
    vi.stubGlobal("Intl", { ...OriginalIntl, DateTimeFormat: MockDateTimeFormat });

    expect(systemHourCycle()).toBe("h23");
  });

  it("returns undefined when it throws", () => {
    const MockDateTimeFormat = vi.fn().mockImplementation(function() {
      throw new Error("Intl error");
    });
    vi.stubGlobal("Intl", { ...OriginalIntl, DateTimeFormat: MockDateTimeFormat });

    expect(systemHourCycle()).toBeUndefined();
  });
});
