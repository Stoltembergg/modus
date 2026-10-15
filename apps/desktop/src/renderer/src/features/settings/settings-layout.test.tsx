import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsPageHeader, SettingsRow } from "./settings-layout";

describe("minimal settings copy", () => {
  it("does not reserve an empty subtitle when a heading is sufficient", () => {
    const html = renderToStaticMarkup(<SettingsPageHeader title="Appearance" />);
    expect(html).toContain("Appearance");
    expect(html).not.toContain("<p");
  });
  it("supports self-explanatory rows without an empty description", () => {
    const html = renderToStaticMarkup(
      <SettingsRow title="Color scheme" control={<button type="button">Dark</button>} />,
    );
    expect(html).toContain("Color scheme");
    expect(html).not.toContain("mt-0.5");
  });
  it("keeps important descriptions visible and complete", () => {
    const description =
      "No secure OS storage was found, so you will sign in again after restarting.";
    const html = renderToStaticMarkup(
      <SettingsRow
        title="Remember me"
        description={description}
        control={<span>This session only</span>}
      />,
    );
    expect(html).toContain(description);
    expect(html).not.toContain("truncate");
  });
});
