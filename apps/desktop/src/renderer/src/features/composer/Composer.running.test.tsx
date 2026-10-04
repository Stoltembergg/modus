// @vitest-environment happy-dom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

afterEach(cleanup);

function renderComposer(isRunning: boolean) {
  return render(
    <Composer
      canSubmit
      contextItems={[]}
      cwd={undefined}
      isRunning={isRunning}
      model=""
      models={[]}
      onAbort={vi.fn()}
      onContextChange={vi.fn()}
      onModelChange={vi.fn()}
      onSubmit={vi.fn()}
      workspaceId={undefined}
    />,
  );
}

describe("Composer running state (replaces the WebGL waves)", () => {
  it("shows the top-edge sweep while running, with no canvas in the DOM", () => {
    const { container } = renderComposer(true);
    expect(container.querySelectorAll("[data-composer-running]")).toHaveLength(1);
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("has no sweep and no canvas when idle", async () => {
    const { container, rerender } = renderComposer(true);
    rerender(
      <Composer
        canSubmit
        contextItems={[]}
        cwd={undefined}
        isRunning={false}
        model=""
        models={[]}
        onAbort={vi.fn()}
        onContextChange={vi.fn()}
        onModelChange={vi.fn()}
        onSubmit={vi.fn()}
        workspaceId={undefined}
      />,
    );
    await waitFor(() => expect(container.querySelector("[data-composer-running]")).toBeNull());
    expect(container.querySelector("canvas")).toBeNull();
    const fresh = renderComposer(false);
    expect(fresh.container.querySelector("[data-composer-running]")).toBeNull();
  });
});
