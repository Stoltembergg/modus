// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroupMessage, GroupRuntimeEvent } from "../../../../shared/contracts";
import { useGroupMessages } from "./useGroupMessages";

const message = (id: string, groupId: string, more: Partial<GroupMessage> = {}): GroupMessage => ({
  id,
  groupId,
  authorKind: "user",
  kind: "message",
  body: id,
  mentions: [],
  createdAt: id,
  ...more,
});
afterEach(cleanup);

describe("room message fetch generations", () => {
  it("discards old pagination and releases the new room pagination lock", async () => {
    const pending = new Map<string, (page: GroupMessage[]) => void>();
    Object.assign(window, {
      modus: {
        group: {
          onEvent: () => () => {},
          listMessages: vi.fn((input) =>
            input.before
              ? new Promise<GroupMessage[]>((resolve) => pending.set(input.groupId, resolve))
              : Promise.resolve([message(`${input.groupId}2`, input.groupId)]),
          ),
        },
      },
    });
    const hook = renderHook(({ id }) => useGroupMessages(id), { initialProps: { id: "A" } });
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    let loadA!: Promise<void>;
    act(() => {
      loadA = hook.result.current.loadOlder();
    });
    hook.rerender({ id: "B" });
    await waitFor(() => expect(hook.result.current.messages[0]?.groupId).toBe("B"));
    expect(hook.result.current.loadingOlder).toBe(false);
    let loadB!: Promise<void>;
    act(() => {
      loadB = hook.result.current.loadOlder();
    });
    expect(pending.has("B")).toBe(true);
    await act(async () => {
      pending.get("A")?.([message("A1", "A")]);
      await loadA;
    });
    expect(hook.result.current.loadingOlder).toBe(true);
    await act(async () => {
      pending.get("B")?.([message("B1", "B"), message("A1", "A")]);
      await loadB;
    });
    expect(hook.result.current.messages.map((m) => m.id)).toEqual(["B1", "B2"]);
  });
  it("keeps a newer live revision when an old initial snapshot arrives", async () => {
    let listener!: (event: GroupRuntimeEvent) => void;
    let resolveSeed!: (page: GroupMessage[]) => void;
    Object.assign(window, {
      modus: {
        group: {
          onEvent: (fn: (event: GroupRuntimeEvent) => void) => {
            listener = fn;
            return () => {};
          },
          listMessages: () =>
            new Promise<GroupMessage[]>((resolve) => {
              resolveSeed = resolve;
            }),
        },
      },
    });
    const hook = renderHook(() => useGroupMessages("A"));
    act(() =>
      listener({
        type: "group.message",
        groupId: "A",
        message: message("m", "A", {
          body: "finished",
          updatedAt: "3",
          status: "completed",
        } as Partial<GroupMessage>),
      }),
    );
    await act(async () => {
      resolveSeed([
        message("m", "A", {
          body: "prefix",
          updatedAt: "2",
          status: "writing",
        } as Partial<GroupMessage>),
        message("wrong", "B"),
      ]);
    });
    expect(hook.result.current.messages.map((m) => m.body)).toEqual(["finished"]);
  });
  it("ignores a rejected pagination request after leaving its room", async () => {
    let rejectA!: (error: Error) => void;
    Object.assign(window, {
      modus: {
        group: {
          onEvent: () => () => {},
          listMessages: (input: { groupId: string; before?: unknown }) =>
            input.before
              ? new Promise<GroupMessage[]>((_resolve, reject) => {
                  rejectA = reject;
                })
              : Promise.resolve([message(`${input.groupId}2`, input.groupId)]),
        },
      },
    });
    const hook = renderHook(({ id }) => useGroupMessages(id), { initialProps: { id: "A" } });
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.loadOlder();
    });
    hook.rerender({ id: "B" });
    await waitFor(() => expect(hook.result.current.messages[0]?.groupId).toBe("B"));
    await act(async () => {
      rejectA(new Error("old room error"));
      await pending;
    });
    expect(hook.result.current.error).toBeUndefined();
  });
});

describe("canonical stream frame updates", () => {
  it("publishes a burst of card revisions once with the latest body", async () => {
    let listener!: (event: GroupRuntimeEvent) => void;
    let renders = 0;
    Object.assign(window, {
      modus: {
        group: {
          onEvent: (fn: (event: GroupRuntimeEvent) => void) => {
            listener = fn;
            return () => {};
          },
          listMessages: () => Promise.resolve([message("m", "A", { createdAt: "000" })]),
        },
      },
    });
    const hook = renderHook(() => {
      renders++;
      return useGroupMessages("A");
    });
    await waitFor(() => expect(hook.result.current.loaded).toBe(true));
    const before = renders;
    for (let i = 1; i <= 20; i++)
      act(() =>
        listener({
          type: "group.message",
          groupId: "A",
          message: message("m", "A", {
            createdAt: "000",
            updatedAt: String(i).padStart(3, "0"),
            body: `revision ${i}`,
            status: "writing",
          }),
        }),
      );
    await waitFor(() => expect(hook.result.current.messages[0]?.body).toBe("revision 20"));
    expect(renders - before).toBe(1);
  });
});
