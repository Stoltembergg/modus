// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ProcessStopNotices } from "./ProcessStopNotices";

function NoticeHarness() {
  const [notices, setNotices] = useState<ReadonlyMap<string, string>>(
    () => new Map([["app-1", "editor: descendant termination was not confirmed"]]),
  );

  return (
    <ProcessStopNotices
      notices={[...notices]}
      onDismiss={(processId) => {
        setNotices((current) => {
          const next = new Map(current);
          next.delete(processId);
          return next;
        });
      }}
    />
  );
}

describe("ProcessStopNotices", () => {
  it("keeps an unconfirmed stop diagnostic visible until explicitly dismissed", () => {
    render(<NoticeHarness />);

    expect(screen.getByRole("alert").textContent).toContain(
      "descendant termination was not confirmed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss stop notice for app-1" }));

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
