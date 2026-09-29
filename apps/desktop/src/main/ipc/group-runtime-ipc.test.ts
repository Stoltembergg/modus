import { describe, expect, it, vi } from "vitest";
import type { GroupMessage } from "../../shared/contracts";
import type { GroupRuntimeIpcService } from "./group-runtime-ipc";
import type { TrustedSenderEvent } from "./trusted-sender";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));

const CHANNELS = ["group:post-message", "group:list-messages", "group:working"];

const MESSAGE: GroupMessage = {
  id: "m-1",
  groupId: "g-1",
  authorKind: "user",
  kind: "message",
  body: "hi",
  mentions: [],
  chainId: "m-1",
  createdAt: "2026-01-01T00:00:00.000Z",
};

type Handler = (event: TrustedSenderEvent, input?: unknown) => unknown;

function mockService() {
  return {
    postUserMessage: vi.fn((_input: unknown): GroupMessage => MESSAGE),
    listGroupMessages: vi.fn((_groupId: string, _options: unknown): GroupMessage[] => [MESSAGE]),
    workingGroupIds: vi.fn((): string[] => ["g-1"]),
  } satisfies GroupRuntimeIpcService;
}

async function register(service: GroupRuntimeIpcService) {
  const { registerGroupRuntimeIpcHandlers } = await import("./group-runtime-ipc");
  const { assertTrustedSender } = await import("./trusted-sender");
  const handlers = new Map<string, Handler>();
  registerGroupRuntimeIpcHandlers(
    { handle: (channel: string, handler: Handler) => void handlers.set(channel, handler) },
    assertTrustedSender,
    service,
  );
  return handlers;
}

async function trustedEvent() {
  const { registerTrustedSender } = await import("./trusted-sender");
  const sender = { mainFrame: { url: "file:///index.html" } };
  const unregister = registerTrustedSender(sender, "file:///index.html");
  return { trusted: { sender, senderFrame: sender.mainFrame }, unregister };
}

describe("group runtime IPC", () => {
  it("registers the room channels and rejects untrusted senders", async () => {
    const service = mockService();
    const handlers = await register(service);
    expect([...handlers.keys()].sort()).toEqual([...CHANNELS].sort());
    const event = { senderFrame: { url: "https://attacker.invalid/" } };
    for (const channel of CHANNELS) {
      expect(() => handlers.get(channel)?.(event, undefined)).toThrow(
        "Blocked IPC call from untrusted renderer frame.",
      );
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it("forwards valid calls with trimmed bodies and cursors", async () => {
    const service = mockService();
    const handlers = await register(service);
    const { trusted, unregister } = await trustedEvent();
    try {
      expect(
        handlers.get("group:post-message")?.(trusted, {
          groupId: "g-1",
          body: "  @Alpha go ",
          mentions: ["s-1"],
          replyToMessageId: "m-0",
        }),
      ).toEqual(MESSAGE);
      expect(service.postUserMessage).toHaveBeenCalledWith({
        groupId: "g-1",
        body: "@Alpha go",
        mentions: ["s-1"],
        replyToMessageId: "m-0",
      });
      const cursor = { createdAt: MESSAGE.createdAt, id: MESSAGE.id };
      expect(
        handlers.get("group:list-messages")?.(trusted, {
          groupId: "g-1",
          before: cursor,
          limit: 50,
        }),
      ).toEqual([MESSAGE]);
      expect(service.listGroupMessages).toHaveBeenCalledWith("g-1", { before: cursor, limit: 50 });
      expect(handlers.get("group:working")?.(trusted, undefined)).toEqual(["g-1"]);
    } finally {
      unregister();
    }
  });

  it("rejects invalid payloads and encodes store errors", async () => {
    const service = mockService();
    const handlers = await register(service);
    const { trusted, unregister } = await trustedEvent();
    try {
      expect(() =>
        handlers.get("group:post-message")?.(trusted, { groupId: "g-1", body: "  " }),
      ).toThrow(/Invalid IPC payload/);
      expect(() =>
        handlers.get("group:list-messages")?.(trusted, { groupId: "g-1", limit: 0 }),
      ).toThrow(/Invalid IPC payload/);
      expect(() => handlers.get("group:working")?.(trusted, { x: 1 })).toThrow(/expected no input/);
      service.postUserMessage.mockImplementationOnce(() => {
        throw Object.assign(new Error("Session s-9 is not a member"), {
          name: "GroupStoreError",
          code: "not-a-member",
        });
      });
      expect(() =>
        handlers.get("group:post-message")?.(trusted, {
          groupId: "g-1",
          body: "x",
          mentions: ["s-9"],
        }),
      ).toThrow(/^\[group-error:not-a-member\] Session s-9 is not a member/);
    } finally {
      unregister();
    }
  });
});
