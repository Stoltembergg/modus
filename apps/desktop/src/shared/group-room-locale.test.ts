import { describe, expect, it, vi } from "vitest";
import {
  groupAgentWorkingLabel,
  groupRoomLabel,
  resolveGroupRoomLocale,
  systemHourCycle,
  thinkingStateKeyFromLive,
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
  it("returns the system hour cycle from Intl.DateTimeFormat resolvedOptions", () => {
    const OriginalDateTimeFormat = Intl.DateTimeFormat;

    vi.stubGlobal("Intl", {
      ...Intl,
      DateTimeFormat: class MockDateTimeFormat {
        resolvedOptions() {
          return { hourCycle: "h12" };
        }
      },
    });

    try {
      expect(systemHourCycle()).toBe("h12");
    } finally {
      vi.stubGlobal("Intl", { ...Intl, DateTimeFormat: OriginalDateTimeFormat });
    }
  });

  it("returns undefined when Intl throws an error", () => {
    const OriginalDateTimeFormat = Intl.DateTimeFormat;

    vi.stubGlobal("Intl", {
      ...Intl,
      DateTimeFormat: class MockDateTimeFormat {
        resolvedOptions() {
          throw new Error("Simulated error");
        }
      },
    });

    try {
      expect(systemHourCycle()).toBeUndefined();
    } finally {
      vi.stubGlobal("Intl", { ...Intl, DateTimeFormat: OriginalDateTimeFormat });
    }
  });
});
