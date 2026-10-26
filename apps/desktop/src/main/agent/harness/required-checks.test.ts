import { describe, expect, it } from "vitest";
import { requestedCheckKinds } from "./required-checks";

describe("requestedCheckKinds", () => {
  it.each([
    "Não faça testes",
    "Não roda testes",
    "Não execute testes",
    "Não rode testes",
    "Do not run tests",
    "Skip tests",
  ])("treats an explicit prohibition as the final instruction in %s", (message) => {
    expect(requestedCheckKinds(message)).toEqual([]);
    expect(requestedCheckKinds(message, true)).toEqual(["tests"]);
  });

  it.each([
    ["Rode testes, mas não faça build", ["tests"], ["build"]],
    ["Don't run tests, but run typecheck", ["typecheck"], ["tests"]],
    ["Não rode testes, mas depois rode testes", ["tests"], []],
    ["Run tests, then do not run tests", [], ["tests"]],
  ] as const)("uses the latest explicit instruction for each check in %s", (message, allowed, denied) => {
    expect(requestedCheckKinds(message)).toEqual(allowed);
    expect(requestedCheckKinds(message, true)).toEqual(denied);
  });

  it.each([
    ["The old note said “run tests”. Continue the implementation.", []],
    ['A quoted instruction says "Do not run tests"; continue.', []],
    ["The old instruction was `run tests`; no new check request.", []],
    ["Maybe run tests? We have not decided yet.", []],
  ])("does not treat cited instructions as new requests in %s", (message, expected) => {
    expect(requestedCheckKinds(message)).toEqual(expected);
    expect(requestedCheckKinds(message, true)).toEqual([]);
  });

  it("does not turn check obligations into tool permissions", () => {
    expect(requestedCheckKinds("Run tests and build")).toEqual(["tests", "build"]);
  });
});
