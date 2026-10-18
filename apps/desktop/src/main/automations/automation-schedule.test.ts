import { describe, expect, it } from "vitest";

const scheduleModule = await import("./automation-schedule").catch(() => null);

describe("automation schedule", () => {
  it("calculates one-time, daily and weekly occurrences in the selected timezone", () => {
    expect(scheduleModule).not.toBeNull();
    if (!scheduleModule) return;

    const { nextAutomationOccurrence } = scheduleModule;

    expect(
      nextAutomationOccurrence(
        { kind: "once", at: "2026-10-18T13:00:00.000Z" },
        "America/Sao_Paulo",
        "2026-10-18T12:59:00.000Z",
      ),
    ).toBe("2026-10-18T13:00:00.000Z");

    expect(
      nextAutomationOccurrence(
        { kind: "daily", localTime: "09:15" },
        "America/Sao_Paulo",
        "2026-10-18T12:30:00.000Z",
      ),
    ).toBe("2026-10-19T12:15:00.000Z");

    expect(
      nextAutomationOccurrence(
        { kind: "weekly", daysOfWeek: [1, 3], localTime: "09:15" },
        "America/Sao_Paulo",
        "2026-10-18T12:30:00.000Z",
      ),
    ).toBe("2026-10-19T12:15:00.000Z");
  });

  it("skips nonexistent daylight-saving times and runs only the first repeated time", () => {
    expect(scheduleModule).not.toBeNull();
    if (!scheduleModule) return;

    const { nextAutomationOccurrence } = scheduleModule;

    // New York jumps from 01:59 to 03:00 on 2026-03-08; 02:30 is skipped.
    expect(
      nextAutomationOccurrence(
        { kind: "daily", localTime: "02:30" },
        "America/New_York",
        "2026-03-08T06:00:00.000Z",
      ),
    ).toBe("2026-03-09T06:30:00.000Z");

    // On the fall-back day, 01:30 maps twice; only the first instant is eligible.
    expect(
      nextAutomationOccurrence(
        { kind: "daily", localTime: "01:30" },
        "America/New_York",
        "2026-11-01T05:45:00.000Z",
      ),
    ).toBe("2026-11-02T06:30:00.000Z");
  });

  it("resolves one-time local inputs in the selected timezone without inventing gap times", () => {
    expect(scheduleModule).not.toBeNull();
    if (!scheduleModule) return;
    const { localDateTimeToInstant } = scheduleModule;
    expect(localDateTimeToInstant("2026-11-01T01:30", "America/New_York")).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    expect(localDateTimeToInstant("2026-03-08T02:30", "America/New_York")).toBeNull();
  });

  it("rejects an invalid IANA timezone", () => {
    expect(scheduleModule).not.toBeNull();
    if (!scheduleModule) return;

    const { nextAutomationOccurrence } = scheduleModule;
    expect(() =>
      nextAutomationOccurrence(
        { kind: "daily", localTime: "09:15" },
        "Mars/Olympus",
        "2026-10-18T12:30:00.000Z",
      ),
    ).toThrow(/time zone/i);
  });

  it("rejects invalid local times, empty weekday sets and unsupported schedule kinds", () => {
    expect(scheduleModule).not.toBeNull();
    if (!scheduleModule) return;

    const { nextAutomationOccurrence } = scheduleModule;
    const after = "2026-10-18T12:30:00.000Z";
    expect(() =>
      nextAutomationOccurrence({ kind: "daily", localTime: "25:90" }, "America/Sao_Paulo", after),
    ).toThrow(/HH:mm/);
    expect(() =>
      nextAutomationOccurrence(
        { kind: "weekly", daysOfWeek: [], localTime: "09:15" },
        "America/Sao_Paulo",
        after,
      ),
    ).toThrow(/weekdays/);
    expect(() =>
      nextAutomationOccurrence(
        { kind: "monthly" } as unknown as Parameters<typeof nextAutomationOccurrence>[0],
        "America/Sao_Paulo",
        after,
      ),
    ).toThrow(/unsupported/i);
  });

  it("summarizes elapsed schedule occurrences without replaying them", () => {
    expect(scheduleModule).not.toBeNull();
    if (!scheduleModule) return;

    const { findMissedAutomationOccurrences } = scheduleModule;
    expect(
      findMissedAutomationOccurrences(
        { kind: "daily", localTime: "09:15" },
        "America/Sao_Paulo",
        "2026-10-18T11:59:00.000Z",
        "2026-10-20T13:00:00.000Z",
      ),
    ).toEqual({
      first: "2026-10-18T12:15:00.000Z",
      last: "2026-10-20T12:15:00.000Z",
      count: 3,
      nextOccurrence: "2026-10-21T12:15:00.000Z",
    });
  });
});
