// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpringCheck } from "./SpringCheck";

afterEach(() => cleanup());

describe("SpringCheck", () => {
  it("exposes checked state for done items", () => {
    render(<SpringCheck checked disabled />);
    const el = screen.getByTestId("spring-check");
    const input = el.querySelector("input") as HTMLInputElement;
    expect(input.checked).toBe(true);
    expect(input.disabled).toBe(true);
  });

  it("calls onChange when interactive", () => {
    const onChange = vi.fn();
    render(<SpringCheck checked={false} onChange={onChange} />);
    const input = screen.getByTestId("spring-check").querySelector("input") as HTMLInputElement;
    input.click();
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
