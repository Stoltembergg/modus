import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppearanceSettingsPanel } from "./sections/appearance";

describe("Appearance settings", () => {
  it("offers a System theme option alongside the explicit palettes", () => {
    const markup = renderToStaticMarkup(<AppearanceSettingsPanel />);

    expect(markup).toContain(">System</button>");
    expect(markup).toContain(">Light</button>");
    expect(markup).toContain(">Dark</button>");
  });
});
