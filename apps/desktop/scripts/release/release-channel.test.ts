import { describe, expect, it } from "vitest";
import {
  channelForVersion,
  resolveTagRelease,
  resolveVersionRelease,
  toOutputLines,
} from "./release-channel.mjs";

describe("resolveTagRelease", () => {
  it("treats vX.Y.Z as a stable release with latest*.yml metadata", () => {
    expect(resolveTagRelease("v1.2.3", "1.2.3")).toEqual({
      version: "1.2.3",
      channel: "stable",
      updateChannel: "latest",
      prerelease: false,
      metadataFiles: { mac: "latest-mac.yml", windows: "latest.yml", linux: "latest-linux.yml" },
    });
  });

  it("treats vX.Y.Z-beta.N as a pre-release with beta*.yml metadata", () => {
    expect(resolveTagRelease("v0.4.0-beta.2", "0.4.0-beta.2")).toEqual({
      version: "0.4.0-beta.2",
      channel: "beta",
      updateChannel: "beta",
      prerelease: true,
      metadataFiles: { mac: "beta-mac.yml", windows: "beta.yml", linux: "beta-linux.yml" },
    });
  });

  it.each([
    "1.2.3",
    "v1.2",
    "v1.2.3.4",
    "v01.2.3",
    "v1.2.3-beta",
    "v1.2.3-beta.01",
    "v1.2.3-rc.1",
    "v1.2.3-alpha.1",
    "v1.2.3-beta.1+build",
    "v1.2.3 ",
    "release-1.2.3",
  ])("rejects unsupported tag %j", (tag) => {
    expect(() => resolveTagRelease(tag, tag.replace(/^v/, ""))).toThrow(/tag/i);
  });

  it("fails when the tag does not match package.json", () => {
    expect(() => resolveTagRelease("v0.2.0", "0.1.0")).toThrow(
      /Tag v0\.2\.0 does not match apps\/desktop\/package\.json version "0\.1\.0"/,
    );
    expect(() => resolveTagRelease("v0.2.0-beta.1", "0.2.0")).toThrow(/does not match/);
  });
});

describe("resolveVersionRelease (pull request dry runs)", () => {
  it("derives the channel from the package.json version", () => {
    expect(resolveVersionRelease("0.1.0").updateChannel).toBe("latest");
    expect(resolveVersionRelease("0.3.0-beta.7").updateChannel).toBe("beta");
    expect(resolveVersionRelease("0.3.0-beta.7").prerelease).toBe(true);
  });
});

describe("channelForVersion", () => {
  it("classifies versions", () => {
    expect(channelForVersion("0.1.0")).toBe("stable");
    expect(channelForVersion("0.1.0-beta.0")).toBe("beta");
    expect(channelForVersion("0.1.0-rc.1")).toBeNull();
  });
});

describe("toOutputLines", () => {
  it("formats GITHUB_OUTPUT lines", () => {
    expect(toOutputLines(resolveTagRelease("v2.0.0-beta.1", "2.0.0-beta.1"))).toEqual([
      "version=2.0.0-beta.1",
      "channel=beta",
      "update_channel=beta",
      "prerelease=true",
      "mac_metadata=beta-mac.yml",
      "windows_metadata=beta.yml",
      "linux_metadata=beta-linux.yml",
    ]);
  });
});
