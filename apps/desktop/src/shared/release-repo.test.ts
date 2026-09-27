import { describe, expect, it } from "vitest";
import builderConfig from "../../electron-builder.config";
import { RELEASE_REPO } from "./release-repo";

describe("RELEASE_REPO", () => {
  it("is the repository electron-builder publishes to (app-update.yml)", () => {
    expect(builderConfig.publish).toMatchObject({
      provider: "github",
      owner: RELEASE_REPO.owner,
      repo: RELEASE_REPO.repo,
    });
  });
});
