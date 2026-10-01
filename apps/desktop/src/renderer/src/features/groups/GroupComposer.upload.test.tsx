// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupComposer } from "./GroupComposer";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  Object.assign(window, {
    modus: {
      group: {
        onEvent: vi.fn(() => () => undefined),
        memberStates: vi.fn(async () => []),
      },
    },
  });
});

describe("GroupComposer file upload", () => {
  it("renders attach control and sends attachments with the message", async () => {
    const onSend = vi.fn(async () => undefined);
    render(
      <GroupComposer
        members={[{ sessionId: "s1", title: "Planner" }]}
        onSend={onSend}
        updatePending={false}
      />,
    );
    expect(screen.getByTestId("group-composer-attach")).toBeTruthy();
    const dropzone = screen.getByTestId("group-composer-dropzone");
    expect(dropzone).toBeTruthy();
    expect(dropzone.getAttribute("data-ui-surface")).toBe("raised");
    expect(dropzone.hasAttribute("data-composer-surface")).toBe(true);

    const file = new File(["hello"], "note.png", { type: "image/png" });
    Object.defineProperty(file, "size", { value: 5 });
    const input = screen.getByTestId("group-composer-file-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await waitFor(() => expect(screen.getByTestId("group-attachment-chip")).toBeTruthy());

    const textarea = screen.getByLabelText("Message the group");
    fireEvent.change(textarea, { target: { value: "see attached" } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Send"));
    });
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const payload = onSend.mock.calls.at(0)?.at(0) as unknown as {
      body: string;
      attachments?: { type: string; name?: string }[];
    };
    expect(payload.body).toBe("see attached");
    expect(payload.attachments?.[0]?.type).toBe("image");
    expect(payload.attachments?.[0]?.name).toBe("note.png");
  });

  it("keeps a failed attachment chip without blocking ready ones", async () => {
    const onSend = vi.fn(async () => undefined);
    render(
      <GroupComposer
        members={[{ sessionId: "s1", title: "Planner" }]}
        onSend={onSend}
        updatePending={false}
      />,
    );
    const huge = new File([new Uint8Array(11 * 1024 * 1024)], "big.png", { type: "image/png" });
    const input = screen.getByTestId("group-composer-file-input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [huge] } });
    });
    await waitFor(() => expect(screen.getByTestId("group-attachment-chip")).toBeTruthy());
    expect(screen.getByText(/too large/i)).toBeTruthy();
    const textarea = screen.getByLabelText("Message the group");
    fireEvent.change(textarea, { target: { value: "only text" } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Send"));
    });
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const payload = onSend.mock.calls.at(0)?.at(0) as unknown as {
      body: string;
      attachments?: unknown[];
    };
    expect(payload.body).toBe("only text");
    expect(payload.attachments).toBeUndefined();
  });
});
