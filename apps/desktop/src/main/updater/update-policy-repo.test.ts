import { describe, expect, it, vi } from "vitest";

// A different repository: the allowlist must follow the shared constant, not a copy.
vi.mock("../../shared/release-repo", () => ({
  RELEASE_REPO: { owner: "example-org", repo: "example-app" },
}));

describe("update policy repository", () => {
  it("derives release URLs and the allowlist from RELEASE_REPO", async () => {
    const policy = await import("./update-policy");
    expect(policy.RELEASES_URL).toBe("https://github.com/example-org/example-app/releases");
    expect(policy.releasePageUrl("1.2.3")).toBe(
      "https://github.com/example-org/example-app/releases/tag/v1.2.3",
    );
    expect(
      policy.isAllowedReleaseAssetUrl(
        "https://github.com/example-org/example-app/releases/download/v1.2.3/Modus.zip",
      ),
    ).toBe(true);
    expect(
      policy.isAllowedReleaseAssetUrl(
        "https://github.com/Stoltembergg/modus/releases/download/v1.2.3/Modus.zip",
      ),
    ).toBe(false);
  });
});
