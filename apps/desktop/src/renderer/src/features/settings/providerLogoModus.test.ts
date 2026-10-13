import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createProviderLogoResolver, providerLogoColor } from "./providerLogoRegistry";

describe("Modus provider logo", () => {
  it("ships the Modus logo for the modus provider in the logo purple", () => {
    expect(existsSync(new URL("../../assets/provider-logos/modus.svg", import.meta.url))).toBe(
      true,
    );
    const resolve = createProviderLogoResolver(new Set(["modus", "synthetic"]));
    expect(resolve("modus", "Modus")).toBe("modus");
    expect(providerLogoColor("modus", "modus").toLowerCase()).toContain("863ff5");
  });
});
